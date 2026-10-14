import { dec, toNum, ZERO, type Dec } from "@/lib/decimal";
import { fetchMarket, fetchOrderBook, normalizeBook } from "@/lib/polymarket/client";
import { finalPayouts } from "@/lib/polymarket/resolution";
import { applyLpFill, lpMarkValue, settleLpPosition, settleRewardDay, type LpPosition } from "./account";
import { fetchRecentTrades, fetchRewardMarkets, type RewardMarket } from "./api";
import { crossFills, matchTrades, yesEquivalent, type PaperFill, type PublicTrade } from "./fills";
import { buildQuotes, quoteCapital, referencePrice, type QuoteConfig, type Quotes } from "./quoting";
import { evaluateQuotes, type Level } from "./scoring";
import { hoursLeft, isEligible, rankCandidates, WEATHER, type Candidate, type SelectionConfig } from "./select";

/**
 * PAPER reward-collecting robot. It decides where a real robot would rest
 * orders to earn Polymarket liquidity rewards, then tracks what would have
 * happened to them using the live public order books and trade feed.
 *
 * It never places an order. Fills are inferred from real trades; rewards are
 * ESTIMATED from the published formula and cannot be confirmed without a real
 * account. Every assumption that could flatter the result is taken the other
 * way: competitors are scored at their maximum, reward minutes missed while
 * the robot was not looking are not back-filled, and a market-day that earns
 * under $1 is counted as unpaid.
 */
export interface RobotConfig {
  accounts: { name: string; startingCash: number }[];
  cycleSeconds: number;
  scanMinutes: number;
  /** How many of the best-looking pools get their order book read each scan. */
  evaluateTop: number;
  /** Dollars set aside per market: the two orders plus room to keep quoting after one fill. */
  budgetPerMarket: number;
  /** Stop quoting a market this many hours before it ends. */
  exitHours: number;
  /** Leave a market after two scans in a row with an average share below this. */
  minShare: number;
  /** What fills are assumed to cost per market per day when ranking pools. */
  assumedDailyCost: number;
  selection: SelectionConfig;
  quoting: QuoteConfig;
}

export const DEFAULT_CONFIG: RobotConfig = {
  accounts: [
    { name: "$20 account", startingCash: 20 },
    { name: "$200 account", startingCash: 200 },
  ],
  cycleSeconds: 60,
  scanMinutes: 30,
  evaluateTop: 60,
  budgetPerMarket: 40,
  exitHours: 24,
  minShare: 0.05,
  assumedDailyCost: 0.5,
  selection: { minDailyRate: 5, maxMinSize: 20, minHoursLeft: 48, minPrice: 0.15, maxPrice: 0.85, exclude: WEATHER, maxPerEvent: 1 },
  quoting: { offsetFraction: 0.6, skewPerLot: 0.01, capLots: 2, minPrice: 0.1, maxPrice: 0.9 },
};

// ---- state (plain JSON; money as decimal strings) ----

export interface HeldMarket {
  conditionId: string;
  marketId: string;
  question: string;
  eventSlug: string | null;
  yesTokenId: string;
  endDate: string | null;
  tick: number;
  minSize: number;
  maxSpread: number;
  dailyRate: number;
  /** quoting = orders resting; holding = left the market, waiting for leftover shares to pay out. */
  status: "quoting" | "holding";
  joinedAt: string;
  leftAt: string | null;
  leftReason: string | null;
  quotes: Quotes;
  lastTradeTs: number;
  seenTrades: string[];
  lastPrice: number | null;
  lastSampleAt: string | null;
  yes: string;
  no: string;
  cashFlow: string;
  fills: number;
  rewardTotal: string;
  rewardDay: string;
  rewardToday: string;
  share: number;
  shareSum: number;
  samples: number;
  scanShareSum: number;
  scanSamples: number;
  lowShareScans: number;
  mark: number | null;
}

export interface ClosedMarket {
  conditionId: string;
  question: string;
  joinedAt: string;
  leftAt: string;
  reason: string;
  rewardTotal: string;
  fills: number;
  tradingResult: string;
  payoutYes: number | null;
}

export interface AccountState {
  name: string;
  startingCash: string;
  cash: string;
  rewardsPaid: string;
  rewardsForfeited: string;
  tradingRealized: string;
  markets: HeldMarket[];
  closed: ClosedMarket[];
  /** Reward accrued per UTC day and market ("2026-10-13|0xabc..."), settled when the day ends. */
  rewardDays: Record<string, string>;
}

export interface CandidateView {
  question: string;
  dailyRate: number;
  share: number;
  expectedDailyReward: number;
  capital: number;
  hoursLeft: number | null;
  volume24h: number;
}

export interface RobotEvent {
  at: string;
  account: string;
  text: string;
}

export interface RobotState {
  version: 1;
  /** Which exchange's reward rules the robot follows. Absent means the international exchange. */
  venue?: "intl" | "us";
  startedAt: string;
  updatedAt: string;
  cycles: number;
  lastScanAt: string | null;
  poolsSeen: { markets: number; dailyTotal: number; eligible: number; uncontested: number; uncontestedDaily: number } | null;
  accounts: AccountState[];
  candidates: CandidateView[];
  events: RobotEvent[];
  lastError: string | null;
}

export function newState(cfg: RobotConfig, now: Date): RobotState {
  return {
    version: 1,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cycles: 0,
    lastScanAt: null,
    poolsSeen: null,
    accounts: cfg.accounts.map((a) => ({ name: a.name, startingCash: String(a.startingCash), cash: String(a.startingCash), rewardsPaid: "0", rewardsForfeited: "0", tradingRealized: "0", markets: [], closed: [], rewardDays: {} })),
    candidates: [],
    events: [],
    lastError: null,
  };
}

/**
 * After the robot has been stopped: a real robot pulls its orders when it shuts
 * down, so nothing could have been filled while it was away, and it earned
 * nothing either. Start every market afresh from now.
 */
export function resumeAfterRestart(state: RobotState, now: Date): void {
  for (const acct of state.accounts) {
    for (const hm of acct.markets) {
      hm.quotes = NO_QUOTES;
      hm.lastTradeTs = Math.floor(now.getTime() / 1000);
      hm.seenTrades = [];
      hm.lastSampleAt = null;
    }
  }
}

// ---- live data ----

export interface MarketInfo {
  closed: boolean;
  /** Set only once the market has finally resolved. */
  payoutYes: number | null;
  acceptingOrders: boolean;
  tick: number;
}

type Book = { bids: Level[]; asks: Level[] };

export interface RobotApi {
  rewardMarkets(minDailyRate: number): Promise<RewardMarket[]>;
  book(tokenId: string): Promise<Book>;
  trades(conditionId: string): Promise<PublicTrade[]>;
  market(marketId: string): Promise<MarketInfo | null>;
}

export const liveApi: RobotApi = {
  rewardMarkets: (minDailyRate) => fetchRewardMarkets(minDailyRate),
  async book(tokenId) {
    const b = normalizeBook(await fetchOrderBook(tokenId));
    const levels = (side: { price: string; size: string }[]) => side.map((l) => ({ price: Number(l.price), size: Number(l.size) }));
    return { bids: levels(b.bids), asks: levels(b.asks) };
  },
  trades: (conditionId) => fetchRecentTrades(conditionId),
  async market(marketId) {
    const m = await fetchMarket(marketId);
    if (!m) return null;
    const final = finalPayouts(m);
    return { closed: m.closed === true, payoutYes: final ? Number(final.payoutYes) : null, acceptingOrders: m.acceptingOrders !== false, tick: Number(m.orderPriceMinTickSize ?? 0.01) || 0.01 };
  },
};

// ---- helpers ----

const MAX_EVENTS = 300;
export const NO_QUOTES: Quotes = { bid: null, ask: null };
export const utcDay = (now: Date) => now.toISOString().slice(0, 10);
const money = (v: Dec | number | string) => `$${dec(v).toFixed(2)}`;
const cents = (p: number) => `${(p * 100).toFixed(1)}c`;

export type Log = (account: string, text: string) => void;

export function logger(state: RobotState, now: Date): Log {
  return (account, text) => {
    state.events.push({ at: now.toISOString(), account, text });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  };
}

export const positionOf = (hm: HeldMarket): LpPosition => ({ yes: dec(hm.yes), no: dec(hm.no), cashFlow: dec(hm.cashFlow), fills: hm.fills });

function storePosition(hm: HeldMarket, pos: LpPosition) {
  hm.yes = pos.yes.toString();
  hm.no = pos.no.toString();
  hm.cashFlow = pos.cashFlow.toString();
  hm.fills = pos.fills;
}

export const isFlat = (hm: HeldMarket) => dec(hm.yes).isZero() && dec(hm.no).isZero();

/** Cash already promised to the resting orders of the account's other markets. */
export function reservedElsewhere(acct: AccountState, except: HeldMarket): number {
  return acct.markets.filter((m) => m !== except).reduce((s, m) => s + quoteCapital(m.quotes, Number(m.yes)), 0);
}

export function recordFill(acct: AccountState, hm: HeldMarket, f: PaperFill, log: Log) {
  const { next, cashDelta } = applyLpFill(positionOf(hm), f.side, f.price, f.size);
  storePosition(hm, next);
  acct.cash = dec(acct.cash).plus(cashDelta).toString();
  const what = f.side === "BID" ? `bought ${f.size} YES at ${cents(f.price)}` : `sold ${f.size} YES at ${cents(f.price)}`;
  log(acct.name, `Filled: ${what} in "${hm.question}" (${f.via === "trade" ? "a real trade crossed our order" : "the book moved through our order"}).`);
}

function closeMarket(acct: AccountState, hm: HeldMarket, reason: string, tradingResult: Dec, payoutYes: number | null, now: Date) {
  acct.tradingRealized = dec(acct.tradingRealized).plus(tradingResult).toString();
  acct.closed.push({ conditionId: hm.conditionId, question: hm.question, joinedAt: hm.joinedAt, leftAt: hm.leftAt ?? now.toISOString(), reason, rewardTotal: hm.rewardTotal, fills: hm.fills, tradingResult: tradingResult.toString(), payoutYes });
  acct.markets = acct.markets.filter((m) => m !== hm);
}

/** Stop quoting. Leftover shares are kept until the market pays out; a flat market is closed straight away. */
export function leaveMarket(acct: AccountState, hm: HeldMarket, reason: string, now: Date, log: Log) {
  hm.status = "holding";
  hm.quotes = NO_QUOTES;
  hm.leftAt = now.toISOString();
  hm.leftReason = reason;
  log(acct.name, `Stopped quoting "${hm.question}": ${reason}.${isFlat(hm) ? "" : " Keeping the shares it left us with until the market pays out."}`);
  if (isFlat(hm)) closeMarket(acct, hm, reason, dec(hm.cashFlow), null, now);
}

export function settleMarket(acct: AccountState, hm: HeldMarket, payoutYes: number, now: Date, log: Log) {
  const { cashDelta, realized } = settleLpPosition(positionOf(hm), payoutYes);
  acct.cash = dec(acct.cash).plus(cashDelta).toString();
  hm.leftAt ??= now.toISOString();
  log(acct.name, `"${hm.question}" resolved (${payoutYes === 1 ? "YES" : payoutYes === 0 ? "NO" : "voided"}). Result from fills there: ${money(realized)}.`);
  closeMarket(acct, hm, hm.leftReason ?? "the market resolved", realized, payoutYes, now);
}

/** Pay (or forfeit) every reward day that has ended. */
export function settleRewardDays(acct: AccountState, now: Date, log: Log) {
  const today = utcDay(now);
  const byDay = new Map<string, { paid: Dec; forfeited: Dec }>();
  for (const [key, amount] of Object.entries(acct.rewardDays)) {
    const day = key.slice(0, 10);
    if (day >= today) continue;
    const r = settleRewardDay(amount);
    const t = byDay.get(day) ?? { paid: ZERO, forfeited: ZERO };
    byDay.set(day, { paid: t.paid.plus(r.paid), forfeited: t.forfeited.plus(r.forfeited) });
    delete acct.rewardDays[key];
  }
  for (const [day, t] of byDay) {
    acct.cash = dec(acct.cash).plus(t.paid).toString();
    acct.rewardsPaid = dec(acct.rewardsPaid).plus(t.paid).toString();
    acct.rewardsForfeited = dec(acct.rewardsForfeited).plus(t.forfeited).toString();
    log(acct.name, `Rewards for ${day}: ${money(t.paid)} counted as paid${t.forfeited.gt(0) ? `, ${money(t.forfeited)} not counted (under $1 in a market)` : ""}. Estimated, not confirmed.`);
  }
}

// ---- one look at one market ----

function stepMarket(acct: AccountState, hm: HeldMarket, cfg: RobotConfig, book: Book, trades: PublicTrade[], now: Date, log: Log) {
  // 1. Real trades and book moves since the last look, against the orders that were resting then.
  const fresh = trades.filter((t) => t.timestamp > hm.lastTradeTs || (t.timestamp === hm.lastTradeTs && !hm.seenTrades.includes(t.key)));
  if (hm.quotes.bid || hm.quotes.ask) {
    const viaTrades = matchTrades(hm.quotes, fresh);
    const viaBook = crossFills(viaTrades.remaining, book, Math.floor(now.getTime() / 1000));
    for (const f of [...viaTrades.fills, ...viaBook.fills]) recordFill(acct, hm, f, log);
  }
  const newest = trades.reduce((m, t) => Math.max(m, t.timestamp), hm.lastTradeTs);
  hm.seenTrades = trades.filter((t) => t.timestamp === newest).map((t) => t.key);
  hm.lastTradeTs = newest;
  const last = fresh[fresh.length - 1];
  if (last) hm.lastPrice = yesEquivalent(last).yesPrice;

  // 2. Fresh orders for the coming minute, and the reward they would be earning.
  if (hm.status === "quoting") {
    const freeCash = Math.max(0, toNum(acct.cash) - reservedElsewhere(acct, hm));
    hm.quotes = buildQuotes({ bids: book.bids, asks: book.asks, lastPrice: hm.lastPrice, minSize: hm.minSize, maxSpread: hm.maxSpread, tick: hm.tick, yesShares: Number(hm.yes), noShares: Number(hm.no), freeCash }, cfg.quoting);
    const ev = evaluateQuotes(book, hm.quotes, hm.minSize, hm.maxSpread);
    // One sample per minute; minutes missed while the robot was away are not back-filled.
    const minutes = hm.lastSampleAt ? Math.min(1.5, Math.max(0, (now.getTime() - Date.parse(hm.lastSampleAt)) / 60_000)) : 1;
    const accrual = dec(hm.dailyRate).div(1440).times(ev.share).times(minutes);
    const day = utcDay(now);
    if (hm.rewardDay !== day) {
      hm.rewardDay = day;
      hm.rewardToday = "0";
    }
    hm.rewardToday = dec(hm.rewardToday).plus(accrual).toString();
    hm.rewardTotal = dec(hm.rewardTotal).plus(accrual).toString();
    const key = `${day}|${hm.conditionId}`;
    acct.rewardDays[key] = dec(acct.rewardDays[key] ?? 0).plus(accrual).toString();
    hm.share = ev.share;
    hm.shareSum += ev.share;
    hm.samples += 1;
    hm.scanShareSum += ev.share;
    hm.scanSamples += 1;
    hm.lastSampleAt = now.toISOString();
  } else {
    hm.quotes = NO_QUOTES;
  }

  // 3. What the shares we hold are worth now.
  hm.mark = referencePrice(book.bids, book.asks, hm.lastPrice) ?? hm.lastPrice ?? hm.mark;
}

/** One pass over every market every account holds. Each market's book and trades are read once and shared. */
export async function runCycle(state: RobotState, cfg: RobotConfig, api: RobotApi, now: Date): Promise<void> {
  const log = logger(state, now);
  const data = new Map<string, Promise<{ book: Book; trades: PublicTrade[] }>>();
  const load = (hm: HeldMarket) => {
    let p = data.get(hm.conditionId);
    if (!p) {
      p = Promise.all([api.book(hm.yesTokenId), hm.status === "quoting" || hm.quotes.bid || hm.quotes.ask ? api.trades(hm.conditionId) : Promise.resolve([])]).then(([book, trades]) => ({ book, trades }));
      data.set(hm.conditionId, p);
    }
    return p;
  };
  for (const acct of state.accounts) {
    settleRewardDays(acct, now, log);
    for (const hm of [...acct.markets]) {
      try {
        const { book, trades } = await load(hm);
        stepMarket(acct, hm, cfg, book, trades, now, log);
      } catch (err) {
        // A failed read costs this market one sample; its resting orders are assumed pulled.
        hm.quotes = NO_QUOTES;
        state.lastError = `${now.toISOString()} ${hm.question}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      }
    }
  }
  state.cycles += 1;
  state.updatedAt = now.toISOString();
}

// ---- choosing markets ----

export interface ScanResult {
  at: Date;
  byId: Map<string, RewardMarket>;
  ranked: Candidate[];
  poolsSeen: NonNullable<RobotState["poolsSeen"]>;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

/** Read the reward pools and the books of the most promising ones. Touches no account, so it can run alongside cycles. */
export async function gatherScan(cfg: RobotConfig, api: RobotApi, now: Date): Promise<ScanResult> {
  const sel = cfg.selection;
  // Pools down to half the minimum are fetched so a held market whose pool shrank a little is not mistaken for one that lost it.
  const rows = await api.rewardMarkets(sel.minDailyRate / 2);
  const eligible = rows.filter((m) => isEligible(m, sel, now));
  const shortlist = [...eligible].sort((a, b) => b.dailyRate / (1 + b.competitiveness) - a.dailyRate / (1 + a.competitiveness)).slice(0, cfg.evaluateTop);
  const candidates: Candidate[] = [];
  await mapLimit(shortlist, 6, async (m) => {
    try {
      const book = await api.book(m.yesTokenId);
      const quotes = buildQuotes({ bids: book.bids, asks: book.asks, lastPrice: m.yesPrice, minSize: m.minSize, maxSpread: m.maxSpread, tick: 0.01, yesShares: 0, noShares: 0, freeCash: Infinity }, cfg.quoting);
      if (!quotes.bid || !quotes.ask) return;
      const share = evaluateQuotes(book, quotes, m.minSize, m.maxSpread).share;
      candidates.push({ market: m, share, expectedDailyReward: m.dailyRate * share, capital: quoteCapital(quotes, 0) });
    } catch {
      // One unreadable book just means one fewer candidate this scan.
    }
  });
  const uncontested = eligible.filter((m) => m.competitiveness === 0);
  return {
    at: now,
    byId: new Map(rows.map((r) => [r.conditionId, r])),
    // A market-day under $1 is not paid, so a pool we could not take $1 of is not worth a slot.
    ranked: rankCandidates(candidates, cfg.assumedDailyCost).filter((c) => c.expectedDailyReward >= 1),
    poolsSeen: {
      markets: rows.length,
      dailyTotal: rows.reduce((s, m) => s + m.dailyRate, 0),
      eligible: eligible.length,
      uncontested: uncontested.length,
      uncontestedDaily: uncontested.reduce((s, m) => s + m.dailyRate, 0),
    },
  };
}

function joinMarket(acct: AccountState, c: Candidate, info: MarketInfo, now: Date, log: Log) {
  const m = c.market;
  acct.markets.push({
    conditionId: m.conditionId, marketId: m.marketId, question: m.question, eventSlug: m.eventSlug, yesTokenId: m.yesTokenId,
    endDate: m.endDate, tick: info.tick, minSize: m.minSize, maxSpread: m.maxSpread, dailyRate: m.dailyRate,
    status: "quoting", joinedAt: now.toISOString(), leftAt: null, leftReason: null,
    quotes: NO_QUOTES, lastTradeTs: Math.floor(now.getTime() / 1000), seenTrades: [], lastPrice: m.yesPrice, lastSampleAt: null,
    yes: "0", no: "0", cashFlow: "0", fills: 0,
    rewardTotal: "0", rewardDay: utcDay(now), rewardToday: "0", share: 0, shareSum: 0, samples: 0, scanShareSum: 0, scanSamples: 0, lowShareScans: 0,
    mark: m.yesPrice,
  });
  log(acct.name, `Started quoting "${m.question}": pool ${money(m.dailyRate)}/day, we would take about ${(c.share * 100).toFixed(0)}% of it, tying up ${money(c.capital)}.`);
}

/** Act on a finished scan: settle what resolved, leave what stopped being worth it, fill free slots with the best pools. */
export async function applyScan(state: RobotState, cfg: RobotConfig, api: RobotApi, scan: ScanResult, now: Date): Promise<void> {
  const log = logger(state, now);
  const infos = new Map<string, Promise<MarketInfo | null>>();
  const info = (marketId: string) => {
    let p = infos.get(marketId);
    if (!p) {
      p = api.market(marketId).catch(() => null);
      infos.set(marketId, p);
    }
    return p;
  };

  for (const acct of state.accounts) {
    for (const hm of [...acct.markets]) {
      const i = await info(hm.marketId);
      if (i?.payoutYes != null) {
        settleMarket(acct, hm, i.payoutYes, now, log);
        continue;
      }
      if (hm.status !== "quoting") continue;
      const row = scan.byId.get(hm.conditionId);
      if (row) {
        hm.dailyRate = row.dailyRate;
        hm.minSize = row.minSize;
        hm.maxSpread = row.maxSpread;
      }
      if (hm.scanSamples > 0) hm.lowShareScans = hm.scanShareSum / hm.scanSamples < cfg.minShare ? hm.lowShareScans + 1 : 0;
      hm.scanShareSum = 0;
      hm.scanSamples = 0;
      const reason = !row ? "its reward pool was removed or cut"
        : i && (i.closed || !i.acceptingOrders) ? "it stopped taking orders"
        : hoursLeft(hm.endDate, now) <= cfg.exitHours ? "it ends within a day"
        : hm.lowShareScans >= 2 ? "others crowded in and our share fell away"
        : null;
      if (reason) leaveMarket(acct, hm, reason, now, log);
    }

    const slots = Math.max(1, Math.floor(toNum(acct.startingCash) / cfg.budgetPerMarket));
    const recentlyLeft = new Set(acct.closed.filter((c) => now.getTime() - Date.parse(c.leftAt) < 6 * 3_600_000).map((c) => c.conditionId));
    for (const c of scan.ranked) {
      const quoting = acct.markets.filter((m) => m.status === "quoting");
      if (quoting.length >= slots) break;
      const m = c.market;
      if (acct.markets.some((h) => h.conditionId === m.conditionId) || recentlyLeft.has(m.conditionId)) continue;
      if (m.eventSlug && quoting.filter((h) => h.eventSlug === m.eventSlug).length >= cfg.selection.maxPerEvent) continue;
      const free = toNum(acct.cash) - acct.markets.reduce((s, h) => s + quoteCapital(h.quotes, Number(h.yes)), 0);
      if (free < c.capital) continue;
      const i = await info(m.marketId);
      if (!i || i.closed || !i.acceptingOrders) continue;
      joinMarket(acct, c, i, now, log);
    }
  }

  state.candidates = scan.ranked.slice(0, 15).map((c) => {
    const h = hoursLeft(c.market.endDate, now);
    return { question: c.market.question, dailyRate: c.market.dailyRate, share: c.share, expectedDailyReward: c.expectedDailyReward, capital: c.capital, hoursLeft: Number.isFinite(h) ? h : null, volume24h: c.market.volume24h };
  });
  state.poolsSeen = scan.poolsSeen;
  state.lastScanAt = now.toISOString();
}

// ---- reading the result ----

export interface AccountSummary {
  name: string;
  startingCash: Dec;
  cash: Dec;
  /** Shares held, valued at the current price. */
  inventoryValue: Dec;
  rewardsPaid: Dec;
  /** Accrued today in markets already past the $1 minimum. */
  rewardsPendingCounted: Dec;
  /** Accrued today in markets still under $1 (lost unless they get there by midnight UTC). */
  rewardsPendingAtRisk: Dec;
  rewardsForfeited: Dec;
  /** Result of fills: settled markets plus open positions at the current price. */
  tradingResult: Dec;
  /** Cash + shares + today's counted rewards: where the account stands IF rewards are paid as published. */
  total: Dec;
  /** The same with every reward taken out: where it stands if no reward is ever paid. */
  totalWithoutRewards: Dec;
  quoting: number;
  holding: number;
}

export function summarize(acct: AccountState, now: Date): AccountSummary {
  let inventoryValue = ZERO;
  let openTrading = ZERO;
  for (const hm of acct.markets) {
    const value = lpMarkValue(positionOf(hm), hm.mark ?? 0.5);
    inventoryValue = inventoryValue.plus(value);
    openTrading = openTrading.plus(dec(hm.cashFlow)).plus(value);
  }
  const today = utcDay(now);
  let counted = ZERO;
  let atRisk = ZERO;
  for (const [key, amount] of Object.entries(acct.rewardDays)) {
    // International keys are a UTC day; US keys start with the period's end time and stay open until it passes.
    const usPeriod = key.length > 10 && key[10] === "T";
    if (!usPeriod && !key.startsWith(today)) continue;
    const r = settleRewardDay(amount);
    counted = counted.plus(r.paid);
    atRisk = atRisk.plus(r.forfeited);
  }
  const cash = dec(acct.cash);
  return {
    name: acct.name,
    startingCash: dec(acct.startingCash),
    cash,
    inventoryValue,
    rewardsPaid: dec(acct.rewardsPaid),
    rewardsPendingCounted: counted,
    rewardsPendingAtRisk: atRisk,
    rewardsForfeited: dec(acct.rewardsForfeited),
    tradingResult: dec(acct.tradingRealized).plus(openTrading),
    total: cash.plus(inventoryValue).plus(counted),
    totalWithoutRewards: cash.minus(acct.rewardsPaid).plus(inventoryValue),
    quoting: acct.markets.filter((m) => m.status === "quoting").length,
    holding: acct.markets.filter((m) => m.status === "holding").length,
  };
}

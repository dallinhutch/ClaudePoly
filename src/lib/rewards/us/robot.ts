import { dec, toNum, ZERO, type Dec } from "@/lib/decimal";
import { settleRewardDay } from "../account";
import { crossFills, type PaperFill } from "../fills";
import { quoteCapital, type Quotes } from "../quoting";
import { isFlat, leaveMarket, logger, NO_QUOTES, recordFill, reservedElsewhere, settleMarket, type AccountState, type HeldMarket, type Log, type RobotState } from "../robot";
import { EPS, type Level } from "../scoring";
import { fetchUsBook, fetchUsMarket, fetchUsRewardMarkets, fetchUsSettlement, type UsBook, type UsMarketInfo, type UsRewardMarket } from "./api";
import { evaluateUsQuotes, type UsProgram } from "./scoring";

/**
 * PAPER robot for Polymarket US liquidity incentives. US rewards go to orders
 * AT the best price (deeper ones are discounted steeply), each period has its
 * own pool, and a period's reward under $1 is not paid. So the robot joins the
 * best bid and best offer with one order each, follows them as they move, and
 * measures what being first in line to be hit would have cost.
 *
 * It never places an order. There is no public trade feed on Polymarket US, so
 * fills are inferred from the book: the running traded-contracts count and the
 * last trade price, against our place in the queue at our price, plus any
 * order that crossed our price outright.
 */
export interface UsAccountConfig {
  name: string;
  startingCash: number;
  /** Contracts per order (one order each side per market). */
  orderSize: number;
}

export interface UsRobotConfig {
  accounts: UsAccountConfig[];
  cycleSeconds: number;
  scanMinutes: number;
  /** Books read per scan, best-paying pools first. */
  evaluateTop: number;
  /** Dollars set aside per market, as a multiple of the order size. */
  budgetPerContract: number;
  /** Never hold more than this many orders' worth of contracts net in one market. */
  capLots: number;
  /** Stay out of books wider than this: the "best price" there is often a stale order. */
  maxSpreadToQuote: number;
  /** Do not join a period with less than this left. */
  minMinutesLeft: number;
  /** How long a live period is assumed to last when spreading its pool over time (longer = more conservative). */
  liveHours: number;
  /** Props on one game move together; cap how many one account holds. */
  maxPerGame: number;
  periods: string[];
}

export const US_CONFIG: UsRobotConfig = {
  accounts: [
    { name: "$20 account", startingCash: 20, orderSize: 20 },
    { name: "$200 account", startingCash: 200, orderSize: 20 },
    { name: "$1,000 account", startingCash: 1000, orderSize: 100 },
  ],
  cycleSeconds: 20,
  scanMinutes: 10,
  evaluateTop: 80,
  budgetPerContract: 1.5,
  capLots: 2,
  maxSpreadToQuote: 0.05,
  minMinutesLeft: 20,
  liveHours: 4,
  maxPerGame: 2,
  // In-game periods are left out: on the first evening (2026-10-14) the $1,000 paper account lost $379 to fills in
  // live Champions League markets while earning about $135 of estimated rewards there. Scores move prices too fast.
  periods: ["day_of", "daily_event"],
};

/** US-specific facts kept on each held market (the shared fields drive the dashboard). */
export interface UsHeldMarket extends HeldMarket {
  program: UsProgram;
  periodStart: string;
  periodEnd: string;
  eventStart: string | null;
  gameKey: string;
  queueBid: number;
  queueAsk: number;
  lastShares: number | null;
}

const H = 3_600_000;
const ET_OFFSET_H = 4; // Eastern daylight time; daily periods run midnight to midnight ET

/** The window a period pays in, or null for kinds the robot does not handle. */
export function periodWindow(period: string, eventStart: Date | null, now: Date, liveHours: number): { start: Date; end: Date } | null {
  if (period === "daily_event") {
    const day = Math.floor((now.getTime() - ET_OFFSET_H * H) / (24 * H));
    const start = new Date(day * 24 * H + ET_OFFSET_H * H);
    return { start, end: new Date(start.getTime() + 24 * H) };
  }
  if (!eventStart) return null;
  const ev = eventStart.getTime();
  if (period === "day_of") return { start: new Date(ev - 6 * H), end: new Date(ev) };
  if (period === "live") return { start: new Date(ev), end: new Date(ev + liveHours * H) };
  return null;
}

/** Markets about the same game share everything up to the date in their slug. */
export function gameKeyOf(slug: string): string {
  const m = slug.replace(/^[a-z0-9]+-/, "").match(/^.*?\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : slug;
}

/** One order at the best bid and one at the best offer, within what the account can fund and hold. */
export function joinBest(book: UsBook, size: number, yes: number, no: number, capLots: number, freeCash: number, maxSpread: number): Quotes {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (bestBid === undefined || bestAsk === undefined || bestAsk - bestBid > maxSpread + EPS || bestAsk <= bestBid) return NO_QUOTES;
  const net = yes - no;
  const cap = capLots * size;
  const q: Quotes = {
    bid: net + size <= cap + EPS ? { price: bestBid, size } : null,
    ask: -net + size <= cap + EPS ? { price: bestAsk, size } : null,
  };
  if (q.bid && quoteCapital({ bid: q.bid, ask: null }, yes) > freeCash + EPS) q.bid = null;
  if (q.ask && quoteCapital(q, yes) > freeCash + EPS) q.ask = null;
  return q;
}

/**
 * Fills implied by trading since the last look. `traded` contracts changed
 * hands, the last at `lastPx`. At our own price we are behind `queue` contracts
 * that were there first; a trade beyond our price means the level was swept.
 */
export function inferTradeFills(quotes: Quotes, queue: { bid: number; ask: number }, traded: number, lastPx: number | null, timestamp: number): { fills: PaperFill[]; remaining: Quotes; queue: { bid: number; ask: number } } {
  const fills: PaperFill[] = [];
  const next = { ...queue };
  let bid = quotes.bid;
  let ask = quotes.ask;
  if (traded > EPS && lastPx !== null) {
    if (ask && lastPx >= ask.price - EPS) {
      const swept = lastPx > ask.price + EPS;
      const ours = swept ? Math.min(traded, ask.size) : Math.min(ask.size, Math.max(0, traded - queue.ask));
      next.ask = swept ? 0 : Math.max(0, queue.ask - traded);
      if (ours > EPS) {
        fills.push({ side: "ASK", price: ask.price, size: ours, timestamp, via: "trade" });
        ask = ask.size - ours > EPS ? { price: ask.price, size: ask.size - ours } : null;
      }
    } else if (bid && lastPx <= bid.price + EPS) {
      const swept = lastPx < bid.price - EPS;
      const ours = swept ? Math.min(traded, bid.size) : Math.min(bid.size, Math.max(0, traded - queue.bid));
      next.bid = swept ? 0 : Math.max(0, queue.bid - traded);
      if (ours > EPS) {
        fills.push({ side: "BID", price: bid.price, size: ours, timestamp, via: "trade" });
        bid = bid.size - ours > EPS ? { price: bid.price, size: bid.size - ours } : null;
      }
    }
  }
  return { fills, remaining: { bid, ask }, queue: next };
}

const sizeAt = (levels: Level[], price: number) => levels.filter((l) => Math.abs(l.price - price) < EPS).reduce((s, l) => s + l.size, 0);
const periodKey = (hm: UsHeldMarket) => `${hm.periodEnd}|${hm.conditionId}|${hm.program.programId}`;

export interface UsApi {
  rewardMarkets(): Promise<UsRewardMarket[]>;
  book(slug: string): Promise<UsBook | null>;
  market(slug: string): Promise<UsMarketInfo | null>;
  settlement(slug: string): Promise<number | null>;
}

export const liveUsApi: UsApi = {
  rewardMarkets: () => fetchUsRewardMarkets(),
  book: fetchUsBook,
  market: fetchUsMarket,
  settlement: fetchUsSettlement,
};

export function newUsState(cfg: UsRobotConfig, now: Date): RobotState {
  return {
    version: 1,
    venue: "us",
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

/** A real robot pulls its orders when it stops; start each market afresh, losing its place in the queue. */
export function resumeUsAfterRestart(state: RobotState): void {
  for (const acct of state.accounts) for (const hm of acct.markets as UsHeldMarket[]) {
    hm.quotes = NO_QUOTES;
    hm.lastSampleAt = null;
    hm.lastShares = null;
  }
}

/** Pay (or forfeit, if under $1) every period that has ended. */
export function settleUsPeriods(acct: AccountState, now: Date, log: Log): void {
  for (const [key, amount] of Object.entries(acct.rewardDays)) {
    const end = Date.parse(key.split("|")[0] ?? "");
    if (!Number.isFinite(end) || end > now.getTime()) continue;
    const r = settleRewardDay(amount);
    acct.cash = dec(acct.cash).plus(r.paid).toString();
    acct.rewardsPaid = dec(acct.rewardsPaid).plus(r.paid).toString();
    acct.rewardsForfeited = dec(acct.rewardsForfeited).plus(r.forfeited).toString();
    delete acct.rewardDays[key];
    const question = acct.markets.find((m) => key.includes(`|${m.conditionId}|`))?.question ?? acct.closed.find((c) => key.includes(`|${c.conditionId}|`))?.question ?? key.split("|")[1];
    log(acct.name, r.paid.gt(0)
      ? `Reward period ended in "${question}": $${r.paid.toFixed(2)} counted as paid. Estimated, not confirmed.`
      : `Reward period ended in "${question}": $${r.forfeited.toFixed(2)} earned but under the $1 minimum, so not counted.`);
  }
}

function stepUsMarket(acct: AccountState, hm: UsHeldMarket, cfg: UsRobotConfig, orderSize: number, book: UsBook, now: Date, log: Log) {
  const ts = Math.floor(now.getTime() / 1000);
  // 1. Fills since the last look, against the orders that were resting then.
  if (hm.quotes.bid || hm.quotes.ask) {
    const traded = book.sharesTraded !== null && hm.lastShares !== null ? Math.max(0, book.sharesTraded - hm.lastShares) : 0;
    const t = inferTradeFills(hm.quotes, { bid: hm.queueBid, ask: hm.queueAsk }, traded, book.lastTradePx, ts);
    hm.queueBid = t.queue.bid;
    hm.queueAsk = t.queue.ask;
    const c = crossFills(t.remaining, book, ts);
    for (const f of [...t.fills, ...c.fills]) recordFill(acct, hm, f, log);
  }
  if (book.sharesTraded !== null) hm.lastShares = book.sharesTraded;
  if (book.lastTradePx !== null) hm.lastPrice = book.lastTradePx;

  // 2. The period may have ended: move on to the next one for this market, or stop.
  if (hm.status === "quoting" && now.getTime() >= Date.parse(hm.periodEnd)) {
    leaveMarket(acct, hm, `its ${hm.program.period.replace("_", "-")} reward period ended`, now, log);
  }
  if (hm.status === "quoting" && !book.open) leaveMarket(acct, hm, "it stopped trading", now, log);

  // 3. Fresh orders at the best prices, and the reward they would be earning.
  if (hm.status === "quoting") {
    const prev = hm.quotes;
    const freeCash = Math.max(0, toNum(acct.cash) - reservedElsewhere(acct, hm));
    const q = joinBest(book, orderSize, Number(hm.yes), Number(hm.no), cfg.capLots, freeCash, cfg.maxSpreadToQuote);
    // Staying at the same price keeps our place in line; a new price puts us behind everyone already there.
    if (q.bid && !(prev.bid && Math.abs(prev.bid.price - q.bid.price) < EPS)) hm.queueBid = sizeAt(book.bids, q.bid.price);
    if (q.ask && !(prev.ask && Math.abs(prev.ask.price - q.ask.price) < EPS)) hm.queueAsk = sizeAt(book.asks, q.ask.price);
    hm.quotes = q;
    const ev = evaluateUsQuotes(book, q, hm.program, hm.tick);
    const elapsed = hm.lastSampleAt ? Math.min(2 * cfg.cycleSeconds, Math.max(0, (now.getTime() - Date.parse(hm.lastSampleAt)) / 1000)) : cfg.cycleSeconds;
    const periodSeconds = Math.max(60, (Date.parse(hm.periodEnd) - Date.parse(hm.periodStart)) / 1000);
    const accrual = dec(hm.program.pool).div(periodSeconds).times(ev.share).times(elapsed);
    hm.rewardToday = dec(hm.rewardToday).plus(accrual).toString();
    hm.rewardTotal = dec(hm.rewardTotal).plus(accrual).toString();
    acct.rewardDays[periodKey(hm)] = dec(acct.rewardDays[periodKey(hm)] ?? 0).plus(accrual).toString();
    hm.share = ev.share;
    hm.shareSum += ev.share;
    hm.samples += 1;
    hm.scanShareSum += ev.share;
    hm.scanSamples += 1;
    hm.lastSampleAt = now.toISOString();
  } else {
    hm.quotes = NO_QUOTES;
  }
  const bb = book.bids[0]?.price;
  const ba = book.asks[0]?.price;
  hm.mark = bb !== undefined && ba !== undefined ? (bb + ba) / 2 : hm.lastPrice ?? hm.mark;
}

export async function runUsCycle(state: RobotState, cfg: UsRobotConfig, api: UsApi, now: Date): Promise<void> {
  const log = logger(state, now);
  const books = new Map<string, Promise<UsBook | null>>();
  const load = (slug: string) => {
    let p = books.get(slug);
    if (!p) {
      p = api.book(slug);
      books.set(slug, p);
    }
    return p;
  };
  for (const [i, acct] of state.accounts.entries()) {
    settleUsPeriods(acct, now, log);
    const orderSize = cfg.accounts[i]?.orderSize ?? 20;
    for (const hm of [...acct.markets] as UsHeldMarket[]) {
      if (hm.status !== "quoting") continue;
      try {
        const book = await load(hm.conditionId);
        if (!book) throw new Error("no order book");
        stepUsMarket(acct, hm, cfg, orderSize, book, now, log);
      } catch (err) {
        hm.quotes = NO_QUOTES;
        state.lastError = `${now.toISOString()} ${hm.question}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      }
    }
  }
  state.cycles += 1;
  state.updatedAt = now.toISOString();
}

// ---- choosing markets ----

export interface UsCandidate {
  market: UsRewardMarket;
  program: UsProgram;
  window: { start: Date; end: Date };
  share: number;
  /** Reward for the rest of the period if the book stayed as it is now. */
  expected: number;
  capital: number;
  orderSize: number;
}

export interface UsScanResult {
  at: Date;
  bySize: Map<number, UsCandidate[]>;
  open: Set<string>;
  /** Latest programme terms per market, so held markets pick up changes (and the pool split). */
  programs: Map<string, UsProgram[]>;
  poolsSeen: NonNullable<RobotState["poolsSeen"]>;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

export async function gatherUsScan(cfg: UsRobotConfig, api: UsApi, now: Date): Promise<UsScanResult> {
  const markets = await api.rewardMarkets();
  const inWindow: { market: UsRewardMarket; program: UsProgram; window: { start: Date; end: Date } }[] = [];
  for (const market of markets) {
    for (const program of market.programs) {
      if (!cfg.periods.includes(program.period)) continue;
      const w = periodWindow(program.period, market.eventStart, now, cfg.liveHours);
      if (!w || now < w.start || w.end.getTime() - now.getTime() < cfg.minMinutesLeft * 60_000) continue;
      inWindow.push({ market, program, window: w });
    }
  }
  const remainingPool = (c: (typeof inWindow)[number]) => c.program.pool * (c.window.end.getTime() - now.getTime()) / (c.window.end.getTime() - c.window.start.getTime());
  const shortlist = [...inWindow].sort((a, b) => remainingPool(b) - remainingPool(a)).slice(0, cfg.evaluateTop);
  const sizes = [...new Set(cfg.accounts.map((a) => a.orderSize))];
  const bySize = new Map<number, UsCandidate[]>(sizes.map((s) => [s, []]));
  let strong = 0;
  let strongPool = 0;
  await mapLimit(shortlist, 4, async (c) => {
    try {
      const book = await api.book(c.market.slug);
      if (!book || !book.open) return;
      let countedStrong = false;
      for (const size of sizes) {
        const q = joinBest(book, size, 0, 0, cfg.capLots, Infinity, cfg.maxSpreadToQuote);
        if (!q.bid || !q.ask) continue;
        const share = evaluateUsQuotes(book, q, c.program, 0.01).share;
        const expected = remainingPool(c) * share;
        bySize.get(size)?.push({ market: c.market, program: c.program, window: c.window, share, expected, capital: quoteCapital(q, 0), orderSize: size });
        if (share >= 0.5 && !countedStrong) { strong++; strongPool += c.program.pool; countedStrong = true; }
      }
    } catch {
      // One unreadable book is one fewer candidate.
    }
  });
  // A period paying us under $1 pays nothing, so it is not worth a slot.
  for (const [size, list] of bySize) bySize.set(size, list.filter((c) => c.expected >= 1).sort((a, b) => b.expected / b.capital - a.expected / a.capital));
  return {
    at: now,
    bySize,
    open: new Set(markets.map((m) => m.slug)),
    programs: new Map(markets.map((m) => [m.slug, m.programs])),
    poolsSeen: { markets: inWindow.length, dailyTotal: inWindow.reduce((s, c) => s + c.program.pool, 0), eligible: shortlist.length, uncontested: strong, uncontestedDaily: strongPool },
  };
}

function joinUsMarket(acct: AccountState, c: UsCandidate, info: UsMarketInfo, now: Date, log: Log) {
  const m: UsHeldMarket = {
    conditionId: c.market.slug, marketId: c.market.slug, question: info.question, eventSlug: gameKeyOf(c.market.slug), yesTokenId: c.market.slug,
    endDate: c.window.end.toISOString(), tick: info.tick, minSize: c.orderSize, maxSpread: c.program.maxSpread ?? 0, dailyRate: c.program.pool,
    status: "quoting", joinedAt: now.toISOString(), leftAt: null, leftReason: null,
    quotes: NO_QUOTES, lastTradeTs: 0, seenTrades: [], lastPrice: null, lastSampleAt: null,
    yes: "0", no: "0", cashFlow: "0", fills: 0,
    rewardTotal: "0", rewardDay: c.window.end.toISOString(), rewardToday: "0", share: 0, shareSum: 0, samples: 0, scanShareSum: 0, scanSamples: 0, lowShareScans: 0,
    mark: null,
    program: c.program, periodStart: c.window.start.toISOString(), periodEnd: c.window.end.toISOString(), eventStart: c.market.eventStart?.toISOString() ?? null,
    gameKey: gameKeyOf(c.market.slug), queueBid: 0, queueAsk: 0, lastShares: null,
  };
  acct.markets.push(m);
  const label = c.program.period === "day_of" ? "pre-game" : c.program.period === "live" ? "in-game" : "daily";
  const pot = c.program.sharedBy && c.program.sharedBy > 1 ? `${label} pot $${(c.program.programPool ?? c.program.pool).toFixed(0)} shared by ${c.program.sharedBy} markets, about $${c.program.pool.toFixed(2)} for this one` : `${label} pool $${c.program.pool.toFixed(2)}`;
  log(acct.name, `Joined "${info.question}" (${pot}): ${c.orderSize} contracts at the best bid and offer would take about ${(c.share * 100).toFixed(0)}% of it, about $${c.expected.toFixed(2)} for the rest of the period, tying up $${c.capital.toFixed(2)}.`);
}

export async function applyUsScan(state: RobotState, cfg: UsRobotConfig, api: UsApi, scan: UsScanResult, now: Date): Promise<void> {
  const log = logger(state, now);
  for (const [i, acct] of state.accounts.entries()) {
    const ac = cfg.accounts[i];
    if (!ac) continue;
    // Leftover contracts are held to settlement.
    for (const hm of [...acct.markets] as UsHeldMarket[]) {
      if (hm.status === "quoting") {
        const latest = scan.programs.get(hm.conditionId)?.find((p) => p.programId === hm.program.programId);
        if (latest) {
          hm.program = latest;
          hm.dailyRate = latest.pool;
        }
        if (!scan.open.has(hm.conditionId)) leaveMarket(acct, hm, "its reward programme ended", now, log);
        else if (hm.scanSamples > 0) {
          hm.lowShareScans = hm.scanShareSum / hm.scanSamples < 0.02 ? hm.lowShareScans + 1 : 0;
          if (hm.lowShareScans >= 3) leaveMarket(acct, hm, "it kept earning almost nothing", now, log);
        }
        hm.scanShareSum = 0;
        hm.scanSamples = 0;
      }
      if (hm.status === "holding" && hm.leftAt && !isFlat(hm)) {
        const payout = await api.settlement(hm.conditionId).catch(() => null);
        if (payout !== null) settleMarket(acct, hm, payout, now, log);
      }
    }
    const slots = Math.max(1, Math.floor(ac.startingCash / (ac.orderSize * cfg.budgetPerContract)));
    for (const c of scan.bySize.get(ac.orderSize) ?? []) {
      const quoting = acct.markets.filter((m) => m.status === "quoting") as UsHeldMarket[];
      if (quoting.length >= slots) break;
      if (acct.markets.some((m) => m.conditionId === c.market.slug)) continue;
      if (quoting.filter((m) => m.gameKey === gameKeyOf(c.market.slug)).length >= cfg.maxPerGame) continue;
      const free = toNum(acct.cash) - acct.markets.reduce((s, m) => s + quoteCapital(m.quotes, Number(m.yes)), 0);
      if (free < c.capital) continue;
      const info = await api.market(c.market.slug).catch(() => null);
      if (!info || !info.open) continue;
      joinUsMarket(acct, c, info, now, log);
    }
  }
  const first = scan.bySize.get(cfg.accounts[0]?.orderSize ?? 20) ?? [];
  state.candidates = first.slice(0, 15).map((c) => ({ question: c.market.slug, dailyRate: c.program.pool, share: c.share, expectedDailyReward: c.expected, capital: c.capital, hoursLeft: (c.window.end.getTime() - now.getTime()) / H, volume24h: 0 }));
  state.poolsSeen = scan.poolsSeen;
  state.lastScanAt = now.toISOString();
}

/** Totals for a quick text summary. */
export function usPending(acct: AccountState): Dec {
  return Object.values(acct.rewardDays).reduce((s, v) => s.plus(v), ZERO);
}

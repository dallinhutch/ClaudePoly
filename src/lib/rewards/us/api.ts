import { z } from "zod";
import type { Level } from "../scoring";
import type { UsProgram } from "./scoring";

/**
 * Polymarket US public gateway (no key). Read-only: market list, incentive
 * programmes, books and settlements. Nothing here can place an order.
 */
const GATEWAY = "https://gateway.polymarket.us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string, attempts = 4): Promise<unknown> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${GATEWAY}${path}`, { headers: { accept: "application/json", "user-agent": "polytrader-paper/0.1" }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      lastErr = new Error(`Polymarket US ${res.status} for ${path}`);
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (err) {
      lastErr = err;
    }
    await sleep(600 * 2 ** i + Math.floor(Math.random() * 250));
  }
  throw lastErr;
}

const num = z.union([z.number(), z.string()]).nullish().transform((v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
});
const amount = z.object({ value: num }).passthrough().nullish().transform((a) => a?.value ?? null);

const PeriodSchema = z.object({
  programId: z.string(),
  programType: z.string(),
  status: z.string().nullish(),
  period: z.string(),
  rewardPool: num,
  discountFactor: num,
  targetSize: num,
  maxSpread: num,
}).passthrough();

const ProgramSchema = z.object({
  marketSlug: z.string(),
  instrumentState: z.string().nullish(),
  category: z.string().nullish(),
  subcategory: z.string().nullish(),
  eventStartTime: z.string().nullish(),
  timePeriods: z.array(z.unknown()).nullish(),
}).passthrough();

const ProgramPageSchema = z.object({ programs: z.array(z.unknown()), nextPageToken: z.string().nullish() });

export interface UsRewardMarket {
  slug: string;
  subcategory: string | null;
  /** Kick-off; the pre-game period is the 6 hours before it, the live period starts at it. */
  eventStart: Date | null;
  programs: UsProgram[];
}

/** "2026-10-15 00:00:00+00" and ISO strings both parse. */
export function parseUsTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const ms = Date.parse(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The API repeats a programme's pool on every market that carries it (379 player-prop
 * markets on one MLB playoff game all show the same $850), but it is one pot. Split it
 * evenly across the markets carrying the programme on the same day. Even is an
 * assumption: markets whose book misses Target Size may not take a slice, which would
 * make each slice somewhat bigger, but never anywhere near the whole pot.
 */
export function splitSharedPools(markets: UsRewardMarket[]): UsRewardMarket[] {
  const key = (m: UsRewardMarket, p: UsProgram) => `${p.programId}|${m.eventStart ? m.eventStart.toISOString().slice(0, 10) : "-"}`;
  const counts = new Map<string, number>();
  for (const m of markets) for (const p of m.programs) counts.set(key(m, p), (counts.get(key(m, p)) ?? 0) + 1);
  return markets.map((m) => ({
    ...m,
    programs: m.programs.map((p) => {
      const sharedBy = counts.get(key(m, p)) ?? 1;
      const programPool = p.programPool ?? p.pool;
      return { ...p, programPool, sharedBy, pool: programPool / sharedBy };
    }),
  }));
}

/** Every open market with an active liquidity programme, each pool already split across the markets sharing it. */
export async function fetchUsRewardMarkets(maxPages = 500): Promise<UsRewardMarket[]> {
  const out: UsRewardMarket[] = [];
  let token: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ page_size: "100", statuses: "active", program_type: "liquidityProgram", instrument_states: "INSTRUMENT_STATE_OPEN" });
    if (token) params.set("page_token", token);
    const parsed = ProgramPageSchema.safeParse(await getJson(`/v1/incentives?${params}`));
    if (!parsed.success) throw new Error(`unexpected incentives response: ${parsed.error.message.slice(0, 200)}`);
    for (const raw of parsed.data.programs) {
      const p = ProgramSchema.safeParse(raw);
      if (!p.success) continue;
      const programs: UsProgram[] = [];
      for (const rawPeriod of p.data.timePeriods ?? []) {
        const t = PeriodSchema.safeParse(rawPeriod);
        if (!t.success || t.data.programType !== "liquidityProgram" || (t.data.status && t.data.status !== "active")) continue;
        if (!t.data.rewardPool || !t.data.targetSize) continue;
        programs.push({ programId: t.data.programId, period: t.data.period, pool: t.data.rewardPool, discountFactor: t.data.discountFactor ?? 1, targetSize: t.data.targetSize, maxSpread: t.data.maxSpread });
      }
      if (programs.length) out.push({ slug: p.data.marketSlug, subcategory: p.data.subcategory ?? null, eventStart: parseUsTime(p.data.eventStartTime), programs });
    }
    token = parsed.data.nextPageToken ?? null;
    if (!token || parsed.data.programs.length === 0) break;
  }
  return splitSharedPools(out);
}

const LevelSchema = z.object({ px: amount, qty: num });
const BookSchema = z.object({
  marketData: z.object({
    bids: z.array(LevelSchema).nullish(),
    offers: z.array(LevelSchema).nullish(),
    state: z.string().nullish(),
    stats: z.object({ sharesTraded: num, lastTradePx: amount, lastTradeQty: num }).passthrough().nullish(),
  }).passthrough(),
});

export interface UsBook {
  bids: Level[];
  asks: Level[];
  open: boolean;
  /** Running total of contracts traded, used to tell that trades happened between looks. */
  sharesTraded: number | null;
  lastTradePx: number | null;
}

export async function fetchUsBook(slug: string): Promise<UsBook | null> {
  const parsed = BookSchema.safeParse(await getJson(`/v1/markets/${encodeURIComponent(slug)}/book`));
  if (!parsed.success) return null;
  const md = parsed.data.marketData;
  const levels = (side: { px: number | null; qty: number | null }[] | null | undefined) =>
    (side ?? []).filter((l) => l.px != null && l.qty != null && l.qty > 0).map((l) => ({ price: l.px as number, size: l.qty as number }));
  return {
    bids: levels(md.bids).sort((a, b) => b.price - a.price),
    asks: levels(md.offers).sort((a, b) => a.price - b.price),
    open: md.state == null || md.state === "MARKET_STATE_OPEN",
    sharesTraded: md.stats?.sharesTraded ?? null,
    lastTradePx: md.stats?.lastTradePx ?? null,
  };
}

const MarketSchema = z.object({
  market: z.object({
    question: z.string().nullish(),
    status: z.string().nullish(),
    closed: z.boolean().nullish(),
    orderPriceMinTickSize: num,
  }).passthrough(),
});

export interface UsMarketInfo {
  question: string;
  open: boolean;
  tick: number;
}

export async function fetchUsMarket(slug: string): Promise<UsMarketInfo | null> {
  const parsed = MarketSchema.safeParse(await getJson(`/v1/market/slug/${encodeURIComponent(slug)}`));
  if (!parsed.success) return null;
  const m = parsed.data.market;
  return { question: m.question ?? slug, open: m.closed !== true && (m.status == null || m.status === "MARKET_STATUS_OPEN"), tick: m.orderPriceMinTickSize ?? 0.01 };
}

/** What a YES contract paid, once the market has settled. */
export async function fetchUsSettlement(slug: string): Promise<number | null> {
  const raw = (await getJson(`/v1/markets/${encodeURIComponent(slug)}/settlement`)) as { settlement?: unknown } | null;
  const v = raw && raw.settlement != null ? Number(raw.settlement) : NaN;
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

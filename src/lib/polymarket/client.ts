import { z } from "zod";

/**
 * Read-only Polymarket public data client (Gamma metadata API + CLOB order books).
 * No API keys, no wallet, no order placement — this project never trades real money.
 */
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

/** Gamma encodes several array fields as JSON strings. */
const jsonStringArray = z
  .union([z.string(), z.array(z.string())])
  .nullish()
  .transform((v) => {
    if (v == null || v === "") return [] as string[];
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  });

const numish = z.union([z.number(), z.string()]).nullish().transform((v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? String(v) : null;
});

export const FeeScheduleSchema = z.object({
  exponent: z.number(),
  rate: z.number(),
  takerOnly: z.boolean().optional(),
  rebateRate: z.number().optional(),
}).passthrough();
export type FeeSchedule = z.infer<typeof FeeScheduleSchema>;

export const GammaTagSchema = z.object({ id: z.string().optional(), label: z.string().nullish(), slug: z.string().nullish() });

export const GammaMarketSchema = z.object({
  id: z.string(),
  conditionId: z.string(),
  question: z.string(),
  slug: z.string().nullish(),
  description: z.string().nullish(),
  resolutionSource: z.string().nullish(),
  groupItemTitle: z.string().nullish(),
  category: z.string().nullish(),
  outcomes: jsonStringArray,
  outcomePrices: jsonStringArray,
  clobTokenIds: jsonStringArray,
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  closedTime: z.string().nullish(),
  active: z.boolean().nullish(),
  closed: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  acceptingOrders: z.boolean().nullish(),
  enableOrderBook: z.boolean().nullish(),
  negRisk: z.boolean().nullish(),
  bestBid: numish,
  bestAsk: numish,
  lastTradePrice: numish,
  spread: numish,
  liquidityNum: numish,
  liquidity: numish,
  volumeNum: numish,
  volume24hr: numish,
  feesEnabled: z.boolean().nullish(),
  feeSchedule: FeeScheduleSchema.nullish().catch(null),
  orderPriceMinTickSize: numish,
  orderMinSize: numish,
  umaResolutionStatus: z.string().nullish(),
  automaticallyResolved: z.boolean().nullish(),
  events: z.array(z.object({ id: z.string() }).passthrough()).nullish(),
}).passthrough();
export type GammaMarket = z.infer<typeof GammaMarketSchema>;

export const GammaEventSchema = z.object({
  id: z.string(),
  slug: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  endDate: z.string().nullish(),
  active: z.boolean().nullish(),
  closed: z.boolean().nullish(),
  negRisk: z.boolean().nullish(),
  tags: z.array(GammaTagSchema).nullish(),
});
/** Nested markets are parsed individually so one malformed market can't drop its event. */
export type GammaEvent = z.infer<typeof GammaEventSchema> & { markets: GammaMarket[] };

const BookLevelSchema = z.object({ price: z.string(), size: z.string() });
export const OrderBookSchema = z.object({
  market: z.string().nullish(),
  asset_id: z.string(),
  timestamp: z.string().nullish(),
  hash: z.string().nullish(),
  bids: z.array(BookLevelSchema),
  asks: z.array(BookLevelSchema),
}).passthrough();
export type OrderBook = z.infer<typeof OrderBookSchema>;

export class PolymarketHttpError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`Polymarket ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit, attempts = 4): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { accept: "application/json", "user-agent": "polytrader-paper/0.1", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return await res.json();
      const body = await res.text();
      const err = new PolymarketHttpError(res.status, url, body);
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
    } catch (err) {
      if (err instanceof PolymarketHttpError && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
    }
    await sleep(500 * 2 ** i + Math.floor(Math.random() * 250));
  }
  throw lastErr;
}

function parseMarkets(raw: unknown[]): GammaMarket[] {
  const out: GammaMarket[] = [];
  for (const m of raw) {
    const parsed = GammaMarketSchema.safeParse(m);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const KeysetEventsSchema = z.object({ events: z.array(z.unknown()), next_cursor: z.string().nullish() });

/**
 * Page through active, open events (each with nested markets + tags). Uses the
 * keyset endpoint: offset paging is capped at 2,000 rows by the API. An optional
 * end-date window keeps short-horizon scans small.
 */
export async function* fetchActiveEvents(opts: { endDateMin?: Date; endDateMax?: Date; pageSize?: number; maxPages?: number } = {}): AsyncGenerator<GammaEvent[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 500;
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ active: "true", closed: "false", limit: String(pageSize) });
    if (opts.endDateMin) params.set("end_date_min", opts.endDateMin.toISOString());
    if (opts.endDateMax) params.set("end_date_max", opts.endDateMax.toISOString());
    if (cursor) params.set("after_cursor", cursor);
    const parsedPage = KeysetEventsSchema.safeParse(await getJson(`${GAMMA}/events/keyset?${params}`));
    if (!parsedPage.success) throw new Error(`unexpected keyset response: ${parsedPage.error.message.slice(0, 200)}`);
    const events: GammaEvent[] = [];
    for (const e of parsedPage.data.events) {
      const parsed = GammaEventSchema.safeParse(e);
      if (!parsed.success) continue;
      const rawMarkets = (e as { markets?: unknown }).markets;
      events.push({ ...parsed.data, markets: parseMarkets(Array.isArray(rawMarkets) ? rawMarkets : []) });
    }
    if (events.length > 0) yield events;
    cursor = parsedPage.data.next_cursor ?? null;
    if (!cursor || parsedPage.data.events.length === 0) return;
  }
}

export async function fetchMarket(marketId: string): Promise<GammaMarket | null> {
  try {
    const data = await getJson(`${GAMMA}/markets/${encodeURIComponent(marketId)}`);
    const parsed = GammaMarketSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    if (err instanceof PolymarketHttpError && err.status === 404) return null;
    throw err;
  }
}

export async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  const data = await getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  return OrderBookSchema.parse(data);
}

/** Levels sorted best-first: asks ascending, bids descending. The API does not guarantee order. */
export function normalizeBook(book: OrderBook): OrderBook {
  const byPrice = (a: { price: string }, b: { price: string }) => Number(a.price) - Number(b.price);
  return {
    ...book,
    asks: [...book.asks].filter((l) => Number(l.size) > 0).sort(byPrice),
    bids: [...book.bids].filter((l) => Number(l.size) > 0).sort((a, b) => byPrice(b, a)),
  };
}

import { z } from "zod";
import { getJson } from "@/lib/polymarket/client";
import type { PublicTrade } from "./fills";

/**
 * Read-only public endpoints for the liquidity-rewards programme and the trade
 * feed. Nothing here can place, change or cancel an order.
 */
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";

const num = z.union([z.number(), z.string()]).nullish().transform((v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
});

const RewardRowSchema = z.object({
  condition_id: z.string(),
  market_id: z.union([z.string(), z.number()]).transform(String),
  question: z.string().nullish(),
  event_slug: z.string().nullish(),
  market_competitiveness: num,
  rewards_config: z.array(z.object({ rate_per_day: num }).passthrough()).nullish(),
  rewards_max_spread: num,
  rewards_min_size: num,
  spread: num,
  volume_24hr: num,
  end_date: z.string().nullish(),
  tokens: z.array(z.object({ token_id: z.string(), price: num }).passthrough()),
}).passthrough();

const RewardPageSchema = z.object({ data: z.array(z.unknown()), next_cursor: z.string().nullish() });

/** One market that currently has a daily reward pool. Prices and spreads are in dollars (0.045 = 4.5c). */
export interface RewardMarket {
  conditionId: string;
  marketId: string;
  question: string;
  eventSlug: string | null;
  /** Dollars shared out per UTC day among qualifying resting orders. */
  dailyRate: number;
  /** Smallest order, in shares, that counts. */
  minSize: number;
  /** Orders further than this from the midpoint do not count. */
  maxSpread: number;
  /** Polymarket's own measure of how much qualifying liquidity is already there; 0 = none. */
  competitiveness: number;
  spread: number | null;
  volume24h: number;
  endDate: string | null;
  yesTokenId: string;
  yesPrice: number | null;
}

const END_CURSOR = "LTE=";

/**
 * Every market whose pool pays at least `minDailyRate`. The endpoint returns
 * pools largest-first, so paging stops at the first page that is entirely below
 * the threshold.
 */
export async function fetchRewardMarkets(minDailyRate: number, maxPages = 400): Promise<RewardMarket[]> {
  const out: RewardMarket[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ order_by: "rate_per_day", position: "DESC" });
    if (cursor) params.set("next_cursor", cursor);
    const parsedPage = RewardPageSchema.safeParse(await getJson(`${CLOB}/rewards/markets/multi?${params}`));
    if (!parsedPage.success) throw new Error(`unexpected rewards response: ${parsedPage.error.message.slice(0, 200)}`);
    let pageMax = 0;
    for (const raw of parsedPage.data.data) {
      const row = RewardRowSchema.safeParse(raw);
      if (!row.success) continue;
      const r = row.data;
      const dailyRate = (r.rewards_config ?? []).reduce((s, c) => s + (c.rate_per_day ?? 0), 0);
      pageMax = Math.max(pageMax, dailyRate);
      const yes = r.tokens[0];
      if (dailyRate < minDailyRate || !yes || r.rewards_min_size == null || r.rewards_max_spread == null) continue;
      out.push({
        conditionId: r.condition_id,
        marketId: r.market_id,
        question: r.question ?? r.condition_id,
        eventSlug: r.event_slug ?? null,
        dailyRate,
        minSize: r.rewards_min_size,
        maxSpread: r.rewards_max_spread / 100,
        competitiveness: r.market_competitiveness ?? 0,
        spread: r.spread,
        volume24h: r.volume_24hr ?? 0,
        endDate: r.end_date ?? null,
        yesTokenId: yes.token_id,
        yesPrice: yes.price,
      });
    }
    cursor = parsedPage.data.next_cursor ?? null;
    if (!cursor || cursor === END_CURSOR || parsedPage.data.data.length === 0 || pageMax < minDailyRate) break;
  }
  return out;
}

const TradeSchema = z.object({
  side: z.enum(["BUY", "SELL"]),
  size: num,
  price: num,
  timestamp: num,
  outcomeIndex: num,
  transactionHash: z.string().nullish(),
  asset: z.string().nullish(),
  proxyWallet: z.string().nullish(),
}).passthrough();

/** The most recent taker trades in a market, oldest first. */
export async function fetchRecentTrades(conditionId: string, limit = 200): Promise<PublicTrade[]> {
  const raw = await getJson(`${DATA}/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}`);
  if (!Array.isArray(raw)) return [];
  const out: PublicTrade[] = [];
  for (const row of raw) {
    const t = TradeSchema.safeParse(row);
    if (!t.success) continue;
    const { size, price, timestamp, outcomeIndex } = t.data;
    if (size == null || price == null || timestamp == null || outcomeIndex == null || size <= 0 || price <= 0 || price >= 1) continue;
    out.push({
      key: [t.data.transactionHash, t.data.asset, t.data.proxyWallet, size, price].join(":"),
      timestamp,
      outcomeIndex,
      side: t.data.side,
      price,
      size,
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

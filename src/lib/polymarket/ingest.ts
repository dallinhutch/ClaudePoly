import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import { marketPriceHistory, markets, polymarketEvents } from "@/db/schema";
import { fetchActiveEvents, type GammaEvent, type GammaMarket } from "./client";

type MarketInsert = typeof markets.$inferInsert;
type EventInsert = typeof polymarketEvents.$inferInsert;

const CATEGORY_PRIORITY = [
  "Elections", "Politics", "Geopolitics", "Economy", "Finance", "Business", "Tech", "Science",
  "Health", "Weather", "Crypto", "Sports", "Culture", "World",
];

export function deriveCategory(tags: string[]): string | null {
  for (const c of CATEGORY_PRIORITY) if (tags.some((t) => t.toLowerCase() === c.toLowerCase())) return c;
  return tags[0] ?? null;
}

const parseDate = (v: string | null | undefined) => {
  if (!v) return null;
  const d = new Date(v.includes("T") || v.includes("+") ? v : `${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const price = (v: string | null | undefined) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? v : null;
};

export function mapEvent(e: GammaEvent, now: Date): EventInsert {
  return {
    id: e.id,
    slug: e.slug ?? null,
    title: e.title,
    description: e.description ?? null,
    tags: (e.tags ?? []).map((t) => t.label).filter((l): l is string => !!l),
    negRisk: e.negRisk ?? false,
    endDate: parseDate(e.endDate),
    active: e.active ?? false,
    closed: e.closed ?? false,
    updatedAt: now,
  };
}

/**
 * Map a Gamma market to our row. Only binary two-token markets are stored.
 * Outcome index 0 is our "YES" side and index 1 our "NO" side; the real outcome
 * labels are kept in `outcomes` for display and for analyst prompts.
 */
export function mapMarket(m: GammaMarket, event: GammaEvent | null, now: Date): MarketInsert | null {
  if (m.outcomes.length !== 2 || m.clobTokenIds.length !== 2) return null;
  const tags = event ? (event.tags ?? []).map((t) => t.label).filter((l): l is string => !!l) : [];
  const { description: _omit, events: _events, ...rawRest } = m;
  return {
    id: m.id,
    conditionId: m.conditionId,
    eventId: event?.id ?? null,
    slug: m.slug ?? null,
    question: m.question,
    groupItemTitle: m.groupItemTitle || null,
    description: m.description ?? event?.description ?? null,
    resolutionSource: m.resolutionSource || null,
    category: m.category || deriveCategory(tags),
    tags,
    outcomes: m.outcomes,
    yesTokenId: m.clobTokenIds[0] ?? null,
    noTokenId: m.clobTokenIds[1] ?? null,
    startDate: parseDate(m.startDate),
    endDate: parseDate(m.endDate) ?? parseDate(event?.endDate),
    active: m.active ?? false,
    closed: m.closed ?? false,
    acceptingOrders: m.acceptingOrders ?? false,
    enableOrderBook: m.enableOrderBook ?? false,
    negRisk: m.negRisk ?? event?.negRisk ?? false,
    yesPrice: price(m.outcomePrices[0]),
    noPrice: price(m.outcomePrices[1]),
    bestBid: price(m.bestBid),
    bestAsk: price(m.bestAsk),
    lastTradePrice: price(m.lastTradePrice),
    spread: price(m.spread),
    liquidityUsd: m.liquidityNum ?? m.liquidity ?? null,
    volumeUsd: m.volumeNum ?? null,
    volume24hUsd: m.volume24hr ?? null,
    feesEnabled: m.feesEnabled ?? false,
    feeSchedule: m.feeSchedule ?? null,
    minTickSize: m.orderPriceMinTickSize ?? null,
    minOrderSize: m.orderMinSize ?? null,
    umaResolutionStatus: m.umaResolutionStatus ?? null,
    updatedAt: now,
    raw: rawRest,
  };
}

/** `SET col = excluded.col` for every column except the ones listed. */
function excludedSet(table: PgTable, skip: string[]): Record<string, SQL> {
  const cols = getTableColumns(table);
  return Object.fromEntries(
    Object.entries(cols).filter(([key]) => !skip.includes(key)).map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function historyRowFor(row: MarketInsert, now: Date): typeof marketPriceHistory.$inferInsert {
  return {
    marketId: row.id,
    observedAt: now,
    source: "gamma",
    yesPrice: row.yesPrice,
    noPrice: row.noPrice,
    bestBid: row.bestBid,
    bestAsk: row.bestAsk,
    lastTradePrice: row.lastTradePrice,
    spread: row.spread,
    liquidityUsd: row.liquidityUsd,
    volume24hUsd: row.volume24hUsd,
  };
}

export async function upsertMarkets(db: Db, rows: MarketInsert[]) {
  for (const part of chunk(rows, 200)) {
    await db.insert(markets).values(part).onConflictDoUpdate({ target: markets.id, set: excludedSet(markets, ["id", "firstSeenAt"]) });
  }
}

/**
 * Full scan of active Polymarket events/markets. Upserts metadata + latest
 * prices, and appends a price observation for markets liquid enough to matter.
 */
export async function ingestActiveMarkets(db: Db, opts: { historyMinLiquidityUsd: number; now?: () => Date }) {
  const clock = opts.now ?? (() => new Date());
  const stats = { pages: 0, events: 0, markets: 0, skippedNonBinary: 0, historyRows: 0 };

  for await (const page of fetchActiveEvents()) {
    const now = clock();
    stats.pages++;
    const eventRows = page.map((e) => mapEvent(e, now));
    for (const part of chunk(eventRows, 200)) {
      await db.insert(polymarketEvents).values(part).onConflictDoUpdate({ target: polymarketEvents.id, set: excludedSet(polymarketEvents, ["id", "firstSeenAt"]) });
    }
    stats.events += eventRows.length;

    const marketRows: MarketInsert[] = [];
    const seen = new Set<string>();
    for (const e of page) {
      for (const m of e.markets) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const row = mapMarket(m, e, now);
        if (row) marketRows.push(row);
        else stats.skippedNonBinary++;
      }
    }
    await upsertMarkets(db, marketRows);
    stats.markets += marketRows.length;

    const history = marketRows
      .filter((r) => r.active && !r.closed && Number(r.liquidityUsd ?? 0) >= opts.historyMinLiquidityUsd)
      .map((r) => historyRowFor(r, now));
    for (const part of chunk(history, 500)) await db.insert(marketPriceHistory).values(part);
    stats.historyRows += history.length;
  }
  return stats;
}

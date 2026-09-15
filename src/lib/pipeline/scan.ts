import { and, eq, gte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { markets, screeningResults } from "@/db/schema";
import { ingestActiveMarkets } from "@/lib/polymarket/ingest";
import { screenMarket } from "@/lib/screening/screen";
import { getActiveStrategy } from "@/lib/strategy/service";

/** Normalize a rejection reason into a countable bucket ("liquidity # < #"). */
const reasonBucket = (r: string) => r.replace(/"[^"]*"/g, '"…"').replace(/-?\d+(\.\d+)?[a-z]?/gi, "#");

/**
 * Stage 1: refresh every active market from Polymarket, then screen the ones
 * that were just refreshed. Passing markets are stored (append-only);
 * rejections are summarized as counts to keep the table small.
 */
export async function scanAndScreen(db: Db) {
  const strategy = await getActiveStrategy(db);
  const cfg = strategy.config.screening;
  const scanStartedAt = new Date();
  // Only events that can pass the time-to-resolution screen are fetched (plus a day of slack).
  const endDateMax = new Date(Date.now() + (cfg.maxDaysToResolution + 1) * 86_400_000);
  const ingest = await ingestActiveMarkets(db, { historyMinLiquidityUsd: cfg.minLiquidityUsd, endDateMax });

  const fresh = await db.select().from(markets)
    .where(and(eq(markets.active, true), eq(markets.closed, false), gte(markets.updatedAt, scanStartedAt)));
  const now = new Date();
  const rejections = new Map<string, number>();
  const passed: Array<typeof screeningResults.$inferInsert> = [];
  for (const m of fresh) {
    const r = screenMarket(m, cfg, now);
    if (r.passed) {
      passed.push({ marketId: m.id, strategyVersionId: strategy.id, score: r.score.toFixed(6), passed: true, reasons: [], features: r.features });
    } else {
      for (const reason of r.reasons) rejections.set(reasonBucket(reason), (rejections.get(reasonBucket(reason)) ?? 0) + 1);
    }
  }
  for (let i = 0; i < passed.length; i += 500) await db.insert(screeningResults).values(passed.slice(i, i + 500));

  return {
    ...ingest,
    screened: fresh.length,
    passed: passed.length,
    rejected: fresh.length - passed.length,
    topRejectionReasons: [...rejections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
    strategyVersion: strategy.version,
  };
}

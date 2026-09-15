import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { marketResolutions, markets, positions, positionUpdates, probabilityEstimates } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { dec, toDb } from "@/lib/decimal";
import { fetchMarket } from "@/lib/polymarket/client";
import { finalPayouts } from "@/lib/polymarket/resolution";
import { appendLedgerEntry, LOCK_KEYS } from "./ledger";
import { stateFromRow } from "./portfolio";
import { applyResolution } from "./positionMath";

const priceOrNull = (v: string | undefined) => (v != null && Number.isFinite(Number(v)) ? v : null);

/**
 * Check markets we hold or have forecast for real Polymarket resolutions,
 * record the outcome (append-only), and settle any open positions at the
 * actual payout.
 */
export async function settleResolvedMarkets(db: Db, opts: { maxMarkets?: number } = {}) {
  const now = new Date();
  const held = await db.selectDistinct({ id: positions.marketId }).from(positions).where(eq(positions.status, "OPEN"));
  const forecastPastEnd = await db
    .selectDistinct({ id: probabilityEstimates.marketId })
    .from(probabilityEstimates)
    .innerJoin(markets, eq(markets.id, probabilityEstimates.marketId))
    .leftJoin(marketResolutions, eq(marketResolutions.marketId, probabilityEstimates.marketId))
    .where(and(isNull(marketResolutions.id), lte(markets.endDate, now)))
    .limit(opts.maxMarkets ?? 200);
  const ids = [...new Set([...held, ...forecastPastEnd].map((r) => r.id))];
  const stats = { checked: 0, newlyResolved: 0, positionsSettled: 0 };

  for (const marketId of ids) {
    stats.checked++;
    const gm = await fetchMarket(marketId);
    if (!gm) continue;
    await db.update(markets).set({
      active: gm.active ?? false,
      closed: gm.closed ?? false,
      acceptingOrders: gm.acceptingOrders ?? false,
      yesPrice: priceOrNull(gm.outcomePrices[0]),
      noPrice: priceOrNull(gm.outcomePrices[1]),
      umaResolutionStatus: gm.umaResolutionStatus ?? null,
      updatedAt: now,
    }).where(eq(markets.id, marketId));

    const payouts = finalPayouts(gm);
    const [existing] = await db.select().from(marketResolutions).where(eq(marketResolutions.marketId, marketId)).limit(1);
    if (!payouts && !existing) continue;

    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEYS.trading})`);
      let resolution = existing;
      if (!resolution && payouts) {
        const { description: _d, events: _e, ...raw } = gm;
        const [inserted] = await tx.insert(marketResolutions).values({
          marketId,
          closedTime: gm.closedTime ? new Date(gm.closedTime) : null,
          payoutYes: payouts.payoutYes,
          payoutNo: payouts.payoutNo,
          winningSide: payouts.winningSide,
          umaResolutionStatus: gm.umaResolutionStatus ?? null,
          raw,
        }).onConflictDoNothing({ target: marketResolutions.marketId }).returning();
        resolution = inserted ?? (await tx.select().from(marketResolutions).where(eq(marketResolutions.marketId, marketId)).limit(1))[0];
        if (inserted) {
          stats.newlyResolved++;
          await recordAudit(tx, "market.resolved", "market", marketId, { question: gm.question, payouts, closedTime: gm.closedTime ?? null });
        }
      }
      if (!resolution) return;

      const open = await tx.select().from(positions).where(and(eq(positions.marketId, marketId), eq(positions.status, "OPEN")));
      for (const p of open) {
        const payout = p.side === "YES" ? resolution.payoutYes : resolution.payoutNo;
        const before = stateFromRow(p);
        const { next, cashDelta, realizedDelta } = applyResolution(before, payout);
        await tx.update(positions).set({
          status: "RESOLVED", shares: toDb(next.shares), costBasis: toDb(next.costBasis), realizedPnl: toDb(next.realizedPnl),
          closedAt: now, recommendation: "RESOLVE", lastMarkPrice: toDb(payout), lastMarkedAt: now, updatedAt: now,
        }).where(eq(positions.id, p.id));
        await appendLedgerEntry(tx, {
          entryType: "RESOLUTION_PAYOUT", amount: cashDelta, positionId: p.id, resolutionId: resolution.id,
          memo: `Resolution payout ${dec(payout).toFixed(2)}/share × ${before.shares.toFixed(2)} ${p.side}`,
        });
        await tx.insert(positionUpdates).values({
          positionId: p.id, action: "RESOLVE", marketBid: toDb(payout),
          sharesBefore: toDb(before.shares), sharesAfter: "0", costBasisBefore: toDb(before.costBasis), costBasisAfter: "0",
          realizedPnlDelta: toDb(realizedDelta),
          reasoning: `Market resolved: YES pays ${resolution.payoutYes}, NO pays ${resolution.payoutNo}. Position ${p.side} ${realizedDelta.gte(0) ? "won" : "lost"} ${realizedDelta.abs().toFixed(2)}.`,
        });
        await recordAudit(tx, "position.resolved", "position", p.id, { marketId, side: p.side, payout, cashDelta, realizedDelta });
        stats.positionsSettled++;
      }
    });
  }
  return stats;
}

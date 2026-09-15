/**
 * Run stage-3 deep research on one specific market, then let the normal entry
 * engine decide (qualification, sizing, paper fill against the live book).
 * Uses the same budget caps and audit trail as the worker.
 *   npx tsx scripts/research-market.ts <marketId> "why this market"
 */
import { getDb, getPool } from "@/db/client";
import { runStage3 } from "@/lib/research/runner";
import { getActiveStrategy } from "@/lib/strategy/service";
import { evaluateEntry } from "@/lib/trading/engine";

async function main() {
  const [marketId, ...reason] = process.argv.slice(2);
  if (!marketId) throw new Error('usage: npx tsx scripts/research-market.ts <marketId> "reason"');
  const db = getDb();
  const strategy = await getActiveStrategy(db);
  const est = await runStage3(db, strategy, marketId, { trigger: `manual: ${reason.join(" ") || "operator request"}`.slice(0, 200) });
  console.log("estimate", JSON.stringify({
    runId: est.runId, estimateId: est.estimateId, probabilityYes: est.probabilityYes.toFixed(4), confidence: est.confidence.toFixed(4),
    bestSide: est.bestSide, bestEdge: est.bestEdge?.toFixed(4) ?? null, costUsd: est.costUsd.toFixed(4),
  }));
  const outcome = await evaluateEntry(db, est.estimateId);
  if (outcome.decision === "TRADE") {
    console.log("decision TRADE", JSON.stringify({ positionId: outcome.positionId, status: outcome.fill.status, shares: outcome.fill.filledShares.toFixed(2), allInPrice: outcome.fill.allInPrice?.toFixed(4), cost: outcome.fill.notional.plus(outcome.fill.fees).toFixed(2) }));
  } else if (outcome.decision === "NO_TRADE") {
    console.log("decision NO_TRADE", JSON.stringify(outcome.reasons));
  } else {
    console.log("decision SKIPPED", outcome.reason);
  }
  await getPool().end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

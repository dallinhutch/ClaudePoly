/**
 * Re-run the entry decision for existing estimates under the ACTIVE strategy,
 * with a fresh order book. No AI cost. Estimates older than 2 hours are skipped.
 *   npx tsx scripts/evaluate-estimate.ts <estimateId> [<estimateId> ...]
 */
import { getDb, getPool } from "@/db/client";
import { evaluateEntry } from "@/lib/trading/engine";

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) throw new Error("usage: npx tsx scripts/evaluate-estimate.ts <estimateId> [...]");
  const db = getDb();
  for (const id of ids) {
    const o = await evaluateEntry(db, id);
    if (o.decision === "TRADE") {
      console.log(id, "TRADE", JSON.stringify({ positionId: o.positionId, status: o.fill.status, shares: o.fill.filledShares.toFixed(2), allInPrice: o.fill.allInPrice?.toFixed(4), cost: o.fill.notional.plus(o.fill.fees).toFixed(2) }));
    } else if (o.decision === "NO_TRADE") {
      console.log(id, "NO_TRADE", JSON.stringify(o.reasons));
    } else {
      console.log(id, "SKIPPED", o.reason);
    }
  }
  await getPool().end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

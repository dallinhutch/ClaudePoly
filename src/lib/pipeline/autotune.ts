import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { probabilityEstimates, strategyActivations, tradeCandidates } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { activateStrategyConfig, getActiveStrategy } from "@/lib/strategy/service";
import { evaluateEntry, MAX_ESTIMATE_AGE_MS } from "@/lib/trading/engine";

/** Checks auto-tune may relax. Liquidity, freshness, resolution clarity etc. are never loosened. */
const TUNABLE = new Set(["confidence", "edge_after_fees", "ev_per_dollar", "analyst_disagreement", "evidence_quality"]);
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * If the active strategy has produced no trades for a while and its NO_TRADE
 * decisions failed only on tunable thresholds, create a new strategy version
 * one step looser (never past the floors) and re-decide still-fresh estimates.
 */
export async function autoTuneStrategy(db: Db) {
  const strategy = await getActiveStrategy(db);
  const t = strategy.config.autoTune;
  if (!t.enabled) return { action: "none", reason: "auto-tune disabled" };

  const [activation] = await db.select({ at: strategyActivations.activatedAt }).from(strategyActivations).orderBy(desc(strategyActivations.id)).limit(1);
  if (!activation) return { action: "none", reason: "no activation" };
  const hoursActive = (Date.now() - activation.at.getTime()) / 3_600_000;
  if (hoursActive < t.minHoursWithoutTrade) return { action: "none", reason: `v${strategy.version} active ${hoursActive.toFixed(2)}h < ${t.minHoursWithoutTrade}h` };

  const decisions = (await db.select().from(tradeCandidates).where(eq(tradeCandidates.strategyVersionId, strategy.id)))
    .filter((c) => c.createdAt >= activation.at);
  if (decisions.some((c) => c.decision === "TRADE")) return { action: "none", reason: "strategy is producing trades" };

  const byEstimate = new Map<string, (typeof decisions)[number]>();
  for (const c of decisions) {
    const failed = c.checks.filter((k) => !k.passed);
    if (failed.length > 0 && failed.every((k) => TUNABLE.has(k.name))) byEstimate.set(c.probabilityEstimateId, c);
  }
  const nearMisses = [...byEstimate.values()];
  if (nearMisses.length < t.minNoTradeDecisions) return { action: "none", reason: `${nearMisses.length} near-miss decisions < ${t.minNoTradeDecisions}` };

  const q = strategy.config.qualification;
  const next = structuredClone(strategy.config);
  next.qualification.minConfidence = r4(Math.max(t.confidenceFloor, q.minConfidence - t.confidenceStep));
  next.qualification.minEdge = r4(Math.max(t.edgeFloor, q.minEdge - t.edgeStep));
  next.qualification.minEvPerDollar = r4(Math.max(t.evFloor, q.minEvPerDollar - t.evStep));
  next.qualification.maxAnalystStdev = r4(Math.min(t.stdevCap, q.maxAnalystStdev + t.stdevStep));
  next.qualification.minEvidenceQuality = r4(Math.max(t.evidenceFloor, q.minEvidenceQuality - t.evidenceStep));
  next.execution.limitEdgeBuffer = Math.min(next.execution.limitEdgeBuffer, next.qualification.minEdge);
  if (JSON.stringify(next.qualification) === JSON.stringify(q)) return { action: "none", reason: "thresholds already at auto-tune floors" };

  const failedCounts: Record<string, number> = {};
  for (const c of nearMisses) for (const k of c.checks) if (!k.passed) failedCounts[k.name] = (failedCounts[k.name] ?? 0) + 1;
  const notes = `auto-tune: no trades in ${hoursActive.toFixed(1)}h under v${strategy.version}; ${nearMisses.length} near-miss NO_TRADE decisions `
    + `(failed ${Object.entries(failedCounts).map(([k, v]) => `${k}×${v}`).join(", ")}); relaxed qualification one step`;
  const created = await db.transaction((tx) => activateStrategyConfig(tx, next, notes));

  const reevaluated: Array<{ estimateId: string; decision?: string; error?: string }> = [];
  for (const c of nearMisses) {
    const [est] = await db.select({ id: probabilityEstimates.id, createdAt: probabilityEstimates.createdAt })
      .from(probabilityEstimates).where(eq(probabilityEstimates.id, c.probabilityEstimateId)).limit(1);
    if (!est || Date.now() - est.createdAt.getTime() > MAX_ESTIMATE_AGE_MS) continue;
    try {
      reevaluated.push({ estimateId: est.id, decision: (await evaluateEntry(db, est.id)).decision });
    } catch (err) {
      reevaluated.push({ estimateId: est.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await recordAudit(db, "strategy.auto_tuned", "strategy_version", created.id, { from: strategy.version, to: created.version, failedCounts, qualification: next.qualification, reevaluated });
  return { action: "relaxed", from: strategy.version, to: created.version, qualification: next.qualification, reevaluated };
}

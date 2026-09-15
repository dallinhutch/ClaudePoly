import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { recordAudit } from "@/lib/audit";
import { BudgetExceededError, runStage2, runStage3 } from "@/lib/research/runner";
import { getActiveStrategy } from "@/lib/strategy/service";
import { evaluateEntry } from "@/lib/trading/engine";

/**
 * Stage 2 → Stage 3 → entry decision for the best-ranked screened markets.
 * Most markets stop at stage 2; most stage-3 results end in NO_TRADE. That is expected.
 */
export async function researchPipeline(db: Db) {
  const strategy = await getActiveStrategy(db);
  const cfg = strategy.config;
  const stats = { candidates: 0, stage2: 0, stage3: 0, trades: 0, noTrades: 0, skipped: 0, errors: [] as string[], stoppedForBudget: false };

  const candidates = (await db.execute(sql`
    with latest as (
      select distinct on (market_id) market_id, score, passed
      from screening_results
      where created_at > now() - interval '3 hours'
        and strategy_version_id = ${strategy.id}
      order by market_id, created_at desc
    )
    select latest.market_id as market_id, latest.score as score
    from latest
    join markets m on m.id = latest.market_id
    where latest.passed
      and m.active and not m.closed
      and not exists (
        select 1 from research_runs r
        where r.market_id = latest.market_id
          and r.queued_at > now() - make_interval(hours => ${cfg.research.cooldownHours}::int)
          -- a run that failed before spending anything (e.g. a request bug) doesn't start a cooldown
          and (r.status <> 'failed' or r.cost_usd > 0)
      )
      and not exists (select 1 from positions p where p.market_id = latest.market_id and p.status = 'OPEN')
    order by latest.score desc
    limit ${cfg.screening.maxStage2PerCycle}
  `)).rows as Array<{ market_id: string; score: string }>;
  stats.candidates = candidates.length;

  for (const c of candidates) {
    try {
      const quick = await runStage2(db, strategy, c.market_id, "screening");
      stats.stage2++;
      const sideProb = quick.bestSide === "YES" ? quick.probabilityYes : quick.bestSide === "NO" ? quick.probabilityYes.neg().plus(1) : null;
      // Deep research is expensive: only escalate when the favored side is close to the required likelihood.
      const worthDeep = quick.bestEdge !== null && quick.bestEdge.gte(cfg.research.stage3MinRawEdge) && quick.confidence.gte(0.3)
        && sideProb !== null && sideProb.gte(Math.max(0, cfg.qualification.minSideProbability - 0.05));
      if (!worthDeep) continue;

      const countRows = (await db.execute(sql`
        select count(*)::int as count from research_runs
        where stage = 3 and trigger <> 'position_review'
          and queued_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
      `)).rows as Array<{ count: number }>;
      const count = countRows[0]?.count ?? 0;
      if (count >= cfg.research.maxStage3PerDay) {
        await recordAudit(db, "research.stage3_daily_cap", "market", c.market_id, { count, cap: cfg.research.maxStage3PerDay });
        continue;
      }

      const deep = await runStage3(db, strategy, c.market_id, { trigger: "stage2_escalation", parentRunId: quick.runId });
      stats.stage3++;
      const outcome = await evaluateEntry(db, deep.estimateId);
      if (outcome.decision === "TRADE") stats.trades++;
      else if (outcome.decision === "NO_TRADE") stats.noTrades++;
      else stats.skipped++;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        stats.stoppedForBudget = true;
        break;
      }
      stats.errors.push(`${c.market_id}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    }
  }
  return stats;
}

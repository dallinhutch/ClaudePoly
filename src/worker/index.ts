import { eq } from "drizzle-orm";
import { getDb, getPool } from "@/db/client";
import { researchRuns, systemJobs } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { autoTuneStrategy } from "@/lib/pipeline/autotune";
import { monitorPositions } from "@/lib/pipeline/monitor";
import { researchPipeline } from "@/lib/pipeline/research";
import { scanAndScreen } from "@/lib/pipeline/scan";
import { getActiveStrategy } from "@/lib/strategy/service";
import { takePortfolioSnapshot } from "@/lib/trading/portfolio";
import { settleResolvedMarkets } from "@/lib/trading/settlement";
import { Scheduler, type JobDef } from "./scheduler";

const MIN = 60_000;

async function recoverInterrupted() {
  const db = getDb();
  const runs = await db.update(researchRuns)
    .set({ status: "failed", completedAt: new Date(), error: "interrupted: worker restarted mid-run" })
    .where(eq(researchRuns.status, "running")).returning({ id: researchRuns.id });
  await db.update(systemJobs)
    .set({ status: "failed", finishedAt: new Date(), error: "interrupted: worker restarted" })
    .where(eq(systemJobs.status, "running"));
  if (runs.length) await recordAudit(db, "worker.recovered_interrupted_runs", "worker", "worker", { researchRunIds: runs.map((r) => r.id) });
}

async function main() {
  if (process.env.WORKER_ENABLED === "false") {
    console.log("WORKER_ENABLED=false — worker idle");
    return;
  }
  const db = getDb();
  await recoverInterrupted();
  const strategy = () => getActiveStrategy(db);

  const jobs: JobDef[] = [
    { name: "scan_markets", lockKey: 7_200_001, intervalMs: async () => (await strategy()).config.scanner.marketRefreshMinutes * MIN, run: () => scanAndScreen(db) },
    { name: "settle_resolutions", lockKey: 7_200_004, intervalMs: async () => 30 * MIN, run: () => settleResolvedMarkets(db) },
    { name: "monitor_positions", lockKey: 7_200_003, intervalMs: async () => (await strategy()).config.monitoring.checkIntervalMinutes * MIN, run: () => monitorPositions(db) },
    { name: "research_pipeline", lockKey: 7_200_002, intervalMs: async () => (await strategy()).config.research.pipelineIntervalMinutes * MIN, run: () => researchPipeline(db) },
    { name: "portfolio_snapshot", lockKey: 7_200_005, intervalMs: async () => 30 * MIN, run: () => takePortfolioSnapshot(db) },
    { name: "auto_tune", lockKey: 7_200_006, intervalMs: async () => 30 * MIN, run: () => autoTuneStrategy(db) },
  ];

  const scheduler = new Scheduler(db, getPool(), jobs);
  scheduler.start();
  console.log("worker started (PAPER TRADING ONLY)");

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, finishing running jobs…`);
    await scheduler.stop();
    await getPool().end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("worker crashed:", err);
  process.exit(1);
});

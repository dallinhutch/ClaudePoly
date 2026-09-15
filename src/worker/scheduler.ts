import { eq } from "drizzle-orm";
import type pg from "pg";
import type { Db } from "@/db/client";
import { systemJobs } from "@/db/schema";

export interface JobDef {
  name: string;
  /** Postgres advisory lock key — guarantees one runner even with several worker containers. */
  lockKey: number;
  intervalMs: () => Promise<number>;
  run: () => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal, transparent job scheduler: each job runs on its interval, never
 * overlaps itself, and every run is recorded in system_jobs for the dashboard.
 */
export class Scheduler {
  private running = new Map<string, Promise<void>>();
  private nextRunAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private db: Db, private pool: pg.Pool, private jobs: JobDef[]) {}

  start(tickMs = 15_000) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  private async tick() {
    if (this.stopping) return;
    const now = Date.now();
    for (const job of this.jobs) {
      if (this.running.has(job.name) || now < (this.nextRunAt.get(job.name) ?? 0)) continue;
      const p = this.execute(job).finally(() => this.running.delete(job.name));
      this.running.set(job.name, p);
    }
  }

  private async execute(job: JobDef) {
    const client = await this.pool.connect();
    let locked = false;
    try {
      const { rows } = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [job.lockKey]);
      locked = rows[0]?.ok === true;
      if (!locked) {
        this.nextRunAt.set(job.name, Date.now() + 60_000);
        return;
      }
      const [rec] = await this.db.insert(systemJobs).values({ jobType: job.name }).returning({ id: systemJobs.id });
      const started = Date.now();
      console.log(`[job] ${job.name} started`);
      try {
        const summary = await job.run();
        await this.db.update(systemJobs).set({ status: "succeeded", finishedAt: new Date(), summary: summary ?? null }).where(eq(systemJobs.id, rec!.id));
        console.log(`[job] ${job.name} succeeded in ${Math.round((Date.now() - started) / 1000)}s`, JSON.stringify(summary ?? {}).slice(0, 500));
      } catch (err) {
        const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        await this.db.update(systemJobs).set({ status: "failed", finishedAt: new Date(), error: message.slice(0, 4000) }).where(eq(systemJobs.id, rec!.id));
        console.error(`[job] ${job.name} failed:`, message);
      }
    } catch (err) {
      console.error(`[job] ${job.name} scheduler error:`, err);
    } finally {
      try {
        this.nextRunAt.set(job.name, Date.now() + (await job.intervalMs()));
      } catch {
        this.nextRunAt.set(job.name, Date.now() + 15 * 60_000);
      }
      if (locked) await client.query("select pg_advisory_unlock($1)", [job.lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async stop(timeoutMs = 90_000) {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.race([Promise.allSettled(this.running.values()), sleep(timeoutMs)]);
  }
}

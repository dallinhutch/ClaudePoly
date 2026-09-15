import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { ensureBootstrap } from "@/db/bootstrap";
import * as schema from "@/db/schema";
import { defaultStrategyConfig } from "@/lib/strategy/config";
import { activateStrategyConfig, getActiveStrategy } from "@/lib/strategy/service";
import { appendLedgerEntry, getCashBalance, InsufficientCashError } from "@/lib/trading/ledger";

// In-process Postgres (PGlite) running the real migrations + triggers.
let db: Db;

beforeAll(async () => {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: "./drizzle" });
  // Same query-builder surface as node-postgres for everything used here.
  db = pgliteDb as unknown as Db;
});

const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Record<string, unknown>[];

/** Drizzle wraps driver errors ("Failed query: ..."); the trigger's message is on `cause`. */
async function expectDbError(query: ReturnType<typeof sql>, pattern: RegExp) {
  try {
    await db.execute(query);
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    expect(`${e.message} ${e.cause?.message ?? ""}`).toMatch(pattern);
    return;
  }
  throw new Error(`expected query to fail with ${pattern}`);
}

describe("bootstrap", () => {
  it("creates strategy v1 and exactly $1,000.00 of simulated cash, idempotently", async () => {
    expect(await ensureBootstrap(db)).toEqual({ strategyCreated: true, deposited: true });
    expect(await ensureBootstrap(db)).toEqual({ strategyCreated: false, deposited: false });
    expect((await getCashBalance(db)).toFixed(2)).toBe("1000.00");
    const active = await getActiveStrategy(db);
    expect(active.version).toBe(1);
  });
});

describe("cash ledger integrity", () => {
  it("rejects a second deposit (no topping up the bankroll)", async () => {
    await expect(db.transaction((tx) => appendLedgerEntry(tx, { entryType: "DEPOSIT", amount: "500", memo: "cheat" }))).rejects.toThrow();
    expect((await getCashBalance(db)).toFixed(2)).toBe("1000.00");
  });

  it("debits buys and refuses to overdraw", async () => {
    await db.transaction((tx) => appendLedgerEntry(tx, { entryType: "BUY", amount: "-100.25", memo: "test buy" }));
    expect((await getCashBalance(db)).toFixed(2)).toBe("899.75");
    await expect(db.transaction((tx) => appendLedgerEntry(tx, { entryType: "BUY", amount: "-5000", memo: "too big" })))
      .rejects.toBeInstanceOf(InsufficientCashError);
  });

  it("rejects wrong-signed entries and forged balances at the database level", async () => {
    await expectDbError(sql`insert into cash_ledger (entry_type, amount, balance_after, memo) values ('BUY', 10, 909.75, 'x')`, /BUY entries must be debits/);
    await expectDbError(sql`insert into cash_ledger (entry_type, amount, balance_after, memo) values ('SELL', 10, 5000, 'x')`, /balance mismatch/);
    await expectDbError(sql`insert into cash_ledger (entry_type, amount, balance_after, memo) values ('DEPOSIT', 10, 909.75, 'x')`, /only the single initial deposit/);
  });

  it("forbids UPDATE, DELETE and TRUNCATE", async () => {
    await expectDbError(sql`update cash_ledger set amount = 0`, /append-only/);
    await expectDbError(sql`delete from cash_ledger`, /append-only/);
    await expectDbError(sql`truncate cash_ledger cascade`, /append-only/);
    expect((await getCashBalance(db)).toFixed(2)).toBe("899.75");
  });
});

describe("strategy versioning", () => {
  it("dedupes identical configs and creates a new version for a change", async () => {
    const same = await db.transaction((tx) => activateStrategyConfig(tx, defaultStrategyConfig(), "re-activate"));
    expect(same).toMatchObject({ version: 1, created: false });

    const changed = defaultStrategyConfig();
    changed.qualification.minEdge = 0.15;
    const v2 = await db.transaction((tx) => activateStrategyConfig(tx, changed, "raise min edge"));
    expect(v2).toMatchObject({ version: 2, created: true });
    expect((await getActiveStrategy(db)).config.qualification.minEdge).toBe(0.15);
  });

  it("never lets a stored strategy be edited", async () => {
    await expectDbError(sql`update strategy_versions set notes = 'rewritten'`, /append-only/);
  });
});

describe("audit hash chain", () => {
  it("chains every event and verifies intact", async () => {
    const events = await rows(sql`select id, prev_hash, hash from audit_events order by id`);
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < events.length; i++) expect(events[i]!.prev_hash).toBe(events[i - 1]!.hash);
    expect(events[0]!.prev_hash).toBeNull();
    const [check] = await rows(sql`select audit_chain_first_break() as broken`);
    expect(check!.broken).toBeNull();
  });

  it("cannot be edited", async () => {
    await expectDbError(sql`update audit_events set payload = '{}'::jsonb`, /append-only/);
    await expectDbError(sql`delete from audit_events`, /append-only/);
  });
});

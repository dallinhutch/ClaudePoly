import { desc, eq, max } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/db/client";
import { strategyActivations, strategyVersions } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { hashStrategyConfig, StrategyConfigSchema, type StrategyConfig } from "./config";

export interface ActiveStrategy {
  id: string;
  version: number;
  config: StrategyConfig;
  configHash: string;
}

export async function getActiveStrategy(db: DbOrTx): Promise<ActiveStrategy> {
  const [row] = await db
    .select({ id: strategyVersions.id, version: strategyVersions.version, config: strategyVersions.config, configHash: strategyVersions.configHash })
    .from(strategyActivations)
    .innerJoin(strategyVersions, eq(strategyActivations.strategyVersionId, strategyVersions.id))
    .orderBy(desc(strategyActivations.id))
    .limit(1);
  if (!row) throw new Error("no active strategy version — run migrations/bootstrap");
  // Stored config is authoritative; parsing only fills fields added to the schema later.
  return { ...row, config: StrategyConfigSchema.parse(row.config) };
}

/**
 * Create (or re-activate) a strategy version. Identical configs dedupe by hash.
 * Existing versions are never modified, so historical trades keep the exact
 * rules they were made under.
 */
export async function activateStrategyConfig(tx: Tx, input: unknown, notes: string): Promise<ActiveStrategy & { created: boolean }> {
  const config = StrategyConfigSchema.parse(input);
  const configHash = hashStrategyConfig(config);

  const [current] = await tx
    .select({ config: strategyVersions.config })
    .from(strategyActivations)
    .innerJoin(strategyVersions, eq(strategyActivations.strategyVersionId, strategyVersions.id))
    .orderBy(desc(strategyActivations.id))
    .limit(1);
  if (current && StrategyConfigSchema.parse(current.config).sizing.startingBankrollUsd !== config.sizing.startingBankrollUsd) {
    throw new Error("the starting bankroll is fixed once the account exists");
  }

  const [existing] = await tx.select().from(strategyVersions).where(eq(strategyVersions.configHash, configHash)).limit(1);
  let id: string;
  let version: number;
  let created = false;
  if (existing) {
    id = existing.id;
    version = existing.version;
  } else {
    const [{ current } = { current: 0 }] = await tx.select({ current: max(strategyVersions.version) }).from(strategyVersions);
    version = (current ?? 0) + 1;
    const [row] = await tx.insert(strategyVersions).values({ version, config, configHash, notes }).returning({ id: strategyVersions.id });
    id = row!.id;
    created = true;
    await recordAudit(tx, "strategy.version_created", "strategy_version", id, { version, configHash, notes, config });
  }
  await tx.insert(strategyActivations).values({ strategyVersionId: id, reason: notes });
  await recordAudit(tx, "strategy.activated", "strategy_version", id, { version, configHash, reason: notes });
  return { id, version, config, configHash, created };
}

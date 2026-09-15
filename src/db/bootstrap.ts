import type { Db } from "./client";
import { cashLedger, strategyVersions } from "./schema";
import { recordAudit } from "@/lib/audit";
import { defaultStrategyConfig } from "@/lib/strategy/config";
import { activateStrategyConfig, getActiveStrategy } from "@/lib/strategy/service";
import { appendLedgerEntry } from "@/lib/trading/ledger";

/**
 * Idempotent first-run setup: strategy v1 and the single $1,000.00 simulated
 * deposit. The ledger trigger rejects any later DEPOSIT, so the bankroll can
 * never be topped up to hide losses.
 */
export async function ensureBootstrap(db: Db) {
  return db.transaction(async (tx) => {
    const result = { strategyCreated: false, deposited: false };

    const [anyStrategy] = await tx.select({ id: strategyVersions.id }).from(strategyVersions).limit(1);
    if (!anyStrategy) {
      await activateStrategyConfig(tx, defaultStrategyConfig(), "Strategy v1 — initial defaults");
      result.strategyCreated = true;
    }

    const [anyLedger] = await tx.select({ id: cashLedger.id }).from(cashLedger).limit(1);
    if (!anyLedger) {
      const strategy = await getActiveStrategy(tx);
      const amount = strategy.config.sizing.startingBankrollUsd.toFixed(2);
      const entry = await appendLedgerEntry(tx, { entryType: "DEPOSIT", amount, memo: "Initial simulated bankroll" });
      await recordAudit(tx, "ledger.initial_deposit", "cash_ledger", String(entry.id), { amount, strategyVersion: strategy.version });
      result.deposited = true;
    }
    return result;
  });
}

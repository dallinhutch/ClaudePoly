import { desc, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/db/client";
import { cashLedger } from "@/db/schema";
import { dec, toDb, type Dec, type Numeric } from "@/lib/decimal";

/** Advisory-lock keys serializing writers of shared accounting state. */
export const LOCK_KEYS = { ledger: 7_100_001, trading: 7_100_002 } as const;

export class InsufficientCashError extends Error {
  constructor(public balance: Dec, public amount: Dec) {
    super(`insufficient simulated cash: balance ${balance.toFixed(2)}, debit ${amount.neg().toFixed(2)}`);
  }
}

type EntryType = (typeof cashLedger.$inferInsert)["entryType"];

/**
 * Append one ledger entry inside a transaction. The lock serializes writers;
 * the DB trigger independently verifies balance_after = previous + amount.
 */
export async function appendLedgerEntry(tx: Tx, entry: {
  entryType: EntryType;
  amount: Numeric;
  memo: string;
  orderId?: string;
  positionId?: string;
  resolutionId?: string;
}) {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEYS.ledger})`);
  const balance = await getCashBalance(tx);
  const amount = dec(entry.amount);
  const next = balance.plus(amount);
  if (next.isNegative()) throw new InsufficientCashError(balance, amount);
  const [row] = await tx.insert(cashLedger).values({
    entryType: entry.entryType,
    amount: toDb(amount),
    balanceAfter: toDb(next),
    memo: entry.memo,
    orderId: entry.orderId,
    positionId: entry.positionId,
    resolutionId: entry.resolutionId,
  }).returning();
  return row!;
}

export async function getCashBalance(db: DbOrTx): Promise<Dec> {
  const [last] = await db.select({ balance: cashLedger.balanceAfter }).from(cashLedger).orderBy(desc(cashLedger.id)).limit(1);
  return dec(last?.balance ?? 0);
}

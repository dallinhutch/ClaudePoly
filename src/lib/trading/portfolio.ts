import { eq, max, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { cashLedger, portfolioSnapshots, positions } from "@/db/schema";
import { D, dec, toDb, ZERO, type Dec } from "@/lib/decimal";
import { getCashBalance } from "./ledger";
import { drawdown, type PositionState } from "./positionMath";

export type PositionRow = typeof positions.$inferSelect;

export interface PortfolioState {
  cash: Dec;
  startingBankroll: Dec;
  open: PositionRow[];
  openCostBasis: Dec;
  openMarkValue: Dec;
  equity: Dec;
  unrealizedPnl: Dec;
  realizedPnl: Dec;
  highWaterMark: Dec;
  drawdown: Dec;
}

export function stateFromRow(p: PositionRow): PositionState {
  return { shares: dec(p.shares), costBasis: dec(p.costBasis), realizedPnl: dec(p.realizedPnl), totalFees: dec(p.totalFees) };
}

/** Mark value of one position: last observed best bid, or cost if never marked. */
export function positionMarkValue(p: PositionRow): Dec {
  if (p.lastMarkPrice != null) return dec(p.shares).times(p.lastMarkPrice);
  return dec(p.costBasis);
}

export async function getPortfolioState(db: DbOrTx): Promise<PortfolioState> {
  const cash = await getCashBalance(db);
  const [deposit] = await db.select({ amount: cashLedger.amount }).from(cashLedger).where(eq(cashLedger.entryType, "DEPOSIT")).limit(1);
  const startingBankroll = dec(deposit?.amount ?? 0);
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const openCostBasis = open.reduce((s, p) => s.plus(p.costBasis), ZERO);
  const openMarkValue = open.reduce((s, p) => s.plus(positionMarkValue(p)), ZERO);
  const [realized] = await db.select({ total: sql<string>`coalesce(sum(${positions.realizedPnl}), 0)` }).from(positions);
  const [hwmRow] = await db.select({ hwm: max(portfolioSnapshots.equity) }).from(portfolioSnapshots);
  const equity = cash.plus(openMarkValue);
  const highWaterMark = D.max(startingBankroll, dec(hwmRow?.hwm ?? 0), equity);
  return {
    cash,
    startingBankroll,
    open,
    openCostBasis,
    openMarkValue,
    equity,
    unrealizedPnl: openMarkValue.minus(openCostBasis),
    realizedPnl: dec(realized?.total ?? 0),
    highWaterMark,
    drawdown: drawdown(equity, highWaterMark),
  };
}

/** Exposure is measured at cost basis (money actually committed). */
export function exposureFor(state: PortfolioState, market: { category: string | null; eventId: string | null; marketId?: string }) {
  let category = ZERO;
  let correlated = ZERO;
  let sameMarket = ZERO;
  for (const p of state.open) {
    if (market.category && p.category === market.category) category = category.plus(p.costBasis);
    if (market.eventId && p.eventId === market.eventId) correlated = correlated.plus(p.costBasis);
    if (market.marketId && p.marketId === market.marketId) sameMarket = sameMarket.plus(p.costBasis);
  }
  return { open: state.openCostBasis, category, correlated, sameMarket };
}

export async function takePortfolioSnapshot(db: DbOrTx) {
  const s = await getPortfolioState(db);
  const [row] = await db.insert(portfolioSnapshots).values({
    cash: toDb(s.cash),
    positionsMarkValue: toDb(s.openMarkValue),
    positionsCostBasis: toDb(s.openCostBasis),
    equity: toDb(s.equity),
    realizedPnl: toDb(s.realizedPnl),
    unrealizedPnl: toDb(s.unrealizedPnl),
    openPositions: s.open.length,
    highWaterMark: toDb(s.highWaterMark),
    drawdown: toDb(s.drawdown),
  }).returning();
  return row!;
}

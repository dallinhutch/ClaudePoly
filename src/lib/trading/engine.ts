import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import {
  markets, positions, positionUpdates, probabilityEstimates, researchRuns, simulatedFills, simulatedOrders, tradeCandidates,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { dec, toDb, ZERO } from "@/lib/decimal";
import { captureBook, type StoredBook } from "@/lib/polymarket/books";
import { researchSignals } from "@/lib/research/signals";
import { getActiveStrategy, type ActiveStrategy } from "@/lib/strategy/service";
import { getExecutionAdapter } from "./adapter";
import { askDepthUsd, feeModelFromMarket, feePerShare, type FillResult } from "./execution";
import { appendLedgerEntry, LOCK_KEYS } from "./ledger";
import { exposureFor, getPortfolioState } from "./portfolio";
import { applyBuy, emptyPosition } from "./positionMath";
import { sideProbability } from "./probability";
import { buyLimitPrice, qualifyTrade } from "./qualification";
import { sizePosition } from "./sizing";

type MarketRow = typeof markets.$inferSelect;
type EstimateRow = typeof probabilityEstimates.$inferSelect;

/** An estimate older than this is never traded on; prices and news move. */
export const MAX_ESTIMATE_AGE_MS = 2 * 60 * 60 * 1000;

export type EntryOutcome =
  | { decision: "SKIPPED"; reason: string }
  | { decision: "NO_TRADE"; candidateId: string; reasons: string[] }
  | { decision: "TRADE"; candidateId: string; orderId: string; positionId: string | null; fill: FillResult };

/**
 * Decide whether a fresh stage-3 estimate becomes a simulated position, using
 * only information available right now: the stored estimate and a live order
 * book captured at decision time.
 */
export async function evaluateEntry(db: Db, estimateId: string): Promise<EntryOutcome> {
  const [row] = await db
    .select({ estimate: probabilityEstimates, market: markets, run: researchRuns })
    .from(probabilityEstimates)
    .innerJoin(markets, eq(probabilityEstimates.marketId, markets.id))
    .innerJoin(researchRuns, eq(probabilityEstimates.researchRunId, researchRuns.id))
    .where(eq(probabilityEstimates.id, estimateId))
    .limit(1);
  if (!row) throw new Error(`estimate ${estimateId} not found`);
  const { estimate, market, run } = row;

  if (estimate.stage !== 3) return { decision: "SKIPPED", reason: "entries require stage-3 research" };
  const strategy = await getActiveStrategy(db);
  if (strategy.id !== estimate.strategyVersionId) return { decision: "SKIPPED", reason: "strategy version changed since the estimate was made" };
  if (Date.now() - estimate.createdAt.getTime() > MAX_ESTIMATE_AGE_MS) return { decision: "SKIPPED", reason: "estimate is stale" };
  const [open] = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.marketId, market.id), eq(positions.status, "OPEN"))).limit(1);
  if (open) return { decision: "SKIPPED", reason: "a position in this market is already open (monitor handles adds)" };

  const side = estimate.bestSide;
  // Network call happens before taking the trading lock.
  const book = side ? await captureBook(db, market, side) : null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEYS.trading})`);
    return decideAndExecute(tx, { strategy, estimate, market, side, book, dossier: run.dossier });
  });
}

async function decideAndExecute(tx: Tx, ctx: {
  strategy: ActiveStrategy;
  estimate: EstimateRow;
  market: MarketRow;
  side: "YES" | "NO" | null;
  book: StoredBook | null;
  dossier: unknown;
}): Promise<EntryOutcome> {
  const { strategy, estimate, market, side, book } = ctx;
  const cfg = strategy.config;
  const now = new Date();

  const recordNoTrade = async (reasons: string[], extra: Partial<typeof tradeCandidates.$inferInsert> = {}) => {
    const [c] = await tx.insert(tradeCandidates).values({
      marketId: market.id, probabilityEstimateId: estimate.id, strategyVersionId: strategy.id,
      decision: "NO_TRADE", action: "OPEN", side, checks: [], rejectionReasons: reasons, ...extra,
    }).returning({ id: tradeCandidates.id });
    await recordAudit(tx, "trade.no_trade", "trade_candidate", c!.id, { marketId: market.id, estimateId: estimate.id, reasons });
    return { decision: "NO_TRADE" as const, candidateId: c!.id, reasons };
  };

  if (!side || !book) return recordNoTrade(["no positive edge on either side after fees"]);
  if (!book.bestAsk) return recordNoTrade([`no asks in the ${side} order book`]);

  const fee = feeModelFromMarket(market.feesEnabled, market.feeSchedule);
  const probSide = sideProbability(estimate.probabilityYes, side);
  const bestAsk = dec(book.bestAsk);
  const allInTop = bestAsk.plus(feePerShare(bestAsk, fee));
  const signals = researchSignals(ctx.dossier);
  const hours = market.endDate ? (market.endDate.getTime() - now.getTime()) / 3_600_000 : null;

  const q = qualifyTrade({
    probSide,
    allInPrice: allInTop,
    confidence: estimate.confidence,
    evidenceQuality: estimate.evidenceQuality,
    analystStdev: estimate.stdevProb,
    liquidityUsd: market.liquidityUsd,
    hoursToResolution: hours,
    resolutionClarity: signals.clarity,
    unresolvedContradictions: signals.unresolvedContradictions,
    newestEvidenceAgeHours: signals.newestEvidenceAt ? (now.getTime() - signals.newestEvidenceAt.getTime()) / 3_600_000 : null,
  }, cfg.qualification);

  const state = await getPortfolioState(tx);
  const exposure = exposureFor(state, { category: market.category, eventId: market.eventId });
  const requiredEdge = Math.max(cfg.qualification.minEdge, cfg.execution.limitEdgeBuffer);
  const limit = buyLimitPrice({
    probSide, requiredEdge, bestAsk, maxSlippage: cfg.execution.maxSlippage, tickSize: market.minTickSize ?? "0.01", fee,
  });
  const sizing = sizePosition({
    probSide,
    confidence: estimate.confidence,
    price: allInTop,
    equity: state.equity,
    cash: state.cash,
    openExposure: exposure.open,
    categoryExposure: exposure.category,
    correlatedExposure: exposure.correlated,
    existingPositionCost: ZERO,
    availableDepthUsd: limit ? askDepthUsd(book.book.asks, limit) : ZERO,
    drawdown: state.drawdown,
    daysToResolution: hours == null ? Number.POSITIVE_INFINITY : hours / 24,
  }, cfg.sizing);

  const reasons = [...q.rejectionReasons];
  if (!limit) reasons.push("no limit price leaves the required edge after fees");
  if (sizing.usd.lte(0)) reasons.push(`position size is zero (binding constraint: ${sizing.bindingConstraint})`);
  const sizingRecord = { ...sizing, portfolio: { equity: state.equity, cash: state.cash, drawdown: state.drawdown }, exposure, allInTop, bestAsk };

  if (reasons.length > 0) {
    return recordNoTrade(reasons, { checks: q.checks, sizing: sizingRecord, limitPrice: limit ? toDb(limit) : null });
  }

  const [candidate] = await tx.insert(tradeCandidates).values({
    marketId: market.id, probabilityEstimateId: estimate.id, strategyVersionId: strategy.id,
    decision: "TRADE", action: "OPEN", side, checks: q.checks, rejectionReasons: [],
    sizing: sizingRecord, proposedUsd: toDb(sizing.usd), limitPrice: toDb(limit!),
  }).returning({ id: tradeCandidates.id });

  const fill = await getExecutionAdapter().buy({
    asks: book.book.asks, budgetUsd: sizing.usd.toFixed(2), limitPrice: limit!.toFixed(), minOrderShares: market.minOrderSize ?? "5", fee,
  });
  const reason = `Entry ${side}: P(${side})=${probSide.toFixed(3)} vs all-in ask ${allInTop.toFixed(4)} (edge ${q.edge.toFixed(3)}), confidence ${dec(estimate.confidence).toFixed(2)}. ${fill.reason}`;

  const orderBase = {
    tradeCandidateId: candidate!.id, marketId: market.id, tokenId: book.tokenId, side, action: "OPEN" as const, direction: "BUY" as const,
    strategyVersionId: strategy.id, orderbookSnapshotId: book.snapshotId, requestedUsd: toDb(sizing.usd), limitPrice: toDb(limit!),
    status: fill.status, filledShares: toDb(fill.filledShares), avgFillPrice: fill.avgPrice ? toDb(fill.avgPrice) : null,
    notionalUsd: toDb(fill.notional), feesUsd: toDb(fill.fees), reason,
  };

  if (fill.filledShares.lte(0)) {
    const [order] = await tx.insert(simulatedOrders).values(orderBase).returning({ id: simulatedOrders.id });
    await recordAudit(tx, "trade.unfilled", "simulated_order", order!.id, { candidateId: candidate!.id, reason: fill.reason });
    return { decision: "TRADE", candidateId: candidate!.id, orderId: order!.id, positionId: null, fill };
  }

  const { next, cashDelta } = applyBuy(emptyPosition(), { shares: fill.filledShares, notional: fill.notional, fees: fill.fees });
  const edgeAtFill = probSide.minus(fill.allInPrice!);
  const [position] = await tx.insert(positions).values({
    marketId: market.id, eventId: market.eventId, category: market.category, side, tokenId: book.tokenId, status: "OPEN",
    strategyVersionId: strategy.id, openedAt: now,
    shares: toDb(next.shares), costBasis: toDb(next.costBasis), totalFees: toDb(next.totalFees),
    entryAvgPrice: toDb(fill.allInPrice!), entryProbability: estimate.probabilityYes, entryConfidence: estimate.confidence,
    entryEdge: toDb(edgeAtFill), entryEstimateId: estimate.id, currentEstimateId: estimate.id, currentProbability: estimate.probabilityYes,
    lastMarkPrice: book.bestBid, lastMarkedAt: now, lastReviewedAt: now, recommendation: "HOLD",
  }).returning({ id: positions.id });

  const [order] = await tx.insert(simulatedOrders).values({ ...orderBase, positionId: position!.id }).returning({ id: simulatedOrders.id });
  await tx.insert(simulatedFills).values(fill.fills.map((f) => ({
    orderId: order!.id, levelIndex: f.levelIndex, price: toDb(f.price), shares: toDb(f.shares), notionalUsd: toDb(f.notional), feeUsd: toDb(f.fee),
  })));
  await appendLedgerEntry(tx, {
    entryType: "BUY", amount: cashDelta, orderId: order!.id, positionId: position!.id,
    memo: `BUY ${fill.filledShares.toFixed(2)} ${side} @ ${fill.allInPrice!.toFixed(4)} all-in — ${market.question}`.slice(0, 500),
  });
  await tx.insert(positionUpdates).values({
    positionId: position!.id, action: "OPEN", probabilityEstimateId: estimate.id, orderId: order!.id,
    marketBid: book.bestBid, probability: estimate.probabilityYes, remainingEdge: toDb(edgeAtFill),
    sharesBefore: "0", sharesAfter: toDb(next.shares), costBasisBefore: "0", costBasisAfter: toDb(next.costBasis), reasoning: reason,
  });
  await recordAudit(tx, "trade.opened", "position", position!.id, {
    orderId: order!.id, candidateId: candidate!.id, estimateId: estimate.id, marketId: market.id, question: market.question, side,
    probabilityYes: estimate.probabilityYes, confidence: estimate.confidence, checks: q.checks, sizing: sizingRecord,
    fill: { status: fill.status, shares: fill.filledShares, avgPrice: fill.avgPrice, allInPrice: fill.allInPrice, fees: fill.fees, levels: fill.fills.length },
    strategyVersion: strategy.version,
  });
  return { decision: "TRADE", candidateId: candidate!.id, orderId: order!.id, positionId: position!.id, fill };
}

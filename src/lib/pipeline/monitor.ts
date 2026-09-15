import { eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { markets, positions, positionUpdates, probabilityEstimates, simulatedFills, simulatedOrders } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { D, dec, toDb, ZERO, type Dec } from "@/lib/decimal";
import { captureBook, type StoredBook } from "@/lib/polymarket/books";
import { BudgetExceededError, runStage2, runStage3 } from "@/lib/research/runner";
import { researchSignals } from "@/lib/research/signals";
import { researchRuns } from "@/db/schema";
import { getActiveStrategy, type ActiveStrategy } from "@/lib/strategy/service";
import { getExecutionAdapter } from "@/lib/trading/adapter";
import { MAX_ESTIMATE_AGE_MS } from "@/lib/trading/engine";
import { askDepthUsd, feeModelFromMarket, feePerShare, SHARE_DECIMALS, type FillResult } from "@/lib/trading/execution";
import { appendLedgerEntry, LOCK_KEYS } from "@/lib/trading/ledger";
import { exposureFor, getPortfolioState, stateFromRow, type PositionRow } from "@/lib/trading/portfolio";
import { applyBuy, applySell } from "@/lib/trading/positionMath";
import { sideProbability } from "@/lib/trading/probability";
import { buyLimitPrice, qualifyTrade, sellLimitPrice } from "@/lib/trading/qualification";
import { sizePosition } from "@/lib/trading/sizing";

type EstimateRow = typeof probabilityEstimates.$inferSelect;
type MarketRow = typeof markets.$inferSelect;
type Action = "HOLD" | "REDUCE" | "EXIT" | "ADD";

export async function monitorPositions(db: Db) {
  const strategy = await getActiveStrategy(db);
  const open = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const stats = { reviewed: 0, hold: 0, reduce: 0, exit: 0, add: 0, researched: 0, errors: [] as string[] };
  for (const p of open) {
    try {
      const r = await reviewPosition(db, strategy, p);
      stats.reviewed++;
      if (r.researched) stats.researched++;
      stats[r.action.toLowerCase() as "hold" | "reduce" | "exit" | "add"]++;
    } catch (err) {
      stats.errors.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    }
  }
  return stats;
}

async function loadEstimate(db: Db, id: string | null): Promise<EstimateRow | null> {
  if (!id) return null;
  const [row] = await db.select().from(probabilityEstimates).where(eq(probabilityEstimates.id, id)).limit(1);
  return row ?? null;
}

export async function reviewPosition(db: Db, strategy: ActiveStrategy, p: PositionRow): Promise<{ action: Action; researched: boolean }> {
  const cfg = strategy.config;
  const [market] = await db.select().from(markets).where(eq(markets.id, p.marketId)).limit(1);
  if (!market) throw new Error(`market ${p.marketId} missing`);
  const now = new Date();
  const book = await captureBook(db, market, p.side);
  const bid = book.bestBid ? dec(book.bestBid) : null;

  // --- Research refresh (only when due, or when the price moved sharply) ---
  let decisionEstimate = await loadEstimate(db, p.currentEstimateId);
  const due = !p.lastReviewedAt || now.getTime() - p.lastReviewedAt.getTime() >= cfg.monitoring.reevaluateEveryHours * 3_600_000;
  const moved = bid !== null && p.lastMarkPrice !== null && bid.minus(p.lastMarkPrice).abs().gte(cfg.monitoring.priceMoveTrigger);
  let researched = false;
  const notes: string[] = [];
  if (due || moved) {
    try {
      const quick = await runStage2(db, strategy, market.id, "position_review", "review");
      researched = true;
      const prior = decisionEstimate ? dec(decisionEstimate.probabilityYes) : null;
      notes.push(`stage-2 review P(YES)=${quick.probabilityYes.toFixed(3)}${prior ? ` vs prior ${prior.toFixed(3)}` : ""}`);
      if (!prior || quick.probabilityYes.minus(prior).abs().gte(cfg.monitoring.deepReviewDelta)) {
        const deep = await runStage3(db, strategy, market.id, {
          trigger: "position_review", parentRunId: quick.runId, lastResearchedAt: p.lastReviewedAt, purpose: "review",
        });
        decisionEstimate = await loadEstimate(db, deep.estimateId);
        notes.push(`thesis re-examined with stage-3 research: P(YES)=${deep.probabilityYes.toFixed(3)}`);
      }
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      notes.push("research skipped: daily AI budget reached");
    }
  }
  if (!decisionEstimate) throw new Error(`position ${p.id} has no estimate`);

  // --- Remaining edge of holding vs. selling at the bid right now ---
  const fee = feeModelFromMarket(market.feesEnabled, market.feeSchedule);
  const probSide = sideProbability(decisionEstimate.probabilityYes, p.side);
  const exitValue = bid ? bid.minus(feePerShare(bid, fee)) : ZERO;
  const remainingEdge = probSide.minus(exitValue);

  let action: Action = "HOLD";
  const reasons: string[] = [];
  let addPlan: Awaited<ReturnType<typeof planAdd>> = null;
  if (!bid) {
    reasons.push("no bids in book; cannot exit — holding to resolution");
  } else if (remainingEdge.lt(cfg.monitoring.exitBelowEdge)) {
    action = "EXIT";
    reasons.push(`remaining edge ${remainingEdge.toFixed(3)} < exit threshold ${cfg.monitoring.exitBelowEdge}`);
  } else if (remainingEdge.lt(cfg.monitoring.reduceBelowEdge)) {
    action = "REDUCE";
    reasons.push(`remaining edge ${remainingEdge.toFixed(3)} < reduce threshold ${cfg.monitoring.reduceBelowEdge}`);
  } else {
    reasons.push(`remaining edge ${remainingEdge.toFixed(3)} supports holding`);
    addPlan = await planAdd(db, { strategy, p, market, book, estimate: decisionEstimate, probSide, now });
    if (addPlan?.ok) action = "ADD";
    else if (addPlan) reasons.push(`no add: ${addPlan.reason}`);
  }

  const shouldLog = researched || action !== "HOLD" || p.recommendation !== action;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEYS.trading})`);
    const [fresh] = await tx.select().from(positions).where(eq(positions.id, p.id)).limit(1);
    if (!fresh || fresh.status !== "OPEN") return;

    let fill: FillResult | null = null;
    let orderId: string | null = null;
    let next = stateFromRow(fresh);
    let realizedDelta = ZERO;
    if ((action === "EXIT" || action === "REDUCE") && bid) {
      const shares = action === "EXIT" ? dec(fresh.shares) : dec(fresh.shares).div(2).toDecimalPlaces(SHARE_DECIMALS, D.ROUND_DOWN);
      const limit = sellLimitPrice({ bestBid: bid, maxSlippage: cfg.execution.maxSlippage, tickSize: market.minTickSize ?? "0.01" });
      fill = await getExecutionAdapter().sell({ bids: book.book.bids, shares: shares.toFixed(), limitPrice: limit.toFixed(), minOrderShares: market.minOrderSize ?? "5", fee });
      orderId = await insertOrder(tx, { strategy, market, p: fresh, book, action, direction: "SELL", fill, limit, requestedShares: shares, reason: reasons.join("; ") });
      if (fill.filledShares.gt(0)) {
        const r = applySell(next, { shares: fill.filledShares, notional: fill.notional, fees: fill.fees });
        next = r.next;
        realizedDelta = r.realizedDelta;
        await appendLedgerEntry(tx, { entryType: "SELL", amount: r.cashDelta, orderId, positionId: fresh.id, memo: `${action} ${fill.filledShares.toFixed(2)} ${fresh.side} @ ${fill.avgPrice!.toFixed(4)} — ${market.question}`.slice(0, 500) });
      } else {
        reasons.push(`sell order unfilled: ${fill.reason}`);
      }
    } else if (action === "ADD" && addPlan?.ok) {
      fill = await getExecutionAdapter().buy({ asks: book.book.asks, budgetUsd: addPlan.usd.toFixed(2), limitPrice: addPlan.limit.toFixed(), minOrderShares: market.minOrderSize ?? "5", fee });
      orderId = await insertOrder(tx, { strategy, market, p: fresh, book, action, direction: "BUY", fill, limit: addPlan.limit, requestedUsd: addPlan.usd, reason: reasons.join("; ") });
      if (fill.filledShares.gt(0)) {
        const r = applyBuy(next, { shares: fill.filledShares, notional: fill.notional, fees: fill.fees });
        next = r.next;
        await appendLedgerEntry(tx, { entryType: "BUY", amount: r.cashDelta, orderId, positionId: fresh.id, memo: `ADD ${fill.filledShares.toFixed(2)} ${fresh.side} @ ${fill.allInPrice!.toFixed(4)} — ${market.question}`.slice(0, 500) });
      } else {
        reasons.push(`add order unfilled: ${fill.reason}`);
      }
    }

    const closed = next.shares.isZero();
    await tx.update(positions).set({
      shares: toDb(next.shares),
      costBasis: toDb(next.costBasis),
      realizedPnl: toDb(next.realizedPnl),
      totalFees: toDb(next.totalFees),
      entryAvgPrice: next.shares.gt(0) ? toDb(next.costBasis.div(next.shares)) : fresh.entryAvgPrice,
      addsCount: action === "ADD" && fill?.filledShares.gt(0) ? fresh.addsCount + 1 : fresh.addsCount,
      status: closed ? "CLOSED" : "OPEN",
      closedAt: closed ? now : null,
      currentEstimateId: decisionEstimate!.id,
      currentProbability: decisionEstimate!.probabilityYes,
      lastMarkPrice: book.bestBid,
      lastMarkedAt: now,
      lastReviewedAt: researched ? now : fresh.lastReviewedAt,
      recommendation: action,
      updatedAt: now,
    }).where(eq(positions.id, fresh.id));

    if (shouldLog || fill) {
      await tx.insert(positionUpdates).values({
        positionId: fresh.id, action, probabilityEstimateId: decisionEstimate!.id, orderId,
        marketBid: book.bestBid, probability: decisionEstimate!.probabilityYes, remainingEdge: toDb(remainingEdge),
        sharesBefore: fresh.shares, sharesAfter: toDb(next.shares), costBasisBefore: fresh.costBasis, costBasisAfter: toDb(next.costBasis),
        realizedPnlDelta: toDb(realizedDelta), reasoning: [...notes, ...reasons].join("; "),
        details: { researched, due, moved, addPlan: addPlan ?? null, fill: fill ? { status: fill.status, shares: fill.filledShares, avgPrice: fill.avgPrice, fees: fill.fees } : null },
      });
      await recordAudit(tx, `position.${action.toLowerCase()}`, "position", fresh.id, {
        estimateId: decisionEstimate!.id, remainingEdge, bid: book.bestBid, notes, reasons, orderId, closed,
      });
    }
  });
  return { action, researched };
}

/** ADD is tightly constrained: fresh stage-3 estimate, full qualification, no averaging down, capped count. */
async function planAdd(db: Db, ctx: {
  strategy: ActiveStrategy; p: PositionRow; market: MarketRow; book: StoredBook; estimate: EstimateRow; probSide: Dec; now: Date;
}): Promise<{ ok: true; usd: Dec; limit: Dec } | { ok: false; reason: string } | null> {
  const { strategy, p, market, book, estimate, probSide, now } = ctx;
  const cfg = strategy.config;
  if (!cfg.monitoring.allowAdd) return null;
  if (p.addsCount >= cfg.monitoring.maxAddsPerPosition) return { ok: false, reason: "max adds reached" };
  if (estimate.stage !== 3 || estimate.id === p.entryEstimateId) return { ok: false, reason: "requires new stage-3 research" };
  if (now.getTime() - estimate.createdAt.getTime() > MAX_ESTIMATE_AGE_MS) return { ok: false, reason: "estimate not fresh" };
  if (!book.bestAsk) return { ok: false, reason: "no asks" };

  const fee = feeModelFromMarket(market.feesEnabled, market.feeSchedule);
  const ask = dec(book.bestAsk);
  const allIn = ask.plus(feePerShare(ask, fee));
  if (allIn.lt(dec(p.entryAvgPrice).minus(cfg.monitoring.maxAdverseMoveForAdd))) {
    return { ok: false, reason: `price moved against entry (${allIn.toFixed(3)} < ${p.entryAvgPrice}); no averaging down` };
  }
  const [run] = await db.select({ dossier: researchRuns.dossier }).from(researchRuns).where(eq(researchRuns.id, estimate.researchRunId)).limit(1);
  const signals = researchSignals(run?.dossier);
  const hours = market.endDate ? (market.endDate.getTime() - now.getTime()) / 3_600_000 : null;
  const q = qualifyTrade({
    probSide, allInPrice: allIn, confidence: estimate.confidence, evidenceQuality: estimate.evidenceQuality, analystStdev: estimate.stdevProb,
    liquidityUsd: market.liquidityUsd, hoursToResolution: hours, resolutionClarity: signals.clarity,
    unresolvedContradictions: signals.unresolvedContradictions,
    newestEvidenceAgeHours: signals.newestEvidenceAt ? (now.getTime() - signals.newestEvidenceAt.getTime()) / 3_600_000 : null,
  }, cfg.qualification);
  if (!q.qualified) return { ok: false, reason: q.rejectionReasons.join(", ") };

  const limit = buyLimitPrice({ probSide, requiredEdge: Math.max(cfg.qualification.minEdge, cfg.execution.limitEdgeBuffer), bestAsk: ask, maxSlippage: cfg.execution.maxSlippage, tickSize: market.minTickSize ?? "0.01", fee });
  if (!limit) return { ok: false, reason: "no limit price leaves required edge" };
  const state = await getPortfolioState(db);
  const exposure = exposureFor(state, { category: market.category, eventId: market.eventId, marketId: market.id });
  const sizing = sizePosition({
    probSide, confidence: estimate.confidence, price: allIn, equity: state.equity, cash: state.cash,
    openExposure: exposure.open, categoryExposure: exposure.category, correlatedExposure: exposure.correlated,
    existingPositionCost: exposure.sameMarket, availableDepthUsd: askDepthUsd(book.book.asks, limit), drawdown: state.drawdown,
    daysToResolution: hours == null ? Number.POSITIVE_INFINITY : hours / 24,
  }, cfg.sizing);
  if (sizing.usd.lte(0)) return { ok: false, reason: `size zero (${sizing.bindingConstraint})` };
  return { ok: true, usd: sizing.usd, limit };
}

async function insertOrder(tx: Tx, a: {
  strategy: ActiveStrategy; market: MarketRow; p: PositionRow; book: StoredBook; action: "EXIT" | "REDUCE" | "ADD";
  direction: "BUY" | "SELL"; fill: FillResult; limit: Dec; requestedShares?: Dec; requestedUsd?: Dec; reason: string;
}): Promise<string> {
  const [order] = await tx.insert(simulatedOrders).values({
    positionId: a.p.id, marketId: a.market.id, tokenId: a.p.tokenId, side: a.p.side, action: a.action, direction: a.direction,
    strategyVersionId: a.strategy.id, orderbookSnapshotId: a.book.snapshotId,
    requestedShares: a.requestedShares ? toDb(a.requestedShares) : null, requestedUsd: a.requestedUsd ? toDb(a.requestedUsd) : null,
    limitPrice: toDb(a.limit), status: a.fill.status, filledShares: toDb(a.fill.filledShares),
    avgFillPrice: a.fill.avgPrice ? toDb(a.fill.avgPrice) : null, notionalUsd: toDb(a.fill.notional), feesUsd: toDb(a.fill.fees),
    reason: `${a.reason}. ${a.fill.reason}`.slice(0, 2000),
  }).returning({ id: simulatedOrders.id });
  if (a.fill.fills.length > 0) {
    await tx.insert(simulatedFills).values(a.fill.fills.map((f) => ({
      orderId: order!.id, levelIndex: f.levelIndex, price: toDb(f.price), shares: toDb(f.shares), notionalUsd: toDb(f.notional), feeUsd: toDb(f.fee),
    })));
  }
  return order!.id;
}

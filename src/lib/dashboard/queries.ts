import "server-only";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import * as s from "@/db/schema";
import {
  bracketOf, calibration, CONFIDENCE_BRACKETS, EDGE_BRACKETS, groupReturns, maxDrawdown, tradeStats, type ClosedTrade,
} from "@/lib/analytics/metrics";
import { aiSpendTodayUsd, aiSpendTotalUsd } from "@/lib/research/runner";
import { getActiveStrategy } from "@/lib/strategy/service";
import { getPortfolioState, positionMarkValue } from "@/lib/trading/portfolio";

const n = (v: string | number | null | undefined) => (v == null ? null : Number(v));

export async function getOverview() {
  const db = getDb();
  const state = await getPortfolioState(db);
  const snaps = await db.select({ takenAt: s.portfolioSnapshots.takenAt, equity: s.portfolioSnapshots.equity })
    .from(s.portfolioSnapshots).orderBy(s.portfolioSnapshots.takenAt);
  const start = state.startingBankroll.toNumber();
  const equity = state.equity.toNumber();
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const lastBeforeToday = [...snaps].reverse().find((x) => x.takenAt < startOfDay);
  const dayStart = lastBeforeToday ? Number(lastBeforeToday.equity) : start;
  const [orders] = await db.select({ count: sql<number>`count(*)::int` }).from(s.simulatedOrders);
  const recentJobs = await db.select().from(s.systemJobs).orderBy(desc(s.systemJobs.startedAt)).limit(8);
  return {
    startingBankroll: start,
    equity,
    cash: state.cash.toNumber(),
    openMarkValue: state.openMarkValue.toNumber(),
    openExposure: state.openCostBasis.toNumber(),
    openPositions: state.open.length,
    realizedPnl: state.realizedPnl.toNumber(),
    unrealizedPnl: state.unrealizedPnl.toNumber(),
    totalReturn: start > 0 ? (equity - start) / start : 0,
    todaysPnl: equity - dayStart,
    currentDrawdown: state.drawdown.toNumber(),
    maxDrawdown: maxDrawdown([start, ...snaps.map((x) => Number(x.equity)), equity]).maxDrawdown,
    aiSpendToday: (await aiSpendTodayUsd(db)).toNumber(),
    aiSpendTotal: (await aiSpendTotalUsd(db)).toNumber(),
    aiBudgetTotal: (await getActiveStrategy(db)).config.research.totalBudgetUsd,
    orderCount: orders?.count ?? 0,
    recentJobs,
  };
}

export interface OpportunityRow {
  estimateId: string;
  marketId: string;
  question: string;
  category: string | null;
  stage: number;
  createdAt: Date;
  probabilityYes: number;
  confidence: number;
  yesAsk: number | null;
  noAsk: number | null;
  mid: number | null;
  edgeYes: number | null;
  edgeNo: number | null;
  bestSide: "YES" | "NO" | null;
  bestEdge: number | null;
  attractiveness: number;
  liquidityUsd: number | null;
  endDate: Date | null;
  decision: "TRADE" | "NO_TRADE" | null;
  proposedUsd: number | null;
  rejectionReasons: string[];
}

export async function getOpportunities(): Promise<OpportunityRow[]> {
  const result = await getDb().execute(sql`
    select distinct on (e.market_id)
      e.id, e.market_id, e.stage, e.created_at, e.probability_yes, e.confidence, e.yes_ask, e.no_ask, e.market_mid,
      e.edge_yes, e.edge_no, e.ev_per_dollar_yes, e.ev_per_dollar_no, e.best_side,
      m.question, m.category, m.liquidity_usd, m.end_date,
      c.decision, c.proposed_usd, c.rejection_reasons
    from probability_estimates e
    join markets m on m.id = e.market_id
    left join lateral (
      select decision, proposed_usd, rejection_reasons from trade_candidates tc
      where tc.probability_estimate_id = e.id order by tc.created_at desc limit 1
    ) c on true
    where e.created_at > now() - interval '14 days' and not m.closed
    order by e.market_id, e.created_at desc
  `);
  const rows = result.rows as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const edgeYes = n(r.edge_yes as string);
    const edgeNo = n(r.edge_no as string);
    const bestSide = (r.best_side as "YES" | "NO" | null) ?? null;
    const bestEdge = bestSide === "YES" ? edgeYes : bestSide === "NO" ? edgeNo : Math.max(edgeYes ?? -1, edgeNo ?? -1);
    const ev = Math.max(n(r.ev_per_dollar_yes as string) ?? 0, n(r.ev_per_dollar_no as string) ?? 0, 0);
    return {
      estimateId: r.id as string,
      marketId: r.market_id as string,
      question: r.question as string,
      category: (r.category as string) ?? null,
      stage: Number(r.stage),
      createdAt: new Date(r.created_at as string),
      probabilityYes: Number(r.probability_yes),
      confidence: Number(r.confidence),
      yesAsk: n(r.yes_ask as string),
      noAsk: n(r.no_ask as string),
      mid: n(r.market_mid as string),
      edgeYes,
      edgeNo,
      bestSide,
      bestEdge,
      attractiveness: ev * Number(r.confidence),
      liquidityUsd: n(r.liquidity_usd as string),
      endDate: r.end_date ? new Date(r.end_date as string) : null,
      decision: (r.decision as "TRADE" | "NO_TRADE" | null) ?? null,
      proposedUsd: n(r.proposed_usd as string),
      rejectionReasons: (r.rejection_reasons as string[] | null) ?? [],
    };
  }).sort((a, b) => b.attractiveness - a.attractiveness);
}

export interface Recommendation {
  candidateId: string;
  recommendedAt: Date;
  marketId: string;
  question: string;
  eventTitle: string | null;
  url: string | null;
  outcomeToBuy: string;
  side: "YES" | "NO";
  /** Probability the recommended outcome wins (the "how sure" number). */
  probability: number;
  /** Reliability score of that probability (analyst agreement × evidence quality). */
  confidence: number;
  /** All-in price per share (ask + fee) when recommended. */
  price: number;
  limitPrice: number | null;
  returnIfRight: number;
  expectedReturn: number;
  recommendedUsd: number;
  bankrollPct: number | null;
  currentPrice: number | null;
  resolvesAt: Date | null;
  status: "ACTIVE" | "PRICE MOVED" | "CLOSED" | "WON" | "LOST" | "VOID";
  paperFilled: boolean;
}

/** TRADE decisions from the entry engine, presented as recommendations. */
export async function getRecommendations(): Promise<Recommendation[]> {
  const rows = (await getDb().execute(sql`
    select c.id, c.created_at, c.side, c.proposed_usd, c.limit_price, c.sizing,
      e.probability_yes, e.confidence,
      m.id as market_id, m.question, m.slug, m.outcomes, m.end_date, m.closed, m.yes_price, m.no_price,
      ev.slug as event_slug, ev.title as event_title,
      r.winning_side, r.payout_yes,
      exists (select 1 from simulated_orders o where o.trade_candidate_id = c.id and o.filled_shares > 0) as filled
    from trade_candidates c
    join probability_estimates e on e.id = c.probability_estimate_id
    join markets m on m.id = c.market_id
    left join polymarket_events ev on ev.id = m.event_id
    left join market_resolutions r on r.market_id = m.id
    where c.decision = 'TRADE'
    order by c.created_at desc
    limit 100
  `)).rows as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const side = row.side as "YES" | "NO";
    const outcomes = (row.outcomes as string[] | null) ?? ["Yes", "No"];
    const pYes = Number(row.probability_yes);
    const probability = side === "YES" ? pYes : 1 - pYes;
    const sizing = (row.sizing ?? {}) as { allInTop?: string; portfolio?: { equity?: string } };
    const limitPrice = n(row.limit_price as string);
    const price = Number(sizing.allInTop ?? limitPrice ?? 0);
    const recommendedUsd = Number(row.proposed_usd ?? 0);
    const equity = n(sizing.portfolio?.equity);
    const currentPrice = n((side === "YES" ? row.yes_price : row.no_price) as string);
    let status: Recommendation["status"] = "ACTIVE";
    if (row.winning_side === side) status = "WON";
    else if (row.winning_side) status = "LOST";
    else if (row.payout_yes != null) status = "VOID";
    else if (row.closed) status = "CLOSED";
    else if (currentPrice != null && limitPrice != null && currentPrice > limitPrice) status = "PRICE MOVED";
    const eventSlug = row.event_slug as string | null;
    return {
      candidateId: row.id as string,
      recommendedAt: new Date(row.created_at as string),
      marketId: row.market_id as string,
      question: row.question as string,
      eventTitle: (row.event_title as string | null) ?? null,
      url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : null,
      outcomeToBuy: (side === "YES" ? outcomes[0] : outcomes[1]) ?? side,
      side,
      probability,
      confidence: Number(row.confidence),
      price,
      limitPrice,
      returnIfRight: price > 0 ? (1 - price) / price : 0,
      expectedReturn: price > 0 ? probability / price - 1 : 0,
      recommendedUsd,
      bankrollPct: equity ? recommendedUsd / equity : null,
      currentPrice,
      resolvesAt: row.end_date ? new Date(row.end_date as string) : null,
      status,
      paperFilled: row.filled === true,
    };
  });
}

export async function getOpenPositions() {
  const db = getDb();
  const rows = await db
    .select({ position: s.positions, question: s.markets.question, endDate: s.markets.endDate, outcomes: s.markets.outcomes })
    .from(s.positions)
    .innerJoin(s.markets, eq(s.positions.marketId, s.markets.id))
    .where(eq(s.positions.status, "OPEN"))
    .orderBy(desc(s.positions.openedAt));
  return rows.map(({ position: p, question, endDate, outcomes }) => {
    const markValue = positionMarkValue(p).toNumber();
    return {
      ...p,
      question,
      endDate,
      outcomeLabel: p.side === "YES" ? outcomes[0] ?? "Yes" : outcomes[1] ?? "No",
      markValue,
      unrealizedPnl: markValue - Number(p.costBasis),
    };
  });
}

export interface TradeFilters {
  side?: "YES" | "NO";
  action?: "OPEN" | "ADD" | "REDUCE" | "EXIT";
  status?: "FILLED" | "PARTIAL" | "UNFILLED";
  category?: string;
}

export async function getTrades(filters: TradeFilters) {
  const conditions: SQL[] = [];
  if (filters.side) conditions.push(eq(s.simulatedOrders.side, filters.side));
  if (filters.action) conditions.push(eq(s.simulatedOrders.action, filters.action));
  if (filters.status) conditions.push(eq(s.simulatedOrders.status, filters.status));
  if (filters.category) conditions.push(eq(s.markets.category, filters.category));
  return getDb()
    .select({ order: s.simulatedOrders, question: s.markets.question, category: s.markets.category, strategyVersion: s.strategyVersions.version })
    .from(s.simulatedOrders)
    .innerJoin(s.markets, eq(s.simulatedOrders.marketId, s.markets.id))
    .innerJoin(s.strategyVersions, eq(s.simulatedOrders.strategyVersionId, s.strategyVersions.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(s.simulatedOrders.createdAt))
    .limit(500);
}

export async function getTradeCategories(): Promise<string[]> {
  const rows = await getDb().selectDistinct({ category: s.markets.category }).from(s.simulatedOrders)
    .innerJoin(s.markets, eq(s.simulatedOrders.marketId, s.markets.id));
  return rows.map((r) => r.category).filter((c): c is string => !!c).sort();
}

export async function getPerformance() {
  const db = getDb();
  const state = await getPortfolioState(db);
  const start = state.startingBankroll.toNumber();
  const snaps = await db.select().from(s.portfolioSnapshots).orderBy(s.portfolioSnapshots.takenAt);
  const series = snaps.map((x) => ({ t: x.takenAt.toISOString(), equity: Number(x.equity) }));
  series.push({ t: new Date().toISOString(), equity: state.equity.toNumber() });
  const dd = maxDrawdown([start, ...series.map((x) => x.equity)]);
  const equitySeries = series.map((x, i) => ({
    ...x,
    drawdown: dd.series[i + 1] ?? 0,
    cumulativeReturn: start > 0 ? (x.equity - start) / start : 0,
  }));

  const closed = (await db.execute(sql`
    select p.id, p.realized_pnl, p.entry_confidence, p.entry_edge, m.category,
      coalesce((select sum(o.notional_usd + o.fees_usd) from simulated_orders o where o.position_id = p.id and o.direction = 'BUY'), 0) as invested
    from positions p join markets m on m.id = p.market_id
    where p.status in ('CLOSED', 'RESOLVED')
  `)).rows as Array<Record<string, string>>;
  const trades: ClosedTrade[] = closed.map((r) => ({
    realizedPnl: Number(r.realized_pnl), invested: Number(r.invested), category: r.category ?? null,
    entryConfidence: Number(r.entry_confidence), entryEdge: Number(r.entry_edge),
  }));

  // Calibration uses the FIRST estimate per market at each stage, made before resolution
  // (no re-forecasting after the fact counts), excluding 50/50 voids.
  const forecasts = (await db.execute(sql`
    select distinct on (e.market_id, e.stage) e.stage, e.probability_yes, r.winning_side
    from probability_estimates e
    join market_resolutions r on r.market_id = e.market_id
    where r.winning_side is not null and e.created_at < r.detected_at
    order by e.market_id, e.stage, e.created_at asc
  `)).rows as Array<{ stage: number; probability_yes: string; winning_side: "YES" | "NO" }>;
  const toForecast = (f: (typeof forecasts)[number]) => ({ probabilityYes: Number(f.probability_yes), resolvedYes: f.winning_side === "YES" });

  return {
    startingBankroll: start,
    equitySeries,
    maxDrawdown: dd.maxDrawdown,
    stats: tradeStats(trades),
    byCategory: groupReturns(trades, (t) => t.category ?? "Uncategorized"),
    byConfidence: groupReturns(trades, (t) => bracketOf(t.entryConfidence, CONFIDENCE_BRACKETS), CONFIDENCE_BRACKETS.map((b) => b.label)),
    byEdge: groupReturns(trades, (t) => bracketOf(t.entryEdge, EDGE_BRACKETS), EDGE_BRACKETS.map((b) => b.label)),
    calibrationDeep: calibration(forecasts.filter((f) => Number(f.stage) === 3).map(toForecast)),
    calibrationQuick: calibration(forecasts.filter((f) => Number(f.stage) === 2).map(toForecast)),
    realizedPnl: state.realizedPnl.toNumber(),
    unrealizedPnl: state.unrealizedPnl.toNumber(),
    equity: state.equity.toNumber(),
  };
}

export async function getMarketResearch(marketId: string) {
  const db = getDb();
  const [market] = await db.select().from(s.markets).where(eq(s.markets.id, marketId)).limit(1);
  if (!market) return null;
  const runs = await db.select().from(s.researchRuns).where(eq(s.researchRuns.marketId, marketId)).orderBy(desc(s.researchRuns.queuedAt)).limit(20);
  const estimates = await db.select().from(s.probabilityEstimates).where(eq(s.probabilityEstimates.marketId, marketId)).orderBy(desc(s.probabilityEstimates.createdAt)).limit(20);
  const latestCompleted = runs.find((r) => r.status === "completed" && r.stage === 3) ?? runs.find((r) => r.status === "completed");
  const analysts = latestCompleted
    ? await db.select().from(s.analystPredictions).where(eq(s.analystPredictions.researchRunId, latestCompleted.id)).orderBy(s.analystPredictions.analystKey)
    : [];
  const sources = latestCompleted
    ? await db.select().from(s.researchSources).where(eq(s.researchSources.researchRunId, latestCompleted.id)).orderBy(s.researchSources.qualityTier)
    : [];
  const candidates = await db.select().from(s.tradeCandidates).where(eq(s.tradeCandidates.marketId, marketId)).orderBy(desc(s.tradeCandidates.createdAt)).limit(10);
  const [resolution] = await db.select().from(s.marketResolutions).where(eq(s.marketResolutions.marketId, marketId)).limit(1);
  const history = await db.select({ t: s.marketPriceHistory.observedAt, yes: s.marketPriceHistory.yesPrice })
    .from(s.marketPriceHistory).where(eq(s.marketPriceHistory.marketId, marketId)).orderBy(desc(s.marketPriceHistory.observedAt)).limit(500);
  return {
    market, runs, estimates, latestRun: latestCompleted ?? null, analysts, sources, candidates, resolution: resolution ?? null,
    priceHistory: history.reverse().map((h) => ({ t: h.t.toISOString(), yes: n(h.yes) })),
  };
}

export async function getActivity() {
  const db = getDb();
  const jobs = await db.select().from(s.systemJobs).orderBy(desc(s.systemJobs.startedAt)).limit(60);
  const running = await db.select({ run: s.researchRuns, question: s.markets.question }).from(s.researchRuns)
    .innerJoin(s.markets, eq(s.researchRuns.marketId, s.markets.id))
    .where(eq(s.researchRuns.status, "running")).orderBy(desc(s.researchRuns.startedAt));
  const recentRuns = await db.select({ run: s.researchRuns, question: s.markets.question }).from(s.researchRuns)
    .innerJoin(s.markets, eq(s.researchRuns.marketId, s.markets.id))
    .orderBy(desc(s.researchRuns.queuedAt)).limit(30);
  const events = await db.select().from(s.auditEvents).orderBy(desc(s.auditEvents.id)).limit(100);
  const [today] = (await db.execute(sql`
    select
      (select count(*)::int from research_runs where stage = 2 and queued_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as stage2_today,
      (select count(*)::int from research_runs where stage = 3 and queued_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as stage3_today,
      (select count(*)::int from trade_candidates where decision = 'NO_TRADE' and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as no_trade_today,
      (select count(*)::int from simulated_orders where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as orders_today,
      (select coalesce(sum(cost_usd), 0) from ai_usage where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as ai_cost_today,
      (select audit_chain_first_break()) as audit_break
  `)).rows as Array<Record<string, string | number | null>>;
  const lastScan = jobs.find((j) => j.jobType === "scan_markets" && j.status === "succeeded");
  return { jobs, running, recentRuns, events, today: today ?? {}, lastScan: lastScan ?? null };
}

export async function getStrategyPage() {
  const db = getDb();
  const active = await getActiveStrategy(db);
  const versions = await db.select().from(s.strategyVersions).orderBy(desc(s.strategyVersions.version));
  return { active, versions };
}

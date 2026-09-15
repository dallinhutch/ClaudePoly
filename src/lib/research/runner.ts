import { eq, gte, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db, DbOrTx } from "@/db/client";
import { aiUsage, analystPredictions, markets, polymarketEvents, probabilityEstimates, researchRuns, researchSources } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { dec, toDb, ZERO, type Dec } from "@/lib/decimal";
import { captureBothBooks } from "@/lib/polymarket/books";
import type { ActiveStrategy } from "@/lib/strategy/service";
import { feeModelFromMarket, feePerShare } from "@/lib/trading/execution";
import { bestSide } from "@/lib/trading/probability";
import { aggregateAnalysts, type AggregateResult, type AnalystInput } from "./aggregate";
import { AgentCallError, runSubmitAgent, type AgentResult, type AgentSpend } from "./claude";
import {
  ANALYST_PERSPECTIVES, analystPrompt, dossierPrompt, quickEstimatePrompt, recentDevelopmentsFocus, RESEARCH_SYSTEM, type MarketBrief,
} from "./prompts";
import {
  AnalystEstimateSchema, clampTier, DossierSchema, probabilityProblems, QuickEstimateSchema, type Dossier, type SourceSchema,
} from "./schemas";
import { parseIsoDate, type StoredDossier } from "./signals";

type MarketRow = typeof markets.$inferSelect;
type EventRow = typeof polymarketEvents.$inferSelect;

export class BudgetExceededError extends Error {}

/** "review" = re-checking an open position; it may use the reserved slice of the budget. */
export type ResearchPurpose = "discovery" | "review";

const startOfUtcDay = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;

export async function aiSpendTodayUsd(db: DbOrTx): Promise<Dec> {
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` }).from(aiUsage).where(gte(aiUsage.createdAt, startOfUtcDay));
  return dec(row?.total ?? 0);
}

export async function aiSpendTotalUsd(db: DbOrTx): Promise<Dec> {
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` }).from(aiUsage);
  return dec(row?.total ?? 0);
}

async function assertBudget(db: DbOrTx, strategy: ActiveStrategy, stage: 2 | 3, purpose: ResearchPurpose) {
  const r = strategy.config.research;
  const expected = stage === 2 ? r.expectedStage2CostUsd : r.expectedStage3CostUsd;
  const share = purpose === "review" ? 1 : 1 - r.reviewBudgetReservePct;
  const [today, total] = await Promise.all([aiSpendTodayUsd(db), aiSpendTotalUsd(db)]);
  if (today.plus(expected).gt(r.dailyBudgetUsd * share)) {
    throw new BudgetExceededError(`daily AI budget: $${today.toFixed(2)} spent today; stage-${stage} (~$${expected}) would exceed $${(r.dailyBudgetUsd * share).toFixed(2)} for ${purpose}`);
  }
  if (total.plus(expected).gt(r.totalBudgetUsd * share)) {
    throw new BudgetExceededError(`total AI budget: $${total.toFixed(2)} spent overall; stage-${stage} (~$${expected}) would exceed $${(r.totalBudgetUsd * share).toFixed(2)} for ${purpose}`);
  }
}

export async function loadMarket(db: DbOrTx, marketId: string): Promise<{ market: MarketRow; event: EventRow | null }> {
  const [row] = await db.select().from(markets).leftJoin(polymarketEvents, eq(markets.eventId, polymarketEvents.id)).where(eq(markets.id, marketId)).limit(1);
  if (!row) throw new Error(`market ${marketId} not found`);
  return { market: row.markets, event: row.polymarket_events };
}

export function buildBrief(market: MarketRow, event: EventRow | null, now: Date): MarketBrief {
  return {
    question: market.question,
    yesOutcomeLabel: market.outcomes[0] ?? "Yes",
    noOutcomeLabel: market.outcomes[1] ?? "No",
    eventTitle: event?.title ?? null,
    groupItemTitle: market.groupItemTitle,
    rules: market.description ?? event?.description ?? "",
    resolutionSource: market.resolutionSource,
    endDate: market.endDate?.toISOString() ?? null,
    category: market.category,
    nowIso: now.toISOString(),
  };
}

/** Prices at research start — stored for the audit trail, never shown to the model. */
function marketSnapshot(m: MarketRow) {
  return {
    yesPrice: m.yesPrice, noPrice: m.noPrice, bestBid: m.bestBid, bestAsk: m.bestAsk, spread: m.spread,
    liquidityUsd: m.liquidityUsd, volume24hUsd: m.volume24hUsd, pricesAsOf: m.updatedAt.toISOString(),
  };
}

const normalizeUrl = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

async function storeSources(db: DbOrTx, runId: string, sources: Array<z.infer<typeof SourceSchema>>, retrievedUrls: string[]) {
  if (sources.length === 0) return;
  const retrieved = new Set(retrievedUrls.map(normalizeUrl));
  await db.insert(researchSources).values(sources.map((s) => ({
    researchRunId: runId,
    url: s.url,
    title: s.title,
    publisher: s.publisher,
    sourceType: s.source_type,
    qualityTier: clampTier(s.quality_tier),
    publishedAt: parseIsoDate(s.published_date),
    usedFor: s.used_for,
    excerpt: retrieved.has(normalizeUrl(s.url)) ? null : "UNVERIFIED: this URL was not returned by a search/fetch tool during the run",
  })));
}

async function recordUsage(db: DbOrTx, runId: string, purpose: string, s: AgentSpend) {
  if (s.usage.inputTokens === 0 && s.usage.outputTokens === 0 && s.costUsd.isZero()) return;
  await db.insert(aiUsage).values({
    researchRunId: runId,
    purpose,
    model: s.models.join(",") || "unknown",
    inputTokens: s.usage.inputTokens,
    outputTokens: s.usage.outputTokens,
    cacheCreationTokens: s.usage.cacheCreationTokens,
    cacheReadTokens: s.usage.cacheReadTokens,
    webSearchRequests: s.usage.webSearchRequests,
    costUsd: toDb(s.costUsd),
  });
}

/** Every agent call goes through here so its cost is recorded whether it succeeds or fails. */
async function callAgent<T>(db: DbOrTx, runId: string, purpose: string, spent: AgentSpend[], call: () => Promise<AgentResult<T>>): Promise<AgentResult<T>> {
  try {
    const r = await call();
    spent.push(r);
    await recordUsage(db, runId, purpose, r);
    return r;
  } catch (err) {
    if (err instanceof AgentCallError) {
      spent.push(err.spend);
      await recordUsage(db, runId, `${purpose}_failed`, err.spend);
    }
    throw err;
  }
}

function totals(spent: AgentSpend[]) {
  return spent.reduce(
    (t, r) => ({
      inputTokens: t.inputTokens + r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheCreationTokens,
      outputTokens: t.outputTokens + r.usage.outputTokens,
      webSearchRequests: t.webSearchRequests + r.usage.webSearchRequests,
      costUsd: t.costUsd.plus(r.costUsd),
    }),
    { inputTokens: 0, outputTokens: 0, webSearchRequests: 0, costUsd: ZERO },
  );
}

export interface EstimateOutcome {
  runId: string;
  estimateId: string;
  stage: 2 | 3;
  probabilityYes: Dec;
  confidence: Dec;
  bestSide: "YES" | "NO" | null;
  bestEdge: Dec | null;
  costUsd: Dec;
}

async function insertEstimate(db: Db, args: {
  market: MarketRow;
  runId: string;
  strategy: ActiveStrategy;
  stage: 2 | 3;
  agg: AggregateResult;
  method: Record<string, unknown>;
}) {
  // Books are captured AFTER research finishes: the estimate is compared with
  // the prices that are actually tradable at the moment it exists.
  const books = await captureBothBooks(db, args.market);
  const fee = feeModelFromMarket(args.market.feesEnabled, args.market.feeSchedule);
  const allIn = (ask: string | null) => (ask == null ? null : dec(ask).plus(feePerShare(ask, fee)));
  const sides = bestSide(args.agg.probabilityYes, allIn(books.yes.bestAsk), allIn(books.no.bestAsk));
  const mid = books.yes.bestBid && books.yes.bestAsk ? dec(books.yes.bestBid).plus(books.yes.bestAsk).div(2) : null;

  const [row] = await db.insert(probabilityEstimates).values({
    marketId: args.market.id,
    researchRunId: args.runId,
    strategyVersionId: args.strategy.id,
    stage: args.stage,
    analystCount: args.agg.usedCount,
    meanProb: toDb(args.agg.mean),
    medianProb: toDb(args.agg.median),
    stdevProb: toDb(args.agg.stdev),
    probabilityYes: toDb(args.agg.probabilityYes),
    confidence: toDb(args.agg.confidence),
    evidenceQuality: toDb(args.agg.evidenceQuality),
    yesBid: books.yes.bestBid,
    yesAsk: books.yes.bestAsk,
    noBid: books.no.bestBid,
    noAsk: books.no.bestAsk,
    marketMid: mid ? toDb(mid) : args.market.yesPrice,
    edgeYes: sides.yes ? toDb(sides.yes.edge) : null,
    edgeNo: sides.no ? toDb(sides.no.edge) : null,
    evPerDollarYes: sides.yes ? toDb(sides.yes.evPerDollar) : null,
    evPerDollarNo: sides.no ? toDb(sides.no.evPerDollar) : null,
    bestSide: sides.best?.side ?? null,
    yesBookSnapshotId: books.yes.snapshotId,
    noBookSnapshotId: books.no.snapshotId,
    method: {
      aggregation: "confidence*evidence weighted log-odds pool; weak analyses excluded; confidence penalized by disagreement",
      edgePricing: "top-of-book ask plus Polymarket taker fee",
      excludedAnalysts: args.agg.excluded,
      disagreementFactor: args.agg.disagreementFactor.toFixed(6),
      ...args.method,
    },
  }).returning({ id: probabilityEstimates.id });
  return { estimateId: row!.id, sides };
}

async function startRun(db: Db, market: MarketRow, strategy: ActiveStrategy, stage: 2 | 3, trigger: string, parentRunId: string | null) {
  const cfg = strategy.config.research;
  const [run] = await db.insert(researchRuns).values({
    marketId: market.id,
    stage,
    status: "running",
    parentRunId,
    strategyVersionId: strategy.id,
    trigger,
    model: cfg.model,
    effort: stage === 2 ? cfg.stage2Effort : cfg.stage3Effort,
    startedAt: new Date(),
    marketSnapshot: marketSnapshot(market),
  }).returning({ id: researchRuns.id });
  await recordAudit(db, "research.started", "research_run", run!.id, { marketId: market.id, stage, trigger, strategyVersion: strategy.version });
  return run!.id;
}

async function failRun(db: Db, runId: string, err: unknown, spent: AgentSpend[]) {
  const t = totals(spent);
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  await db.update(researchRuns).set({
    status: "failed", completedAt: new Date(), error: message.slice(0, 2000),
    inputTokens: t.inputTokens, outputTokens: t.outputTokens, webSearchRequests: t.webSearchRequests, costUsd: toDb(t.costUsd),
  }).where(eq(researchRuns.id, runId));
  await recordAudit(db, "research.failed", "research_run", runId, { error: message, costUsd: t.costUsd });
}

async function completeRun(db: Db, runId: string, dossier: StoredDossier, spent: AgentSpend[]) {
  const t = totals(spent);
  await db.update(researchRuns).set({
    status: "completed", completedAt: new Date(), dossier,
    inputTokens: t.inputTokens, outputTokens: t.outputTokens, webSearchRequests: t.webSearchRequests, costUsd: toDb(t.costUsd),
  }).where(eq(researchRuns.id, runId));
  return t;
}

/** Stage 2: one low-effort pass with a few searches. Decides whether stage 3 is worth paying for. */
export async function runStage2(db: Db, strategy: ActiveStrategy, marketId: string, trigger: string, purpose: ResearchPurpose = "discovery"): Promise<EstimateOutcome> {
  const cfg = strategy.config.research;
  await assertBudget(db, strategy, 2, purpose);
  const { market, event } = await loadMarket(db, marketId);
  const runId = await startRun(db, market, strategy, 2, trigger, null);
  const spent: AgentSpend[] = [];
  try {
    const brief = buildBrief(market, event, new Date());
    const r = await callAgent(db, runId, "stage2_quick_estimate", spent, () => runSubmitAgent({
      model: cfg.model,
      effort: cfg.stage2Effort,
      system: RESEARCH_SYSTEM,
      prompt: quickEstimatePrompt(brief, cfg.stage2MaxWebSearches),
      submitTool: { name: "submit_quick_estimate", description: "Submit the first-pass forecast for this contract.", schema: QuickEstimateSchema },
      maxWebSearches: cfg.stage2MaxWebSearches,
      blockedDomains: cfg.blockedDomains,
      validate: probabilityProblems,
    }));
    const q = r.output;
    await storeSources(db, runId, q.sources, r.retrievedUrls);
    await db.insert(analystPredictions).values({
      researchRunId: runId, analystKey: "quick", perspective: "Stage-2 generalist",
      probabilityYes: toDb(q.probability_yes), confidence: toDb(q.confidence), evidenceQuality: toDb(q.evidence_quality),
      reasoning: q.reasoning, details: { key_points: q.key_points, resolution_clarity: q.resolution_clarity },
      model: r.models.join(","), inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: toDb(r.costUsd),
    });

    const agg = aggregateAnalysts(
      [{ analystKey: "quick", probabilityYes: q.probability_yes, confidence: q.confidence, evidenceQuality: q.evidence_quality }],
      { minAnalystEvidenceQuality: cfg.minAnalystEvidenceQuality, disagreementScale: cfg.disagreementScale },
    );
    const { estimateId, sides } = await insertEstimate(db, { market, runId, strategy, stage: 2, agg, method: { analysts: ["quick"] } });
    const t = await completeRun(db, runId, { stage: 2, quickEstimate: q }, spent);
    await recordAudit(db, "research.completed", "research_run", runId, {
      stage: 2, estimateId, probabilityYes: agg.probabilityYes, confidence: agg.confidence, bestSide: sides.best?.side ?? null, costUsd: t.costUsd,
    });
    return { runId, estimateId, stage: 2, probabilityYes: agg.probabilityYes, confidence: agg.confidence, bestSide: sides.best?.side ?? null, bestEdge: sides.best?.edge ?? null, costUsd: t.costUsd };
  } catch (err) {
    await failRun(db, runId, err, spent);
    throw err;
  }
}

/** Stage 3: evidence dossier, then N independent analysts, then aggregation. */
export async function runStage3(db: Db, strategy: ActiveStrategy, marketId: string, opts: {
  trigger: string;
  parentRunId?: string | null;
  lastResearchedAt?: Date | null;
  purpose?: ResearchPurpose;
}): Promise<EstimateOutcome> {
  const cfg = strategy.config.research;
  await assertBudget(db, strategy, 3, opts.purpose ?? "discovery");
  const { market, event } = await loadMarket(db, marketId);
  const runId = await startRun(db, market, strategy, 3, opts.trigger, opts.parentRunId ?? null);
  const spent: AgentSpend[] = [];
  try {
    const brief = buildBrief(market, event, new Date());
    const focus = opts.lastResearchedAt ? recentDevelopmentsFocus(opts.lastResearchedAt.toISOString()) : "";
    const dossierResult = await callAgent(db, runId, "stage3_dossier", spent, () => runSubmitAgent({
      model: cfg.model,
      effort: cfg.stage3Effort,
      system: RESEARCH_SYSTEM,
      prompt: dossierPrompt(brief, cfg.stage3MaxWebSearches) + focus,
      submitTool: { name: "submit_dossier", description: "Submit the completed research dossier.", schema: DossierSchema },
      maxWebSearches: cfg.stage3MaxWebSearches,
      blockedDomains: cfg.blockedDomains,
      validate: (d) => {
        const p: string[] = [];
        if (!(d.data_quality.score >= 0 && d.data_quality.score <= 1)) p.push("data_quality.score must be within 0..1");
        if (d.base_rate.rate != null && !(d.base_rate.rate >= 0 && d.base_rate.rate <= 1)) p.push("base_rate.rate must be within 0..1 or null");
        return p;
      },
    }));
    const dossier: Dossier = dossierResult.output;
    await storeSources(db, runId, dossier.sources, dossierResult.retrievedUrls);

    const perspectives = Array.from({ length: cfg.analystCount }, (_, i) => {
      const p = ANALYST_PERSPECTIVES[i % ANALYST_PERSPECTIVES.length]!;
      return { ...p, key: i < ANALYST_PERSPECTIVES.length ? p.key : `${p.key}_${i}` };
    });
    const settled = await Promise.allSettled(perspectives.map((p) => callAgent(db, runId, `stage3_analyst_${p.key}`, spent, () => runSubmitAgent({
      model: cfg.model,
      effort: cfg.stage3Effort,
      system: RESEARCH_SYSTEM,
      prompt: analystPrompt(brief, dossier, p, cfg.analystMaxWebSearches),
      submitTool: { name: "submit_estimate", description: "Submit your independent forecast for this contract.", schema: AnalystEstimateSchema },
      maxWebSearches: cfg.analystMaxWebSearches,
      blockedDomains: cfg.blockedDomains,
      validate: probabilityProblems,
    }))));

    const inputs: AnalystInput[] = [];
    const analystFailures: string[] = [];
    for (const [i, s] of settled.entries()) {
      const p = perspectives[i]!;
      if (s.status === "rejected") {
        analystFailures.push(`${p.key}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
        continue;
      }
      const r = s.value;
      const a = r.output;
      await storeSources(db, runId, a.additional_sources, r.retrievedUrls);
      await db.insert(analystPredictions).values({
        researchRunId: runId, analystKey: p.key, perspective: p.name,
        probabilityYes: toDb(a.probability_yes), confidence: toDb(a.confidence), evidenceQuality: toDb(a.evidence_quality),
        reasoning: a.reasoning,
        details: { key_factors: a.key_factors, main_uncertainties: a.main_uncertainties, disagreements_with_dossier: a.disagreements_with_dossier, base_rate_used: a.base_rate_used },
        model: r.models.join(","), inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: toDb(r.costUsd),
      });
      inputs.push({ analystKey: p.key, probabilityYes: a.probability_yes, confidence: a.confidence, evidenceQuality: a.evidence_quality });
    }
    const minAnalysts = Math.max(2, Math.ceil(cfg.analystCount * 0.6));
    if (inputs.length < minAnalysts) {
      throw new Error(`only ${inputs.length}/${cfg.analystCount} analysts succeeded (need ${minAnalysts}): ${analystFailures.join(" | ")}`);
    }

    const agg = aggregateAnalysts(inputs, { minAnalystEvidenceQuality: cfg.minAnalystEvidenceQuality, disagreementScale: cfg.disagreementScale });
    const { estimateId, sides } = await insertEstimate(db, {
      market, runId, strategy, stage: 3, agg,
      method: { analysts: inputs.map((i) => i.analystKey), analystFailures, dossierDataQuality: dossier.data_quality.score },
    });
    const t = await completeRun(db, runId, { stage: 3, dossier, analystFailures }, spent);
    await recordAudit(db, "research.completed", "research_run", runId, {
      stage: 3, estimateId, analysts: inputs, probabilityYes: agg.probabilityYes, confidence: agg.confidence, stdev: agg.stdev,
      bestSide: sides.best?.side ?? null, bestEdge: sides.best?.edge ?? null, costUsd: t.costUsd,
    });
    return { runId, estimateId, stage: 3, probabilityYes: agg.probabilityYes, confidence: agg.confidence, bestSide: sides.best?.side ?? null, bestEdge: sides.best?.edge ?? null, costUsd: t.costUsd };
  } catch (err) {
    await failRun(db, runId, err, spent);
    throw err;
  }
}

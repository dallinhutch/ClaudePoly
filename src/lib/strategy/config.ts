import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The single source of truth for every tunable trading/research threshold.
 * Code must read thresholds from a StrategyConfig instance, never hardcode them.
 * Any change to a config creates a new immutable strategy_versions row.
 */
export const StrategyConfigSchema = z.object({
  scanner: z.object({
    /** Full metadata + price refresh of all active markets. */
    marketRefreshMinutes: z.number().int().min(1).default(15),
    /** Price-only refresh for markets we hold or are researching. */
    watchedPriceRefreshMinutes: z.number().int().min(1).default(5),
  }).prefault({}),

  screening: z.object({
    minLiquidityUsd: z.number().min(0).default(5_000),
    minVolume24hUsd: z.number().min(0).default(1_000),
    minHoursToResolution: z.number().min(0).default(48),
    maxDaysToResolution: z.number().min(1).default(180),
    /** Skip extreme tails: little upside and dominated by fees/noise. */
    minYesPrice: z.number().min(0).max(1).default(0.04),
    maxYesPrice: z.number().min(0).max(1).default(0.96),
    maxSpread: z.number().min(0).max(1).default(0.04),
    /** Case-insensitive substrings; matches in the question reject the market. */
    excludedQuestionPatterns: z.array(z.string()).default([
      "up or down", "price of bitcoin", "price of ethereum", "price of solana",
      "handicap", "o/u ", "spread:", "exact score", "set 1", "map 1", "tweets",
    ]),
    excludedTags: z.array(z.string()).default(["Crypto Prices", "Esports", "Mentions"]),
    minScreenScore: z.number().min(0).max(1).default(0.55),
    maxStage2PerCycle: z.number().int().min(0).default(6),
  }).prefault({}),

  research: z.object({
    model: z.string().default("claude-opus-5"),
    stage2Effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
    stage3Effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
    stage2MaxWebSearches: z.number().int().min(0).default(4),
    stage3MaxWebSearches: z.number().int().min(0).default(15),
    analystCount: z.number().int().min(1).max(9).default(5),
    /** Each analyst may run a few searches of its own to verify or challenge the shared dossier. */
    analystMaxWebSearches: z.number().int().min(0).default(2),
    /**
     * Prediction-market / odds sites are blocked from research so estimates stay
     * independent of market prices (no anchoring, clean calibration measurement).
     */
    blockedDomains: z.array(z.string()).default([
      "polymarket.com", "kalshi.com", "manifold.markets", "predictit.org", "oddschecker.com", "betfair.com", "smarkets.com",
    ]),
    /** Stage-2 |estimate - market| needed to escalate to expensive stage 3. */
    stage3MinRawEdge: z.number().min(0).max(1).default(0.08),
    maxStage3PerDay: z.number().int().min(0).default(8),
    /** Don't re-research the same market more often than this (unless held). */
    cooldownHours: z.number().min(0).default(24),
    dailyBudgetUsd: z.number().min(0).default(10),
    /** Share of the daily budget new-market research may NOT use, so open positions can always be re-reviewed. */
    reviewBudgetReservePct: z.number().min(0).max(1).default(0.25),
    /** How often the worker looks for new markets to research. */
    pipelineIntervalMinutes: z.number().int().min(1).default(15),
    /** Analysts below this evidence quality are excluded from aggregation (unless all are). */
    minAnalystEvidenceQuality: z.number().min(0).max(1).default(0.3),
    /** Scale for the disagreement penalty: confidence *= exp(-(stdev/scale)^2). */
    disagreementScale: z.number().positive().default(0.15),
  }).prefault({}),

  qualification: z.object({
    minConfidence: z.number().min(0).max(1).default(0.8),
    /** Percentage points, as a fraction: 0.12 = 12pp between our prob and the fill price. */
    minEdge: z.number().min(0).max(1).default(0.12),
    minEvPerDollar: z.number().min(0).default(0.15),
    minLiquidityUsd: z.number().min(0).default(10_000),
    maxAnalystStdev: z.number().min(0).max(1).default(0.1),
    minEvidenceQuality: z.number().min(0).max(1).default(0.6),
    maxInformationAgeHours: z.number().min(0).default(72),
    requireClearResolution: z.boolean().default(true),
    maxUnresolvedContradictions: z.number().int().min(0).default(0),
    minHoursToResolution: z.number().min(0).default(24),
  }).prefault({}),

  sizing: z.object({
    startingBankrollUsd: z.number().positive().default(1_000),
    /** Fraction of full Kelly. 0.25 = quarter Kelly. */
    kellyFraction: z.number().min(0).max(1).default(0.25),
    maxPositionPctBankroll: z.number().min(0).max(1).default(0.05),
    maxTotalExposurePct: z.number().min(0).max(1).default(0.5),
    maxCategoryExposurePct: z.number().min(0).max(1).default(0.2),
    /** Positions in the same Polymarket event are treated as correlated. */
    maxCorrelatedExposurePct: z.number().min(0).max(1).default(0.1),
    minCashReservePct: z.number().min(0).max(1).default(0.2),
    minOrderUsd: z.number().min(0).default(5),
    /** Never take more than this fraction of visible ask depth inside the limit price. */
    maxBookDepthFraction: z.number().min(0).max(1).default(0.25),
    /** Positions resolving further out than this get sized down (capital lock-up). */
    longDatedDays: z.number().min(1).default(90),
    longDatedFactor: z.number().min(0).max(1).default(0.5),
    drawdownThrottleStart: z.number().min(0).max(1).default(0.1),
    drawdownHalt: z.number().min(0).max(1).default(0.3),
  }).prefault({}),

  execution: z.object({
    /** Limit price = our fair value minus this required margin (for buys). */
    limitEdgeBuffer: z.number().min(0).max(1).default(0.12),
    /** Max price we'll walk above best ask while filling. */
    maxSlippage: z.number().min(0).max(1).default(0.02),
  }).prefault({}),

  monitoring: z.object({
    /** How often open positions are marked and checked (cheap; research only runs when due). */
    checkIntervalMinutes: z.number().int().min(1).default(15),
    reevaluateEveryHours: z.number().min(1).default(12),
    /** If a routine stage-2 review moves P(YES) by at least this much, run full stage-3 research. */
    deepReviewDelta: z.number().min(0).max(1).default(0.1),
    /** Re-run research if price moved this much since last estimate. */
    priceMoveTrigger: z.number().min(0).max(1).default(0.07),
    /** Exit if remaining edge (at the bid) falls below this. Negative = thesis now against us. */
    exitBelowEdge: z.number().min(-1).max(1).default(-0.03),
    /** Reduce by half if remaining edge falls below this. */
    reduceBelowEdge: z.number().min(-1).max(1).default(0.02),
    allowAdd: z.boolean().default(true),
    maxAddsPerPosition: z.number().int().min(0).default(1),
    /** ADD blocked if price has moved against the entry by more than this (no averaging down). */
    maxAdverseMoveForAdd: z.number().min(0).max(1).default(0.02),
  }).prefault({}),
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export function defaultStrategyConfig(): StrategyConfig {
  return StrategyConfigSchema.parse({});
}

/** Stable JSON: sorted keys, so identical configs always hash identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashStrategyConfig(config: StrategyConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

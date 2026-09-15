/**
 * Relational schema. Tables marked APPEND-ONLY are protected by database
 * triggers (see the integrity migration): UPDATE and DELETE raise an error.
 * Historical predictions, orders, fills, ledger entries and audit events can
 * therefore never be silently altered after the fact.
 */
import { sql } from "drizzle-orm";
import {
  bigserial, boolean, check, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const usd = (name: string) => numeric(name, { precision: 20, scale: 6 });
const prob = (name: string) => numeric(name, { precision: 10, scale: 6 });
const qty = (name: string) => numeric(name, { precision: 20, scale: 6 });
const createdAt = () => ts("created_at").defaultNow().notNull();

export const outcomeSide = pgEnum("outcome_side", ["YES", "NO"]);
export const researchStatus = pgEnum("research_status", ["queued", "running", "completed", "failed"]);
export const tradeDecision = pgEnum("trade_decision", ["TRADE", "NO_TRADE"]);
export const orderAction = pgEnum("order_action", ["OPEN", "ADD", "REDUCE", "EXIT"]);
export const orderDirection = pgEnum("order_direction", ["BUY", "SELL"]);
export const orderStatus = pgEnum("order_status", ["FILLED", "PARTIAL", "UNFILLED"]);
export const positionStatus = pgEnum("position_status", ["OPEN", "CLOSED", "RESOLVED"]);
export const positionAction = pgEnum("position_action", ["OPEN", "HOLD", "REDUCE", "EXIT", "ADD", "RESOLVE"]);
export const ledgerEntryType = pgEnum("ledger_entry_type", ["DEPOSIT", "BUY", "SELL", "RESOLUTION_PAYOUT"]);
export const jobStatus = pgEnum("job_status", ["running", "succeeded", "failed"]);

// ---------------------------------------------------------------- auth

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  /** sha256(token) — the raw token only ever lives in the cookie. */
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: ts("expires_at").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const loginAttempts = pgTable("login_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  email: text("email"),
  ip: text("ip").notNull(),
  success: boolean("success").notNull(),
  createdAt: createdAt(),
}, (t) => [index("login_attempts_ip_time_idx").on(t.ip, t.createdAt)]);

// ---------------------------------------------------------------- strategy

/** APPEND-ONLY. A config never changes; a change is a new version. */
export const strategyVersions = pgTable("strategy_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull().unique(),
  config: jsonb("config").notNull(),
  configHash: text("config_hash").notNull().unique(),
  notes: text("notes"),
  createdAt: createdAt(),
});

/** APPEND-ONLY. The active strategy is the most recent activation. */
export const strategyActivations = pgTable("strategy_activations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  strategyVersionId: uuid("strategy_version_id").notNull().references(() => strategyVersions.id),
  activatedAt: ts("activated_at").defaultNow().notNull(),
  reason: text("reason"),
});

// ---------------------------------------------------------------- markets

export const polymarketEvents = pgTable("polymarket_events", {
  id: text("id").primaryKey(),
  slug: text("slug"),
  title: text("title").notNull(),
  description: text("description"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  negRisk: boolean("neg_risk").notNull().default(false),
  endDate: ts("end_date"),
  active: boolean("active").notNull(),
  closed: boolean("closed").notNull(),
  firstSeenAt: ts("first_seen_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const markets = pgTable("markets", {
  id: text("id").primaryKey(),
  conditionId: text("condition_id").notNull(),
  eventId: text("event_id").references(() => polymarketEvents.id),
  slug: text("slug"),
  question: text("question").notNull(),
  groupItemTitle: text("group_item_title"),
  description: text("description"),
  resolutionSource: text("resolution_source"),
  category: text("category"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  outcomes: jsonb("outcomes").$type<string[]>().notNull(),
  yesTokenId: text("yes_token_id"),
  noTokenId: text("no_token_id"),
  startDate: ts("start_date"),
  endDate: ts("end_date"),
  active: boolean("active").notNull(),
  closed: boolean("closed").notNull(),
  acceptingOrders: boolean("accepting_orders").notNull().default(false),
  enableOrderBook: boolean("enable_order_book").notNull().default(false),
  negRisk: boolean("neg_risk").notNull().default(false),
  yesPrice: prob("yes_price"),
  noPrice: prob("no_price"),
  bestBid: prob("best_bid"),
  bestAsk: prob("best_ask"),
  lastTradePrice: prob("last_trade_price"),
  spread: prob("spread"),
  liquidityUsd: usd("liquidity_usd"),
  volumeUsd: usd("volume_usd"),
  volume24hUsd: usd("volume_24h_usd"),
  feesEnabled: boolean("fees_enabled").notNull().default(false),
  feeSchedule: jsonb("fee_schedule"),
  minTickSize: prob("min_tick_size"),
  minOrderSize: qty("min_order_size"),
  umaResolutionStatus: text("uma_resolution_status"),
  firstSeenAt: ts("first_seen_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
  raw: jsonb("raw"),
}, (t) => [
  index("markets_open_idx").on(t.closed, t.active),
  index("markets_end_date_idx").on(t.endDate),
  index("markets_event_idx").on(t.eventId),
]);

/** APPEND-ONLY price observations. */
export const marketPriceHistory = pgTable("market_price_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  observedAt: ts("observed_at").defaultNow().notNull(),
  source: text("source").notNull(),
  yesPrice: prob("yes_price"),
  noPrice: prob("no_price"),
  bestBid: prob("best_bid"),
  bestAsk: prob("best_ask"),
  lastTradePrice: prob("last_trade_price"),
  spread: prob("spread"),
  liquidityUsd: usd("liquidity_usd"),
  volume24hUsd: usd("volume_24h_usd"),
}, (t) => [index("price_history_market_time_idx").on(t.marketId, t.observedAt)]);

export interface BookLevel { price: string; size: string }

/** APPEND-ONLY. The exact book every simulated fill was computed against. */
export const orderbookSnapshots = pgTable("orderbook_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id),
  tokenId: text("token_id").notNull(),
  side: outcomeSide("side").notNull(),
  observedAt: ts("observed_at").defaultNow().notNull(),
  exchangeTimestamp: text("exchange_timestamp"),
  bookHash: text("book_hash"),
  bestBid: prob("best_bid"),
  bestAsk: prob("best_ask"),
  bids: jsonb("bids").$type<BookLevel[]>().notNull(),
  asks: jsonb("asks").$type<BookLevel[]>().notNull(),
}, (t) => [index("orderbook_market_time_idx").on(t.marketId, t.observedAt)]);

/** APPEND-ONLY. Stage-1 rule-based screening outcome. */
export const screeningResults = pgTable("screening_results", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  marketId: text("market_id").notNull().references(() => markets.id),
  strategyVersionId: uuid("strategy_version_id").notNull().references(() => strategyVersions.id),
  createdAt: createdAt(),
  score: prob("score").notNull(),
  passed: boolean("passed").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  features: jsonb("features").notNull(),
}, (t) => [index("screening_market_time_idx").on(t.marketId, t.createdAt)]);

// ---------------------------------------------------------------- research

/**
 * Mutable only while queued/running; once completed or failed a trigger locks it.
 * `marketSnapshot` records market prices at research time for the audit trail —
 * it is never shown to analysts.
 */
export const researchRuns = pgTable("research_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id),
  stage: integer("stage").notNull(),
  status: researchStatus("status").notNull().default("queued"),
  parentRunId: uuid("parent_run_id"),
  strategyVersionId: uuid("strategy_version_id").notNull().references(() => strategyVersions.id),
  trigger: text("trigger").notNull(),
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  queuedAt: ts("queued_at").defaultNow().notNull(),
  startedAt: ts("started_at"),
  completedAt: ts("completed_at"),
  marketSnapshot: jsonb("market_snapshot"),
  dossier: jsonb("dossier"),
  error: text("error"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  webSearchRequests: integer("web_search_requests").notNull().default(0),
  costUsd: usd("cost_usd").notNull().default("0"),
}, (t) => [
  index("research_market_time_idx").on(t.marketId, t.queuedAt),
  index("research_status_idx").on(t.status),
  check("research_stage_valid", sql`${t.stage} in (2, 3)`),
]);

/** APPEND-ONLY. */
export const researchSources = pgTable("research_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  researchRunId: uuid("research_run_id").notNull().references(() => researchRuns.id),
  url: text("url").notNull(),
  title: text("title"),
  publisher: text("publisher"),
  sourceType: text("source_type").notNull(),
  /** 1 = official/primary ... 5 = weak/unverified. */
  qualityTier: integer("quality_tier").notNull(),
  publishedAt: ts("published_at"),
  retrievedAt: ts("retrieved_at").defaultNow().notNull(),
  usedFor: text("used_for"),
  excerpt: text("excerpt"),
}, (t) => [
  index("sources_run_idx").on(t.researchRunId),
  check("sources_tier_valid", sql`${t.qualityTier} between 1 and 5`),
]);

/** APPEND-ONLY. */
export const analystPredictions = pgTable("analyst_predictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  researchRunId: uuid("research_run_id").notNull().references(() => researchRuns.id),
  analystKey: text("analyst_key").notNull(),
  perspective: text("perspective").notNull(),
  probabilityYes: prob("probability_yes").notNull(),
  confidence: prob("confidence").notNull(),
  evidenceQuality: prob("evidence_quality").notNull(),
  reasoning: text("reasoning").notNull(),
  details: jsonb("details").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: usd("cost_usd").notNull().default("0"),
  createdAt: createdAt(),
}, (t) => [
  index("analyst_run_idx").on(t.researchRunId),
  check("analyst_prob_valid", sql`${t.probabilityYes} between 0 and 1`),
]);

/** APPEND-ONLY. Every estimate counts toward calibration, traded or not. */
export const probabilityEstimates = pgTable("probability_estimates", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id),
  researchRunId: uuid("research_run_id").notNull().references(() => researchRuns.id),
  strategyVersionId: uuid("strategy_version_id").notNull().references(() => strategyVersions.id),
  createdAt: createdAt(),
  stage: integer("stage").notNull(),
  analystCount: integer("analyst_count").notNull(),
  meanProb: prob("mean_prob").notNull(),
  medianProb: prob("median_prob").notNull(),
  stdevProb: prob("stdev_prob").notNull(),
  probabilityYes: prob("probability_yes").notNull(),
  confidence: prob("confidence").notNull(),
  evidenceQuality: prob("evidence_quality").notNull(),
  yesBid: prob("yes_bid"),
  yesAsk: prob("yes_ask"),
  noBid: prob("no_bid"),
  noAsk: prob("no_ask"),
  marketMid: prob("market_mid"),
  edgeYes: prob("edge_yes"),
  edgeNo: prob("edge_no"),
  evPerDollarYes: numeric("ev_per_dollar_yes", { precision: 20, scale: 6 }),
  evPerDollarNo: numeric("ev_per_dollar_no", { precision: 20, scale: 6 }),
  bestSide: outcomeSide("best_side"),
  yesBookSnapshotId: uuid("yes_book_snapshot_id").references(() => orderbookSnapshots.id),
  noBookSnapshotId: uuid("no_book_snapshot_id").references(() => orderbookSnapshots.id),
  method: jsonb("method").notNull(),
}, (t) => [
  index("estimates_market_time_idx").on(t.marketId, t.createdAt),
  check("estimate_prob_valid", sql`${t.probabilityYes} between 0 and 1`),
]);

// ---------------------------------------------------------------- trading

export interface QualificationCheck { name: string; passed: boolean; value: string | number | boolean | null; threshold: string | number | boolean | null }

/** APPEND-ONLY. Every TRADE / NO_TRADE decision with the checks that produced it. */
export const tradeCandidates = pgTable("trade_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id),
  probabilityEstimateId: uuid("probability_estimate_id").notNull().references(() => probabilityEstimates.id),
  strategyVersionId: uuid("strategy_version_id").notNull().references(() => strategyVersions.id),
  createdAt: createdAt(),
  decision: tradeDecision("decision").notNull(),
  action: orderAction("action").notNull(),
  side: outcomeSide("side"),
  checks: jsonb("checks").$type<QualificationCheck[]>().notNull(),
  rejectionReasons: jsonb("rejection_reasons").$type<string[]>().notNull(),
  sizing: jsonb("sizing"),
  proposedUsd: usd("proposed_usd"),
  limitPrice: prob("limit_price"),
}, (t) => [index("candidates_market_time_idx").on(t.marketId, t.createdAt)]);

export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().references(() => markets.id),
  eventId: text("event_id"),
  category: text("category"),
  side: outcomeSide("side").notNull(),
  tokenId: text("token_id").notNull(),
  status: positionStatus("status").notNull().default("OPEN"),
  strategyVersionId: uuid("strategy_version_id").notNull().references(() => strategyVersions.id),
  openedAt: ts("opened_at").defaultNow().notNull(),
  closedAt: ts("closed_at"),
  shares: qty("shares").notNull(),
  costBasis: usd("cost_basis").notNull(),
  realizedPnl: usd("realized_pnl").notNull().default("0"),
  totalFees: usd("total_fees").notNull().default("0"),
  entryAvgPrice: prob("entry_avg_price").notNull(),
  entryProbability: prob("entry_probability").notNull(),
  entryConfidence: prob("entry_confidence").notNull(),
  entryEdge: prob("entry_edge").notNull(),
  entryEstimateId: uuid("entry_estimate_id").notNull().references(() => probabilityEstimates.id),
  currentEstimateId: uuid("current_estimate_id").references(() => probabilityEstimates.id),
  currentProbability: prob("current_probability"),
  lastMarkPrice: prob("last_mark_price"),
  lastMarkedAt: ts("last_marked_at"),
  lastReviewedAt: ts("last_reviewed_at"),
  recommendation: positionAction("recommendation"),
  addsCount: integer("adds_count").notNull().default(0),
  updatedAt: ts("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("positions_one_open_per_market_side").on(t.marketId, t.side).where(sql`status = 'OPEN'`),
  index("positions_status_idx").on(t.status),
  check("positions_shares_nonneg", sql`${t.shares} >= 0`),
  check("positions_cost_nonneg", sql`${t.costBasis} >= 0`),
]);

/** APPEND-ONLY. Paper execution record. `adapter` is always 'paper' in this build. */
export const simulatedOrders = pgTable("simulated_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  tradeCandidateId: uuid("trade_candidate_id").references(() => tradeCandidates.id),
  positionId: uuid("position_id").references(() => positions.id),
  marketId: text("market_id").notNull().references(() => markets.id),
  tokenId: text("token_id").notNull(),
  side: outcomeSide("side").notNull(),
  action: orderAction("action").notNull(),
  direction: orderDirection("direction").notNull(),
  adapter: text("adapter").notNull().default("paper"),
  strategyVersionId: uuid("strategy_version_id").notNull().references(() => strategyVersions.id),
  orderbookSnapshotId: uuid("orderbook_snapshot_id").notNull().references(() => orderbookSnapshots.id),
  requestedUsd: usd("requested_usd"),
  requestedShares: qty("requested_shares"),
  limitPrice: prob("limit_price").notNull(),
  status: orderStatus("status").notNull(),
  filledShares: qty("filled_shares").notNull(),
  avgFillPrice: prob("avg_fill_price"),
  notionalUsd: usd("notional_usd").notNull(),
  feesUsd: usd("fees_usd").notNull(),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("orders_market_time_idx").on(t.marketId, t.createdAt),
  check("orders_adapter_paper", sql`${t.adapter} = 'paper'`),
]);

/** APPEND-ONLY. One row per order-book level consumed. */
export const simulatedFills = pgTable("simulated_fills", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => simulatedOrders.id),
  levelIndex: integer("level_index").notNull(),
  price: prob("price").notNull(),
  shares: qty("shares").notNull(),
  notionalUsd: usd("notional_usd").notNull(),
  feeUsd: usd("fee_usd").notNull(),
  createdAt: createdAt(),
}, (t) => [index("fills_order_idx").on(t.orderId)]);

/** APPEND-ONLY. Every review / action on a position. */
export const positionUpdates = pgTable("position_updates", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionId: uuid("position_id").notNull().references(() => positions.id),
  createdAt: createdAt(),
  action: positionAction("action").notNull(),
  probabilityEstimateId: uuid("probability_estimate_id").references(() => probabilityEstimates.id),
  orderId: uuid("order_id").references(() => simulatedOrders.id),
  marketBid: prob("market_bid"),
  probability: prob("probability"),
  remainingEdge: prob("remaining_edge"),
  sharesBefore: qty("shares_before").notNull(),
  sharesAfter: qty("shares_after").notNull(),
  costBasisBefore: usd("cost_basis_before").notNull(),
  costBasisAfter: usd("cost_basis_after").notNull(),
  realizedPnlDelta: usd("realized_pnl_delta").notNull().default("0"),
  reasoning: text("reasoning").notNull(),
  details: jsonb("details"),
}, (t) => [index("position_updates_position_idx").on(t.positionId, t.createdAt)]);

/** APPEND-ONLY. Real outcome as reported by Polymarket. */
export const marketResolutions = pgTable("market_resolutions", {
  id: uuid("id").primaryKey().defaultRandom(),
  marketId: text("market_id").notNull().unique().references(() => markets.id),
  detectedAt: ts("detected_at").defaultNow().notNull(),
  closedTime: ts("closed_time"),
  /** Payout per YES share (1, 0, or 0.5 for a 50/50 resolution). */
  payoutYes: prob("payout_yes").notNull(),
  payoutNo: prob("payout_no").notNull(),
  winningSide: outcomeSide("winning_side"),
  umaResolutionStatus: text("uma_resolution_status"),
  raw: jsonb("raw").notNull(),
});

/**
 * APPEND-ONLY cash ledger. A trigger verifies balance_after = previous + amount
 * and balance_after >= 0, so the simulated account can never be overdrawn or
 * edited.
 */
export const cashLedger = pgTable("cash_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: createdAt(),
  entryType: ledgerEntryType("entry_type").notNull(),
  amount: usd("amount").notNull(),
  balanceAfter: usd("balance_after").notNull(),
  orderId: uuid("order_id").references(() => simulatedOrders.id),
  positionId: uuid("position_id").references(() => positions.id),
  resolutionId: uuid("resolution_id").references(() => marketResolutions.id),
  memo: text("memo").notNull(),
}, (t) => [check("ledger_balance_nonneg", sql`${t.balanceAfter} >= 0`)]);

/** APPEND-ONLY. */
export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  takenAt: ts("taken_at").defaultNow().notNull(),
  cash: usd("cash").notNull(),
  positionsMarkValue: usd("positions_mark_value").notNull(),
  positionsCostBasis: usd("positions_cost_basis").notNull(),
  equity: usd("equity").notNull(),
  realizedPnl: usd("realized_pnl").notNull(),
  unrealizedPnl: usd("unrealized_pnl").notNull(),
  openPositions: integer("open_positions").notNull(),
  highWaterMark: usd("high_water_mark").notNull(),
  drawdown: prob("drawdown").notNull(),
}, (t) => [index("snapshots_time_idx").on(t.takenAt)]);

// ---------------------------------------------------------------- operations

export const systemJobs = pgTable("system_jobs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jobType: text("job_type").notNull(),
  status: jobStatus("status").notNull().default("running"),
  startedAt: ts("started_at").defaultNow().notNull(),
  finishedAt: ts("finished_at"),
  summary: jsonb("summary"),
  error: text("error"),
}, (t) => [index("jobs_type_time_idx").on(t.jobType, t.startedAt)]);

/** APPEND-ONLY. Every AI call's token usage and estimated cost. */
export const aiUsage = pgTable("ai_usage", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: createdAt(),
  researchRunId: uuid("research_run_id").references(() => researchRuns.id),
  purpose: text("purpose").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  webSearchRequests: integer("web_search_requests").notNull().default(0),
  costUsd: usd("cost_usd").notNull(),
}, (t) => [index("ai_usage_time_idx").on(t.createdAt)]);

/** APPEND-ONLY, SHA-256 hash-chained by trigger. */
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: createdAt(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: jsonb("payload").notNull(),
  prevHash: text("prev_hash"),
  hash: text("hash"),
}, (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)]);

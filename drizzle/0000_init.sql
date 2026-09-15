CREATE TYPE "public"."job_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('DEPOSIT', 'BUY', 'SELL', 'RESOLUTION_PAYOUT');--> statement-breakpoint
CREATE TYPE "public"."order_action" AS ENUM('OPEN', 'ADD', 'REDUCE', 'EXIT');--> statement-breakpoint
CREATE TYPE "public"."order_direction" AS ENUM('BUY', 'SELL');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('FILLED', 'PARTIAL', 'UNFILLED');--> statement-breakpoint
CREATE TYPE "public"."outcome_side" AS ENUM('YES', 'NO');--> statement-breakpoint
CREATE TYPE "public"."position_action" AS ENUM('OPEN', 'HOLD', 'REDUCE', 'EXIT', 'ADD', 'RESOLVE');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('OPEN', 'CLOSED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."research_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trade_decision" AS ENUM('TRADE', 'NO_TRADE');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"research_run_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyst_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"analyst_key" text NOT NULL,
	"perspective" text NOT NULL,
	"probability_yes" numeric(10, 6) NOT NULL,
	"confidence" numeric(10, 6) NOT NULL,
	"evidence_quality" numeric(10, 6) NOT NULL,
	"reasoning" text NOT NULL,
	"details" jsonb NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyst_prob_valid" CHECK ("analyst_predictions"."probability_yes" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prev_hash" text,
	"hash" text
);
--> statement-breakpoint
CREATE TABLE "cash_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"balance_after" numeric(20, 6) NOT NULL,
	"order_id" uuid,
	"position_id" uuid,
	"resolution_id" uuid,
	"memo" text NOT NULL,
	CONSTRAINT "ledger_balance_nonneg" CHECK ("cash_ledger"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_price_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"yes_price" numeric(10, 6),
	"no_price" numeric(10, 6),
	"best_bid" numeric(10, 6),
	"best_ask" numeric(10, 6),
	"last_trade_price" numeric(10, 6),
	"spread" numeric(10, 6),
	"liquidity_usd" numeric(20, 6),
	"volume_24h_usd" numeric(20, 6)
);
--> statement-breakpoint
CREATE TABLE "market_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_time" timestamp with time zone,
	"payout_yes" numeric(10, 6) NOT NULL,
	"payout_no" numeric(10, 6) NOT NULL,
	"winning_side" "outcome_side",
	"uma_resolution_status" text,
	"raw" jsonb NOT NULL,
	CONSTRAINT "market_resolutions_market_id_unique" UNIQUE("market_id")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"condition_id" text NOT NULL,
	"event_id" text,
	"slug" text,
	"question" text NOT NULL,
	"group_item_title" text,
	"description" text,
	"resolution_source" text,
	"category" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcomes" jsonb NOT NULL,
	"yes_token_id" text,
	"no_token_id" text,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"active" boolean NOT NULL,
	"closed" boolean NOT NULL,
	"accepting_orders" boolean DEFAULT false NOT NULL,
	"enable_order_book" boolean DEFAULT false NOT NULL,
	"neg_risk" boolean DEFAULT false NOT NULL,
	"yes_price" numeric(10, 6),
	"no_price" numeric(10, 6),
	"best_bid" numeric(10, 6),
	"best_ask" numeric(10, 6),
	"last_trade_price" numeric(10, 6),
	"spread" numeric(10, 6),
	"liquidity_usd" numeric(20, 6),
	"volume_usd" numeric(20, 6),
	"volume_24h_usd" numeric(20, 6),
	"fees_enabled" boolean DEFAULT false NOT NULL,
	"fee_schedule" jsonb,
	"min_tick_size" numeric(10, 6),
	"min_order_size" numeric(20, 6),
	"uma_resolution_status" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "orderbook_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" "outcome_side" NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exchange_timestamp" text,
	"book_hash" text,
	"best_bid" numeric(10, 6),
	"best_ask" numeric(10, 6),
	"bids" jsonb NOT NULL,
	"asks" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polymarket_events" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text,
	"title" text NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"neg_risk" boolean DEFAULT false NOT NULL,
	"end_date" timestamp with time zone,
	"active" boolean NOT NULL,
	"closed" boolean NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cash" numeric(20, 6) NOT NULL,
	"positions_mark_value" numeric(20, 6) NOT NULL,
	"positions_cost_basis" numeric(20, 6) NOT NULL,
	"equity" numeric(20, 6) NOT NULL,
	"realized_pnl" numeric(20, 6) NOT NULL,
	"unrealized_pnl" numeric(20, 6) NOT NULL,
	"open_positions" integer NOT NULL,
	"high_water_mark" numeric(20, 6) NOT NULL,
	"drawdown" numeric(10, 6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" "position_action" NOT NULL,
	"probability_estimate_id" uuid,
	"order_id" uuid,
	"market_bid" numeric(10, 6),
	"probability" numeric(10, 6),
	"remaining_edge" numeric(10, 6),
	"shares_before" numeric(20, 6) NOT NULL,
	"shares_after" numeric(20, 6) NOT NULL,
	"cost_basis_before" numeric(20, 6) NOT NULL,
	"cost_basis_after" numeric(20, 6) NOT NULL,
	"realized_pnl_delta" numeric(20, 6) DEFAULT '0' NOT NULL,
	"reasoning" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"event_id" text,
	"category" text,
	"side" "outcome_side" NOT NULL,
	"token_id" text NOT NULL,
	"status" "position_status" DEFAULT 'OPEN' NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"shares" numeric(20, 6) NOT NULL,
	"cost_basis" numeric(20, 6) NOT NULL,
	"realized_pnl" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total_fees" numeric(20, 6) DEFAULT '0' NOT NULL,
	"entry_avg_price" numeric(10, 6) NOT NULL,
	"entry_probability" numeric(10, 6) NOT NULL,
	"entry_confidence" numeric(10, 6) NOT NULL,
	"entry_edge" numeric(10, 6) NOT NULL,
	"entry_estimate_id" uuid NOT NULL,
	"current_estimate_id" uuid,
	"current_probability" numeric(10, 6),
	"last_mark_price" numeric(10, 6),
	"last_marked_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"recommendation" "position_action",
	"adds_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_shares_nonneg" CHECK ("positions"."shares" >= 0),
	CONSTRAINT "positions_cost_nonneg" CHECK ("positions"."cost_basis" >= 0)
);
--> statement-breakpoint
CREATE TABLE "probability_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"research_run_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage" integer NOT NULL,
	"analyst_count" integer NOT NULL,
	"mean_prob" numeric(10, 6) NOT NULL,
	"median_prob" numeric(10, 6) NOT NULL,
	"stdev_prob" numeric(10, 6) NOT NULL,
	"probability_yes" numeric(10, 6) NOT NULL,
	"confidence" numeric(10, 6) NOT NULL,
	"evidence_quality" numeric(10, 6) NOT NULL,
	"yes_bid" numeric(10, 6),
	"yes_ask" numeric(10, 6),
	"no_bid" numeric(10, 6),
	"no_ask" numeric(10, 6),
	"market_mid" numeric(10, 6),
	"edge_yes" numeric(10, 6),
	"edge_no" numeric(10, 6),
	"ev_per_dollar_yes" numeric(20, 6),
	"ev_per_dollar_no" numeric(20, 6),
	"best_side" "outcome_side",
	"yes_book_snapshot_id" uuid,
	"no_book_snapshot_id" uuid,
	"method" jsonb NOT NULL,
	CONSTRAINT "estimate_prob_valid" CHECK ("probability_estimates"."probability_yes" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"stage" integer NOT NULL,
	"status" "research_status" DEFAULT 'queued' NOT NULL,
	"parent_run_id" uuid,
	"strategy_version_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"market_snapshot" jsonb,
	"dossier" jsonb,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "research_stage_valid" CHECK ("research_runs"."stage" in (2, 3))
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"publisher" text,
	"source_type" text NOT NULL,
	"quality_tier" integer NOT NULL,
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_for" text,
	"excerpt" text,
	CONSTRAINT "sources_tier_valid" CHECK ("research_sources"."quality_tier" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "screening_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score" numeric(10, 6) NOT NULL,
	"passed" boolean NOT NULL,
	"reasons" jsonb NOT NULL,
	"features" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "simulated_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"level_index" integer NOT NULL,
	"price" numeric(10, 6) NOT NULL,
	"shares" numeric(20, 6) NOT NULL,
	"notional_usd" numeric(20, 6) NOT NULL,
	"fee_usd" numeric(20, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulated_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trade_candidate_id" uuid,
	"position_id" uuid,
	"market_id" text NOT NULL,
	"token_id" text NOT NULL,
	"side" "outcome_side" NOT NULL,
	"action" "order_action" NOT NULL,
	"direction" "order_direction" NOT NULL,
	"adapter" text DEFAULT 'paper' NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"orderbook_snapshot_id" uuid NOT NULL,
	"requested_usd" numeric(20, 6),
	"requested_shares" numeric(20, 6),
	"limit_price" numeric(10, 6) NOT NULL,
	"status" "order_status" NOT NULL,
	"filled_shares" numeric(20, 6) NOT NULL,
	"avg_fill_price" numeric(10, 6),
	"notional_usd" numeric(20, 6) NOT NULL,
	"fees_usd" numeric(20, 6) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_adapter_paper" CHECK ("simulated_orders"."adapter" = 'paper')
);
--> statement-breakpoint
CREATE TABLE "strategy_activations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_versions_version_unique" UNIQUE("version"),
	CONSTRAINT "strategy_versions_config_hash_unique" UNIQUE("config_hash")
);
--> statement-breakpoint
CREATE TABLE "system_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "trade_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" text NOT NULL,
	"probability_estimate_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" "trade_decision" NOT NULL,
	"action" "order_action" NOT NULL,
	"side" "outcome_side",
	"checks" jsonb NOT NULL,
	"rejection_reasons" jsonb NOT NULL,
	"sizing" jsonb,
	"proposed_usd" numeric(20, 6),
	"limit_price" numeric(10, 6)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_predictions" ADD CONSTRAINT "analyst_predictions_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD CONSTRAINT "cash_ledger_order_id_simulated_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."simulated_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD CONSTRAINT "cash_ledger_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ledger" ADD CONSTRAINT "cash_ledger_resolution_id_market_resolutions_id_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."market_resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_price_history" ADD CONSTRAINT "market_price_history_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_id_polymarket_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."polymarket_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orderbook_snapshots" ADD CONSTRAINT "orderbook_snapshots_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_updates" ADD CONSTRAINT "position_updates_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_updates" ADD CONSTRAINT "position_updates_probability_estimate_id_probability_estimates_id_fk" FOREIGN KEY ("probability_estimate_id") REFERENCES "public"."probability_estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_updates" ADD CONSTRAINT "position_updates_order_id_simulated_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."simulated_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_entry_estimate_id_probability_estimates_id_fk" FOREIGN KEY ("entry_estimate_id") REFERENCES "public"."probability_estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_current_estimate_id_probability_estimates_id_fk" FOREIGN KEY ("current_estimate_id") REFERENCES "public"."probability_estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probability_estimates" ADD CONSTRAINT "probability_estimates_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probability_estimates" ADD CONSTRAINT "probability_estimates_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probability_estimates" ADD CONSTRAINT "probability_estimates_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probability_estimates" ADD CONSTRAINT "probability_estimates_yes_book_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("yes_book_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probability_estimates" ADD CONSTRAINT "probability_estimates_no_book_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("no_book_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_results" ADD CONSTRAINT "screening_results_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_results" ADD CONSTRAINT "screening_results_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_fills" ADD CONSTRAINT "simulated_fills_order_id_simulated_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."simulated_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_trade_candidate_id_trade_candidates_id_fk" FOREIGN KEY ("trade_candidate_id") REFERENCES "public"."trade_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_orders" ADD CONSTRAINT "simulated_orders_orderbook_snapshot_id_orderbook_snapshots_id_fk" FOREIGN KEY ("orderbook_snapshot_id") REFERENCES "public"."orderbook_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_activations" ADD CONSTRAINT "strategy_activations_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_candidates" ADD CONSTRAINT "trade_candidates_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_candidates" ADD CONSTRAINT "trade_candidates_probability_estimate_id_probability_estimates_id_fk" FOREIGN KEY ("probability_estimate_id") REFERENCES "public"."probability_estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_candidates" ADD CONSTRAINT "trade_candidates_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_time_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "analyst_run_idx" ON "analyst_predictions" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_time_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "price_history_market_time_idx" ON "market_price_history" USING btree ("market_id","observed_at");--> statement-breakpoint
CREATE INDEX "markets_open_idx" ON "markets" USING btree ("closed","active");--> statement-breakpoint
CREATE INDEX "markets_end_date_idx" ON "markets" USING btree ("end_date");--> statement-breakpoint
CREATE INDEX "markets_event_idx" ON "markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "orderbook_market_time_idx" ON "orderbook_snapshots" USING btree ("market_id","observed_at");--> statement-breakpoint
CREATE INDEX "snapshots_time_idx" ON "portfolio_snapshots" USING btree ("taken_at");--> statement-breakpoint
CREATE INDEX "position_updates_position_idx" ON "position_updates" USING btree ("position_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_one_open_per_market_side" ON "positions" USING btree ("market_id","side") WHERE status = 'OPEN';--> statement-breakpoint
CREATE INDEX "positions_status_idx" ON "positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "estimates_market_time_idx" ON "probability_estimates" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "research_market_time_idx" ON "research_runs" USING btree ("market_id","queued_at");--> statement-breakpoint
CREATE INDEX "research_status_idx" ON "research_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sources_run_idx" ON "research_sources" USING btree ("research_run_id");--> statement-breakpoint
CREATE INDEX "screening_market_time_idx" ON "screening_results" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fills_order_idx" ON "simulated_fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_market_time_idx" ON "simulated_orders" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_type_time_idx" ON "system_jobs" USING btree ("job_type","started_at");--> statement-breakpoint
CREATE INDEX "candidates_market_time_idx" ON "trade_candidates" USING btree ("market_id","created_at");
-- Integrity guarantees for the paper-trading record.
-- These live in the database (not just application code) so that no code path,
-- script, or manual query can quietly rewrite history.

-- 1. Append-only tables: UPDATE, DELETE and TRUNCATE are rejected.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'strategy_versions', 'strategy_activations', 'market_price_history', 'orderbook_snapshots',
    'screening_results', 'research_sources', 'analyst_predictions', 'probability_estimates',
    'trade_candidates', 'simulated_orders', 'simulated_fills', 'position_updates',
    'market_resolutions', 'cash_ledger', 'portfolio_snapshots', 'ai_usage', 'audit_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. Research runs are editable while in progress, frozen once finished, never deleted.
CREATE OR REPLACE FUNCTION research_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'research_runs rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'research run % is finalized and immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.market_id <> OLD.market_id OR NEW.stage <> OLD.stage OR NEW.strategy_version_id <> OLD.strategy_version_id OR NEW.queued_at <> OLD.queued_at THEN
    RAISE EXCEPTION 'research run identity fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER research_runs_guard BEFORE UPDATE OR DELETE ON research_runs FOR EACH ROW EXECUTE FUNCTION research_runs_guard();
--> statement-breakpoint

-- 3. Positions: live state may change while OPEN, but entry facts never change,
--    closed/resolved positions are frozen, and rows are never deleted.
CREATE OR REPLACE FUNCTION positions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'positions cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.market_id <> OLD.market_id OR NEW.side <> OLD.side OR NEW.token_id <> OLD.token_id
     OR NEW.opened_at <> OLD.opened_at OR NEW.strategy_version_id <> OLD.strategy_version_id
     OR NEW.entry_estimate_id <> OLD.entry_estimate_id OR NEW.entry_probability <> OLD.entry_probability
     OR NEW.entry_confidence <> OLD.entry_confidence OR NEW.entry_edge <> OLD.entry_edge THEN
    RAISE EXCEPTION 'position % entry fields are immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'OPEN' AND (NEW.status <> OLD.status OR NEW.shares <> OLD.shares
     OR NEW.cost_basis <> OLD.cost_basis OR NEW.realized_pnl <> OLD.realized_pnl OR NEW.total_fees <> OLD.total_fees) THEN
    RAISE EXCEPTION 'position % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER positions_guard BEFORE UPDATE OR DELETE ON positions FOR EACH ROW EXECUTE FUNCTION positions_guard();
--> statement-breakpoint

-- 4. Cash ledger: one initial deposit only, running balance verified, signs enforced.
--    IDs are re-assigned under the lock so id order == commit order.
CREATE OR REPLACE FUNCTION cash_ledger_verify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev numeric(20, 6);
BEGIN
  PERFORM pg_advisory_xact_lock(7100001);
  NEW.id := nextval(pg_get_serial_sequence('cash_ledger', 'id'));
  SELECT balance_after INTO prev FROM cash_ledger ORDER BY id DESC LIMIT 1;
  IF NEW.entry_type = 'DEPOSIT' THEN
    IF prev IS NOT NULL THEN
      RAISE EXCEPTION 'only the single initial deposit is allowed' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.amount <= 0 THEN
      RAISE EXCEPTION 'deposit must be positive' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF prev IS NULL THEN
    RAISE EXCEPTION 'first ledger entry must be the initial deposit' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entry_type = 'BUY' AND NEW.amount >= 0 THEN
    RAISE EXCEPTION 'BUY entries must be debits' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entry_type IN ('SELL', 'RESOLUTION_PAYOUT') AND NEW.amount < 0 THEN
    RAISE EXCEPTION '% entries must be credits', NEW.entry_type USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.balance_after <> COALESCE(prev, 0) + NEW.amount THEN
    RAISE EXCEPTION 'ledger balance mismatch: expected %, got %', COALESCE(prev, 0) + NEW.amount, NEW.balance_after
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER cash_ledger_verify BEFORE INSERT ON cash_ledger FOR EACH ROW EXECUTE FUNCTION cash_ledger_verify();
--> statement-breakpoint

-- 5. Audit events: SHA-256 hash chain. Editing any past event breaks every later hash.
CREATE OR REPLACE FUNCTION audit_event_hash(prev text, id bigint, created_at timestamptz, event_type text, entity_type text, entity_id text, payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    COALESCE(prev, 'GENESIS'), id::text,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    event_type, entity_type, entity_id, payload::text), 'UTF8')), 'hex');
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(7100003);
  NEW.id := nextval(pg_get_serial_sequence('audit_events', 'id'));
  NEW.created_at := COALESCE(NEW.created_at, now());
  SELECT hash INTO prev FROM audit_events ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := audit_event_hash(prev, NEW.id, NEW.created_at, NEW.event_type, NEW.entity_type, NEW.entity_id, NEW.payload);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_chain();
--> statement-breakpoint

-- Returns the id of the first event whose hash doesn't verify, or NULL if the chain is intact.
CREATE OR REPLACE FUNCTION audit_chain_first_break() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE r record; prev text := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_events ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM prev
       OR r.hash IS DISTINCT FROM audit_event_hash(prev, r.id, r.created_at, r.event_type, r.entity_type, r.entity_id, r.payload) THEN
      RETURN r.id;
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

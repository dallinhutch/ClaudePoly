-- Timestamps on the historical record come from the DATABASE clock at insert
-- time. No application code path, script or manual insert can backdate (or
-- future-date) a prediction, decision, order, fill, ledger entry or audit event.
CREATE OR REPLACE FUNCTION force_insert_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('strategy_versions', 'created_at'), ('strategy_activations', 'activated_at'),
    ('market_price_history', 'observed_at'), ('orderbook_snapshots', 'observed_at'),
    ('screening_results', 'created_at'), ('research_runs', 'queued_at'), ('research_sources', 'retrieved_at'),
    ('analyst_predictions', 'created_at'), ('probability_estimates', 'created_at'), ('trade_candidates', 'created_at'),
    ('simulated_orders', 'created_at'), ('simulated_fills', 'created_at'), ('position_updates', 'created_at'),
    ('market_resolutions', 'detected_at'), ('cash_ledger', 'created_at'), ('portfolio_snapshots', 'taken_at'),
    ('ai_usage', 'created_at'), ('login_attempts', 'created_at'), ('audit_events', 'created_at')
  ) AS t(tbl, col) LOOP
    -- BEFORE triggers fire in name order; the "a0_" prefix makes this run before
    -- audit_events_chain, so the hash covers the database-assigned timestamp.
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION force_insert_timestamp(%L)',
      'a0_' || r.tbl || '_insert_now', r.tbl, r.col
    );
  END LOOP;
END $$;

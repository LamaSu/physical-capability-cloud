-- =============================================================================
-- Agent-onboarding observability — centralized PRIVATE sink (piece 5)
-- =============================================================================
-- REFERENCE DRAFT. This is the owner-ruled PRIVATE observability DB schema
-- (coord #062) — it is DELIBERATELY SEPARATE from the operator-facing gateway
-- SQLite (`packages/gateway/src/db.ts`). Nothing in this PR applies it; it is
-- applied by hand when the private DB (Postgres + TimescaleDB) is stood up.
--
-- Target: PostgreSQL 14+ with the TimescaleDB extension.
-- Ingestion:
--   • agent_trace_events  ← OTel spans (OTLP collector → span→PG processor) AND
--                            the audit-log ETL (scripts/observability/etl-*.mjs)
--   • agent_reports       ← ETL from audit eventType='agent.report'
--   • agent_funnel_events ← ETL from audit eventType='agent.funnel'
--   • agent_canary_runs   ← canary POSTs / ETL
--
-- All times are TIMESTAMPTZ (UTC). trace_id format: tr_<16-32 hex>.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS pcc_observability;
SET search_path TO pcc_observability, public;

-- TimescaleDB is optional but recommended (hypertables + continuous aggregates +
-- retention). The DDL below degrades to plain tables if the extension is absent.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- -----------------------------------------------------------------------------
-- agent_trace_events — one row per significant request in an agent journey.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_trace_events (
  id          TEXT        NOT NULL,
  trace_id    TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  method      TEXT        NOT NULL,
  route       TEXT        NOT NULL,
  status      INT         NOT NULL,
  operator_id TEXT,
  error_code  TEXT,
  hint        TEXT,
  docs        TEXT,
  agent_kind  TEXT,
  span_attrs  JSONB,
  PRIMARY KEY (id, ts)
);
CREATE INDEX IF NOT EXISTS idx_trace_events_trace  ON agent_trace_events (trace_id, ts);
CREATE INDEX IF NOT EXISTS idx_trace_events_err    ON agent_trace_events (error_code, ts) WHERE error_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trace_events_op     ON agent_trace_events (operator_id, ts);

-- -----------------------------------------------------------------------------
-- agent_reports — pcc_report friction reports (piece 3 back-channel).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_reports (
  id              TEXT        PRIMARY KEY,        -- report_id (agr_...)
  trace_id        TEXT,
  ts              TIMESTAMPTZ NOT NULL,
  summary         TEXT        NOT NULL,
  detail          TEXT,
  last_endpoint   TEXT,
  last_error_code TEXT,
  agent_kind      TEXT,
  confused_about  TEXT,
  actor           TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_trace ON agent_reports (trace_id);
CREATE INDEX IF NOT EXISTS idx_reports_ts    ON agent_reports (ts);
CREATE INDEX IF NOT EXISTS idx_reports_stage ON agent_reports (confused_about, ts);

-- -----------------------------------------------------------------------------
-- agent_funnel_events — deduped funnel progression. (trace_id, stage) is unique.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_funnel_events (
  trace_id TEXT        NOT NULL,
  stage    TEXT        NOT NULL,   -- provision|discover|build|fund|submit|settle
  ts       TIMESTAMPTZ NOT NULL,
  route    TEXT,
  status   INT,
  PRIMARY KEY (trace_id, stage)    -- idempotent: ETL upserts, never double-counts
);
CREATE INDEX IF NOT EXISTS idx_funnel_stage_ts ON agent_funnel_events (stage, ts);

-- -----------------------------------------------------------------------------
-- agent_canary_runs — one row per synthetic canary loop (piece 6).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_canary_runs (
  id            TEXT        PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL,
  target        TEXT        NOT NULL,
  ok            BOOLEAN     NOT NULL,
  stage_reached TEXT,                  -- furthest stage the canary completed
  failed_stage  TEXT,
  last_status   INT,
  last_error    TEXT,
  trace_id      TEXT,
  duration_ms   INT
);
CREATE INDEX IF NOT EXISTS idx_canary_ts ON agent_canary_runs (ts);
CREATE INDEX IF NOT EXISTS idx_canary_ok ON agent_canary_runs (ok, ts);

-- -----------------------------------------------------------------------------
-- Hypertables (TimescaleDB). Safe no-ops if already hypertables / no extension.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM create_hypertable('agent_trace_events', 'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('agent_reports',      'ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('agent_funnel_events','ts', if_not_exists => TRUE, migrate_data => TRUE);
  PERFORM create_hypertable('agent_canary_runs',  'ts', if_not_exists => TRUE, migrate_data => TRUE);
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'TimescaleDB not installed — using plain tables.';
END $$;

-- -----------------------------------------------------------------------------
-- Continuous aggregate — daily funnel cohort (distinct trace_ids per stage).
-- Materializes the expensive distinct-count so view_funnel_cohort is sub-second.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE $ca$
    CREATE MATERIALIZED VIEW IF NOT EXISTS funnel_cohort_daily
    WITH (timescaledb.continuous) AS
    SELECT time_bucket('1 day', ts) AS day,
           stage,
           count(DISTINCT trace_id) AS journeys
    FROM agent_funnel_events
    GROUP BY day, stage
    WITH NO DATA;
  $ca$;
  PERFORM add_continuous_aggregate_policy('funnel_cohort_daily',
    start_offset => INTERVAL '3 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
EXCEPTION WHEN undefined_function OR undefined_object THEN
  RAISE NOTICE 'TimescaleDB continuous aggregate skipped — create a plain view instead.';
END $$;

-- -----------------------------------------------------------------------------
-- Retention policies (TimescaleDB). Tune to budget.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM add_retention_policy('agent_trace_events', INTERVAL '30 days', if_not_exists => TRUE);
  PERFORM add_retention_policy('agent_reports',      INTERVAL '365 days', if_not_exists => TRUE);
  PERFORM add_retention_policy('agent_funnel_events', INTERVAL '365 days', if_not_exists => TRUE);
  PERFORM add_retention_policy('agent_canary_runs',  INTERVAL '90 days', if_not_exists => TRUE);
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'TimescaleDB retention policies skipped.';
END $$;

-- =============================================================================
-- Troubleshooting VIEWS / FUNCTIONS  (the "troubleshooting view" of piece 5)
-- =============================================================================

-- fn_agent_journey(trace_id) — full ordered event list for one agent journey:
-- HTTP trace events ∪ funnel milestones ∪ friction reports, time-ordered.
CREATE OR REPLACE FUNCTION fn_agent_journey(p_trace_id TEXT)
RETURNS TABLE (ts TIMESTAMPTZ, kind TEXT, detail JSONB) AS $$
  SELECT ts, 'request' AS kind,
         jsonb_build_object('method', method, 'route', route, 'status', status,
                            'error_code', error_code, 'hint', hint)
  FROM agent_trace_events WHERE trace_id = p_trace_id
  UNION ALL
  SELECT ts, 'funnel' AS kind,
         jsonb_build_object('stage', stage, 'route', route, 'status', status)
  FROM agent_funnel_events WHERE trace_id = p_trace_id
  UNION ALL
  SELECT ts, 'report' AS kind,
         jsonb_build_object('summary', summary, 'last_error_code', last_error_code,
                            'confused_about', confused_about, 'agent_kind', agent_kind)
  FROM agent_reports WHERE trace_id = p_trace_id
  ORDER BY ts ASC;
$$ LANGUAGE sql STABLE;

-- view_funnel_cohort — per-stage distinct journeys + conversion vs provision,
-- last 7 days. (Reads the continuous aggregate when present.)
CREATE OR REPLACE VIEW view_funnel_cohort AS
WITH s AS (
  SELECT stage, count(DISTINCT trace_id) AS journeys
  FROM agent_funnel_events
  WHERE ts > now() - INTERVAL '7 days'
  GROUP BY stage
), entry AS (
  SELECT journeys AS provision_journeys FROM s WHERE stage = 'provision'
)
SELECT s.stage, s.journeys,
       round(100.0 * s.journeys / NULLIF((SELECT provision_journeys FROM entry), 0), 1) AS conversion_pct
FROM s
ORDER BY array_position(
  ARRAY['provision','discover','build','fund','submit','settle']::text[], s.stage);

-- view_error_class_freq — error-code histogram from reports, last 7 days.
CREATE OR REPLACE VIEW view_error_class_freq AS
SELECT coalesce(last_error_code, '(none)') AS error_code,
       count(*) AS occurrences,
       max(ts)  AS last_seen
FROM agent_reports
WHERE ts > now() - INTERVAL '7 days'
GROUP BY error_code
ORDER BY occurrences DESC;

-- view_agent_friction_stream — recent reports joined to the furthest funnel
-- stage that journey reached (so we see WHERE in the funnel the friction hit).
CREATE OR REPLACE VIEW view_agent_friction_stream AS
SELECT r.id AS report_id, r.ts, r.trace_id, r.summary, r.agent_kind,
       r.last_endpoint, r.last_error_code, r.confused_about,
       (SELECT stage FROM agent_funnel_events f
         WHERE f.trace_id = r.trace_id
         ORDER BY array_position(
           ARRAY['provision','discover','build','fund','submit','settle']::text[], f.stage) DESC
         LIMIT 1) AS furthest_stage
FROM agent_reports r
ORDER BY r.ts DESC;

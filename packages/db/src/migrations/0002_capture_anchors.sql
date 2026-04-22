-- Wave 4 CVP (gateway-golf): capture_anchors
--
-- One row per on-chain anchor submission to CaptureClassRegistry. Keyed on
-- verdict_id (1:1) with capture_verdicts. If the CaptureClassRegistry
-- contract is not yet deployed (Wave 4 acceptance allows this), the
-- /api/capture/anchor route returns 202 Accepted and does NOT write a row.
-- Spec source: ai/supervisor/wave4-spec.md §Database Migrations.
--
-- Type translation (Postgres -> SQLite):
--   UUID           -> TEXT (uuid string)
--   BIGINT         -> INTEGER
--   NUMERIC        -> TEXT (wei / gas-used as string to avoid precision loss)
--   TIMESTAMPTZ    -> TEXT (ISO-8601)

CREATE TABLE IF NOT EXISTS capture_anchors (
  verdict_id   TEXT PRIMARY KEY REFERENCES capture_verdicts(id),
  tx_hash      TEXT NOT NULL UNIQUE,
  block_number INTEGER NOT NULL,
  gas_used     TEXT NOT NULL DEFAULT '0',
  anchored_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capture_anchors_tx ON capture_anchors(tx_hash);

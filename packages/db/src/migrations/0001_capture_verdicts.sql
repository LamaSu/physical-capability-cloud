-- Wave 4 CVP (gateway-golf): capture_verdicts
--
-- One row per CaptureVerifier verdict. Persists the full gate result and
-- supports the /api/capture/upload → /api/capture/anchor → /api/capture/status
-- flow. Spec source: ai/supervisor/wave4-spec.md §Database Migrations.
--
-- NOTE: the gateway runs on SQLite (better-sqlite3). The spec's DDL uses
-- Postgres types (UUID, BYTEA, SMALLINT, BOOLEAN, TEXT[], TIMESTAMPTZ); we
-- translate them here to the closest SQLite-compatible forms while keeping
-- the same semantics:
--
--   UUID / BYTEA      -> TEXT (uuid string / 0x-prefixed hex)
--   SMALLINT / BOOL   -> INTEGER
--   TEXT[] / INT[]    -> TEXT JSON array
--   TIMESTAMPTZ       -> TEXT (ISO-8601)
--   CHECK enum        -> TEXT CHECK(verdict IN ('PASS','PARTIAL','FAIL'))

CREATE TABLE IF NOT EXISTS capture_verdicts (
  id              TEXT PRIMARY KEY,
  job_id          TEXT,
  operator_id     TEXT NOT NULL,
  capture_hash    TEXT NOT NULL,
  manifest_hash   TEXT NOT NULL,
  declared_class  INTEGER NOT NULL,
  verified_class  INTEGER NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN ('PASS','PARTIAL','FAIL')),
  gates_passed    TEXT NOT NULL DEFAULT '[]',   -- JSON number[]
  gates_failed    TEXT NOT NULL DEFAULT '[]',   -- JSON number[]
  warnings        TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  anchor_candidate INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  result_json     TEXT NOT NULL DEFAULT '{}',   -- full CaptureVerifierResult JSON
  declared_class_str TEXT NOT NULL,             -- "CC0".."CC5" for display
  verified_class_str TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capture_verdicts_job ON capture_verdicts(job_id);
CREATE INDEX IF NOT EXISTS idx_capture_verdicts_hash ON capture_verdicts(capture_hash);
CREATE INDEX IF NOT EXISTS idx_capture_verdicts_operator ON capture_verdicts(operator_id);

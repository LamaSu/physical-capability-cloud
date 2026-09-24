-- 0004_budget_reservations.sql
--
-- R13: one-use, server-issued budget reservations (operator decision #2240, amended by #2301 and
-- #2302). DRAFT until the operator approves the schema.
--
-- Mirrors BUDGET_RESERVATIONS_DDL in packages/db/src/repositories/budget-reservations.ts, which
-- the gateway's runtime migration (packages/db/src/migrate.ts) executes. Amounts are exact base
-- units stored as canonical decimal TEXT (SQLite has no numeric(78,0)) and compared as BigInt in
-- application code. Issue and consume run in BEGIN IMMEDIATE transactions.

CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  payer_address TEXT NOT NULL,
  currency TEXT NOT NULL,
  max_amount_base_units TEXT NOT NULL
    CHECK (max_amount_base_units NOT GLOB '*[^0-9]*' AND length(max_amount_base_units) BETWEEN 1 AND 78
           AND (max_amount_base_units = '0' OR substr(max_amount_base_units, 1, 1) <> '0')),
  purpose TEXT NOT NULL,
  request_id TEXT NOT NULL,
  job_binding TEXT,
  min_tier INTEGER CHECK (min_tier IS NULL OR min_tier BETWEEN 0 AND 3),
  parent_reservation_id TEXT,
  parent_unit TEXT,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired', 'released')),
  consumed_deal_digest TEXT,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK ((state = 'consumed') = (consumed_deal_digest IS NOT NULL)),
  CHECK ((parent_reservation_id IS NULL) = (parent_unit IS NULL))
);
CREATE INDEX IF NOT EXISTS budget_reservations_request_idx ON budget_reservations(request_id, state);
CREATE INDEX IF NOT EXISTS budget_reservations_parent_idx ON budget_reservations(parent_reservation_id, parent_unit);

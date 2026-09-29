-- 0004_budget_reservations.sql
--
-- R13: one-use, server-issued budget reservations (operator decision #2240, amended by #2301, #2302
-- and #3231). DRAFT until the operator approves the schema.
--
-- This is BUDGET_RESERVATIONS_DDL in packages/db/src/repositories/budget-reservations.ts, statement for
-- statement (budget-reservations.test.ts holds the two equal). The gateway's runtime migration
-- (packages/db/src/migrate.ts) runs it through ensureBudgetReservationsSchema, which trusts the RECORDED
-- schema version (pcc_schema_versions, written by this DDL) and never the table's SQL text: a table
-- without the current version is rebuilt when empty and stops the boot when it holds rows.
-- Amounts are exact base units stored as canonical decimal TEXT (SQLite has no
-- numeric(78,0)) and compared as BigInt in application code. Issue and consume run in BEGIN IMMEDIATE
-- transactions. The guard triggers hold no data, so they are dropped and recreated on every run.

CREATE TABLE IF NOT EXISTS pcc_schema_versions (object TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  payer_address TEXT NOT NULL CHECK (length(payer_address) BETWEEN 1 AND 128),
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 1 AND 128),
  max_amount_base_units TEXT NOT NULL
    CHECK (max_amount_base_units NOT GLOB '*[^0-9]*' AND substr(max_amount_base_units, 1, 1) <> '0'
           AND (length(max_amount_base_units) BETWEEN 1 AND 77
                OR (length(max_amount_base_units) = 78 AND max_amount_base_units <= '115792089237316195423570985008687907853269984665640564039457584007913129639935'))),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 256),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  job_binding TEXT CHECK (job_binding IS NULL OR length(job_binding) BETWEEN 1 AND 128),
  min_tier INTEGER CHECK (min_tier IS NULL OR (typeof(min_tier) = 'integer' AND min_tier BETWEEN 0 AND 3)),
  parent_reservation_id TEXT,
  parent_unit TEXT CHECK (parent_unit IS NULL OR length(parent_unit) BETWEEN 3 AND 300),
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired', 'released')),
  consumed_deal_digest TEXT
    CHECK (consumed_deal_digest IS NULL OR (length(consumed_deal_digest) = 66 AND substr(consumed_deal_digest, 1, 2) = '0x'
           AND substr(consumed_deal_digest, 3) NOT GLOB '*[^0-9a-f]*')),
  consumed_deal_json TEXT CHECK (consumed_deal_json IS NULL OR length(CAST(consumed_deal_json AS BLOB)) BETWEEN 2 AND 1048576),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER CHECK (consumed_at IS NULL OR (typeof(consumed_at) = 'integer' AND consumed_at >= 0)),
  CHECK (typeof(created_at) = 'integer' AND typeof(expires_at) = 'integer' AND created_at >= 0 AND expires_at > created_at),
  CHECK ((state = 'consumed') = (consumed_deal_digest IS NOT NULL)),
  CHECK ((state = 'consumed') = (consumed_deal_json IS NOT NULL)),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((parent_reservation_id IS NULL) = (parent_unit IS NULL))
);
CREATE INDEX IF NOT EXISTS budget_reservations_request_idx ON budget_reservations(request_id, state);
CREATE INDEX IF NOT EXISTS budget_reservations_parent_idx ON budget_reservations(parent_reservation_id, parent_unit);
DROP TRIGGER IF EXISTS budget_reservations_insert_guard;
CREATE TRIGGER budget_reservations_insert_guard BEFORE INSERT ON budget_reservations
WHEN NEW.state <> 'issued'
  OR EXISTS (SELECT 1 FROM budget_reservations e WHERE e.id = NEW.id)
  OR (NEW.parent_reservation_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM budget_reservations p WHERE p.id = NEW.parent_reservation_id AND p.state = 'consumed'))
BEGIN
  SELECT RAISE(ABORT, 'budget_reservations: a reservation is inserted issued, under an id never used before, and a child only under a consumed parent');
END;
DROP TRIGGER IF EXISTS budget_reservations_update_guard;
CREATE TRIGGER budget_reservations_update_guard BEFORE UPDATE ON budget_reservations
WHEN OLD.state <> 'issued' OR NEW.state = 'issued'
  OR NEW.id IS NOT OLD.id OR NEW.principal IS NOT OLD.principal OR NEW.payer_address IS NOT OLD.payer_address
  OR NEW.currency IS NOT OLD.currency OR NEW.max_amount_base_units IS NOT OLD.max_amount_base_units
  OR NEW.purpose IS NOT OLD.purpose OR NEW.request_id IS NOT OLD.request_id OR NEW.job_binding IS NOT OLD.job_binding
  OR NEW.min_tier IS NOT OLD.min_tier OR NEW.parent_reservation_id IS NOT OLD.parent_reservation_id
  OR NEW.parent_unit IS NOT OLD.parent_unit OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'budget_reservations: only issued -> consumed, expired or released, and no term changes');
END;
DROP TRIGGER IF EXISTS budget_reservations_delete_guard;
CREATE TRIGGER budget_reservations_delete_guard BEFORE DELETE ON budget_reservations
BEGIN
  SELECT RAISE(ABORT, 'budget_reservations: a reservation is never deleted');
END;
INSERT OR REPLACE INTO pcc_schema_versions (object, version) VALUES ('budget_reservations', 2);

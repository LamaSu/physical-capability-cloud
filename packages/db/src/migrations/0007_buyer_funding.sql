-- N145 buyer funding verification records and frozen prepare rows.
-- Mirrors the runtime DDL in packages/db/src/migrate.ts.

CREATE TABLE IF NOT EXISTS escrow_funding (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 200),
  chain_id INTEGER NOT NULL CHECK (typeof(chain_id) = 'integer' AND chain_id > 0),
  escrow TEXT NOT NULL CHECK (escrow = lower(escrow) AND length(escrow) = 42 AND substr(escrow,1,2) = '0x' AND substr(escrow,3) NOT GLOB '*[^0-9a-f]*' AND escrow <> '0x0000000000000000000000000000000000000000'),
  buyer TEXT NOT NULL CHECK (buyer = lower(buyer) AND length(buyer) = 42 AND substr(buyer,1,2) = '0x' AND substr(buyer,3) NOT GLOB '*[^0-9a-f]*' AND buyer <> '0x0000000000000000000000000000000000000000'),
  operator TEXT NOT NULL CHECK (operator = lower(operator) AND length(operator) = 42 AND substr(operator,1,2) = '0x' AND substr(operator,3) NOT GLOB '*[^0-9a-f]*' AND operator <> '0x0000000000000000000000000000000000000000'),
  finality TEXT NOT NULL CHECK (finality IN ('latest', 'finalized')),
  block_number TEXT NOT NULL CHECK (block_number NOT GLOB '*[^0-9]*' AND length(block_number) BETWEEN 1 AND 20 AND (block_number = '0' OR substr(block_number,1,1) <> '0')),
  block_hash TEXT NOT NULL CHECK (block_hash = lower(block_hash) AND length(block_hash) = 66 AND substr(block_hash,1,2) = '0x' AND substr(block_hash,3) NOT GLOB '*[^0-9a-f]*'),
  funding_block_number TEXT NOT NULL CHECK (funding_block_number NOT GLOB '*[^0-9]*' AND length(funding_block_number) BETWEEN 1 AND 20 AND (funding_block_number = '0' OR substr(funding_block_number,1,1) <> '0')),
  funding_block_hash TEXT NOT NULL CHECK (funding_block_hash = lower(funding_block_hash) AND length(funding_block_hash) = 66 AND substr(funding_block_hash,1,2) = '0x' AND substr(funding_block_hash,3) NOT GLOB '*[^0-9a-f]*'),
  funded_at INTEGER NOT NULL CHECK (typeof(funded_at) = 'integer' AND funded_at > 0),
  verifier_version TEXT NOT NULL CHECK (length(verifier_version) BETWEEN 1 AND 100),
  verified_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS escrow_funding_final_scope_uq ON escrow_funding(scope_id) WHERE finality = 'finalized';
CREATE UNIQUE INDEX IF NOT EXISTS escrow_funding_final_escrow_uq ON escrow_funding(chain_id, escrow) WHERE finality = 'finalized';
CREATE TRIGGER IF NOT EXISTS escrow_funding_no_update BEFORE UPDATE ON escrow_funding
  BEGIN SELECT RAISE(ABORT, 'escrow_funding is append-only'); END;
CREATE TRIGGER IF NOT EXISTS escrow_funding_no_delete BEFORE DELETE ON escrow_funding
  BEGIN SELECT RAISE(ABORT, 'escrow_funding is append-only'); END;

CREATE TRIGGER IF NOT EXISTS escrow_funding_no_replace BEFORE INSERT ON escrow_funding
  WHEN EXISTS (SELECT 1 FROM escrow_funding WHERE id = NEW.id)
    OR (NEW.finality = 'finalized' AND EXISTS (
      SELECT 1 FROM escrow_funding WHERE finality = 'finalized'
        AND (scope_id = NEW.scope_id OR (chain_id = NEW.chain_id AND escrow = NEW.escrow))
    ))
  BEGIN SELECT RAISE(ABORT, 'escrow_funding_no_replace'); END;

CREATE TABLE IF NOT EXISTS funding_prepares (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  scope_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_id_hash TEXT NOT NULL CHECK (job_id_hash = lower(job_id_hash) AND length(job_id_hash) = 66 AND substr(job_id_hash,1,2) = '0x' AND substr(job_id_hash,3) NOT GLOB '*[^0-9a-f]*'),
  chain_id INTEGER NOT NULL CHECK (typeof(chain_id) = 'integer' AND chain_id > 0),
  escrow TEXT NOT NULL CHECK (escrow = lower(escrow) AND length(escrow) = 42 AND substr(escrow,1,2) = '0x' AND substr(escrow,3) NOT GLOB '*[^0-9a-f]*' AND escrow <> '0x0000000000000000000000000000000000000000'),
  s01_record_sha256 TEXT NOT NULL CHECK (s01_record_sha256 = lower(s01_record_sha256) AND length(s01_record_sha256) = 64 AND s01_record_sha256 NOT GLOB '*[^0-9a-f]*'),
  s01_schedule_id TEXT NOT NULL,
  s01_schedule_testnet_only INTEGER NOT NULL CHECK (typeof(s01_schedule_testnet_only) = 'integer' AND s01_schedule_testnet_only IN (0, 1)),
  factory TEXT NOT NULL CHECK (factory = lower(factory) AND length(factory) = 42 AND substr(factory,1,2) = '0x' AND substr(factory,3) NOT GLOB '*[^0-9a-f]*' AND factory <> '0x0000000000000000000000000000000000000000'),
  implementation TEXT NOT NULL CHECK (implementation = lower(implementation) AND length(implementation) = 42 AND substr(implementation,1,2) = '0x' AND substr(implementation,3) NOT GLOB '*[^0-9a-f]*' AND implementation <> '0x0000000000000000000000000000000000000000'),
  usdc TEXT NOT NULL CHECK (usdc = lower(usdc) AND length(usdc) = 42 AND substr(usdc,1,2) = '0x' AND substr(usdc,3) NOT GLOB '*[^0-9a-f]*' AND usdc <> '0x0000000000000000000000000000000000000000'),
  payer TEXT NOT NULL CHECK (payer = lower(payer) AND length(payer) = 42 AND substr(payer,1,2) = '0x' AND substr(payer,3) NOT GLOB '*[^0-9a-f]*' AND payer <> '0x0000000000000000000000000000000000000000'),
  operator TEXT NOT NULL CHECK (operator = lower(operator) AND length(operator) = 42 AND substr(operator,1,2) = '0x' AND substr(operator,3) NOT GLOB '*[^0-9a-f]*' AND operator <> '0x0000000000000000000000000000000000000000'),
  terms_hash TEXT NOT NULL CHECK (terms_hash = lower(terms_hash) AND length(terms_hash) = 66 AND substr(terms_hash,1,2) = '0x' AND substr(terms_hash,3) NOT GLOB '*[^0-9a-f]*'),
  policy_nonce TEXT NOT NULL CHECK (policy_nonce NOT GLOB '*[^0-9]*' AND length(policy_nonce) BETWEEN 1 AND 78 AND (policy_nonce = '0' OR substr(policy_nonce,1,1) <> '0')),
  pre_policy_root TEXT NOT NULL CHECK (pre_policy_root = lower(pre_policy_root) AND length(pre_policy_root) = 66 AND substr(pre_policy_root,1,2) = '0x' AND substr(pre_policy_root,3) NOT GLOB '*[^0-9a-f]*'),
  accepted_policy_digest TEXT NOT NULL CHECK (accepted_policy_digest = lower(accepted_policy_digest) AND length(accepted_policy_digest) = 66 AND substr(accepted_policy_digest,1,2) = '0x' AND substr(accepted_policy_digest,3) NOT GLOB '*[^0-9a-f]*'),
  total_gross TEXT NOT NULL CHECK (total_gross NOT GLOB '*[^0-9]*' AND length(total_gross) BETWEEN 1 AND 78 AND (total_gross = '0' OR substr(total_gross,1,1) <> '0')),
  quote_snapshot TEXT NOT NULL,
  configs TEXT NOT NULL,
  unit_ids TEXT NOT NULL,
  expiry INTEGER NOT NULL CHECK (typeof(expiry) = 'integer'),
  scope_expires_at TEXT NOT NULL,
  finality_f_s INTEGER NOT NULL CHECK (typeof(finality_f_s) = 'integer' AND finality_f_s >= 0),
  margin_m_s INTEGER NOT NULL CHECK (typeof(margin_m_s) = 'integer' AND margin_m_s >= 0),
  reclaim_at_earliest INTEGER NOT NULL CHECK (typeof(reclaim_at_earliest) = 'integer'),
  reclaim_at_latest INTEGER NOT NULL CHECK (typeof(reclaim_at_latest) = 'integer'),
  reconcile_until INTEGER NOT NULL CHECK (typeof(reconcile_until) = 'integer'),
  typed_data_digest TEXT NOT NULL CHECK (typed_data_digest = lower(typed_data_digest) AND length(typed_data_digest) = 66 AND substr(typed_data_digest,1,2) = '0x' AND substr(typed_data_digest,3) NOT GLOB '*[^0-9a-f]*'),
  operator_signature TEXT CHECK (operator_signature IS NULL OR (operator_signature = lower(operator_signature) AND substr(operator_signature,1,2) = '0x' AND length(operator_signature) >= 4 AND length(operator_signature) % 2 = 0 AND substr(operator_signature,3) NOT GLOB '*[^0-9a-f]*')),
  signature_verified_at TEXT,
  signed_at TEXT,
  served_payload BLOB,
  served_payload_sha256 TEXT CHECK (served_payload_sha256 IS NULL OR (served_payload_sha256 = lower(served_payload_sha256) AND length(served_payload_sha256) = 64 AND served_payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK (state IN ('pending_signature', 'served', 'superseded', 'expired')),
  created_at TEXT NOT NULL,
  signature_requested_at TEXT,
  ended_at TEXT,
  superseded_by TEXT,
  CHECK (reclaim_at_earliest <= reclaim_at_latest),
  CHECK (expiry < reclaim_at_earliest),
  CHECK (reconcile_until + finality_f_s <= reclaim_at_earliest),
  CHECK (s01_schedule_testnet_only = 1 OR reconcile_until <= reclaim_at_earliest - 777600),
  CHECK (json_valid(quote_snapshot) AND json_valid(configs) AND json_valid(unit_ids) AND json_type(unit_ids) = 'array'),
  CHECK (served_payload IS NULL OR (typeof(served_payload) = 'blob' AND length(served_payload) > 0)),
  CHECK (state <> 'served' OR (operator_signature IS NOT NULL AND signature_verified_at IS NOT NULL AND signed_at IS NOT NULL AND served_payload IS NOT NULL AND served_payload_sha256 IS NOT NULL)),
  CHECK (state NOT IN ('superseded', 'expired') OR ended_at IS NOT NULL),
  CHECK ((state = 'superseded') = (superseded_by IS NOT NULL))
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS funding_prepares_escrow_uq ON funding_prepares(chain_id, escrow);
CREATE UNIQUE INDEX IF NOT EXISTS funding_prepares_live_scope_uq ON funding_prepares(scope_id) WHERE state IN ('pending_signature', 'served');
CREATE INDEX IF NOT EXISTS funding_prepares_job_idx ON funding_prepares(job_id);
CREATE TRIGGER IF NOT EXISTS funding_prepares_no_replace BEFORE INSERT ON funding_prepares
  WHEN EXISTS (SELECT 1 FROM funding_prepares WHERE id = NEW.id)
    OR EXISTS (SELECT 1 FROM funding_prepares WHERE chain_id = NEW.chain_id AND escrow = NEW.escrow)
    OR (NEW.state IN ('pending_signature', 'served') AND EXISTS (
      SELECT 1 FROM funding_prepares WHERE scope_id = NEW.scope_id AND state IN ('pending_signature', 'served')
    ))
  BEGIN SELECT RAISE(ABORT, 'funding_prepares_no_replace'); END;
CREATE TRIGGER IF NOT EXISTS funding_prepares_frozen
  BEFORE UPDATE OF id, scope_id, job_id, job_id_hash, chain_id, escrow, s01_record_sha256, s01_schedule_id, s01_schedule_testnet_only, factory, implementation, usdc, payer, operator, terms_hash, policy_nonce, pre_policy_root, accepted_policy_digest, total_gross, quote_snapshot, configs, unit_ids, expiry, scope_expires_at, finality_f_s, margin_m_s, reclaim_at_earliest, reclaim_at_latest, reconcile_until, typed_data_digest, created_at ON funding_prepares
  BEGIN SELECT RAISE(ABORT, 'funding_prepares_frozen'); END;
CREATE TRIGGER IF NOT EXISTS funding_prepares_signed_once
  BEFORE UPDATE OF operator_signature, signature_verified_at, signed_at, served_payload, served_payload_sha256 ON funding_prepares
  WHEN NOT (OLD.state = 'pending_signature' AND NEW.state = 'served')
  BEGIN SELECT RAISE(ABORT, 'funding_prepares_signed_once'); END;
CREATE TRIGGER IF NOT EXISTS funding_prepares_transitions
  BEFORE UPDATE OF state ON funding_prepares
  WHEN NOT ((OLD.state = 'pending_signature' AND NEW.state IN ('served', 'superseded', 'expired')) OR (OLD.state = 'served' AND NEW.state IN ('superseded', 'expired')))
  BEGIN SELECT RAISE(ABORT, 'funding_prepares_transitions'); END;
CREATE TRIGGER IF NOT EXISTS funding_prepares_end_once
  BEFORE UPDATE OF ended_at, superseded_by ON funding_prepares
  WHEN NOT (OLD.state IN ('pending_signature', 'served') AND NEW.state IN ('superseded', 'expired'))
  BEGIN SELECT RAISE(ABORT, 'funding_prepares_end_once'); END;
CREATE TRIGGER IF NOT EXISTS funding_prepares_requested
  BEFORE UPDATE OF signature_requested_at ON funding_prepares
  WHEN OLD.state <> 'pending_signature'
  BEGIN SELECT RAISE(ABORT, 'funding_prepares_requested'); END;
CREATE TRIGGER IF NOT EXISTS funding_prepares_no_delete BEFORE DELETE ON funding_prepares
  BEGIN SELECT RAISE(ABORT, 'funding_prepares_no_delete'); END;

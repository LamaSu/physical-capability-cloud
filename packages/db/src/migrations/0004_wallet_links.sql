-- W1 wallet link requests and public-key consent receipts.
-- Mirrors the runtime DDL in packages/db/src/migrate.ts.

CREATE TABLE IF NOT EXISTS wallet_link_requests (
  id TEXT PRIMARY KEY,
  key_type TEXT NOT NULL CHECK (key_type IN ('secp256k1', 'ed25519')),
  address_or_pubkey TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('agent', 'device')),
  label TEXT NOT NULL,
  client_info TEXT,
  kernel_id TEXT,
  chain_id INTEGER NOT NULL,
  env TEXT NOT NULL,
  domain TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_proof', 'awaiting_approval', 'approved', 'denied', 'failed', 'expired')),
  message TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_sha256 TEXT NOT NULL,
  proof_signature TEXT,
  proof_consumed_at TEXT,
  account_id TEXT,
  created_by_key_id TEXT,
  approved_by TEXT,
  approved_by_key_id TEXT,
  decided_at TEXT,
  link_id TEXT,
  requester_ip_class TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_link_requests_pending_code_uq
  ON wallet_link_requests(user_code)
  WHERE status IN ('pending_proof', 'awaiting_approval');
CREATE INDEX IF NOT EXISTS wallet_link_requests_pending_key_idx
  ON wallet_link_requests(key_type, lower(address_or_pubkey), chain_id, status, expires_at);
CREATE INDEX IF NOT EXISTS wallet_link_requests_expires_idx
  ON wallet_link_requests(expires_at);

CREATE TABLE IF NOT EXISTS wallet_links (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('agent', 'device')),
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  key_type TEXT NOT NULL CHECK (key_type IN ('secp256k1', 'ed25519')),
  address_or_pubkey TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_sha256 TEXT NOT NULL,
  proof_message TEXT NOT NULL,
  proof_signature TEXT NOT NULL,
  approval_signature TEXT,
  request_id TEXT NOT NULL,
  created_by_key_id TEXT,
  approved_by TEXT NOT NULL,
  approved_by_key_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_links_active_key_uq
  ON wallet_links(key_type, lower(address_or_pubkey), chain_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS wallet_links_account_idx ON wallet_links(account_id);

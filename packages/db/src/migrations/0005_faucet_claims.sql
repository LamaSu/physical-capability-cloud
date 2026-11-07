-- W2 per-link testnet faucet claims.
-- Mirrors the runtime DDL in packages/db/src/migrate.ts.

CREATE TABLE IF NOT EXISTS faucet_claims (
  link_id TEXT NOT NULL,
  token TEXT NOT NULL,
  seq INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  account_proof TEXT NOT NULL CHECK (account_proof IN ('siwe', 'claimed')),
  approved_by_key_id TEXT,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  tx_hash TEXT,
  error_class TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (link_id, token, seq),
  CHECK ((token = 'eth' AND amount = '0.0001') OR (token = 'usdc' AND amount = '1')),
  CHECK ((status = 'succeeded') = (tx_hash IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS faucet_claims_tx_hash_uq
  ON faucet_claims(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS faucet_claims_address_created_idx
  ON faucet_claims(address, created_at);
CREATE INDEX IF NOT EXISTS faucet_claims_account_created_idx
  ON faucet_claims(account_id, created_at);
CREATE INDEX IF NOT EXISTS faucet_claims_created_idx
  ON faucet_claims(created_at);

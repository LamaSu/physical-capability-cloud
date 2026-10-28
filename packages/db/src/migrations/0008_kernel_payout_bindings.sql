CREATE TABLE IF NOT EXISTS kernel_payout_bindings (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  kernel_id TEXT NOT NULL CHECK (length(kernel_id) BETWEEN 1 AND 200),
  chain_id INTEGER NOT NULL CHECK (typeof(chain_id) = 'integer' AND chain_id > 0),
  payout_address TEXT NOT NULL CHECK (payout_address = lower(payout_address) AND length(payout_address) = 42 AND substr(payout_address,1,2) = '0x' AND substr(payout_address,3) NOT GLOB '*[^0-9a-f]*' AND payout_address <> '0x0000000000000000000000000000000000000000'),
  bound_by_wallet TEXT NOT NULL CHECK (bound_by_wallet = lower(bound_by_wallet) AND length(bound_by_wallet) = 42 AND substr(bound_by_wallet,1,2) = '0x' AND substr(bound_by_wallet,3) NOT GLOB '*[^0-9a-f]*' AND bound_by_wallet <> '0x0000000000000000000000000000000000000000'),
  proof_via TEXT NOT NULL CHECK (proof_via = 'siwe-session'),
  proof_carrier TEXT NOT NULL CHECK (proof_carrier IN ('key', 'bearer-session')),
  consent_version TEXT NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 100),
  consent_sha256 TEXT NOT NULL CHECK (consent_sha256 = lower(consent_sha256) AND length(consent_sha256) = 64 AND consent_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT CHECK (revoked_by IN ('owner', 'admin')),
  revoke_reason TEXT CHECK (revoke_reason IN ('owner_revoked', 'admin_revoked', 'rebound')),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
      OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)),
  CHECK (revoke_reason IS NULL
      OR (revoked_by = 'admin' AND revoke_reason = 'admin_revoked')
      OR (revoked_by = 'owner' AND revoke_reason IN ('owner_revoked', 'rebound'))),
  CHECK (payout_address = bound_by_wallet)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS kernel_payout_bindings_active_uq
  ON kernel_payout_bindings(kernel_id, chain_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS kernel_payout_bindings_kernel_idx ON kernel_payout_bindings(kernel_id, chain_id, created_at);
CREATE TRIGGER IF NOT EXISTS kernel_payout_bindings_no_delete BEFORE DELETE ON kernel_payout_bindings
  BEGIN SELECT RAISE(ABORT, 'kernel_payout_bindings keeps its history'); END;
CREATE TRIGGER IF NOT EXISTS kernel_payout_bindings_revoke_only BEFORE UPDATE ON kernel_payout_bindings
  WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NEW.id IS NOT OLD.id OR NEW.kernel_id IS NOT OLD.kernel_id OR NEW.chain_id IS NOT OLD.chain_id
    OR NEW.payout_address IS NOT OLD.payout_address OR NEW.bound_by_wallet IS NOT OLD.bound_by_wallet
    OR NEW.proof_via IS NOT OLD.proof_via OR NEW.proof_carrier IS NOT OLD.proof_carrier
    OR NEW.consent_version IS NOT OLD.consent_version OR NEW.consent_sha256 IS NOT OLD.consent_sha256
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'kernel_payout_bindings_revoke_only'); END;
CREATE TRIGGER IF NOT EXISTS kernel_payout_bindings_born_active BEFORE INSERT ON kernel_payout_bindings
  WHEN NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'kernel_payout_bindings_born_active'); END;
CREATE TRIGGER IF NOT EXISTS kernel_payout_bindings_no_replace BEFORE INSERT ON kernel_payout_bindings
  WHEN EXISTS (SELECT 1 FROM kernel_payout_bindings WHERE id = NEW.id)
    OR (NEW.revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM kernel_payout_bindings
      WHERE kernel_id = NEW.kernel_id AND chain_id = NEW.chain_id AND revoked_at IS NULL))
  BEGIN SELECT RAISE(ABORT, 'kernel_payout_bindings_no_replace'); END;

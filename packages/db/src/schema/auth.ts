import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** User sessions */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  token: text("token").notNull().unique(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastActiveAt: text("last_active_at").notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
});

/** API keys for operator authentication */
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  operatorId: text("operator_id").notNull(),
  name: text("name"),
  description: text("description"),
  scopes: text("scopes").notNull(),
  rateLimit: text("rate_limit").notNull(),
  usageCount: text("usage_count").notNull().default("0"),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  metadata: text("metadata"),
  /**
   * Raw Ed25519 public key the agent signs evidence + heartbeats with.
   * Hex-encoded 32 bytes (64 hex chars), no `0x` prefix. Nullable for
   * backward compatibility with pre-migration rows.
   *
   * Set at provision time:
   *   - server-generated when `POST /api/auth/provision` runs without a
   *     `publicKey` field (the matching private key is returned ONCE in
   *     the response body, then forgotten).
   *   - bring-your-own when the agent provides `publicKey` in the request.
   *
   * See `POST /api/agents/:id/verify` for the verification surface.
   */
  publicKey: text("public_key"),
  // ERC-8004 IdentityRegistry write tracking (added 2026-06-19).
  // Eventually-consistent: provision returns 201 before on-chain write,
  // background sweeper retries failed writes.
  onchainAgentId: text("onchain_agent_id"),                  // bigint stored as decimal string
  onchainStatus: text("onchain_status").default("pending"),  // pending | written | failed
  onchainTxHash: text("onchain_tx_hash"),
  onchainRegistryAddress: text("onchain_registry_address"),
  onchainChainId: integer("onchain_chain_id"),
  onchainAttemptedAt: text("onchain_attempted_at"),
  onchainError: text("onchain_error"),
  // ── Operator operational wallet (option A ownership stopgap) ──────
  // Per-operator EOA generated at provision. Gateway custodies the key
  // at bootstrap (`operatorWalletCustody = "gateway"`) so the operator
  // never touches a private key; the wallet address gets written to the
  // ERC-8004 `agentWallet` field via best-effort setAgentWallet.
  // A future export endpoint lets the operator claim their key + move
  // to `operatorWalletCustody = "operator"`; a future v2 replaces this
  // with an ERC-4337 smart wallet + passkey (see coord bulletin 235).
  operatorWalletAddress: text("operator_wallet_address"),
  operatorWalletPrivateKey: text("operator_wallet_private_key"), // hex, custodial at bootstrap
  operatorWalletCustody: text("operator_wallet_custody").default("gateway"), // gateway | operator
  agentWalletOnchainStatus: text("agent_wallet_onchain_status").default("pending"), // pending | written | failed
  agentWalletOnchainTxHash: text("agent_wallet_onchain_tx_hash"),
  agentWalletOnchainError: text("agent_wallet_onchain_error"),
  // ── Option B ERC-4337 smart wallet + passkey (groundwork) ────────
  // Groundwork columns for the v2 ownership path (ai/research/
  // option-b-smart-wallet-passkey-plan.md). Wire-up is a follow-up PR
  // that fills in these values via ZeroDev Kernel + passkey validator:
  //   - smart_wallet_address = counterfactual SW address derived from
  //     the passkey credentialId; NFT ownership sits here (true operator
  //     ownership, unlike option A where NFT stays with the gateway)
  //   - passkey_credential_id = WebAuthn credential ID (base64url)
  //     returned by the browser during passkey registration
  //   - passkey_public_key = WebAuthn COSE public key (base64url) for
  //     verifying subsequent passkey signatures
  //   - passkey_rp_id = the relying-party domain the passkey is bound to
  //     (e.g. "capability.network")
  // Nullable while option A remains the primary path; a migration entry
  // ("gateway" → "smart_wallet") flips `operatorWalletCustody` when an A
  // operator upgrades to B via setAgentWallet from the new SW.
  smartWalletAddress: text("smart_wallet_address"),
  passkeyCredentialId: text("passkey_credential_id"),
  passkeyPublicKey: text("passkey_public_key"),
  passkeyRpId: text("passkey_rp_id"),
});

/**
 * Passkey challenge sessions — durable challenge cache for the WebAuthn
 * register-challenge -> verify-attestation round trip. Replaces the
 * in-memory Map that shipped with the option B stub in PR #197.
 *
 * Rows live for ~60s (the WebAuthn ceremony completes in seconds); a
 * sweeper deletes expired rows on a timer. Survives process restarts +
 * multi-instance deployments (the point of moving off the in-memory Map).
 */
export const passkeySessions = sqliteTable("passkey_sessions", {
  sessionId: text("session_id").primaryKey(),
  challenge: text("challenge").notNull(),        // base64url of 32 random bytes
  rpId: text("rp_id").notNull(),
  expectedOrigin: text("expected_origin").notNull(),
  operatorId: text("operator_id"),                // optional binding to an existing api-key
  createdAt: integer("created_at").notNull(),     // ms epoch — cheap integer, no ISO parse
  expiresAt: integer("expires_at").notNull(),     // ms epoch; enforced at read time
});

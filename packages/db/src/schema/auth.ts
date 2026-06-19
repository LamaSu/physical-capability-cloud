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
});

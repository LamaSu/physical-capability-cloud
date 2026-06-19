import { eq, and, isNull, or } from "drizzle-orm";
import { apiKeys } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IApiKeyRepository } from "../interfaces/IApiKeyRepository.js";

export class ApiKeyRepository implements IApiKeyRepository {
  constructor(private db: StoreDB) {}

  findByHash(keyHash: string) {
    return this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
  }

  findById(id: string) {
    return this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  }

  findByOperator(operatorId: string) {
    return this.db.select().from(apiKeys).where(eq(apiKeys.operatorId, operatorId)).all();
  }

  findActiveByHash(keyHash: string) {
    return this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .get();
  }

  insert(key: typeof apiKeys.$inferInsert) {
    return this.db.insert(apiKeys).values(key).returning().get();
  }

  incrementUsage(id: string) {
    const existing = this.findById(id);
    if (!existing) return;
    const newCount = String(parseInt(existing.usageCount, 10) + 1);
    this.db
      .update(apiKeys)
      .set({ usageCount: newCount, lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .execute();
  }

  revoke(id: string) {
    return this.db
      .update(apiKeys)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, id))
      .returning()
      .get();
  }

  listActive() {
    return this.db
      .select()
      .from(apiKeys)
      .where(isNull(apiKeys.revokedAt))
      .all();
  }

  countByOperator(operatorId: string) {
    return this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.operatorId, operatorId), isNull(apiKeys.revokedAt)))
      .all()
      .length;
  }

  // ── ERC-8004 IdentityRegistry write tracking ───────────────────────

  /** Mark a key as having a confirmed on-chain identity. */
  recordOnchainSuccess(
    id: string,
    onchain: {
      agentId: bigint | string;
      txHash: string;
      registryAddress: string;
      chainId: number;
    },
  ) {
    return this.db
      .update(apiKeys)
      .set({
        onchainAgentId: String(onchain.agentId),
        onchainStatus: "written",
        onchainTxHash: onchain.txHash,
        onchainRegistryAddress: onchain.registryAddress,
        onchainChainId: onchain.chainId,
        onchainAttemptedAt: new Date().toISOString(),
        onchainError: null,
      })
      .where(eq(apiKeys.id, id))
      .returning()
      .get();
  }

  /** Record a failed on-chain write attempt (kept 'pending' for retry). */
  recordOnchainFailure(id: string, error: string) {
    return this.db
      .update(apiKeys)
      .set({
        onchainStatus: "pending",
        onchainAttemptedAt: new Date().toISOString(),
        onchainError: error.slice(0, 1024),
      })
      .where(eq(apiKeys.id, id))
      .returning()
      .get();
  }

  /**
   * List API keys that still need an on-chain identity write.
   * Used by the retry sweeper. Excludes revoked keys + already-written.
   */
  listPendingOnchain(limit = 25) {
    return this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          isNull(apiKeys.revokedAt),
          or(
            isNull(apiKeys.onchainStatus),
            eq(apiKeys.onchainStatus, "pending"),
          ),
        ),
      )
      .limit(limit)
      .all();
  }
}

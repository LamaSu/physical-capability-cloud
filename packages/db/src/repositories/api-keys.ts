import { eq, and, isNull } from "drizzle-orm";
import { apiKeys } from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class ApiKeyRepository {
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
}

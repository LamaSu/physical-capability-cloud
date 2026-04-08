import type { apiKeys } from "../schema/index.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;

export interface IApiKeyRepository {
  findByHash(keyHash: string): ApiKeyRow | undefined;
  findById(id: string): ApiKeyRow | undefined;
  findByOperator(operatorId: string): ApiKeyRow[];
  findActiveByHash(keyHash: string): ApiKeyRow | undefined;
  insert(key: ApiKeyInsert): ApiKeyRow | undefined;
  incrementUsage(id: string): void;
  revoke(id: string): ApiKeyRow | undefined;
  listActive(): ApiKeyRow[];
  countByOperator(operatorId: string): number;
}

import type { invocationReceipts } from "../schema/index.js";

export type InvocationReceiptRow = typeof invocationReceipts.$inferSelect;
export type InvocationReceiptInsert = typeof invocationReceipts.$inferInsert;

export interface InvocationReceiptFilter {
  indexedToolId?: string;
  callerAgentId?: string;
  effectiveDccClass?: string;
  /** Inclusive lower bound on createdAt (ISO 8601). */
  sinceCreatedAt?: string;
}

export interface IInvocationReceiptRepository {
  insert(record: InvocationReceiptInsert): InvocationReceiptRow | undefined;
  findById(id: string): InvocationReceiptRow | undefined;
  findByCid(cid: string): InvocationReceiptRow | undefined;
  findRecent(limit: number): InvocationReceiptRow[];
  findByTool(indexedToolId: string, limit?: number): InvocationReceiptRow[];
  findByCaller(callerAgentId: string, limit?: number): InvocationReceiptRow[];
  query(filter: InvocationReceiptFilter, limit?: number): InvocationReceiptRow[];
  countByTool(indexedToolId: string): number;
}

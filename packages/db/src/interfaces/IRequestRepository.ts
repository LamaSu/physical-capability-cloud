import type { capabilityRequests } from "../schema/index.js";

export type RequestRow = typeof capabilityRequests.$inferSelect;
export type RequestInsert = typeof capabilityRequests.$inferInsert;

export interface RequestsFilter {
  status?: string;
  urgency?: string;
  requesterEmail?: string;
}

export interface IRequestRepository {
  findAll(filter?: RequestsFilter): RequestRow[];
  findById(id: string): RequestRow | undefined;
  findByCompositionSignature(signature: string): RequestRow[];
  findRecent(limit: number): RequestRow[];
  insert(request: RequestInsert): RequestRow | undefined;
  update(id: string, data: Partial<RequestInsert>): RequestRow | undefined;
  /** Soft delete: sets status='cancelled' and updates updatedAt */
  softDelete(id: string): RequestRow | undefined;
}

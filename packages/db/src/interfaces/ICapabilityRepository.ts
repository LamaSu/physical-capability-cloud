import type { capabilities } from "../schema/index.js";

export type CapabilityRow = typeof capabilities.$inferSelect;
export type CapabilityInsert = typeof capabilities.$inferInsert;

/** Wave 4.1.x — additive tenant scope opts. Omitted = today's behavior. */
export interface CapabilityTenantOpts {
  tenantId?: string;
}

export interface ICapabilityRepository {
  findAll(opts?: CapabilityTenantOpts): CapabilityRow[];
  findById(id: string): CapabilityRow | undefined;
  /** Batch lookup — one query per ≤500 ids (true N+1 prevention). Empty input → []. */
  findByIds(ids: string[]): CapabilityRow[];
  findByKernel(kernelId: string, opts?: CapabilityTenantOpts): CapabilityRow[];
  findByType(type: string, opts?: CapabilityTenantOpts): CapabilityRow[];
  search(query: string, opts?: CapabilityTenantOpts): CapabilityRow[];
  insert(capability: CapabilityInsert): CapabilityRow | undefined;
  update(id: string, data: Partial<CapabilityInsert>): CapabilityRow | undefined;
}

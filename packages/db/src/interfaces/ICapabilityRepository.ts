import type { capabilities } from "../schema/index.js";

export type CapabilityRow = typeof capabilities.$inferSelect;
export type CapabilityInsert = typeof capabilities.$inferInsert;

export interface ICapabilityRepository {
  findAll(): CapabilityRow[];
  findById(id: string): CapabilityRow | undefined;
  findByKernel(kernelId: string): CapabilityRow[];
  findByType(type: string): CapabilityRow[];
  search(query: string): CapabilityRow[];
  insert(capability: CapabilityInsert): CapabilityRow | undefined;
  update(id: string, data: Partial<CapabilityInsert>): CapabilityRow | undefined;
}

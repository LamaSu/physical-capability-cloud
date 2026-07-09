import { eq, like, and, inArray } from "drizzle-orm";
import { capabilities } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { ICapabilityRepository, CapabilityTenantOpts } from "../interfaces/ICapabilityRepository.js";
import { inChunks } from "./batch.js";

export class CapabilityRepository implements ICapabilityRepository {
  constructor(private db: StoreDB) {}

  findAll(opts?: CapabilityTenantOpts) {
    if (opts?.tenantId) {
      return this.db.select().from(capabilities).where(eq(capabilities.tenantId, opts.tenantId)).all();
    }
    return this.db.select().from(capabilities).all();
  }

  findById(id: string) {
    return this.db.select().from(capabilities).where(eq(capabilities.id, id)).get();
  }

  findByIds(ids: string[]) {
    return inChunks(ids, (chunk) =>
      this.db.select().from(capabilities).where(inArray(capabilities.id, chunk)).all(),
    );
  }

  findByKernel(kernelId: string, opts?: CapabilityTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(capabilities)
        .where(and(eq(capabilities.kernelId, kernelId), eq(capabilities.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(capabilities).where(eq(capabilities.kernelId, kernelId)).all();
  }

  findByType(type: string, opts?: CapabilityTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(capabilities)
        .where(and(eq(capabilities.type, type), eq(capabilities.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(capabilities).where(eq(capabilities.type, type)).all();
  }

  distinctTypes(opts?: CapabilityTenantOpts): string[] {
    const rows = opts?.tenantId
      ? this.db
          .selectDistinct({ type: capabilities.type })
          .from(capabilities)
          .where(eq(capabilities.tenantId, opts.tenantId))
          .all()
      : this.db.selectDistinct({ type: capabilities.type }).from(capabilities).all();
    // `type` is NOT NULL in the schema, but guard defensively against a
    // corrupted / empty value rather than advertise a blank type string.
    return rows
      .map((r) => r.type)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
  }

  search(query: string, opts?: CapabilityTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(capabilities)
        .where(and(like(capabilities.name, `%${query}%`), eq(capabilities.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(capabilities).where(like(capabilities.name, `%${query}%`)).all();
  }

  insert(capability: typeof capabilities.$inferInsert) {
    return this.db.insert(capabilities).values(capability).returning().get();
  }

  update(id: string, data: Partial<typeof capabilities.$inferInsert>) {
    return this.db.update(capabilities).set(data).where(eq(capabilities.id, id)).returning().get();
  }
}

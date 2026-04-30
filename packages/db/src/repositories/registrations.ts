import { eq, and, isNull, type SQL } from "drizzle-orm";
import { machineRegistrations } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  IRegistrationRepository,
  RegistrationRow,
  RegistrationPatch,
  TenantScopeOpts,
} from "../interfaces/IRegistrationRepository.js";

/**
 * Wave 4.1 — build a drizzle WHERE clause for tenant scoping.
 *
 * Tri-state semantics:
 *   - opts undefined / opts.tenantId === undefined → returns undefined (no filter)
 *   - opts.tenantId === null                       → tenant_id IS NULL
 *   - opts.tenantId === <string>                   → tenant_id = <string>
 */
function tenantClause(opts?: TenantScopeOpts): SQL | undefined {
  if (!opts) return undefined;
  if (opts.tenantId === undefined) return undefined;
  if (opts.tenantId === null) return isNull(machineRegistrations.tenantId);
  return eq(machineRegistrations.tenantId, opts.tenantId);
}

export class RegistrationRepository implements IRegistrationRepository {
  constructor(private db: StoreDB) {}

  findAll(opts?: TenantScopeOpts) {
    const where = tenantClause(opts);
    if (where) {
      return this.db.select().from(machineRegistrations).where(where).all();
    }
    return this.db.select().from(machineRegistrations).all();
  }

  findById(id: string) {
    return this.db.select().from(machineRegistrations).where(eq(machineRegistrations.id, id)).get();
  }

  findByStatus(status: string, opts?: TenantScopeOpts) {
    const tc = tenantClause(opts);
    const where = tc ? and(eq(machineRegistrations.status, status), tc) : eq(machineRegistrations.status, status);
    return this.db.select().from(machineRegistrations).where(where).all();
  }

  /**
   * T2.3 — find by compliance regulationId.
   *
   * SQLite doesn't have first-class JSON-array membership operators, so we
   * filter in JS on the parsed JSON column. The dataset is small (operator
   * directory), so this is fine; if it ever grows we'd index a separate
   * `registration_compliance(reg_id, regulation_id)` table and join.
   *
   * Wave 4.1 — when opts.tenantId is set we AND the tenant filter into the
   * SQL clause before the JS membership pass, so the tenant scope reduces
   * the row set the JSON filter has to walk.
   */
  findByCompliance(regulationId: string, opts?: TenantScopeOpts): RegistrationRow[] {
    if (!regulationId) return [];
    const tc = tenantClause(opts);
    const rows = tc
      ? this.db.select().from(machineRegistrations).where(tc).all()
      : this.db.select().from(machineRegistrations).all();
    return rows.filter((r) => {
      const list = r.complianceRegulations;
      if (!Array.isArray(list)) return false;
      return list.includes(regulationId);
    });
  }

  insert(reg: typeof machineRegistrations.$inferInsert) {
    return this.db.insert(machineRegistrations).values(reg).returning().get();
  }

  updateStatus(id: string, status: string, extra?: { approvedAt?: string; description?: string }) {
    const data: Partial<typeof machineRegistrations.$inferInsert> = { status };
    if (extra?.approvedAt) data.approvedAt = extra.approvedAt;
    if (extra?.description) data.description = extra.description;
    return this.db.update(machineRegistrations).set(data).where(eq(machineRegistrations.id, id)).returning().get();
  }

  /**
   * T2.2 — partial update of mutable fields. Status changes are intentionally
   * NOT permitted here; the route layer rejects them with 400 before calling.
   * Repos.updateStatus is the one path to status mutation.
   */
  update(id: string, patch: RegistrationPatch): RegistrationRow | undefined {
    const data: Partial<typeof machineRegistrations.$inferInsert> = {};
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.photos !== undefined) data.photos = patch.photos;
    if (patch.capabilities !== undefined) data.capabilities = patch.capabilities;
    if (patch.spaceRequirements !== undefined) data.spaceRequirements = patch.spaceRequirements;
    if (patch.pricing !== undefined) data.pricing = patch.pricing;
    if (patch.complianceRegulations !== undefined) {
      data.complianceRegulations = patch.complianceRegulations;
    }
    if (Object.keys(data).length === 0) return this.findById(id);
    return this.db
      .update(machineRegistrations)
      .set(data)
      .where(eq(machineRegistrations.id, id))
      .returning()
      .get();
  }
}

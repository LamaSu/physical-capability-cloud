import type { machineRegistrations } from "../schema/index.js";

export type RegistrationRow = typeof machineRegistrations.$inferSelect;
export type RegistrationInsert = typeof machineRegistrations.$inferInsert;

/**
 * Wave 4.1 — tenant scoping options for repo queries.
 *
 * `tenantId` is interpreted as follows:
 *   - omitted (opts undefined or omitted)  → no filter, returns all rows (today's behavior)
 *   - string                                → filter rows where tenant_id = <string>
 *   - null                                  → filter rows where tenant_id IS NULL
 *
 * The route layer chooses which mode by inspecting TENANT_ENFORCE + req.tenantId
 * (see packages/gateway/src/config/tenant-enforce.ts).
 */
export interface TenantScopeOpts {
  tenantId?: string | null;
}

export interface IRegistrationRepository {
  findAll(opts?: TenantScopeOpts): RegistrationRow[];
  findById(id: string): RegistrationRow | undefined;
  findByStatus(status: string, opts?: TenantScopeOpts): RegistrationRow[];
  /**
   * T2.3 — find registrations whose `complianceRegulations` JSON array
   * contains the given regulationId (membership test on a JSON column).
   * Wave 4.1 — accepts an optional tenant scope; AND-ed with the compliance
   * filter when set.
   */
  findByCompliance(regulationId: string, opts?: TenantScopeOpts): RegistrationRow[];
  insert(reg: RegistrationInsert): RegistrationRow | undefined;
  updateStatus(
    id: string,
    status: string,
    extra?: { approvedAt?: string; description?: string },
  ): RegistrationRow | undefined;
  /**
   * T2.2 — partial update of a registration. Only the fields listed in
   * RegistrationPatch are honored; status changes go through updateStatus.
   * Returns the updated row, or undefined if the id isn't found.
   */
  update(id: string, patch: RegistrationPatch): RegistrationRow | undefined;
}

export interface RegistrationPatch {
  description?: string | null;
  photos?: string[];
  capabilities?: RegistrationRow["capabilities"];
  spaceRequirements?: RegistrationRow["spaceRequirements"];
  pricing?: RegistrationRow["pricing"];
  complianceRegulations?: string[];
}

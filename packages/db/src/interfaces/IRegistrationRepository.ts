import type { machineRegistrations } from "../schema/index.js";

export type RegistrationRow = typeof machineRegistrations.$inferSelect;
export type RegistrationInsert = typeof machineRegistrations.$inferInsert;

export interface IRegistrationRepository {
  findAll(): RegistrationRow[];
  findById(id: string): RegistrationRow | undefined;
  findByStatus(status: string): RegistrationRow[];
  /**
   * T2.3 — find registrations whose `complianceRegulations` JSON array
   * contains the given regulationId (membership test on a JSON column).
   */
  findByCompliance(regulationId: string): RegistrationRow[];
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

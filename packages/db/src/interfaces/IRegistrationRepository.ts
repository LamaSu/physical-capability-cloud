import type { machineRegistrations } from "../schema/index.js";

export type RegistrationRow = typeof machineRegistrations.$inferSelect;
export type RegistrationInsert = typeof machineRegistrations.$inferInsert;

export interface IRegistrationRepository {
  findAll(): RegistrationRow[];
  findById(id: string): RegistrationRow | undefined;
  findByStatus(status: string): RegistrationRow[];
  insert(reg: RegistrationInsert): RegistrationRow | undefined;
  updateStatus(
    id: string,
    status: string,
    extra?: { approvedAt?: string; description?: string },
  ): RegistrationRow | undefined;
}

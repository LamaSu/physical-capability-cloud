import { eq } from "drizzle-orm";
import { machineRegistrations } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  IRegistrationRepository,
  RegistrationRow,
} from "../interfaces/IRegistrationRepository.js";

export class RegistrationRepository implements IRegistrationRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(machineRegistrations).all();
  }

  findById(id: string) {
    return this.db.select().from(machineRegistrations).where(eq(machineRegistrations.id, id)).get();
  }

  findByStatus(status: string) {
    return this.db.select().from(machineRegistrations).where(eq(machineRegistrations.status, status)).all();
  }

  /**
   * T2.3 — find by compliance regulationId.
   *
   * SQLite doesn't have first-class JSON-array membership operators, so we
   * filter in JS on the parsed JSON column. The dataset is small (operator
   * directory), so this is fine; if it ever grows we'd index a separate
   * `registration_compliance(reg_id, regulation_id)` table and join.
   */
  findByCompliance(regulationId: string): RegistrationRow[] {
    if (!regulationId) return [];
    const rows = this.db.select().from(machineRegistrations).all();
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
}

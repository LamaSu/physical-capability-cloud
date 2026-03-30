import { eq } from "drizzle-orm";
import { machineRegistrations } from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class RegistrationRepository {
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

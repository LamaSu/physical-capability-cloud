import { eq, like, and } from "drizzle-orm";
import { capabilities } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { ICapabilityRepository } from "../interfaces/ICapabilityRepository.js";

export class CapabilityRepository implements ICapabilityRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(capabilities).all();
  }

  findById(id: string) {
    return this.db.select().from(capabilities).where(eq(capabilities.id, id)).get();
  }

  findByKernel(kernelId: string) {
    return this.db.select().from(capabilities).where(eq(capabilities.kernelId, kernelId)).all();
  }

  findByType(type: string) {
    return this.db.select().from(capabilities).where(eq(capabilities.type, type)).all();
  }

  search(query: string) {
    return this.db.select().from(capabilities).where(like(capabilities.name, `%${query}%`)).all();
  }

  insert(capability: typeof capabilities.$inferInsert) {
    return this.db.insert(capabilities).values(capability).returning().get();
  }

  update(id: string, data: Partial<typeof capabilities.$inferInsert>) {
    return this.db.update(capabilities).set(data).where(eq(capabilities.id, id)).returning().get();
  }
}

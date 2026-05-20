import { and, desc, eq } from "drizzle-orm";
import { capabilityRequests } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  IRequestRepository,
  RequestInsert,
  RequestsFilter,
} from "../interfaces/IRequestRepository.js";

export class RequestRepository implements IRequestRepository {
  constructor(private db: StoreDB) {}

  findAll(filter?: RequestsFilter) {
    const conds = [] as Array<ReturnType<typeof eq>>;
    if (filter?.status) conds.push(eq(capabilityRequests.status, filter.status));
    if (filter?.urgency) conds.push(eq(capabilityRequests.urgency, filter.urgency));
    if (filter?.requesterEmail)
      conds.push(eq(capabilityRequests.requesterEmail, filter.requesterEmail));

    if (conds.length === 0) {
      return this.db
        .select()
        .from(capabilityRequests)
        .orderBy(desc(capabilityRequests.createdAt))
        .all();
    }
    if (conds.length === 1) {
      return this.db
        .select()
        .from(capabilityRequests)
        .where(conds[0]!)
        .orderBy(desc(capabilityRequests.createdAt))
        .all();
    }
    return this.db
      .select()
      .from(capabilityRequests)
      .where(and(...conds))
      .orderBy(desc(capabilityRequests.createdAt))
      .all();
  }

  findById(id: string) {
    return this.db
      .select()
      .from(capabilityRequests)
      .where(eq(capabilityRequests.id, id))
      .get();
  }

  findByCompositionSignature(signature: string) {
    return this.db
      .select()
      .from(capabilityRequests)
      .where(eq(capabilityRequests.compositionSignature, signature))
      .orderBy(desc(capabilityRequests.createdAt))
      .all();
  }

  findRecent(limit: number) {
    return this.db
      .select()
      .from(capabilityRequests)
      .orderBy(desc(capabilityRequests.createdAt))
      .limit(limit)
      .all();
  }

  insert(request: RequestInsert) {
    return this.db.insert(capabilityRequests).values(request).returning().get();
  }

  update(id: string, data: Partial<RequestInsert>) {
    return this.db
      .update(capabilityRequests)
      .set(data)
      .where(eq(capabilityRequests.id, id))
      .returning()
      .get();
  }

  softDelete(id: string) {
    return this.db
      .update(capabilityRequests)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(capabilityRequests.id, id))
      .returning()
      .get();
  }
}

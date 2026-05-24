import { and, desc, eq, gte, sql } from "drizzle-orm";
import { invocationReceipts } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  IInvocationReceiptRepository,
  InvocationReceiptFilter,
  InvocationReceiptInsert,
} from "../interfaces/IInvocationReceiptRepository.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function capLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export class InvocationReceiptRepository implements IInvocationReceiptRepository {
  constructor(private db: StoreDB) {}

  insert(record: InvocationReceiptInsert) {
    return this.db
      .insert(invocationReceipts)
      .values(record)
      .returning()
      .get();
  }

  findById(id: string) {
    return this.db
      .select()
      .from(invocationReceipts)
      .where(eq(invocationReceipts.id, id))
      .get();
  }

  findByCid(cid: string) {
    return this.db
      .select()
      .from(invocationReceipts)
      .where(eq(invocationReceipts.receiptCid, cid))
      .get();
  }

  findRecent(limit: number) {
    return this.db
      .select()
      .from(invocationReceipts)
      .orderBy(desc(invocationReceipts.createdAt))
      .limit(capLimit(limit))
      .all();
  }

  findByTool(indexedToolId: string, limit?: number) {
    return this.db
      .select()
      .from(invocationReceipts)
      .where(eq(invocationReceipts.indexedToolId, indexedToolId))
      .orderBy(desc(invocationReceipts.createdAt))
      .limit(capLimit(limit))
      .all();
  }

  findByCaller(callerAgentId: string, limit?: number) {
    return this.db
      .select()
      .from(invocationReceipts)
      .where(eq(invocationReceipts.callerAgentId, callerAgentId))
      .orderBy(desc(invocationReceipts.createdAt))
      .limit(capLimit(limit))
      .all();
  }

  query(filter: InvocationReceiptFilter, limit?: number) {
    const conds = [] as Array<ReturnType<typeof eq>>;
    if (filter.indexedToolId)
      conds.push(eq(invocationReceipts.indexedToolId, filter.indexedToolId));
    if (filter.callerAgentId)
      conds.push(eq(invocationReceipts.callerAgentId, filter.callerAgentId));
    if (filter.effectiveDccClass)
      conds.push(
        eq(invocationReceipts.effectiveDccClass, filter.effectiveDccClass),
      );
    if (filter.sinceCreatedAt)
      conds.push(
        gte(
          invocationReceipts.createdAt,
          filter.sinceCreatedAt,
        ) as unknown as ReturnType<typeof eq>,
      );

    if (conds.length === 0) {
      return this.findRecent(capLimit(limit));
    }
    if (conds.length === 1) {
      return this.db
        .select()
        .from(invocationReceipts)
        .where(conds[0]!)
        .orderBy(desc(invocationReceipts.createdAt))
        .limit(capLimit(limit))
        .all();
    }
    return this.db
      .select()
      .from(invocationReceipts)
      .where(and(...conds))
      .orderBy(desc(invocationReceipts.createdAt))
      .limit(capLimit(limit))
      .all();
  }

  countByTool(indexedToolId: string): number {
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(invocationReceipts)
      .where(eq(invocationReceipts.indexedToolId, indexedToolId))
      .get();
    return Number(result?.count ?? 0);
  }
}

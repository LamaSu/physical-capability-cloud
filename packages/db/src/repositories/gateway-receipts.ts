import { asc, desc, eq } from "drizzle-orm";
import { gatewayReceipts } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  GatewayReceiptInsert,
  GatewayReceiptSessionSnapshot,
  IGatewayReceiptRepository,
} from "../interfaces/IGatewayReceiptRepository.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function capLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Persistence for gateway receipts (§8.3). Pure data access — canonicalization,
 * signing, and the transactional-acceptance ordering live in the gateway's
 * gateway-receipt-store.ts. This class only reads and writes rows.
 *
 * `insert` uses `.returning().get()` so the write path can construct the
 * returned receipt FROM the persisted row (the §8.3 "construct receipt FROM
 * PERSISTED VALUES" step).
 */
export class GatewayReceiptRepository implements IGatewayReceiptRepository {
  constructor(private db: StoreDB) {}

  insert(record: GatewayReceiptInsert) {
    return this.db
      .insert(gatewayReceipts)
      .values(record)
      .returning()
      .get();
  }

  findById(receiptId: string) {
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.receiptId, receiptId))
      .get();
  }

  findByJob(jobId: string, limit?: number) {
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.jobId, jobId))
      .orderBy(asc(gatewayReceipts.createdAt))
      .limit(capLimit(limit))
      .all();
  }

  findBySession(sessionId: string, limit?: number) {
    // seq-ascending: a session's receipts ARE its accepted chain, in order.
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.sessionId, sessionId))
      .orderBy(asc(gatewayReceipts.seq))
      .limit(capLimit(limit))
      .all();
  }

  findByCheckpointHash(checkpointHash: string) {
    return this.db
      .select()
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.checkpointHash, checkpointHash))
      .orderBy(asc(gatewayReceipts.createdAt))
      .all();
  }

  lastAcceptedForSession(
    sessionId: string,
  ): GatewayReceiptSessionSnapshot | undefined {
    const row = this.db
      .select({
        seq: gatewayReceipts.seq,
        checkpointHash: gatewayReceipts.checkpointHash,
        receiptId: gatewayReceipts.receiptId,
      })
      .from(gatewayReceipts)
      .where(eq(gatewayReceipts.sessionId, sessionId))
      .orderBy(desc(gatewayReceipts.seq))
      .limit(1)
      .get();
    if (!row) return undefined;
    return {
      lastSeq: row.seq,
      lastHash: row.checkpointHash,
      lastReceiptId: row.receiptId,
    };
  }
}

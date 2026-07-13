import { and, asc, eq } from "drizzle-orm";
import { checkpointBodies } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  CheckpointBodyInsert,
  ICheckpointBodyRepository,
} from "../interfaces/ICheckpointBodyRepository.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function capLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Persistence for checkpoint bodies (§8.4-B-3 / §2.2 step 7). Pure data access —
 * checkpoint verification and the transactional receipt live in the gateway
 * (services/gateway-receipt-store.ts, step 5). This class only reads and writes
 * rows; finalize replays a session's bodies via `findBySession` (seq-asc).
 */
export class CheckpointBodyRepository implements ICheckpointBodyRepository {
  constructor(private db: StoreDB) {}

  insert(record: CheckpointBodyInsert) {
    return this.db.insert(checkpointBodies).values(record).returning().get();
  }

  findBySessionSeq(sessionId: string, seq: number) {
    return this.db
      .select()
      .from(checkpointBodies)
      .where(and(eq(checkpointBodies.sessionId, sessionId), eq(checkpointBodies.seq, seq)))
      .get();
  }

  findBySession(sessionId: string, limit?: number) {
    // seq-ascending: a session's bodies replay in checkpoint-chain order.
    return this.db
      .select()
      .from(checkpointBodies)
      .where(eq(checkpointBodies.sessionId, sessionId))
      .orderBy(asc(checkpointBodies.seq))
      .limit(capLimit(limit))
      .all();
  }
}

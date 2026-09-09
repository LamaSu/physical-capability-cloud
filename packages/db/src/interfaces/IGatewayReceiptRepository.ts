import type { gatewayReceipts } from "../schema/index.js";

export type GatewayReceiptRow = typeof gatewayReceipts.$inferSelect;
export type GatewayReceiptInsert = typeof gatewayReceipts.$inferInsert;

/**
 * The durable per-session accepted-chain tip, recovered from committed rows.
 * The DB-backed mirror of `sessionSequenceStore.snapshot()`; step 6 uses it to
 * re-issue acceptance state after a restart (§8.1-#3 "recoverable by re-issuing
 * from committed state").
 */
export interface GatewayReceiptSessionSnapshot {
  /** Highest accepted seq for the session. */
  lastSeq: number;
  /** The checkpointHash of the highest-seq accepted checkpoint. */
  lastHash: string;
  /** The receiptId of that top row. */
  lastReceiptId: string;
}

export interface IGatewayReceiptRepository {
  insert(record: GatewayReceiptInsert): GatewayReceiptRow | undefined;
  findById(receiptId: string): GatewayReceiptRow | undefined;
  /** A job's receipts, oldest-first by createdAt. */
  findByJob(jobId: string, limit?: number): GatewayReceiptRow[];
  /**
   * A session's accepted chain, in seq order (ascending), CAPPED (default 100 /
   * max 1000). Fine for UI listing; NOT safe for protocol chain reconstruction —
   * a chain longer than the cap silently truncates. Use findAllBySession for any
   * evidenceRoot / recovery path.
   */
  findBySession(sessionId: string, limit?: number): GatewayReceiptRow[];
  /**
   * The FULL session chain, seq-ascending, with NO limit. evidenceRoot /
   * chain-reconstruction / recovery paths MUST use this — never the capped
   * findBySession, whose truncation would compute a forked evidence root over a
   * partial chain. The full-row integrity assert applies here too.
   */
  findAllBySession(sessionId: string): GatewayReceiptRow[];
  /**
   * Receipt(s) attesting a checkpoint hash. Returns an array: a hash is unique
   * WITHIN a session's chain (never accepted twice), but the mechanism does not
   * forbid the same hash appearing across two sessions.
   */
  findByCheckpointHash(checkpointHash: string): GatewayReceiptRow[];
  /** The per-session last-accepted snapshot (lastSeq/lastHash), or undefined if none. */
  lastAcceptedForSession(sessionId: string): GatewayReceiptSessionSnapshot | undefined;
}

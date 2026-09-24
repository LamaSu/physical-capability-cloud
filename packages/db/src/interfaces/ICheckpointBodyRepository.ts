import type { checkpointBodies } from "../schema/index.js";

export type CheckpointBodyRow = typeof checkpointBodies.$inferSelect;
export type CheckpointBodyInsert = typeof checkpointBodies.$inferInsert;

export interface ICheckpointBodyRepository {
  insert(record: CheckpointBodyInsert): CheckpointBodyRow | undefined;
  findBySessionSeq(sessionId: string, seq: number): CheckpointBodyRow | undefined;
  /** A session's checkpoint bodies in seq order (ascending) — capped (UI). */
  findBySession(sessionId: string, limit?: number): CheckpointBodyRow[];
  /**
   * The FULL session chain, seq-asc, UNCAPPED. finalize's payload replay is a
   * money-path read — it MUST see every revealed body, so it uses this, never the
   * capped findBySession (same S6-6 truncation hazard as gateway_receipts).
   */
  findAllBySession(sessionId: string): CheckpointBodyRow[];
  /**
   * Persist a revealed payload for (sessionId, seq) — the S6-5 reveal path. Only the
   * `payload` column changes (the receipted checkpoint fields are immutable). Idempotent:
   * re-revealing the same payload is a harmless overwrite. Returns the updated row, or
   * undefined if no checkpoint body exists at (sessionId, seq).
   */
  setPayload(sessionId: string, seq: number, payload: unknown): CheckpointBodyRow | undefined;
}

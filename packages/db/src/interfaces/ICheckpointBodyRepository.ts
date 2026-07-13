import type { checkpointBodies } from "../schema/index.js";

export type CheckpointBodyRow = typeof checkpointBodies.$inferSelect;
export type CheckpointBodyInsert = typeof checkpointBodies.$inferInsert;

export interface ICheckpointBodyRepository {
  insert(record: CheckpointBodyInsert): CheckpointBodyRow | undefined;
  findBySessionSeq(sessionId: string, seq: number): CheckpointBodyRow | undefined;
  /** A session's checkpoint bodies in seq order (ascending) — finalize replay. */
  findBySession(sessionId: string, limit?: number): CheckpointBodyRow[];
}

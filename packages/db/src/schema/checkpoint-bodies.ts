import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Checkpoint bodies — persisted checkpoint content, so `finalize` can verify
 * payload commitments (§8.4-B-3). The gateway_receipts row for a checkpoint
 * carries only hashes; this SIBLING table keeps the checkpoint's own fields
 * (eventsRoot, type, device createdAt, signature, and the payload once revealed)
 * keyed by (sessionId, seq). Kept separate from gateway_receipts to leave that
 * table pure (spec §3 file list — "sibling table to leave gateway_receipts pure").
 *
 * Written by `POST /api/jobs/:jobId/evidence/checkpoints` step 7 (spec §2.2)
 * AFTER the transactional receipt is recorded. `payload` is NULLABLE — the
 * eventsRoot commitment is recorded at checkpoint time; the actual events may be
 * revealed later at finalize (§8.1-#1: new data allowed iff it matches receipted
 * commitments).
 *
 * `deviceCreatedAt` is the device's ADVISORY createdAt (Unix SECONDS) — a skew
 * flag only, never an authority time (§8.4-A trailing clause). `createdAt` is
 * ISO 8601 row metadata (mirrors gateway_receipts.createdAt).
 *
 * ADDITIVE + NON-BREAKING: backs the step-6 checkpoint path only.
 */
export const checkpointBodies = sqliteTable(
  "checkpoint_bodies",
  {
    /** Deterministic id `ckpt-<sessionId>-<seq>`; PK. */
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    /** Strictly serial per session; first checkpoint is seq 1. */
    seq: integer("seq").notNull(),
    jobId: text("job_id").notNull(),
    /** Server-computed sha256 over the canonical checkpoint content. */
    checkpointHash: text("checkpoint_hash").notNull(),
    /** Previous accepted checkpoint hash in the chain; NULL at genesis. */
    prevCheckpointHash: text("prev_checkpoint_hash"),
    /** sha256 commitment to this checkpoint's event payloads. */
    eventsRoot: text("events_root").notNull(),
    /** e.g. "execution_started" | "workflow_step_completed" | "execution_completed". */
    checkpointType: text("checkpoint_type").notNull(),
    /** Device ADVISORY createdAt (Unix seconds) — skew flag only, never authority. */
    deviceCreatedAt: integer("device_created_at").notNull(),
    /** Session-key Ed25519 signature over the canonical checkpoint content. */
    signature: text("signature").notNull(),
    /** Event payloads, revealed at finalize; NULL until then (JSON). */
    payload: text("payload", { mode: "json" }),
    /** ISO 8601 row-creation timestamp (DB metadata). */
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    bySession: index("checkpoint_bodies_session_idx").on(t.sessionId),
    // UNIQUE(session_id, seq): one body per (session, seq) — mirrors the
    // gateway_receipts per-(session, seq) invariant. Also serves findBySessionSeq
    // and findBySession's seq-ordered replay.
    bySessionSeq: uniqueIndex("checkpoint_bodies_session_seq_unique").on(t.sessionId, t.seq),
  }),
);

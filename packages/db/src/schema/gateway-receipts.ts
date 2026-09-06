import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Gateway receipts — per-checkpoint transactional acceptance records
 * (§8.5 step 5 of the frozen v3 evidence-signing protocol, object model §8.3).
 *
 * One row per accepted checkpoint. A GatewayReceipt is the gateway's signed
 * assertion "PCC durably accepted checkpoint <checkpointHash> at
 * <acceptedAt>" — the online freshness anchor / TIME-AUTHORITY artifact of
 * §8.4's division of responsibilities.
 *
 * THE TRANSACTIONAL INVARIANT (frozen §8.3): a receipt row exists IFF the
 * checkpoint was durably accepted, serialized per session. The write path lives
 * in the step-5 mechanism module services/gateway-receipt-store.ts (persist this
 * row, then advance the in-memory `sessionSequenceStore` — the row commits
 * first, so a receipt is exposed only after commit). That module is unit-proven
 * but NOT yet wired into any live route; step 6 wires it into the
 * checkpoint-submission path. This table is the durable source of truth a
 * restart recovers accepted-chain tips from (`lastAcceptedForSession`).
 *
 * The full receipt (content + signature) is stored in `body` (JSON) for a
 * lossless round-trip; the individual columns duplicate receipt fields for
 * index-friendly query patterns:
 *   - by jobId       (all receipts for a job)
 *   - by sessionId   (a session's accepted chain, in seq order)
 *   - by checkpointHash (provenance: which receipt attests a checkpoint)
 *   - by (sessionId, seq) (the per-session last-accepted snapshot)
 *
 * ADDITIVE + NON-BREAKING: this table backs the step-5 mechanism only. Wiring
 * the write path into the live checkpoint-submission / settlement flow is
 * step 6 — no route reads or writes this table yet.
 *
 * CHECK CONSTRAINTS (authoritative in migrate.ts, NOT here): the raw-SQL CREATE
 * TABLE in packages/db/src/migrate.ts adds three §8.3 invariant CHECKs that
 * drizzle-orm cannot cleanly express on a table (no first-class table-CHECK API),
 * so the migration SQL is the source of truth — this schema is the drizzle
 * mirror for typed queries only. The enforced rules are:
 *   - seq >= 1                      (1-based; genesis is seq 1)
 *   - session_state_version = seq   (they coincide under the strict chain — see
 *                                    the sessionStateVersion column note below)
 *   - accepted_at > 0               (a positive Unix-seconds point)
 * Body/column divergence is caught at READ time by the repository's
 * assertRowIntegrity (a signed-artifact drift fails closed), not by a DB CHECK.
 *
 * Mirrors invocation-receipts.ts (column-duplication-for-indexes; body for
 * round-trip; no logic here — the receipt-store owns canonicalization/signing).
 */
export const gatewayReceipts = sqliteTable(
  "gateway_receipts",
  {
    /** Deterministic id `grcpt-<sessionId>-<seq>`. Per-(session,seq) uniqueness is ALSO DB-enforced by gateway_receipts_session_seq_unique — not left to this id scheme alone. */
    receiptId: text("receipt_id").primaryKey(),
    /**
     * Identifies the Ed25519 gateway key that signed this receipt. The key
     * HISTORY must itself be tamper-evident (§8.1-#3 caveat) — see the TODO in
     * gateway-receipt-signer.ts; a single configured key id is used for now.
     */
    gatewayKeyId: text("gateway_key_id").notNull(),

    jobId: text("job_id").notNull(),
    /** The ephemeral session whose accepted chain this checkpoint extends. */
    sessionId: text("session_id").notNull(),
    /** Strictly serial per session; first accepted checkpoint is seq 1 (§8.4-A step 5). */
    seq: integer("seq").notNull(),

    /** This checkpoint's own hash (the accepted unit). */
    checkpointHash: text("checkpoint_hash").notNull(),
    /** Previous accepted checkpoint hash in this session's chain. NULL at genesis. */
    previousAcceptedHash: text("previous_accepted_hash"),

    /**
     * Monotonic per-session version = the new lastAcceptedSeq after this
     * checkpoint (= accepted-checkpoint count; they coincide under the strict
     * seq===lastAcceptedSeq+1 chain from genesis seq=1). See §8.3.
     */
    sessionStateVersion: integer("session_state_version").notNull(),
    /**
     * acceptedAt = effectiveEvidenceTime (the point), Unix SECONDS. Supplied
     * to the receipt-store by the caller (step 6 passes the live gateway
     * receivedAt); never the device's raw timestamp (§7.1/§7.3-4).
     */
    acceptedAt: integer("accepted_at").notNull(),

    /** Ed25519 gateway signature (128-hex) over the canonical receipt content (sans signature). */
    signature: text("signature").notNull(),

    /** Full receipt body as JSON (content + signature) for round-trip + future-proofing. */
    body: text("body", { mode: "json" }).notNull(),

    /** ISO 8601 row creation timestamp (DB metadata; distinct from acceptedAt). */
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    byJob: index("gateway_receipts_job_idx").on(t.jobId),
    bySession: index("gateway_receipts_session_idx").on(t.sessionId),
    // checkpoint_hash alone: findByCheckpointHash resolves a hash ACROSS sessions.
    byCheckpoint: index("gateway_receipts_checkpoint_idx").on(t.checkpointHash),
    // UNIQUE(session_id, seq): the DB enforces one accepted receipt per session
    // sequence (the §8.3 invariant — not reliant on the deterministic receiptId
    // PK alone). Also serves lastAcceptedForSession (WHERE session_id=? ORDER BY
    // seq DESC LIMIT 1) and findBySession's seq-ordered chain replay.
    bySessionSeq: uniqueIndex("gateway_receipts_session_seq_unique").on(t.sessionId, t.seq),
    // UNIQUE(session_id, checkpoint_hash): a checkpoint hash is accepted at most
    // once within a session's chain (the mechanism never re-accepts a hash); the
    // same hash MAY recur across sessions, so the constraint is per-session.
    bySessionCheckpoint: uniqueIndex("gateway_receipts_session_checkpoint_unique").on(
      t.sessionId,
      t.checkpointHash,
    ),
  }),
);

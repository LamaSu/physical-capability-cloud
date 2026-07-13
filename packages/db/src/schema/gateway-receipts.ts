import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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
 * checkpoint was durably accepted, serialized per session. The write path
 * (services/gateway-receipt-store.ts) persists this row and the in-memory
 * acceptance advance atomically-in-effect: the row commits first, the
 * in-memory `sessionSequenceStore` advances only after commit. So this table
 * is the durable source of truth a restart can recover accepted-chain tips
 * from (`lastAcceptedForSession`).
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
 * Mirrors invocation-receipts.ts (column-duplication-for-indexes; body for
 * round-trip; no logic here — the receipt-store owns canonicalization/signing).
 */
export const gatewayReceipts = sqliteTable(
  "gateway_receipts",
  {
    /** Deterministic id `grcpt-<sessionId>-<seq>` — unique (strict chain ⇒ one accept per (session,seq)). */
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
    byCheckpoint: index("gateway_receipts_checkpoint_idx").on(t.checkpointHash),
    // Serves lastAcceptedForSession (WHERE session_id=? ORDER BY seq DESC LIMIT 1)
    // and findBySession's seq-ordered chain replay.
    bySessionSeq: index("gateway_receipts_session_seq_idx").on(t.sessionId, t.seq),
  }),
);

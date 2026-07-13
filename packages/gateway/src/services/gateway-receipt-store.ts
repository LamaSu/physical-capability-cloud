/**
 * Transactional per-checkpoint gateway receipts — the §8.3 invariant, made real.
 *
 * FROZEN INVARIANT (§8.3): a signed GatewayReceipt exists (is returned) IFF the
 * checkpoint was durably accepted, serialized per session:
 *
 *   read prior → verify(§8.4-A step 5) → [TXN: persist + construct-from-persisted]
 *              → COMMIT → advance in-memory → return the stored, signed object.
 *
 * Two failure orderings this closes (§8.1-#3):
 *   - sign-then-crash-before-persist would hand out a freshness proof for a
 *     checkpoint the store never durably accepted (phantom evidence). Here the
 *     receipt is EXPOSED only after the row commits, so a crash before commit
 *     yields no receipt.
 *   - advance-in-memory-then-crash-before-persist would leave the accepted-chain
 *     tip ahead of the durable store. Here the in-memory advance happens ONLY
 *     after the DB commit; a persisted row with no advance is the recoverable
 *     direction (re-issue the tip from committed state via
 *     repo.lastAcceptedForSession).
 *
 * SINGLE-WRITER: the whole read→verify→persist→advance is ONE synchronous span
 * with NO `await`. In a single Node process the event loop cannot interleave
 * another `record()` between the prior read and the in-memory advance, so
 * `seq === lastAcceptedSeq + 1` unambiguously serializes the chain. `checkSequence`
 * (pure), `signer.sign` (node:crypto, sync), `db.transaction` (better-sqlite3,
 * sync), and `sequenceStore.accept` (sync) are all synchronous — the property
 * holds by construction. Mirrors the pattern documented in session-sequence-store.ts.
 *
 * ADDITIVE + NON-BREAKING (step 5, NOT step 6): nothing here is wired into
 * paid-job-flow.ts / device-evidence-settlement.ts / the settlement gate.
 * `effectiveEvidenceTime` is PASSED IN — step 6 supplies the live gateway
 * receivedAt (§7.1/§7.3-4: never wall-clock-now, never the device's raw claim).
 * This module delivers the mechanism, unit-proven.
 */

import {
  checkSequence,
  type SequenceEntry,
  type SequenceRejectReason,
} from "@pcc/verifier";
import type {
  StoreDB,
  IGatewayReceiptRepository,
  GatewayReceiptRow,
  GatewayReceiptInsert,
} from "@pcc/store";
import {
  SessionSequenceStore,
  sessionSequenceStore,
} from "./session-sequence-store.js";
import {
  GatewayReceiptSigner,
  getDefaultGatewayReceiptSigner,
} from "./gateway-receipt-signer.js";

/**
 * The §8.3 GatewayReceipt object. Ed25519-signed by the gateway; the online
 * freshness anchor / time-authority artifact. `sessionId` is carried alongside
 * the §8.3 fields so the receipt is self-describing for per-session queries.
 */
export interface GatewayReceipt {
  receiptId: string;
  gatewayKeyId: string;
  jobId: string;
  sessionId: string;
  /** Strictly serial per session (first accepted checkpoint is seq 1). */
  seq: number;
  checkpointHash: string;
  /** Previous accepted checkpoint hash; null at genesis. */
  previousAcceptedHash: string | null;
  /** Monotonic per-session version = the new lastAcceptedSeq after this checkpoint. */
  sessionStateVersion: number;
  /** acceptedAt = effectiveEvidenceTime (the point), Unix seconds. */
  acceptedAt: number;
  /** Ed25519 gateway signature (128-hex) over the canonical content (this object sans `signature`). */
  signature: string;
}

/** The exact bytes signed: the receipt object without its own signature. */
export type GatewayReceiptContent = Omit<GatewayReceipt, "signature">;

/** Input for one checkpoint-acceptance attempt. */
export interface CheckpointReceiptInput {
  jobId: string;
  sessionId: string;
  /** This checkpoint's serial number (must equal lastAcceptedSeq + 1 to be accepted). */
  seq: number;
  /** This checkpoint's own hash. */
  checkpointHash: string;
  /** Previous checkpoint hash in this session's chain; null for the genesis checkpoint. */
  prevCheckpointHash: string | null;
  /** The session's SessionScope.maxSignatures ceiling (§8.4-A step 5 bound). */
  maxSignatures: number;
  /**
   * effectiveEvidenceTime as a Unix-seconds point — PASSED IN by the caller.
   * Step 6 supplies the live gateway receivedAt; never wall-clock-now, never the
   * device's raw createdAt (§7.1/§7.3-4). Written as receipt.acceptedAt.
   */
  effectiveEvidenceTime: number;
  /** ISO row-creation timestamp; defaults to now(). DB metadata, distinct from acceptedAt. */
  createdAt?: string;
}

/**
 * Discriminated outcome. `accepted` carries the signed receipt (built from the
 * persisted row) + the raw row; `rejected` carries the §8.4-A step-5 reason and
 * guarantees NO persist + NO advance; `errored` means the persist transaction
 * threw (rolled back) — NO receipt and, critically, NO in-memory advance.
 */
export type RecordCheckpointResult =
  | { status: "accepted"; receipt: GatewayReceipt; row: GatewayReceiptRow }
  | { status: "rejected"; reason: SequenceRejectReason }
  | { status: "errored"; error: Error };

export interface GatewayReceiptStoreDeps {
  /** The store's drizzle DB — owns `.transaction()`. Must be the SAME connection the repo writes through. */
  db: StoreDB;
  /** Gateway-receipt persistence. Injected so tests can simulate a failing insert. */
  repo: IGatewayReceiptRepository;
  /** In-memory accepted-chain store. Defaults to the process-wide singleton. */
  sequenceStore?: SessionSequenceStore;
  /** Ed25519 signer. Defaults to the process-default gateway receipt signer. */
  signer?: GatewayReceiptSigner;
}

export class GatewayReceiptStore {
  private readonly db: StoreDB;
  private readonly repo: IGatewayReceiptRepository;
  private readonly sequenceStore: SessionSequenceStore;
  private readonly signer: GatewayReceiptSigner;

  constructor(deps: GatewayReceiptStoreDeps) {
    this.db = deps.db;
    this.repo = deps.repo;
    this.sequenceStore = deps.sequenceStore ?? sessionSequenceStore;
    this.signer = deps.signer ?? getDefaultGatewayReceiptSigner();
  }

  /** The signer's public key (hex) — for out-of-band verification / key publication. */
  get publicKeyHex(): string {
    return this.signer.publicKeyHex;
  }

  /**
   * Attempt to accept a checkpoint and mint its transactional receipt.
   *
   * The entire body is ONE synchronous critical section (no `await`) — see the
   * file header for why that is the single-writer guarantee.
   */
  record(input: CheckpointReceiptInput): RecordCheckpointResult {
    // 0. REHYDRATE-ON-FIRST-TOUCH (§1): after a restart, in-memory state is genesis
    //    for every session, but the durable gateway_receipts rows hold the real
    //    accepted tip. Recover it INSIDE this same synchronous span (before the
    //    priorState read) so no other record() can interleave between rehydrate and
    //    the accept below. better-sqlite3 reads are synchronous, so the critical
    //    section stays await-free (the single-writer property in the file header).
    //    §1 rules: rehydrate ONLY when memory is empty AND durable rows exist — a
    //    genuinely new session stays genesis (never store a genesis; rule 1). Once
    //    the tip is recovered, a post-restart replayed seq-1 rejects cleanly as
    //    `seq_gap_or_replay` (rule 3) instead of hitting the deterministic PK, and a
    //    legit mid-session seq re-joins the chain. First-touch-wins: rehydrate()
    //    refuses to overwrite live memory (rule 2). NOTE: the idempotent receipt
    //    re-issue (rule 4) is the Wave-3 ROUTE's job, deliberately NOT here —
    //    record() stays strict (a re-submitted accepted seq still rejects/errors).
    //    Multi-instance durability is the Gate-5 boundary (rule 5), unchanged: one
    //    better-sqlite3 connection per process; a second instance is out of scope,
    //    and the deterministic PK makes a cross-instance violation detectable.
    if (!this.sequenceStore.hasSession(input.sessionId)) {
      const tip = this.repo.lastAcceptedForSession(input.sessionId); // sync
      if (tip) {
        const rows = this.repo.findBySession(input.sessionId); // seq-asc chain
        this.sequenceStore.rehydrate(input.sessionId, {
          lastSeq: tip.lastSeq,
          lastHash: tip.lastHash,
          seen: new Set(rows.map((r) => r.checkpointHash)), // rebuild the dup-hash set
        });
      }
    }

    // 1. READ the prior accepted-chain state (incl. `seen`, for the dup-hash clause).
    const prior = this.sequenceStore.priorState(input.sessionId);

    // 2. VERIFY §8.4-A step 5 (pure). A reject here means NO persist, NO advance.
    const entry: SequenceEntry = {
      seq: input.seq,
      prevHash: input.prevCheckpointHash,
      hash: input.checkpointHash,
      maxSignatures: input.maxSignatures,
    };
    const check = checkSequence(entry, prior);
    if (!check.accepted) {
      return { status: "rejected", reason: check.reason as SequenceRejectReason };
    }

    // 3. Construct the receipt CONTENT from the verified input + prior tip.
    //    previousAcceptedHash === prior.lastHash (== entry.prevHash by the chain
    //    clause just checked). sessionStateVersion === entry.seq: under the strict
    //    seq===lastAcceptedSeq+1 chain from genesis (seq starts at 1), the new
    //    lastAcceptedSeq equals the count of accepted checkpoints — they coincide
    //    — so entry.seq is the monotonic per-session version (§8.3).
    const content: GatewayReceiptContent = {
      receiptId: `grcpt-${input.sessionId}-${input.seq}`,
      gatewayKeyId: this.signer.keyId,
      jobId: input.jobId,
      sessionId: input.sessionId,
      seq: input.seq,
      checkpointHash: input.checkpointHash,
      previousAcceptedHash: prior.lastHash,
      sessionStateVersion: input.seq,
      acceptedAt: input.effectiveEvidenceTime,
    };
    // Sign deterministically (pure + synchronous → critical section intact). The
    // signature is not EXPOSED until the row commits below; §8.1-#3 protects
    // exposure ordering, not the moment the bytes are computed.
    const signature = this.signer.sign(content);
    const receipt: GatewayReceipt = { ...content, signature };

    const createdAt = input.createdAt ?? new Date().toISOString();
    const insertRow: GatewayReceiptInsert = {
      receiptId: receipt.receiptId,
      gatewayKeyId: receipt.gatewayKeyId,
      jobId: receipt.jobId,
      sessionId: receipt.sessionId,
      seq: receipt.seq,
      checkpointHash: receipt.checkpointHash,
      previousAcceptedHash: receipt.previousAcceptedHash,
      sessionStateVersion: receipt.sessionStateVersion,
      acceptedAt: receipt.acceptedAt,
      signature: receipt.signature,
      body: receipt as unknown as Record<string, unknown>,
      createdAt,
    };

    // 4. PERSIST inside a synchronous transaction; construct-from-persisted via
    //    the returned row. If the insert throws, drizzle rolls back and rethrows
    //    → we return `errored` WITHOUT advancing. receipt ⟺ committed row.
    //    NOTE (better-sqlite3): drizzle's `db.transaction(fn)` RUNS fn immediately
    //    and returns its result (unlike native better-sqlite3, which returns a
    //    callable). Because @pcc/store is a SINGLE-connection better-sqlite3 DB,
    //    `repo.insert` (same connection) executed inside the callback runs
    //    between BEGIN/COMMIT and is part of the transaction — no `tx` handoff
    //    needed (that is only required for pooled async drivers).
    let storedRow: GatewayReceiptRow | undefined;
    try {
      storedRow = this.db.transaction(() => this.repo.insert(insertRow));
    } catch (err) {
      return {
        status: "errored",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    if (!storedRow) {
      // Defensive: no row came back (nothing durably committed) — do NOT advance.
      return {
        status: "errored",
        error: new Error("gateway receipt insert returned no row"),
      };
    }

    // 5. COMMITTED. Advance the in-memory accepted-chain — AFTER commit, still
    //    within the synchronous span. accept() re-runs the pure check against the
    //    (unchanged) prior state and advances. It MUST accept; a rejection would
    //    mean state changed mid-critical-section (impossible in one process), so
    //    surface it loudly rather than let the in-memory tip silently diverge
    //    from the committed row (the row is durable + recoverable regardless).
    const advance = this.sequenceStore.accept(input.sessionId, entry);
    if (!advance.accepted) {
      throw new Error(
        `gateway-receipt invariant violation: receipt ${receipt.receiptId} committed ` +
          `but in-memory advance rejected (${advance.reason})`,
      );
    }

    // 6. Return the receipt built FROM the persisted row (body round-trip) — the
    //    §8.3 "construct receipt FROM PERSISTED VALUES" contract.
    return {
      status: "accepted",
      receipt: storedRow.body as unknown as GatewayReceipt,
      row: storedRow,
    };
  }
}

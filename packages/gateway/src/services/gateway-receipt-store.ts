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
  ICheckpointBodyRepository,
  CheckpointBodyInsert,
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
  /**
   * The checkpoint's events commitment (sha256). Persisted to the checkpoint_bodies
   * sibling row ATOMICALLY with the receipt (§8.1-#3 split-brain fix).
   */
  eventsRoot: string;
  /**
   * The checkpoint type (e.g. "execution_completed"). Persisted to the body row and
   * read by finalize to enforce the terminal-completion requirement (frozen §8.1-#1).
   */
  checkpointType: string;
  /**
   * The device's ADVISORY createdAt (Unix seconds) — a skew flag only, never authority
   * (§8.4-A). Persisted to the body row (distinct from the receipt `createdAt` metadata).
   */
  deviceCreatedAt: number;
  /** The session-key Ed25519 signature over the canonical checkpoint content. Persisted to the body row. */
  signature: string;
}

/**
 * Discriminated outcome. `accepted` carries the signed receipt (built from the
 * persisted row) + the raw row; `idempotent` (H1) is an EXACT resubmit of an
 * already-committed checkpoint (response-lost-after-commit) — the committed
 * receipt, NO 2nd row; `conflict` (H1) is a DIFFERENT checkpoint at an
 * already-committed (sessionId, seq) — an equivocation attempt, committed row
 * left untouched; `rejected` carries the §8.4-A step-5 reason and guarantees NO
 * persist + NO advance; `errored` means a contract-violating input (R-14b) or a
 * persist transaction that threw (rolled back) — NO receipt and NO advance.
 */
export type RecordCheckpointResult =
  | { status: "accepted"; receipt: GatewayReceipt; row: GatewayReceiptRow }
  | { status: "idempotent"; receipt: GatewayReceipt; row: GatewayReceiptRow }
  | { status: "conflict"; reason: "equivocation" }
  | { status: "rejected"; reason: SequenceRejectReason }
  | { status: "errored"; error: Error };

/**
 * R-14b defensive input validation for `record()`. A structurally invalid input
 * is a CONTRACT VIOLATION (→ `errored`), never a sequence reject: it must never
 * reach checkSequence / the signer / the DB. Returns a clear message on the
 * first violation, or null when the input is structurally sound. (`gatewayKeyId`
 * comes from the signer and `sessionStateVersion` is set to `seq` by record(),
 * so those are correct by construction; the W2.5a DB CHECKs are the storage-layer
 * backstop below this service-layer guard.)
 */
function validateCheckpointInput(input: CheckpointReceiptInput): string | null {
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    return `invalid seq ${JSON.stringify(input.seq)} (must be an integer >= 1)`;
  }
  if (!Number.isInteger(input.maxSignatures) || input.maxSignatures < 0) {
    return `invalid maxSignatures ${JSON.stringify(input.maxSignatures)} (must be an integer >= 0)`;
  }
  if (!Number.isFinite(input.effectiveEvidenceTime) || input.effectiveEvidenceTime <= 0) {
    return `invalid effectiveEvidenceTime ${JSON.stringify(input.effectiveEvidenceTime)} (must be a finite number > 0)`;
  }
  if (typeof input.jobId !== "string" || input.jobId.trim() === "") {
    return "invalid jobId (must be a non-empty string)";
  }
  if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
    return "invalid sessionId (must be a non-empty string)";
  }
  if (typeof input.checkpointHash !== "string" || input.checkpointHash.trim() === "") {
    return "invalid checkpointHash (must be a non-empty string)";
  }
  // Body fields (persisted atomically with the receipt) — keep garbage out of the txn.
  if (typeof input.eventsRoot !== "string" || input.eventsRoot.trim() === "") {
    return "invalid eventsRoot (must be a non-empty string)";
  }
  if (typeof input.checkpointType !== "string" || input.checkpointType.trim() === "") {
    return "invalid checkpointType (must be a non-empty string)";
  }
  if (typeof input.signature !== "string" || input.signature.trim() === "") {
    return "invalid signature (must be a non-empty string)";
  }
  if (!Number.isFinite(input.deviceCreatedAt)) {
    return `invalid deviceCreatedAt ${JSON.stringify(input.deviceCreatedAt)} (must be a finite number)`;
  }
  return null;
}

export interface GatewayReceiptStoreDeps {
  /** The store's drizzle DB — owns `.transaction()`. Must be the SAME connection the repos write through. */
  db: StoreDB;
  /** Gateway-receipt persistence. Injected so tests can simulate a failing insert. */
  repo: IGatewayReceiptRepository;
  /**
   * Checkpoint-body sibling persistence. The body row is inserted ATOMICALLY with the
   * receipt inside record()'s single transaction (§8.1-#3 split-brain fix), and read
   * by the H1 idempotent-integrity guard. Same connection as `repo`.
   */
  checkpointBodies: ICheckpointBodyRepository;
  /** In-memory accepted-chain store. Defaults to the process-wide singleton. */
  sequenceStore?: SessionSequenceStore;
  /** Ed25519 signer. Defaults to the process-default gateway receipt signer. */
  signer?: GatewayReceiptSigner;
}

export class GatewayReceiptStore {
  private readonly db: StoreDB;
  private readonly repo: IGatewayReceiptRepository;
  private readonly checkpointBodies: ICheckpointBodyRepository;
  private readonly sequenceStore: SessionSequenceStore;
  private readonly signer: GatewayReceiptSigner;

  constructor(deps: GatewayReceiptStoreDeps) {
    this.db = deps.db;
    this.repo = deps.repo;
    this.checkpointBodies = deps.checkpointBodies;
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
    // R-14b. DEFENSIVE INPUT VALIDATION (contract violation → `errored`, NOT a
    //    sequence reject). record() is the money-path acceptance gate; a
    //    structurally invalid input must never reach the rehydrate probe,
    //    checkSequence, the signer, or the DB. Runs first so a garbage sessionId
    //    never triggers a rehydrate read. The DB CHECKs (W2.5a) are the storage
    //    backstop; this fails fast at the service layer with a clear message.
    const invalidInput = validateCheckpointInput(input);
    if (invalidInput) {
      return { status: "errored", error: new Error(`gateway receipt record: ${invalidInput}`) };
    }

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

    // H1. DB-AUTHORITATIVE idempotency / equivocation guard. The durable
    //    gateway_receipts row at (sessionId, seq) is the SOURCE OF TRUTH; the
    //    in-memory chain is only a cache over it. Resolve the deterministic id
    //    BEFORE checkSequence so the discriminator is "does a committed row exist
    //    AT THIS seq?":
    //      - yes + SAME (jobId, checkpointHash, prevCheckpointHash)  → idempotent
    //        (the response was lost after commit; return the committed receipt,
    //        insert NO 2nd row, do NOT mis-classify as a replay).
    //      - yes + DIFFERENT any of those                           → conflict
    //        (equivocation: a fork attempt at a committed height; NEVER overwrite
    //        the committed row).
    //      - no row                                                 → fall through
    //        to the existing checkSequence path (accept / seq_gap_or_replay /
    //        chain_broken / max_signatures / duplicate_hash), UNCHANGED.
    //    findById is sync + integrity-asserted (W2.5a), so the critical section
    //    stays await-free (the single-writer property in the file header).
    const committed = this.repo.findById(`grcpt-${input.sessionId}-${input.seq}`);
    if (committed) {
      const sameCheckpoint =
        committed.jobId === input.jobId &&
        committed.checkpointHash === input.checkpointHash &&
        (committed.previousAcceptedHash ?? null) === (input.prevCheckpointHash ?? null);
      if (sameCheckpoint) {
        // INTEGRITY (§8.1-#3 split-brain fix): a committed receipt row MUST have a
        // matching checkpoint_bodies row — record() inserts them atomically below. If
        // the body is MISSING or DIVERGES from the committed receipt / this input, that
        // is an integrity failure, NOT a safe idempotent replay. Fail closed: a
        // committed receipt without a matching body must NEVER return `idempotent`.
        const body = this.checkpointBodies.findBySessionSeq(input.sessionId, input.seq);
        if (
          !body ||
          body.checkpointHash !== committed.checkpointHash ||
          body.eventsRoot !== input.eventsRoot
        ) {
          return {
            status: "errored",
            error: new Error(
              `gateway receipt integrity: committed receipt without a matching checkpoint body ` +
                `for ${committed.receiptId} (body ${body ? "diverges" : "missing"})`,
            ),
          };
        }
        return {
          status: "idempotent",
          receipt: committed.body as unknown as GatewayReceipt,
          row: committed,
        };
      }
      return { status: "conflict", reason: "equivocation" };
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

    // The checkpoint_bodies sibling row — inserted ATOMICALLY with the receipt in the
    // SAME transaction (§8.1-#3 split-brain fix: a committed receipt and its body
    // commit together or not at all). Its `createdAt` derives from
    // effectiveEvidenceTime (the acceptance point), matching the route's prior body
    // createdAt; distinct from the receipt row's ISO metadata `createdAt` above.
    const bodyRow: CheckpointBodyInsert = {
      id: `ckpt-${input.sessionId}-${input.seq}`,
      sessionId: input.sessionId,
      seq: input.seq,
      jobId: input.jobId,
      checkpointHash: input.checkpointHash,
      prevCheckpointHash: input.prevCheckpointHash,
      eventsRoot: input.eventsRoot,
      checkpointType: input.checkpointType,
      deviceCreatedAt: input.deviceCreatedAt,
      signature: input.signature,
      payload: null,
      createdAt: new Date(input.effectiveEvidenceTime * 1000).toISOString(),
    };

    // 4. PERSIST inside a synchronous transaction; construct-from-persisted via
    //    the returned receipt row. The receipt row AND the checkpoint_bodies row insert
    //    inside the ONE transaction — if EITHER throws, drizzle rolls back BOTH and
    //    rethrows → we return `errored` WITHOUT advancing (no split-brain). receipt ⟺
    //    (committed receipt row AND committed body row).
    //    NOTE (better-sqlite3): drizzle's `db.transaction(fn)` RUNS fn immediately
    //    and returns its result (unlike native better-sqlite3, which returns a
    //    callable). Because @pcc/store is a SINGLE-connection better-sqlite3 DB, both
    //    `repo.insert` and `checkpointBodies.insert` (same connection) executed inside
    //    the callback run between BEGIN/COMMIT and are part of the transaction — no `tx`
    //    handoff needed (that is only required for pooled async drivers).
    let storedRow: GatewayReceiptRow | undefined;
    try {
      storedRow = this.db.transaction(() => {
        const row = this.repo.insert(insertRow);
        // Receipt inserted FIRST, body SECOND: a body-insert throw rolls the receipt back.
        this.checkpointBodies.insert(bodyRow);
        return row;
      });
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

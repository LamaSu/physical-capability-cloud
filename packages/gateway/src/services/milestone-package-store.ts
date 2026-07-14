/**
 * Milestone package store — assemble → verify (§8.4-B) → persist → receipt the
 * claim-free FinalMilestonePackage under the step-5 TRANSACTIONAL INVARIANT
 * (spec §2.3, §8.4-B; object model §8.3 L317-324). MIRRORS
 * `gateway-receipt-store.ts`: read → verify → [TXN: persist + construct-from-
 * persisted] → COMMIT → return the stored object; the signature is EXPOSED only
 * after the row commits.
 *
 * SINGLE-WRITER / AWAIT-FREE: the whole `finalize` body is ONE synchronous span
 * with NO `await` (better-sqlite3 reads/writes are sync; merkleRoot,
 * canonicalSha256, signer.sign, db.transaction are all sync). A crash before
 * commit yields no package row and no session-finalize; a crash after commit is
 * recoverable idempotently from the persisted row. Same property the receipt
 * store documents.
 *
 * SEQUENCING INVARIANTS this file upholds (the §5 through-line):
 *  - The package introduces NO new claims and needs NO live key; its only time
 *    bound is window 3 via its own PackageReceipt (§8.4-B, §8.1-#1). It is
 *    permissionless-in-principle — the gateway recomputes everything from its OWN
 *    durable store, so any authenticated caller may trigger it (§8.3 L317).
 *  - The accepted chain is rebuilt from the DURABLE `gateway_receipts` rows ONLY
 *    (§8.4-B-1). In-memory acceptance state is NEVER consulted here — the durable
 *    rows ARE the gateway's acceptance record. A non-accepted hash simply is not
 *    in this chain; that is how "references only accepted checkpoints" is enforced.
 *  - Package persist + session-finalize are ATOMIC in one transaction (§2.3-10).
 *  - Fail closed: a lookup/verify failure is a `rejected` variant with a stable
 *    reason code; a partial accepted chain is an `errored` (never a wrong root).
 *
 * CLAIM-FREE PROPERTY (§8.3 L317-324, §2.3): the package has NO `assuranceTier`,
 * NO `oracleVerified`, NO success/outcome field. Tier and success are ORACLE
 * outputs (step 10), never device or package assertions. The terminal
 * `execution_completed` checkpoint is where completion is CLAIMED (signed +
 * receipted under live authority); the package merely aggregates receipted hashes.
 *
 * BOUNDARY: this is a SERVICE, not a route. `finalize` returns a discriminated
 * union with stable reason codes; the Wave-3 route maps each variant to an HTTP
 * status AND owns the job-status vocabulary — the JOB flip to `evidence_finalized`
 * is the ROUTE's job, NOT this store's. This store flips only the SESSION status
 * to `finalized`. No session-signature verification here (the checkpoint route did
 * that at submission; finalize trusts the already-receipted durable chain).
 *
 * ADDITIVE + NON-BREAKING: backs the step-6 finalize path only.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "@pcc/spec";
import { merkleRoot } from "@pcc/verifier";
import type {
  StoreDB,
  IEvidenceSessionRepository,
  IGatewayReceiptRepository,
  ICheckpointBodyRepository,
  IMilestonePackageRepository,
  MilestonePackageInsert,
  MilestonePackageRow,
} from "@pcc/store";
import {
  GatewayReceiptSigner,
  getDefaultGatewayReceiptSigner,
} from "./gateway-receipt-signer.js";

/**
 * CROSS-WAVE HASH CONTRACT (must be byte-identical across Waves 2/3/4):
 *   canonicalSha256(x) = "sha256:" + sha256hex( utf8( canonicalize(x) ) )
 *   eventsRoot   = canonicalSha256(events)            // events = a checkpoint's events[]
 *   packageHash  = canonicalSha256(FinalMilestonePackage)
 *
 * This is the SAME idiom paid-job-flow.ts uses for `gatewayBundleHash`
 * (crypto.createHash over the canonical string, node:crypto, SYNCHRONOUS) — NOT
 * @pcc/spec's async `crypto.subtle` sha256, which would inject an `await` into the
 * single-writer critical section. `createHash(...).update(<string>)` uses utf8 by
 * default, so this is exactly sha256hex(utf8(canonicalize(x))). `finalize`
 * RECOMPUTES `eventsRoot` for a revealed payload and compares to the stored
 * commitment — it must equal what the device computed (§8.1-#1). `packageHash` is
 * the content-addressed unit `GET /api/evidence/:hash` serves and the oracle
 * re-hashes (a Merkle root is NOT a document content hash — keep them distinct,
 * §2.3 naming rule).
 */
function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

/**
 * Terminal-completion checkpoint types (frozen §8.1-#1): the LAST accepted checkpoint
 * must be one of these for finalize to assemble a success package — completion is a
 * CLAIM signed + receipted under LIVE authority, not an inference the package makes.
 * A named, extensible set (add future terminal-completion types here).
 */
const TERMINAL_COMPLETION_TYPES: ReadonlySet<string> = new Set(["execution_completed"]);

/**
 * The terminal FAULT checkpoint type — a run that reached a terminal state but FAILED.
 * Distinct from a chain that simply never completed: it yields its own reject reason
 * (`terminal_fault`), never a success finalize.
 */
const TERMINAL_FAULT_TYPE = "fault_report";

/**
 * The §8.3 claim-free FinalMilestonePackage (L317-324, interim fields). Content-
 * addressed by `packageHash = canonicalSha256(thisObject)`; the object carries
 * NEITHER its own hash NOR any tier/success claim.
 */
export interface FinalMilestonePackage {
  packageId: string; // "fmp-<jobId>-<milestoneIndex>"
  jobId: string;
  milestoneIndex: number;
  sessionId: string;
  /** Accepted checkpoint hashes in seq order — equals the gateway's own accepted set. */
  acceptedCheckpointHashes: string[];
  /** Provenance: the receipts attesting each hash (seq order). */
  receiptIds: string[];
  /** MerkleRoot(acceptedCheckpointHashes) (§3.3, §8.4-B-2). */
  evidenceRoot: string;
  /** The receipted hash of the terminal completion checkpoint (the last accepted checkpoint). */
  terminalCheckpointHash: string;
  /** The delegation's crypto session-key id (S6-8), distinct from the evidence sessionId; null on pre-S6-8 rows. */
  delegationSessionId: string | null;
  // Round-5 payloads-out: the package carries NO payloads. Revealed payloads live OUTSIDE the
  // immutable package (content-addressed by checkpoint hash, fetched independently), so a
  // permissionless finalizer cannot curate/exclude them and finalize-before-reveal is a no-op.
  /** §7.1 — how time was established (step-6 online path). */
  evidenceTimeProvenance: {
    kind: "gateway-receipt-points";
    firstAcceptedAt: number;
    lastAcceptedAt: number;
  };
}

/** The settlement-boundary receipt over the package (§8.3 L323-324, §8.4-B-4). */
export interface PackageReceipt {
  receiptId: string; // "fmprcpt-<jobId>-<milestoneIndex>"
  gatewayKeyId: string;
  jobId: string;
  milestoneIndex: number;
  sessionId: string;
  packageHash: string;
  evidenceRoot: string;
  acceptedCount: number;
  /** Window-3 boundary time = finalize receivedAt, Unix seconds. */
  acceptedAt: number;
  /** Ed25519 gateway signature over the canonical content (this object sans `signature`). */
  signature: string;
}

/** The exact bytes signed: the package receipt without its own signature. */
export type PackageReceiptContent = Omit<PackageReceipt, "signature">;

/**
 * Input for one finalize attempt. `now` is the finalize receivedAt (Unix seconds).
 * Round-5 payloads-out: the package binds ONLY commitments (accepted chain + receipts +
 * evidenceRoot + terminal checkpoint + delegation session) — it carries NO payloads at all.
 * Revealed payloads live outside the immutable package, content-addressed by checkpoint hash and
 * fetched independently, so a permissionless finalizer cannot curate/exclude them AND finalizing
 * before the device reveals changes nothing in the package (the S6-5 griefing race is gone).
 */
export interface FinalizeMilestoneInput {
  jobId: string;
  milestoneIndex: number;
  now: number;
}

/** The stable §8.4-B rejection reasons (the Wave-3 route maps each to an HTTP status). */
export type FinalizeRejectReason =
  | "session_not_found"
  | "evidence_deadline_passed"
  | "no_checkpoints"
  | "payload_commitment_mismatch"
  // Frozen §8.1-#1 terminal-completion requirement (the Wave-3 route maps these → 422):
  | "terminal_checkpoint_missing" // last accepted checkpoint is not a completion type
  | "terminal_fault" // last accepted checkpoint is a terminal FAULT (completed-but-failed)
  | "post_terminal_checkpoint"; // S6-2b: a terminal checkpoint appears BEFORE the last (chain continued past a terminal)

/**
 * Discriminated outcome. `finalized`/`idempotent` carry the package + receipt built
 * FROM the persisted row (signature exposed only post-commit); `rejected` carries a
 * §8.4-B reason and guarantees NO persist + NO session flip; `errored` means the
 * persist transaction threw (rolled back) or the accepted chain was incomplete —
 * NO package, NO session flip.
 */
export type FinalizeMilestoneResult =
  | {
      status: "finalized" | "idempotent";
      package: FinalMilestonePackage;
      packageReceipt: PackageReceipt;
      evidenceRoot: string;
      packageHash: string;
    }
  | { status: "rejected"; reason: FinalizeRejectReason }
  | { status: "errored"; error: Error };

export interface MilestonePackageStoreDeps {
  /** The store's drizzle DB — owns `.transaction()`. Same connection the repos write through. */
  db: StoreDB;
  evidenceSessions: IEvidenceSessionRepository;
  gatewayReceipts: IGatewayReceiptRepository;
  checkpointBodies: ICheckpointBodyRepository;
  milestonePackages: IMilestonePackageRepository;
  /** Ed25519 signer — the SAME key as per-checkpoint receipts (§8.3: shared time authority). */
  signer?: GatewayReceiptSigner;
}

export class MilestonePackageStore {
  private readonly db: StoreDB;
  private readonly evidenceSessions: IEvidenceSessionRepository;
  private readonly gatewayReceipts: IGatewayReceiptRepository;
  private readonly checkpointBodies: ICheckpointBodyRepository;
  private readonly milestonePackages: IMilestonePackageRepository;
  private readonly signer: GatewayReceiptSigner;

  constructor(deps: MilestonePackageStoreDeps) {
    this.db = deps.db;
    this.evidenceSessions = deps.evidenceSessions;
    this.gatewayReceipts = deps.gatewayReceipts;
    this.checkpointBodies = deps.checkpointBodies;
    this.milestonePackages = deps.milestonePackages;
    this.signer = deps.signer ?? getDefaultGatewayReceiptSigner();
  }

  /** The signer's public key (hex) — lets a holder verify a PackageReceipt out of band. */
  get publicKeyHex(): string {
    return this.signer.publicKeyHex;
  }

  /**
   * Finalize a (job, milestone): implement §8.4-B in order, each clause fail-closed.
   * ONE synchronous critical section (no `await`) — see the file header.
   */
  finalize(input: FinalizeMilestoneInput): FinalizeMilestoneResult {
    const { jobId, milestoneIndex } = input;

    // B (clause 1): load the session for (job, milestone); require open|finalized.
    const session = this.evidenceSessions.findByJobMilestone(jobId, milestoneIndex);
    if (!session) return { status: "rejected", reason: "session_not_found" };
    if (
      session.status !== "open" &&
      session.status !== "terminal_success" &&
      session.status !== "terminal_fault" &&
      session.status !== "finalized"
    ) {
      // Not a finalizable session state — fail closed. (open: seeder path with no terminal
      // transition; terminal_success/terminal_fault: the route path after the P1-2 transition on the
      // terminal checkpoint; finalized: idempotent re-finalize.)
      return { status: "rejected", reason: "session_not_found" };
    }
    const sessionId = session.sessionId;

    // B (clause 2): idempotent — a package already exists → return it from the row.
    // (Permissionless triggers MUST be idempotent; PK fmp-<jobId>-<mi>.) This runs
    // BEFORE the deadline check so a re-finalize after the deadline still returns the
    // package that was validly minted at the first finalize.
    const existingPkg = this.milestonePackages.findByJobMilestone(jobId, milestoneIndex);
    if (existingPkg) return idempotentFromRow(existingPkg);

    // B-4 (clause 3): deadline — enforced against the finalize receivedAt (`now`).
    if (input.now > session.evidenceSubmissionDeadline) {
      return { status: "rejected", reason: "evidence_deadline_passed" };
    }

    // B-1 (clause 4): rebuild the accepted chain from the DURABLE store ONLY, seq-asc.
    // R-14c: use the UNCAPPED finder — evidenceRoot is a money-path root and MUST be
    // computed over the WHOLE chain. The capped findBySession would silently truncate
    // a >1000-checkpoint session and fork the root (§8.4-B-2). findAllBySession returns
    // every row (integrity-asserted, W2.5a).
    const receiptRows = this.gatewayReceipts.findAllBySession(sessionId);
    if (receiptRows.length === 0) {
      return { status: "rejected", reason: "no_checkpoints" };
    }
    // Fail-closed completeness guard (defense-in-depth): the accepted chain is
    // contiguous seq 1..lastSeq by construction (record() enforces seq===lastSeq+1
    // from genesis). With findAllBySession (uncapped) truncation can no longer cause
    // a short read, so this should NEVER trip — if it does, that is a genuine hole in
    // the durable chain (real corruption) and we must NOT compute evidenceRoot over a
    // partial chain (a settlement fork) → `errored`, never a partial root.
    const tip = this.gatewayReceipts.lastAcceptedForSession(sessionId);
    if (
      !tip ||
      receiptRows.length !== tip.lastSeq ||
      receiptRows[receiptRows.length - 1].seq !== tip.lastSeq
    ) {
      return {
        status: "errored",
        error: new Error(
          `milestone finalize: accepted chain incomplete for ${sessionId} ` +
            `(fetched ${receiptRows.length}, tip seq ${tip?.lastSeq ?? "none"})`,
        ),
      };
    }
    const acceptedCheckpointHashes = receiptRows.map((r) => r.checkpointHash);
    const receiptIds = receiptRows.map((r) => r.receiptId);

    const lastReceipt = receiptRows[receiptRows.length - 1];

    // WHOLE-CHAIN INTEGRITY (round-6 P1-3): the package is a settlement ROOT, so EVERY accepted
    // checkpoint — not just the terminal one — must be independently reproducible from its durable
    // body AND receipt-bound. Read the full durable body chain (findAllBySession is UNCAPPED) and
    // verify, one body per receipt, in seq order:
    //   • EXACTLY one body per receipt — fail closed on a missing / extra / duplicate body;
    //   • the body recomputes to its OWN checkpointHash over the same 6 canonical keys the route
    //     signs (§2.2), AND that hash equals the RECEIPTED hash (receipt-bound — a consistently
    //     altered body can't be trusted to classify for a DIFFERENT receipt commitment);
    //   • seq is contiguous (i+1), the receipt belongs to THIS job, and prevCheckpointHash chains
    //     to the previous receipt's hash (no reorder / splice / graft);
    //   • S6-2b: no NON-last body is a terminal type (a terminal ENDS the run — the chain must not
    //     continue past it, else `fault_report → execution_completed` would finalize as success).
    // All reads are sync (the await-free critical section holds); runs BEFORE assembly.
    const allBodies = this.checkpointBodies.findAllBySession(sessionId); // seq-asc, uncapped
    if (allBodies.length !== receiptRows.length) {
      return {
        status: "errored",
        error: new Error(
          `finalize integrity: body/receipt count mismatch for ${sessionId} ` +
            `(${allBodies.length} bodies, ${receiptRows.length} receipts)`,
        ),
      };
    }
    for (let i = 0; i < allBodies.length; i++) {
      const body = allBodies[i];
      const receipt = receiptRows[i];
      const recomputed = canonicalSha256({
        sessionId,
        seq: body.seq,
        createdAt: body.deviceCreatedAt,
        prevCheckpointHash: body.prevCheckpointHash ?? null,
        eventsRoot: body.eventsRoot,
        checkpointType: body.checkpointType,
      });
      const expectedPrev = i > 0 ? receiptRows[i - 1].checkpointHash : null;
      if (
        body.seq !== i + 1 ||
        receipt.seq !== i + 1 ||
        receipt.jobId !== jobId ||
        recomputed !== body.checkpointHash ||
        body.checkpointHash !== receipt.checkpointHash ||
        (body.prevCheckpointHash ?? null) !== expectedPrev
      ) {
        return {
          status: "errored",
          error: new Error(
            `finalize integrity: chain divergence at seq ${i + 1} for ${sessionId} ` +
              `(receipt ${receipt.receiptId})`,
          ),
        };
      }
      // A terminal checkpoint must be the LAST — reject a chain that continued past one.
      if (
        i < allBodies.length - 1 &&
        (TERMINAL_COMPLETION_TYPES.has(body.checkpointType) ||
          body.checkpointType === TERMINAL_FAULT_TYPE)
      ) {
        return { status: "rejected", reason: "post_terminal_checkpoint" };
      }
    }

    // TERMINAL-COMPLETION GUARD (frozen §8.1-#1): the LAST accepted checkpoint must be a terminal-
    // completion type; a chain that never completed — or ended in a fault — is NOT a success package.
    const lastBody = allBodies[allBodies.length - 1];
    if (!TERMINAL_COMPLETION_TYPES.has(lastBody.checkpointType)) {
      if (lastBody.checkpointType === TERMINAL_FAULT_TYPE) {
        return { status: "rejected", reason: "terminal_fault" };
      }
      return { status: "rejected", reason: "terminal_checkpoint_missing" };
    }
    // Round-5 payloads-out: NO payloads are collected or assembled into the package. Revealed
    // payloads live OUTSIDE the immutable package (content-addressed by checkpoint hash, fetched
    // independently), so the finalizer cannot curate/exclude them and finalize-before-reveal is a
    // no-op on the package contents.

    // B-2 (clause 6): evidenceRoot = merkleRoot over the accepted hashes (seq order).
    const evidenceRoot = merkleRoot(acceptedCheckpointHashes);

    // Clause 7: assemble the CLAIM-FREE, PAYLOAD-FREE package (no tier / oracleVerified / success;
    // round-5: no payloads either). It binds ONLY commitments: the accepted chain, its receipts,
    // the Merkle evidenceRoot, the terminal checkpoint hash, and the delegation session id.
    const packageId = `fmp-${jobId}-${milestoneIndex}`;
    const pkg: FinalMilestonePackage = {
      packageId,
      jobId,
      milestoneIndex,
      sessionId,
      acceptedCheckpointHashes,
      receiptIds,
      evidenceRoot,
      terminalCheckpointHash: lastReceipt.checkpointHash,
      delegationSessionId: session.delegationSessionId ?? null,
      evidenceTimeProvenance: {
        kind: "gateway-receipt-points",
        firstAcceptedAt: receiptRows[0].acceptedAt,
        lastAcceptedAt: receiptRows[receiptRows.length - 1].acceptedAt,
      },
    };

    // Clause 8: packageHash = canonicalSha256(package) (the servable/anchorable unit).
    const packageHash = canonicalSha256(pkg);

    // Clause 9: the PackageReceipt, signed over its content-sans-signature.
    const receiptContent: PackageReceiptContent = {
      receiptId: `fmprcpt-${jobId}-${milestoneIndex}`,
      gatewayKeyId: this.signer.keyId,
      jobId,
      milestoneIndex,
      sessionId,
      packageHash,
      evidenceRoot,
      acceptedCount: acceptedCheckpointHashes.length,
      acceptedAt: input.now, // window-3 boundary = finalize receivedAt
    };
    const signature = this.signer.sign(receiptContent);
    const packageReceipt: PackageReceipt = { ...receiptContent, signature };

    // Clause 10: TRANSACTIONAL persist — package insert + session-finalize ATOMIC.
    // Construct the returned objects FROM the persisted row; the signature is EXPOSED
    // only after commit (a rolled-back txn never reaches the `finalized` return).
    const insertRow: MilestonePackageInsert = {
      packageId,
      jobId,
      milestoneIndex,
      sessionId,
      evidenceRoot,
      packageHash,
      receiptId: packageReceipt.receiptId,
      body: pkg as unknown as MilestonePackageInsert["body"],
      receiptBody: packageReceipt as unknown as MilestonePackageInsert["receiptBody"],
      acceptedAt: input.now,
      createdAt: new Date(input.now * 1000).toISOString(),
    };

    let storedRow: MilestonePackageRow | undefined;
    try {
      storedRow = this.db.transaction(() => {
        const row = this.milestonePackages.insert(insertRow);
        // Same single better-sqlite3 connection → part of this transaction.
        this.evidenceSessions.setStatus(sessionId, "finalized");
        return row;
      });
    } catch (err) {
      // Concurrent finalize / PK collision: prefer returning the now-present row
      // idempotently over surfacing an error (permissionless triggers race).
      const raced = this.milestonePackages.findByJobMilestone(jobId, milestoneIndex);
      if (raced) return idempotentFromRow(raced);
      return {
        status: "errored",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    if (!storedRow) {
      const raced = this.milestonePackages.findByJobMilestone(jobId, milestoneIndex);
      if (raced) return idempotentFromRow(raced);
      return {
        status: "errored",
        error: new Error(`milestone package insert returned no row for ${packageId}`),
      };
    }

    // COMMITTED — construct the result FROM the persisted row (body round-trip).
    return {
      status: "finalized",
      package: storedRow.body as unknown as FinalMilestonePackage,
      packageReceipt: storedRow.receiptBody as unknown as PackageReceipt,
      evidenceRoot: storedRow.evidenceRoot,
      packageHash: storedRow.packageHash,
    };
  }

  /** The finalized package for a (job, milestone), if any — read passthrough. */
  get(jobId: string, milestoneIndex: number): MilestonePackageRow | undefined {
    return this.milestonePackages.findByJobMilestone(jobId, milestoneIndex);
  }
}

/** Rebuild an idempotent result from a persisted milestone-package row (round-trip). */
function idempotentFromRow(row: MilestonePackageRow): FinalizeMilestoneResult {
  return {
    status: "idempotent",
    package: row.body as unknown as FinalMilestonePackage,
    packageReceipt: row.receiptBody as unknown as PackageReceipt,
    evidenceRoot: row.evidenceRoot,
    packageHash: row.packageHash,
  };
}

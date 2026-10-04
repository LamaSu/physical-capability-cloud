/**
 * N79 (G2 of dress rehearsal R0): a job that ends without completing gives its escrow back.
 *
 * Before this, every writer of a `failed` or `cancelled` job status (the operator relay, the job facade, the
 * MCP cancel, the kernel service) left the job's escrow and milestones reading "funded" forever. R0 saw it on
 * a master gateway: the operator node reported `failed`, the settlement read said "cancelled", and the escrow
 * stayed funded.
 *
 * THE RULE. When a job's status becomes one that ends it without completing (`failed` or `cancelled`; the spec's
 * `timed_out` too, once anything writes it), and the write comes from a writer ENTITLED to give the escrow back, its
 * escrow is given back in the SAME database transaction as the status write (so a crash cannot strand one without
 * the other).
 *
 * WHO MAY TRIGGER IT (steward #4218). A refund is sticky: every release path refuses a given-back escrow, so a
 * trigger must come from someone entitled to give up the payout.
 *   - The gateway's own failure observations: the kernel service's failure writes and the dispatch rollback.
 *   - The job facade (`updateStatus`): the owner-checked MCP cancel (the job's own operator forfeits) and
 *     PATCH /api/jobs/:id/status. Merge-up with master's N85(a): the facade now writes through
 *     {@link writeJobStatusGuardedWithRefund}, which composes this refund with {@link writeJobStatusGuarded}'s
 *     settlement-owned-status guard in the SAME transaction, so a generic writer still cannot finish, fail,
 *     cancel or re-open a paid job, but a terminal write it IS allowed to make still gives the escrow back.
 *   - NOT the operator relay (POST /api/operator/job-status). It has no owner check (N85(b)), so any key can post
 *     any job's status there. It never gives an escrow back: on a paid job N85(a) refuses its terminal write
 *     outright, and an unpaid job has no escrow to give back.
 *
 * The refund itself:
 *   - MOCK settlement (`mock-escrow-*`): there is no chain, so the refund is complete at once. Every milestone
 *     and the escrow read "refunded".
 *   - A CHAIN escrow (V2/V3): the refund is DECIDED here but not executed. The escrow and its milestones read
 *     "refund_pending". Executing it on-chain is a separate step (V3: the payer-only `reclaimAfterDeadline`,
 *     after `fundedAt` + the reclaim deadline; V2: only through `resolveDispute`), and nothing here sends a
 *     transaction.
 *
 * NEVER RELEASED. The gateway never moves an escrow it has given back toward a release. Each release path refuses
 * it: PUT /api/jobs/:id/complete and POST /api/jobs/:id/resume-settlement (409 `escrow_refunded`), the settlement
 * keeper, the raw chain routes for evidence, attestation and release (409), and SettlementService.releaseMilestone
 * (POST /api/settlement/release and the automatic release after evidence), which also never reports the job settled.
 * A dispute stays open: V2 refunds only through `resolveDispute`.
 *
 * CONSERVATIVE BY DESIGN. It gives an escrow back only when nothing has started to settle it:
 *   - the job was not already in a settlement phase before this write (a late `failed` report must not
 *     reach back over a completion in flight);
 *   - the escrow is still `funded`/`active`, and NO settlement holds its lease (below);
 *   - every milestone is still `unfunded`/`funded`/`locked`: no evidence, attestation, release or dispute.
 * Anything else is left to the settlement or dispute path, and reported as `skipped` with the reason.
 * Repeating the write is harmless: an escrow already refunded or refund-pending is skipped.
 *
 * SETTLEMENT OWNERSHIP (astra rounds 2 and 3 on #462). Whoever settles an escrow (PUT /complete, resume-settlement, the
 * raw chain release, SettlementService.releaseMilestone, the settlement keeper) calls {@link beginSettlement} FIRST,
 * synchronously, with no await between it and the work it guards. Ownership has two layers:
 *   1. DURABLE: the escrow status `completing`. It blocks every refund, and it survives a restart, so a settlement the
 *      process died in the middle of can be ADOPTED by the next one (resume-settlement, a release, the keeper).
 *   2. IN-FLIGHT: an exclusive lease, `settlementLeases`: escrow id -> the token of the one operation acting on it now.
 *      `completing` alone says only that SOME settlement began; it cannot tell the operation that holds the escrow from
 *      a second one that walked in, and a hand-back by the first would then free the escrow underneath the second. The
 *      lease can: at most one operation holds it, every claim carries its token, and the hand-back and the release
 *      record act only for the holder. A second claimant gets `busy` and must not touch the chain.
 * Why a process-local lease is sound: the gateway is ONE process over ONE SQLite file with synchronous better-sqlite3
 * (the same assumption `withSignerLock` makes for chain writes), so `beginSettlement`'s read, compare-and-set and lease
 * write run to completion before anything else can run. A restart drops every lease; `completing` survives and is
 * adopted. Two gateway processes on one file would need a database lease instead; nothing here supports that.
 *
 * The lease is not a lock on the row. A `created` row (a live V1/V2 chain escrow reads it from creation until its settlement
 * completes it: nothing writes `funded` for it) takes the lease and is left as it is (`leased`). So does any other status
 * that is not given back or completed, for the keeper alone, whose DB row can lag the chain. A refund is skipped while ANY
 * lease is live on the escrow, even if its row no longer reads `completing`.
 */
import { getAddress, isAddress, keccak256, toBytes, type Hex } from "viem";
import { getRepos, getStore } from "../db.js";
import { schema, eq, and } from "@pcc/store";
// The words this module writes live in @pcc/spec, so the job read (readmodels) reads the same ones.
import { ESCROW_REFUND_STATUS, TERMINAL_JOB_STATUSES } from "@pcc/spec";
// N79 round 8 (P4, astra 126i MEDIUM-2): the three ABIs' own status enums are the writer's ONLY source for
// "Released" and for the valid status domain (never a new numeric literal). They come from @pcc/contracts/abi,
// which exports all three and which no test mocks: not from the chain client (viem and env reads at module
// load), and not from the @pcc/contracts root (story-pipeline.test.ts mocks that root with a non-hoisted factory).
import { MilestoneStatus, MilestoneStatusV2, MilestoneStatusV3 } from "@pcc/contracts/abi";
// N85(a)'s guard, composed with the N79 refund in writeJobStatusGuardedWithRefund below. One-way import:
// settlement-owned-status.ts imports only "@pcc/store" and "../db.js", so there is no cycle.
import { writeJobStatusGuarded, type GuardedStatusWrite } from "./settlement-owned-status.js";

/** The job statuses that end a job without completing it: every terminal status in the spec except `completed`. */
export const TERMINAL_FAILURE_JOB_STATUSES: ReadonlySet<string> = new Set(
  TERMINAL_JOB_STATUSES.filter((s) => s !== "completed"),
);

/** Job statuses meaning settlement has started. A later failure report must not refund underneath it. */
const SETTLEMENT_PHASE_JOB_STATUSES: ReadonlySet<string> = new Set([
  "completing",
  "collecting_evidence",
  "evidence_stored",
  "evidence_submitted",
  "settled",
  "completed",
]);

/** Escrow statuses a refund may start from. */
const REFUNDABLE_ESCROW_STATUSES: ReadonlySet<string> = new Set(["funded", "active"]);

/**
 * The DURABLE layer of settlement ownership: the escrow status that means A SETTLEMENT OWNS THIS ESCROW. A settlement
 * takes it, synchronously, at its claim ({@link beginSettlement}). While an escrow reads it, no refund lands, however
 * often the job's status is rewritten meanwhile (the job status is mutable by other writers; this row is not), and it
 * survives a restart. It is already in @pcc/spec's escrow vocabulary. It does NOT say which operation owns the escrow;
 * that is the in-flight lease below.
 */
export const SETTLEMENT_OWNED_ESCROW_STATUS = "completing";

/**
 * The IN-FLIGHT layer: escrow id -> the token of the ONE operation acting on that escrow right now. Process-local on
 * purpose (see the header: one process, one SQLite file, synchronous driver; a restart drops every lease and
 * `completing` is adopted). Every writer below acts only for the token it holds.
 */
const settlementLeases = new Map<string, symbol>();

/** Milestone statuses with nothing yet claimed against them. */
const REFUNDABLE_MILESTONE_STATUSES: ReadonlySet<string> = new Set(["unfunded", "funded", "locked"]);

/** Statuses an escrow cannot be released from: `/complete` and the settlement keeper refuse these. */
export const NON_RELEASABLE_ESCROW_STATUSES: ReadonlySet<string> = new Set([
  ESCROW_REFUND_STATUS.PENDING,
  ESCROW_REFUND_STATUS.DONE,
]);

/** Statuses no settlement may claim, not even the keeper: given back, or already paid out. */
const SETTLEMENT_CLOSED_ESCROW_STATUSES: ReadonlySet<string> = new Set([...NON_RELEASABLE_ESCROW_STATUSES, "completed"]);

/**
 * A chain escrow's row reads `created` from the day it is made until its settlement completes it: nothing writes
 * `funded` for a V1/V2 escrow (the settlement crank funds it on-chain), so `created` IS the normal state of a live
 * escrow at /complete. It is never refundable (`REFUNDABLE_ESCROW_STATUSES`), so it needs no durable marker; a
 * settlement takes the lease only, and the row stays as it is.
 */
const CREATED_ESCROW_STATUS = "created";

export type EscrowRefundOutcome =
  | { outcome: "refunded" | "refund_pending"; escrowId: string; milestones: number }
  | {
      outcome: "skipped";
      reason:
        | "not_terminal"
        | "no_escrow"
        | "settlement_in_progress"
        | "escrow_not_refundable"
        | "milestone_past_funding"
        | "escrow_shared";
      escrowId?: string;
      escrowStatus?: string;
      /** For `escrow_shared`: the other jobs that reference the same escrow. */
      sharedWith?: string[];
    };

/** A mock-settlement escrow has no chain behind it; its refund completes at once. */
export function isMockEscrowAddress(contractAddress: string): boolean {
  return contractAddress.startsWith("mock-escrow-");
}

/** The job's escrow, found the way the settlement read finds it: the job's session, its cwmId, the escrow. */
export function escrowForJob(jobId: string) {
  const { db } = getStore();
  const session = db
    .select()
    .from(schema.negotiationSessions)
    .where(eq(schema.negotiationSessions.jobId, jobId))
    .get();
  if (!session?.cwmId) return undefined;
  return getRepos().escrows.findByCwm(session.cwmId);
}

/**
 * The escrow row at an on-chain address, matched in any letter case: rows are written checksummed (paid-job-flow),
 * while callers often send lowercase.
 */
export function escrowByContractAddress(contractAddress: string) {
  const escrows = getRepos().escrows;
  const candidates = new Set<string>([contractAddress, contractAddress.toLowerCase()]);
  if (isAddress(contractAddress)) candidates.add(getAddress(contractAddress));
  for (const candidate of candidates) {
    const row = escrows.findByContractAddress(candidate);
    if (row) return row;
  }
  return undefined;
}

/**
 * N79 round 8 (P2, astra 126i MEDIUM-1): the ONE resolver for the rowless default target — the address a job
 * with NO escrow row of its own may still settle against, when the deployment is configured for it. An address
 * alone (`ESCROW_CONTRACT_ADDRESS`) proves nothing about which ABI answers at it: production sets it to the V2
 * factory address (`docs/V2_DEPLOY.md:183`), not a V1 escrow. Returns the v1 target ONLY when
 * `ESCROW_CONTRACT_VERSION` is explicitly `"v1"` (the one case the rowless default is still unambiguous — see
 * `verifyDerivedMilestoneOnChain`'s doc comment in settlement-service.ts); otherwise none. Every consumer of the
 * rowless default (`autoReleaseContractAddress` in kernel-service.ts; `processEvidence`'s allowed target and its
 * rowless milestone derivation, and `releaseMilestone`'s rowless fallback, both in settlement-service.ts) calls
 * this instead of reading `ESCROW_CONTRACT_ADDRESS` directly, so a rowless job with no configured version has NO
 * chain target: the evidence is persisted, nothing touches the chain (round 7 wrongly assumed v1 unconditionally
 * — the false "always v1-style" comments this round removes).
 */
export function resolveRowlessDefaultTarget(): { address: string; version: "v1" } | undefined {
  const address = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!address) return undefined;
  if (process.env.ESCROW_CONTRACT_VERSION !== "v1") return undefined;
  return { address, version: "v1" };
}

/**
 * The escrow a release would touch that the gateway has already given back (`refund_pending` or `refunded`), if any:
 * the job's own escrow, and the escrow at `contractAddress` when one is named. A release must refuse when this
 * returns a row.
 */
export function givenBackEscrow(ref: { jobId?: string; contractAddress?: string }) {
  const rows = [
    ref.jobId ? escrowForJob(ref.jobId) : undefined,
    ref.contractAddress ? escrowByContractAddress(ref.contractAddress) : undefined,
  ];
  return rows.find((row) => row !== undefined && NON_RELEASABLE_ESCROW_STATUSES.has(row.status));
}

/**
 * Give back the escrow of a job that ended without completing. `priorStatus` is the job's status BEFORE the
 * terminal write, when the caller knows it. Call it inside the transaction that writes the status
 * ({@link setJobStatusWithRefund} does both).
 */
export function refundEscrowForTerminalJob(jobId: string, priorStatus?: string): EscrowRefundOutcome {
  const repos = getRepos();
  const job = repos.jobs.findById(jobId);
  if (!job || !TERMINAL_FAILURE_JOB_STATUSES.has(job.status)) return { outcome: "skipped", reason: "not_terminal" };
  if (priorStatus !== undefined && SETTLEMENT_PHASE_JOB_STATUSES.has(priorStatus)) {
    return { outcome: "skipped", reason: "settlement_in_progress" };
  }
  const escrow = escrowForJob(jobId);
  if (!escrow) return { outcome: "skipped", reason: "no_escrow" };
  // A settlement owns the escrow: durably (`completing`), or in flight (a live lease). The lease check holds even when
  // the row has been rewritten to something refundable underneath the operation that holds it.
  if (escrow.status === SETTLEMENT_OWNED_ESCROW_STATUS || settlementLeases.has(escrow.id)) {
    return { outcome: "skipped", reason: "settlement_in_progress", escrowId: escrow.id, escrowStatus: escrow.status };
  }
  if (!REFUNDABLE_ESCROW_STATUSES.has(escrow.status)) {
    return { outcome: "skipped", reason: "escrow_not_refundable", escrowId: escrow.id, escrowStatus: escrow.status };
  }
  // The whole escrow is given back, so it must be this job's alone. A job that ends does not speak for another job's
  // milestones on a shared escrow (astra round 2, F2).
  const sharedWith = otherJobsOnEscrow(jobId, escrow.cwmId);
  if (sharedWith.length > 0) {
    return { outcome: "skipped", reason: "escrow_shared", escrowId: escrow.id, escrowStatus: escrow.status, sharedWith };
  }
  const milestones = repos.escrows.findMilestonesByEscrow(escrow.id);
  if (milestones.some((m) => !REFUNDABLE_MILESTONE_STATUSES.has(m.status))) {
    return { outcome: "skipped", reason: "milestone_past_funding", escrowId: escrow.id, escrowStatus: escrow.status };
  }
  const target = isMockEscrowAddress(escrow.contractAddress) ? ESCROW_REFUND_STATUS.DONE : ESCROW_REFUND_STATUS.PENDING;
  for (const m of milestones) repos.escrows.updateMilestoneStatus(m.id, target);
  repos.escrows.updateStatus(escrow.id, target);
  return { outcome: target === ESCROW_REFUND_STATUS.DONE ? "refunded" : "refund_pending", escrowId: escrow.id, milestones: milestones.length };
}

/**
 * Every other job that references the escrow's CWM (and so the escrow): through its own row (`jobs.cwmId`) or through its
 * negotiation session (`negotiation_sessions.cwmId`, the relationship {@link escrowForJob} resolves a job's escrow by).
 * The schema does not tie the two copies of the CWM together, so a job counts if EITHER names the escrow's CWM (astra
 * round 3, F6).
 */
function otherJobsOnEscrow(jobId: string, cwmId: string): string[] {
  const { db } = getStore();
  const viaJobRows = db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.cwmId, cwmId))
    .all()
    .map((r) => r.id);
  const viaSessions = db
    .select({ id: schema.negotiationSessions.jobId })
    .from(schema.negotiationSessions)
    .where(eq(schema.negotiationSessions.cwmId, cwmId))
    .all()
    .flatMap((r) => (r.id ? [r.id] : []));
  return [...new Set([...viaJobRows, ...viaSessions])].filter((id) => id !== jobId);
}

/** What a settlement holds while it acts on an escrow: the lease token, and what to hand back if it gives up. */
export interface SettlementClaim {
  escrowId: string;
  /** This operation's lease token. Only the claim holding the escrow's live lease may hand back or record. */
  token: symbol;
  /** The status the escrow had before THIS claim changed it. Set only by an `acquired` claim; the hand-back restores it. */
  prior?: string;
  /** The status the row reads while this claim holds the escrow: `completing`, or (`leased`) what the row already read. */
  leasedStatus: string;
  /** The escrow's job (found through `negotiation_sessions.cwmId`), so a hand-back can reconcile a refund for it. */
  jobId?: string;
}

/**
 * How a claim ended:
 *   - `acquired`: the row read `funded`/`active` and now reads `completing`; the claim holds the lease and `prior`.
 *   - `adopted`: the row already read `completing` with no live lease (a settlement a restart or a give-up left); the
 *      claim holds the lease and changed nothing.
 *   - `leased`: the lease only, the row unchanged (a `created` row, or, for the keeper only, a row that lags the chain).
 *   - `no_escrow`: nothing known to protect.
 *   - `busy`: another operation holds the lease. The caller must not touch the chain.
 *   - `blocked`: the row is not releasable (given back, completed, or a status no settlement may claim), or a
 *      compare-and-set lost. The caller must not touch the chain.
 */
export type SettlementClaimResult =
  | { disposition: "acquired" | "adopted" | "leased"; claim: SettlementClaim }
  | { disposition: "no_escrow" }
  | { disposition: "busy"; escrowId: string; escrowStatus: string }
  | { disposition: "blocked"; escrowId: string; escrowStatus: string };

/**
 * Take ownership of an escrow's settlement. SYNCHRONOUS: no await anywhere inside it, and the caller must not await
 * between it and the work it guards. Finds the escrow by `escrowId`, else by `jobId`, else by `contractAddress`.
 *   - no row: `no_escrow`;
 *   - a live lease on the row: `busy`;
 *   - given back or completed: `blocked`;
 *   - `funded`/`active`: compare-and-set to `completing`. Winning takes the lease (`acquired`, `prior` set); losing
 *     (the row changed under us) is `blocked` with the status re-read;
 *   - `completing`: take the lease (`adopted`); the row stays as it is;
 *   - `created`, or any other status when `leaseOnly` (the keeper, whose row can lag the chain): take the lease and
 *     leave the row (`leased`); otherwise `blocked`.
 * Every claim is followed by `try { ... } finally { endSettlement(claim) }`.
 */
export function beginSettlement(
  ref: { escrowId?: string; jobId?: string; contractAddress?: string },
  opts: { leaseOnly?: boolean } = {},
): SettlementClaimResult {
  const repos = getRepos();
  const escrow = ref.escrowId
    ? repos.escrows.findById(ref.escrowId)
    : ref.jobId
      ? escrowForJob(ref.jobId)
      : ref.contractAddress
        ? escrowByContractAddress(ref.contractAddress)
        : undefined;
  if (!escrow) return { disposition: "no_escrow" };
  const row = { escrowId: escrow.id, escrowStatus: escrow.status };
  if (settlementLeases.has(escrow.id)) return { disposition: "busy", ...row };
  if (SETTLEMENT_CLOSED_ESCROW_STATUSES.has(escrow.status)) return { disposition: "blocked", ...row };

  // N79 round 4 (R4-M2, astra 126b Q3 MEDIUM): resolve every fallible piece of the claim BEFORE the compare-and-set
  // and BEFORE the lease is inserted. `jobOfEscrow` runs a DB query that can throw; if it threw after the lease was
  // in the map, the caller never receives a claim and can never reach `endSettlement()`, leaking the lease (and, for
  // the CAS branch, leaving the row `completing` with nothing holding it) until restart.
  const resolvedJobId = ref.jobId ?? jobOfEscrow(escrow.cwmId);

  let disposition: "acquired" | "adopted" | "leased";
  let prior: string | undefined;
  let leasedStatus = escrow.status;
  if (REFUNDABLE_ESCROW_STATUSES.has(escrow.status)) {
    const took = storeDb()
      .update(schema.escrows)
      .set({ status: SETTLEMENT_OWNED_ESCROW_STATUS })
      .where(and(eq(schema.escrows.id, escrow.id), eq(schema.escrows.status, escrow.status)))
      .returning()
      .all();
    if (took.length !== 1) {
      // The row changed between the read and the write. Never proceed on a lost compare-and-set.
      return { disposition: "blocked", escrowId: escrow.id, escrowStatus: repos.escrows.findById(escrow.id)?.status ?? "missing" };
    }
    disposition = "acquired";
    prior = escrow.status;
    leasedStatus = SETTLEMENT_OWNED_ESCROW_STATUS;
  } else if (escrow.status === SETTLEMENT_OWNED_ESCROW_STATUS) {
    disposition = "adopted";
  } else if (escrow.status === CREATED_ESCROW_STATUS || opts.leaseOnly) {
    disposition = "leased";
  } else {
    return { disposition: "blocked", ...row };
  }

  const token = Symbol(`settlement:${escrow.id}`);
  settlementLeases.set(escrow.id, token);
  try {
    // Nothing here is expected to throw — `resolvedJobId` was already computed above, before the lease existed —
    // but defence in depth (R4-M2): if it somehow does, the lease must not outlive this call.
    return { disposition, claim: { escrowId: escrow.id, token, prior, leasedStatus, jobId: resolvedJobId } };
  } catch (err) {
    if (settlementLeases.get(escrow.id) === token) settlementLeases.delete(escrow.id);
    throw err;
  }
}

/** Drop the lease, only if it is this claim's. Idempotent; every claimant calls it in a `finally`. */
export function endSettlement(claim: SettlementClaim | undefined): void {
  if (claim && settlementLeases.get(claim.escrowId) === claim.token) settlementLeases.delete(claim.escrowId);
}

/**
 * Hand an escrow back after a settlement gave up WITHOUT recording evidence, and drop its lease. Only the claim that
 * still holds the lease may: it restores the status the claim took the escrow from (`prior`, a compare-and-set from
 * `completing`; an adopted or leased claim restores nothing). Then, if the job ended without completing meanwhile (a
 * failure write landed while the settlement owned the escrow), the escrow is given back now. One transaction. A claim
 * that does not hold the lease changes nothing: it must never hand back another operation's ownership.
 */
export function releaseEscrowFromSettlement(claim: SettlementClaim, jobId?: string): EscrowRefundOutcome | undefined {
  if (settlementLeases.get(claim.escrowId) !== claim.token) return undefined;
  return storeDb().transaction(() => {
    if (claim.prior) casEscrowStatus(claim.escrowId, SETTLEMENT_OWNED_ESCROW_STATUS, claim.prior);
    // The lease must be gone before the refund looks for one; the refund then judges the restored row on its own.
    settlementLeases.delete(claim.escrowId);
    if (!jobId) return undefined;
    const job = getRepos().jobs.findById(jobId);
    return job && TERMINAL_FAILURE_JOB_STATUSES.has(job.status) ? refundEscrowForTerminalJob(jobId) : undefined;
  });
}

/**
 * A chain read's ordered milestone identity + status set, as the mapping check needs it. `stepIds[i]` is the
 * chain's raw bytes32 stepId at index i (production writes `keccak256(toBytes(localRow.stepId))` on-chain —
 * paid-job-flow.ts, V2 and V3 `addMilestone`); `statuses[i]` is that same index's current on-chain status.
 */
export interface ChainMapping {
  stepIds: readonly Hex[];
  statuses: readonly number[];
}

/** The result of comparing an escrow's local rows against a chain read's ordered set (P4). */
export interface ChainMappingCheck {
  ok: boolean;
  chainCount: number;
  localCount: number;
  /** The first index (local or chain) where cardinality or identity disagrees. Set only when `!ok`. */
  firstMismatch?: number;
}

/**
 * P4 (N79 round 6, addendum 1 — "fix the PROPERTY, not the cases"): the full ordered identity + cardinality
 * compare between an escrow's LOCAL milestone rows (in index order) and a chain read's ordered `stepIds` /
 * `statuses`. Pure — no DB writes, no escrow-status change, and no reference to STATUS values: a drift is a
 * drift whether every chain milestone is already Released or every one is still Funded. Round 5 validated this
 * mapping only at the moment a row was about to be WRITTEN (a Released milestone, or whole-escrow completion);
 * round 6's finding H2-B is that a drift below Released is invisible under that rule and the escrow can be
 * handed back toward a refund with the drift never detected. This helper is meant to run immediately after
 * EVERY authoritative chain read that feeds a settlement decision, before any drive or any write.
 *
 * The count must be equal, and every index must satisfy `keccak256(toBytes(localRow.stepId)) === chain.stepIds[i]`
 * (compared case-insensitively, since stepId hex arrives in mixed case from different callers).
 *
 * N79 round 7 (R7-M1, astra 126g MEDIUM): `chain.statuses.length` is part of the mapping's own cardinality, not
 * only `chain.stepIds.length` against the local row count. Before this, a caller that passed a `statuses` array
 * shorter or longer than `stepIds` (every production chain reader builds both from the SAME milestone array, so
 * this was never exposed by real chain data — but the guarded writer itself must fail closed on malformed input,
 * not rely on its callers) could pass this check (identity confirmed on whatever indices BOTH arrays happened to
 * share) and let {@link recordChainSettlement} act on an out-of-bounds or truncated status read.
 *
 * Takes `escrowId`, not pre-fetched rows: like every other write path in this module, it reads the GLOBAL
 * store itself (`getRepos()`), so a caller never needs its own repos access just to run this check — and a
 * test can replace this ONE function (mock) to exercise a caller's drift-handling with no real store at all.
 */
export function checkChainMapping(escrowId: string, chain: ChainMapping): ChainMappingCheck {
  const localRows = getRepos().escrows.findMilestonesByEscrow(escrowId);
  const chainCount = chain.stepIds.length;
  const localCount = localRows.length;
  const statusesCount = chain.statuses.length;
  if (chainCount !== localCount || statusesCount !== chainCount) {
    return { ok: false, chainCount, localCount, firstMismatch: Math.min(chainCount, localCount, statusesCount) };
  }
  for (let i = 0; i < localCount; i++) {
    if (keccak256(toBytes(localRows[i]!.stepId)).toLowerCase() !== chain.stepIds[i]!.toLowerCase()) {
      return { ok: false, chainCount, localCount, firstMismatch: i };
    }
  }
  return { ok: true, chainCount, localCount };
}

/**
 * `chain` plus the ABI whose enum decoded `statuses` (N79 round 8, P4, astra 126i MEDIUM-2: round 7 let the
 * caller hand in a bare `releasedStatus` number with no domain behind it — any two equal integers, in or out of
 * the real enum, read as "released". `abiVersion` names the reader instead, so the writer derives BOTH the
 * "fully paid" value and the full valid domain from that version's own enum object — never a new numeric
 * literal here). V1/V2/V3 currently encode an identical 0..8 domain (Released=5), but this module takes no
 * assumption of that: each version's domain comes from its own enum export.
 */
export interface ChainSettlementInput extends ChainMapping {
  abiVersion: "v1" | "v2" | "v3";
}

/** `abiVersion` -> that ABI's own enum object, as `MilestoneStatus` / `MilestoneStatusV2` / `MilestoneStatusV3`
 *  (all three from `@pcc/contracts/abi` — see the import comment above) already export them — the writer's
 *  ONLY source for "what is Released" and "what is a valid status at all" (see {@link ChainSettlementInput}). */
function abiStatusEnum(abiVersion: string): Record<string, number> | undefined {
  switch (abiVersion) {
    case "v1":
      return MilestoneStatus;
    case "v2":
      return MilestoneStatusV2;
    case "v3":
      return MilestoneStatusV3;
    default:
      return undefined;
  }
}

/** The outcome of {@link recordChainSettlement}. */
export interface ChainSettlementResult {
  ok: boolean;
  /** True only on an identity/cardinality drift: nothing was written; the escrow stays `completing`. */
  drifted?: boolean;
  /** True once every chain-reported milestone is `releasedStatus` and the escrow compare-and-set to `completed` won. */
  completed?: boolean;
  /** True when no drift but not every milestone was released: the escrow was handed back to `claim.prior`. */
  handedBack?: boolean;
  /** Set when a row write failed partway through (R4-H3, generalized): the escrow stays `completing`, and
   *  nothing — no further row, no completion, no hand-back — is attempted after this index. */
  recordFailedIndex?: number;
}

/**
 * P1 (N79 round 6, addendum 1): the ONE function that changes chain-backed settlement state — a milestone row to
 * `released`, an escrow row to `completed`, or the hand-back after a chain read. `chain` is REQUIRED: there is no
 * optional-mapping form and no index-only form — that absence is exactly what let H2-A's older per-index writers
 * complete an escrow from local rows alone, blind to how many milestones the chain actually has. Every
 * chain-backed call site (the settlement keeper, {@link SettlementService.releaseMilestone}, the raw escrow
 * release route, and resume-settlement) calls ONLY this writer; `recordMilestoneReleased`,
 * `recordMilestoneRowReleased` and `recordEscrowReleased` below are retained only as the lower-level primitives
 * this function is built from (and because round 5's tests pin their standalone behaviour directly) — nothing in
 * production calls them directly anymore.
 *
 * Order of operations:
 *   1. {@link checkChainMapping} FIRST, before any write. On drift: write NOTHING, log
 *      `[escrow] settlement_mapping_mismatch`, and return `{ok:false, drifted:true}`. The escrow stays exactly
 *      as the claim found it (`completing`) — the caller's `finally` must end the lease WITHOUT a hand-back, the
 *      same quarantine R4-H3 already applied to a failed row write, now applied to an unexplained mapping drift
 *      too: known drift must never permit a refund.
 *   2. No drift: stamp every local row whose chain status is `releasedStatus` (identity already confirmed by
 *      step 1), skipping any row that already reads `released`. A single write failure (a genuine DB error, not
 *      a drift) stops here: nothing further is attempted, and the result says which index, so the caller logs
 *      `settlement_record_failed` and leaves the escrow `completing` — money that already moved on-chain must
 *      never be reopened to a refund because its bookkeeping lagged.
 *   3. Complete the escrow — compare-and-set from `claim.leasedStatus` to `completed` — ONLY when every chain
 *      status equals `releasedStatus`.
 *   4. Otherwise (no drift, partly released): hand back an `acquired` claim to `claim.prior`, exactly as
 *      {@link releaseEscrowFromSettlement} always did — including the same immediate refund when the escrow's
 *      job (`claim.jobId`) already ended without completing while this settlement held it. An `adopted`/`leased`
 *      claim (no `prior`) holds the escrow `completing` — nothing to hand back to.
 *
 * One transaction: the row stamps, the completion compare-and-set (or the hand-back and its refund check) all
 * commit together. A caught write failure (step 2) does not THROW out of the transaction — it returns the
 * failure in the result instead — so whatever stamps already landed before it are kept (a partly paid escrow's
 * rows still tell the truth) while nothing further (no completion, no hand-back) is attempted.
 */
export function recordChainSettlement(claim: SettlementClaim, chain: ChainSettlementInput): ChainSettlementResult {
  const repos = getRepos();
  const localRows = repos.escrows.findMilestonesByEscrow(claim.escrowId);
  // N79 round 8 (P4, astra 126i MEDIUM-2): an `abiVersion` this writer does not recognize is drift — refuse
  // before any write, exactly like a cardinality or identity mismatch. (TypeScript's own union already refuses
  // this for in-tree callers; a test or a loosely-typed caller can still hand in a garbage string at runtime.)
  const statusEnum: Record<string, number> | undefined = abiStatusEnum(chain.abiVersion);
  if (!statusEnum) {
    console.error("[escrow] settlement_mapping_mismatch", {
      escrowId: claim.escrowId,
      error: "unknown abiVersion",
      abiVersion: chain.abiVersion,
    });
    return { ok: false, drifted: true };
  }
  const releasedStatus = statusEnum.Released!;
  const statusDomain = new Set(Object.values(statusEnum));
  // Round 7 (P4, astra 126g MEDIUM) checked only that `releasedStatus` itself was an integer — any two equal
  // integers, in or out of the real enum, then read as "released" (astra 126i MEDIUM-2's own reproduction:
  // statuses:[999], releasedStatus:999 completed the escrow). Every entry of `statuses` must be an integer
  // INSIDE this version's domain, or it is drift: refuse before any write.
  for (const s of chain.statuses) {
    if (!Number.isInteger(s) || !statusDomain.has(s)) {
      console.error("[escrow] settlement_mapping_mismatch", {
        escrowId: claim.escrowId,
        error: "status outside the ABI's domain",
        abiVersion: chain.abiVersion,
        status: s,
      });
      return { ok: false, drifted: true };
    }
  }
  const mapping = checkChainMapping(claim.escrowId, chain);
  if (!mapping.ok) {
    console.error("[escrow] settlement_mapping_mismatch", {
      escrowId: claim.escrowId,
      chainCount: mapping.chainCount,
      localCount: mapping.localCount,
      firstMismatch: mapping.firstMismatch,
    });
    return { ok: false, drifted: true };
  }

  return storeDb().transaction(() => {
    for (let i = 0; i < localRows.length; i++) {
      if (chain.statuses[i] !== releasedStatus) continue;
      if (localRows[i]!.status === "released") continue;
      try {
        repos.escrows.updateMilestoneStatus(localRows[i]!.id, "released");
      } catch (err) {
        console.error("[escrow] settlement_record_failed", {
          escrowId: claim.escrowId,
          milestoneIndex: i,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, recordFailedIndex: i };
      }
    }

    // The lease may have been lost between this call starting and the loop above finishing (it never awaits, so
    // in practice this only guards against a caller that itself raced two claims) — never complete or hand back
    // for a claim that is no longer the live holder.
    if (settlementLeases.get(claim.escrowId) !== claim.token) return { ok: true, completed: false };

    const allReleased = chain.statuses.length > 0 && chain.statuses.every((s) => s === releasedStatus);
    if (allReleased) {
      const completed = casEscrowStatus(claim.escrowId, claim.leasedStatus, "completed");
      return { ok: true, completed };
    }

    if (!claim.prior) return { ok: true, completed: false, handedBack: false };
    const handedBack = casEscrowStatus(claim.escrowId, SETTLEMENT_OWNED_ESCROW_STATUS, claim.prior);
    // Drop the lease BEFORE the refund check, exactly as releaseEscrowFromSettlement does: the refund path's own
    // "is any lease live" guard (refundEscrowForTerminalJob) would otherwise see this claim's own still-live
    // lease and wrongly skip a refund this hand-back just made legitimate. The caller's later `endSettlement`
    // is idempotent and no-ops once the lease is already gone.
    if (handedBack) settlementLeases.delete(claim.escrowId);
    if (handedBack && claim.jobId) {
      const job = repos.jobs.findById(claim.jobId);
      if (job && TERMINAL_FAILURE_JOB_STATUSES.has(job.status)) refundEscrowForTerminalJob(claim.jobId);
    }
    return { ok: true, completed: false, handedBack };
  });
}

/**
 * Mock-only completion (N79 round 6, addendum 1, P1): mocks have no chain identities, so there is nothing for
 * {@link recordChainSettlement} to compare against — calling it for a mock escrow would always report drift.
 * Call this ONLY under `isMockSettlement()`. Marks every local milestone row released and completes the escrow,
 * exactly as the old unguarded writer did for every caller; safe here because a mock escrow was never real money
 * and never had a chain mapping to drift from.
 */
export function recordMockEscrowReleased(claim: SettlementClaim): boolean {
  const repos = getRepos();
  return storeDb().transaction(() => {
    const milestones = repos.escrows.findMilestonesByEscrow(claim.escrowId);
    for (const m of milestones) {
      if (m.status !== "released") repos.escrows.updateMilestoneStatus(m.id, "released");
    }
    if (settlementLeases.get(claim.escrowId) !== claim.token) return false;
    return casEscrowStatus(claim.escrowId, claim.leasedStatus, "completed");
  });
}

// N79 round 6 (addendum 1, P1, "whichever leaves fewer doors", steward #5849): the three per-index/per-row
// writers that used to live here — `recordMilestoneReleased`, `recordMilestoneRowReleased`, `recordEscrowReleased`
// — are REMOVED, not merely superseded. Each took an optional or index-only chain argument, which is exactly
// H2-A's finding: an escrow could complete from local rows alone, blind to the chain's true milestone count.
// `recordChainSettlement` above is the only function anywhere in this module that writes a milestone row to
// `released` or compare-and-sets an escrow row to `completed` from a chain-backed caller (the mock-only
// `recordMockEscrowReleased` is the other, for callers under `isMockSettlement()`). Nothing else needs a
// private equivalent of these three — `recordChainSettlement` reimplements the stamp-then-decide logic itself.

function storeDb() {
  return getStore().db;
}

/** Compare-and-set an escrow's status. Returns whether this call changed the row. */
function casEscrowStatus(escrowId: string, from: string, to: string): boolean {
  return (
    storeDb()
      .update(schema.escrows)
      .set({ status: to })
      .where(and(eq(schema.escrows.id, escrowId), eq(schema.escrows.status, from)))
      .returning()
      .all().length === 1
  );
}

/** The job whose negotiation session names this CWM, if any. */
function jobOfEscrow(cwmId: string): string | undefined {
  const session = storeDb().select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.cwmId, cwmId)).get();
  return session?.jobId ?? undefined;
}

/**
 * Write a job's status and, when that status ends the job without completing it, give its escrow back, in ONE
 * database transaction. Returns the updated job row (undefined when the job does not exist) and, for a terminal
 * failure, what happened to the escrow.
 */
export function setJobStatusWithRefund(jobId: string, status: string, progress?: number) {
  const repos = getRepos();
  const { db } = getStore();
  return db.transaction(() => {
    const priorStatus = repos.jobs.findById(jobId)?.status;
    const job = repos.jobs.updateStatus(jobId, status, progress);
    if (!job || !TERMINAL_FAILURE_JOB_STATUSES.has(status)) return { job, escrowRefund: undefined };
    return { job, escrowRefund: refundEscrowForTerminalJob(jobId, priorStatus) };
  });
}

/**
 * N79 x N85(a) merge-up composition: JobFacade.updateStatus's write (PATCH /api/jobs/:jobId/status, and the
 * owner-checked MCP cancel once it reaches the same facade) must still give the escrow back on a terminal
 * failure, through the SAME guard N85(a) already wraps that write in. NOT the operator relay (POST
 * /api/operator/job-status): it calls {@link writeJobStatusGuarded} directly, never through this function —
 * unchanged from N79's own rule, reaffirmed by the merge, that the relay can never trigger a refund (WHO MAY
 * TRIGGER IT, above): it has no owner check, so any key could post there. Neither property depends on the
 * other's current definition: {@link writeJobStatusGuarded} (`./settlement-owned-status.js` — a one-way
 * import, no cycle: that module imports only `@pcc/store`/`../db.js`) decides whether a GENERIC writer may
 * touch this job at all; this function decides, ONLY once that guard already said `written`, whether the
 * now-terminal status also means the escrow goes back. Both run in ONE transaction, so a crash between them
 * cannot strand the status write without its refund, or vice versa.
 *
 * Why the refund is unreachable today: `escrowForJob` finds an escrow only through the job's negotiation
 * session, and {@link hasSettlementRecord} treats any session (or an escrow linked through the job's `cwmId`)
 * as a settlement record — so N85(a) already refuses every terminal write on a job N79 could refund, before
 * this function's refund branch is ever reached. The composition exists so N79's property survives if N85(a)
 * is ever relaxed (gateway was asked in #6374 about a pre-execution cancel of a paid job) — at that point this
 * function, not a second rewrite of the guard, is what gives the escrow back.
 */
export function writeJobStatusGuardedWithRefund(
  jobId: string,
  status: string,
  progress?: number,
): { outcome: GuardedStatusWrite; escrowRefund?: EscrowRefundOutcome } {
  const repos = getRepos();
  const { db } = getStore();
  return db.transaction(() => {
    const priorStatus = repos.jobs.findById(jobId)?.status;
    const outcome = writeJobStatusGuarded(jobId, status, progress);
    if (outcome.kind !== "written" || !TERMINAL_FAILURE_JOB_STATUSES.has(status)) {
      return { outcome };
    }
    return { outcome, escrowRefund: refundEscrowForTerminalJob(jobId, priorStatus) };
  });
}

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
 *     PATCH /api/jobs/:id/status. On master that route answers 403 to every caller: its owner check compares
 *     columns that don't exist.
 *   - NOT the operator relay (POST /api/operator/job-status). It has no owner check (N85), so any key can post any
 *     job's status there. A relay report marks the job and gives nothing back. Its refund waits on N85's owner check.
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
 *   - the escrow is still `funded`/`active`;
 *   - every milestone is still `unfunded`/`funded`/`locked`: no evidence, attestation, release or dispute.
 * Anything else is left to the settlement or dispute path, and reported as `skipped` with the reason.
 * Repeating the write is harmless: an escrow already refunded or refund-pending is skipped.
 */
import { getAddress, isAddress } from "viem";
import { getRepos, getStore } from "../db.js";
import { schema, eq, and } from "@pcc/store";
// The words this module writes live in @pcc/spec, so the job read (readmodels) reads the same ones.
import { ESCROW_REFUND_STATUS, TERMINAL_JOB_STATUSES } from "@pcc/spec";

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
 * The escrow status that means A SETTLEMENT OWNS THIS ESCROW (astra round 2 on #462, F1/F3). A settlement takes it,
 * synchronously, at its claim: /complete, resume-settlement and SettlementService.releaseMilestone. While an escrow
 * reads it, no refund lands, however often the job's status is rewritten meanwhile (the job status is mutable by
 * other writers; this row is not). It is already in @pcc/spec's escrow vocabulary.
 */
export const SETTLEMENT_OWNED_ESCROW_STATUS = "completing";

/** Milestone statuses with nothing yet claimed against them. */
const REFUNDABLE_MILESTONE_STATUSES: ReadonlySet<string> = new Set(["unfunded", "funded", "locked"]);

/** Statuses an escrow cannot be released from: `/complete` and the settlement keeper refuse these. */
export const NON_RELEASABLE_ESCROW_STATUSES: ReadonlySet<string> = new Set([
  ESCROW_REFUND_STATUS.PENDING,
  ESCROW_REFUND_STATUS.DONE,
]);

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
  if (escrow.status === SETTLEMENT_OWNED_ESCROW_STATUS) {
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

/** Every other job that references the escrow's CWM (and so the escrow). */
function otherJobsOnEscrow(jobId: string, cwmId: string): string[] {
  const { db } = getStore();
  return db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.cwmId, cwmId))
    .all()
    .map((r) => r.id)
    .filter((id) => id !== jobId);
}

/** What a settlement took when it claimed a job's escrow, to hand back if it gives up. */
export interface SettlementClaim {
  escrowId?: string;
  /** The status the escrow had before this claim. Undefined when this claim changed nothing. */
  prior?: string;
}

/**
 * Take settlement ownership of a job's escrow: a compare-and-set from `funded`/`active` to `completing`. Call it
 * synchronously, with no await between it and the claim that starts the settlement. An escrow that is already
 * `completing` stays owned (a resume continues the same settlement); any other status is not the refund's to touch,
 * so it is left alone.
 */
export function claimEscrowForSettlement(jobId: string): SettlementClaim {
  const escrow = escrowForJob(jobId);
  return escrow ? claimEscrowRow(escrow) : {};
}

/**
 * The same claim for routes that act by CONTRACT ADDRESS rather than by job (the raw chain release route). Also names
 * the escrow's job, so a release that gives up can reconcile a refund for it.
 */
export function claimEscrowByAddressForSettlement(contractAddress: string): { claim: SettlementClaim; jobId?: string } {
  const escrow = escrowByContractAddress(contractAddress);
  if (!escrow) return { claim: {} };
  const { db } = getStore();
  const session = db
    .select()
    .from(schema.negotiationSessions)
    .where(eq(schema.negotiationSessions.cwmId, escrow.cwmId))
    .get();
  return { claim: claimEscrowRow(escrow), jobId: session?.jobId ?? undefined };
}

function claimEscrowRow(escrow: { id: string; status: string }): SettlementClaim {
  if (!REFUNDABLE_ESCROW_STATUSES.has(escrow.status)) return { escrowId: escrow.id };
  const { db } = getStore();
  const took = db
    .update(schema.escrows)
    .set({ status: SETTLEMENT_OWNED_ESCROW_STATUS })
    .where(and(eq(schema.escrows.id, escrow.id), eq(schema.escrows.status, escrow.status)))
    .returning()
    .all();
  return took.length === 1 ? { escrowId: escrow.id, prior: escrow.status } : { escrowId: escrow.id };
}

/**
 * Hand an escrow back after a settlement gave up WITHOUT recording evidence: it returns to the status it had before
 * the claim (only if it still reads `completing`). Then, if the job ended without completing meanwhile (a failure write
 * landed while the settlement owned the escrow), give the escrow back now (astra round 2, F4). One transaction.
 */
export function releaseEscrowFromSettlement(
  jobId: string | undefined,
  claim: SettlementClaim,
): EscrowRefundOutcome | undefined {
  const { db } = getStore();
  return db.transaction(() => {
    if (claim.escrowId && claim.prior) {
      db.update(schema.escrows)
        .set({ status: claim.prior })
        .where(and(eq(schema.escrows.id, claim.escrowId), eq(schema.escrows.status, SETTLEMENT_OWNED_ESCROW_STATUS)))
        .run();
    }
    if (!jobId) return undefined;
    const job = getRepos().jobs.findById(jobId);
    return job && TERMINAL_FAILURE_JOB_STATUSES.has(job.status) ? refundEscrowForTerminalJob(jobId) : undefined;
  });
}

/**
 * Record a release that went through for a settlement holding `claim`: the milestone at `milestoneIndex` reads
 * `released`. Once every milestone does, the escrow reads `completed`. Otherwise a claim this settlement took is handed
 * back (the escrow returns to its prior status); one it did not take stays with its owner. One transaction.
 */
export function recordMilestoneReleased(milestoneIndex: number, claim: SettlementClaim): void {
  if (!claim.escrowId) return;
  const escrowId = claim.escrowId;
  const { db } = getStore();
  const repos = getRepos();
  db.transaction(() => {
    const milestone = repos.escrows.findMilestonesByEscrow(escrowId)[milestoneIndex];
    if (milestone) repos.escrows.updateMilestoneStatus(milestone.id, "released");
    const all = repos.escrows.findMilestonesByEscrow(escrowId);
    if (all.length > 0 && all.every((m) => m.status === "released")) {
      repos.escrows.updateStatus(escrowId, "completed");
    } else if (claim.prior) {
      db.update(schema.escrows)
        .set({ status: claim.prior })
        .where(and(eq(schema.escrows.id, escrowId), eq(schema.escrows.status, SETTLEMENT_OWNED_ESCROW_STATUS)))
        .run();
    }
  });
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

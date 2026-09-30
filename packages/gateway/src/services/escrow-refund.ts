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
import { schema, eq } from "@pcc/store";
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
        | "milestone_past_funding";
      escrowId?: string;
      escrowStatus?: string;
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
  if (!REFUNDABLE_ESCROW_STATUSES.has(escrow.status)) {
    return { outcome: "skipped", reason: "escrow_not_refundable", escrowId: escrow.id, escrowStatus: escrow.status };
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

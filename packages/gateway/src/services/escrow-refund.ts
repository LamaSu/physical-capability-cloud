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
  return { disposition, claim: { escrowId: escrow.id, token, prior, leasedStatus, jobId: ref.jobId ?? jobOfEscrow(escrow.cwmId) } };
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
 * Record a release that went through on-chain: the milestone at `milestoneIndex` reads `released`, because that is the
 * chain's truth, whoever holds the escrow. The ESCROW row changes only for the claim that holds the lease: once every
 * milestone reads `released` it becomes `completed` (a compare-and-set from what the claim holds it as); otherwise an
 * `acquired` claim hands it back to its `prior` status. It never writes over `refund_pending` or `refunded`. One
 * transaction. It throws if a write fails; the caller must say so (F5), not swallow it.
 */
export function recordMilestoneReleased(milestoneIndex: number, claim: SettlementClaim): void {
  const repos = getRepos();
  storeDb().transaction(() => {
    const milestone = repos.escrows.findMilestonesByEscrow(claim.escrowId)[milestoneIndex];
    if (milestone) repos.escrows.updateMilestoneStatus(milestone.id, "released");
    if (settlementLeases.get(claim.escrowId) !== claim.token) return;
    const all = repos.escrows.findMilestonesByEscrow(claim.escrowId);
    if (all.length > 0 && all.every((m) => m.status === "released")) {
      casEscrowStatus(claim.escrowId, claim.leasedStatus, "completed");
    } else if (claim.prior) {
      casEscrowStatus(claim.escrowId, SETTLEMENT_OWNED_ESCROW_STATUS, claim.prior);
    }
  });
}

/**
 * Record ONE milestone's release on its row, and nothing else. The keeper calls it the moment the chain shows a milestone
 * Released (a drive that settled, or a pre-read that already read Released), so the rows of a partly paid escrow tell the
 * truth at once and a later refund finds `milestone_past_funding` instead of giving back money that moved. It writes only
 * the milestone row: it never touches the escrow row or the lease. {@link recordMilestoneReleased} mid-loop would hand the
 * claim back (restore `prior`), and the final compare-and-set to `completed` would then miss.
 */
export function recordMilestoneRowReleased(escrowId: string, milestoneIndex: number): void {
  const repos = getRepos();
  const milestone = repos.escrows.findMilestonesByEscrow(escrowId)[milestoneIndex];
  if (milestone && milestone.status !== "released") repos.escrows.updateMilestoneStatus(milestone.id, "released");
}

/**
 * Record that EVERY milestone of the escrow was released on-chain (the keeper, once the chain reads all Released): every
 * milestone row reads `released`, and the escrow, for the claim that holds the lease, becomes `completed`. Returns
 * whether the escrow row was completed. Same rules as {@link recordMilestoneReleased}: never over a refund.
 */
export function recordEscrowReleased(claim: SettlementClaim): boolean {
  const repos = getRepos();
  return storeDb().transaction(() => {
    for (const m of repos.escrows.findMilestonesByEscrow(claim.escrowId)) {
      if (m.status !== "released") repos.escrows.updateMilestoneStatus(m.id, "released");
    }
    if (settlementLeases.get(claim.escrowId) !== claim.token) return false;
    return casEscrowStatus(claim.escrowId, claim.leasedStatus, "completed");
  });
}

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

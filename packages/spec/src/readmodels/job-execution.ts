/**
 * JobExecutionDTO: the product read model for ONE job (product pack section 7, PX-6).
 *
 * WHY THIS EXISTS. The live Jobs list drilled into a detail page built from mock data,
 * and the older job DTOs inferred money meaning from the job row: `completed` rendered
 * as `settled`. This read model gives a surface everything it needs to PROJECT a job
 * without inferring anything. It has four independent axes. Each axis has an explicit
 * enum, names the source it was read from, and carries that source's own timestamps.
 *
 *   execution     what the executor reported (the gateway job row today; VCR's public
 *                 execution stream replaces it when PX-9 lands)
 *   evidence      what evidence the gateway holds, and how much of it is
 *                 fabricated-by-design (mock or simulated sources)
 *   verification  whether anything VERIFIED the outcome. Holding evidence is not
 *                 verification.
 *   settlement    what the linked settlement record says about money. Finishing the
 *                 work is not payment.
 *
 * RULES
 *  - Axes never borrow meaning from each other. `completed` never implies paid; evidence
 *    never implies verified.
 *  - Unknown source values fail closed to `unknown`, never to a success state.
 *  - A failed read is `unavailable` and carries the error. It is never an empty list or a
 *    default value (absence is not evidence).
 *  - Timestamps are the source's own. A missing one stays null; nothing is filled with
 *    "now".
 *  - `asOf` is the time the gateway READ the sources, not a last-change time
 *    (render-provenance contract, `ProvenancedReadModel.asOf`).
 *
 * Browser-safe: no Node imports.
 */

import type { KernelJobStatus } from "../types/job-lifecycle.js";
import type { StepStatus } from "../types/common.js";
import type { MoneyTone } from "../money/money-status.js";

/** Schema id for the closed render IR bind registry and for clients that pin a version. */
export const JOB_EXECUTION_SCHEMA_ID = "pcc.job-execution/v1" as const;

// ── Execution axis ──────────────────────────────────────────────────────────

/**
 * What the executor has reported about the work itself. It says nothing about evidence,
 * verification or money.
 *
 *   pending           accepted into PCC, not yet released to an executor
 *   queued            waiting for an executor to start it
 *   dispatched        sent to one executor, which has not acknowledged it yet
 *   running           the executor acknowledged it or reports it is working
 *   awaiting_handoff  the executor reports the physical work is done and waiting for pickup
 *   paused            the executor paused it
 *   completed         the executor reported the work finished. NOT verified, NOT paid.
 *   failed            the executor or the gateway reported failure
 *   timed_out         a lifecycle deadline expired
 *   cancelled         cancelled before completion
 *   unknown           the source value is not a documented job status (fail closed)
 */
export type ExecutionPhase =
  | "pending"
  | "queued"
  | "dispatched"
  | "running"
  | "awaiting_handoff"
  | "paused"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown";

/** Phases after which the job row will not move again. */
export const TERMINAL_EXECUTION_PHASES: readonly ExecutionPhase[] = Object.freeze([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
] as const);

type KnownPhase = Exclude<ExecutionPhase, "unknown">;

/**
 * The exact table from every job-row status value PCC writes (or has documented) to its
 * execution phase. Keys are lower-case. Anything not listed is `unknown`.
 */
export const JOB_EXECUTION_PHASE_MAP: Readonly<Record<string, KnownPhase>> = Object.freeze({
  // Canonical gateway vocabulary (gateway config/job-status.ts JOB_STATUSES).
  pending: "pending",
  queued: "queued",
  in_progress: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  // Input alias the gateway normalizes on write. Tolerated on read for legacy rows.
  running: "running",

  // Kernel vocabulary (KernelJobStatus, types/job-lifecycle.ts).
  dispatched: "dispatched",
  accepted: "running",
  preparing: "running",
  executing: "running",
  collecting_evidence: "running",
  awaiting_pickup: "awaiting_handoff",
  timed_out: "timed_out",

  // CWM step vocabulary (StepStatus, types/common.ts). A step that awaits verification,
  // was verified or is disputed has already been reported complete by its executor. The
  // verification and dispute themselves belong to the other axes, never to this one.
  scheduled: "queued",
  awaiting_verification: "completed",
  verified: "completed",
  disputed: "completed",

  // Values the gateway's paid-job pipeline writes into the job row.
  // `active`: a gateway-local job created against a funded escrow; nothing has
  //   reported starting it.
  // `evidence_stored` / `evidence_submitted` / `settled`: written AFTER the executor
  //   reported completion. They are NOT money states: mock settlement writes `settled`
  //   with no money moving. The settlement axis reads money from the settlement record.
  active: "queued",
  evidence_stored: "completed",
  evidence_submitted: "completed",
  settled: "completed",
});

/** Normalize a job-row status for lookup: trimmed, lower-case. */
export function normalizeJobRowStatus(s: unknown): string {
  return String(s == null ? "" : s).trim().toLowerCase();
}

/** Exact lookup. Anything undocumented is `unknown`, never a success phase. */
export function executionPhaseOf(status: unknown): ExecutionPhase {
  const key = normalizeJobRowStatus(status);
  return Object.prototype.hasOwnProperty.call(JOB_EXECUTION_PHASE_MAP, key)
    ? JOB_EXECUTION_PHASE_MAP[key]!
    : "unknown";
}

export function isTerminalExecutionPhase(phase: ExecutionPhase): boolean {
  return (TERMINAL_EXECUTION_PHASES as readonly string[]).includes(phase);
}

export interface ExecutionAxis {
  phase: ExecutionPhase;
  /** The exact job-row status the phase was read from (for inspect views). */
  sourceStatus: string;
  /**
   * `gateway_job_row`: the gateway's job record, written from executor and operator status
   * reports and by the gateway's own pipeline. It is not the private VCR execution
   * authority; VCR's public execution stream (PX-9) replaces it when that is wired.
   */
  source: "gateway_job_row";
  terminal: boolean;
  /**
   * Progress the executor reported, 0-100. Present only while the phase is `running` or
   * `paused` and a value above 0 was reported. The job row stores 0 by default, and a
   * default is not a report. Never predicted.
   */
  progressPercent: number | null;
  /** When the row entered `completed`. The store stamps only that transition. */
  completedAt: string | null;
}

// ── Evidence axis ───────────────────────────────────────────────────────────

/** Most bundles listed inline. Totals always cover every bundle. */
export const JOB_EXECUTION_EVIDENCE_LIMIT = 20;

export type EvidenceAxisState = "none" | "received" | "unavailable";

export interface EvidenceBundleSummary {
  bundleId: string;
  stepId: string;
  /** Content hash the bundle was stored under. */
  bundleHash: string;
  /** Assurance tier the bundle CLAIMS. A claim, not a verification. */
  claimedTier: number;
  eventCount: number;
  /** Events that the canonical `isFabricated` predicate flags (mock or simulated source). */
  fabricatedEventCount: number;
  /** Signer the bundle names, as stored. No signature check is implied. */
  signer: { algorithm: string; id: string } | null;
  /** When the gateway stored the bundle. */
  storedAt: string;
}

export interface EvidenceAxis {
  /**
   * `none`: the store holds no evidence for this job. `received`: it holds at least one
   * bundle (received, NOT verified). `unavailable`: the store could not be read.
   */
  state: EvidenceAxisState;
  source: "gateway_evidence_store";
  /** Every bundle held for the job. Null when unavailable. */
  bundleCount: number | null;
  /** Newest first, at most JOB_EXECUTION_EVIDENCE_LIMIT. */
  bundles: EvidenceBundleSummary[];
  truncated: boolean;
  /** Totals across ALL bundles. Null when unavailable. */
  eventCount: number | null;
  fabricatedEventCount: number | null;
  latestStoredAt: string | null;
  error: ReadError | null;
}

// ── Verification axis ───────────────────────────────────────────────────────

/**
 * Verification of the job OUTCOME against its contract. No public read model carries an
 * outcome verdict yet: the verifier is private (ledger row 24) and its verdict surfaces
 * only through settlement. Later values are additive.
 */
export type OutcomeVerificationState = "not_available";

export type CaptureCheckVerdict = "pass" | "partial" | "fail" | "unknown";

export interface CaptureCheckSummary {
  verdictId: string;
  verdict: CaptureCheckVerdict;
  /** The verifier's exact verdict string. */
  sourceVerdict: string;
  declaredClass: string;
  verifiedClass: string;
  checkedAt: string;
}

export interface VerificationAxis {
  outcome: {
    state: OutcomeVerificationState;
    reason: "no_public_outcome_verdict";
  };
  /**
   * Capture Verification Protocol verdicts on captures submitted for this job. They grade
   * a capture's authenticity class. They do not verify the job outcome and do not release
   * payment.
   */
  captureChecks: {
    state: "none" | "present" | "unavailable";
    source: "gateway_capture_verdicts";
    pass: number | null;
    partial: number | null;
    fail: number | null;
    unrecognized: number | null;
    latestAt: string | null;
    /** Newest first, at most JOB_EXECUTION_EVIDENCE_LIMIT. */
    items: CaptureCheckSummary[];
    error: ReadError | null;
  };
}

// ── Settlement axis ─────────────────────────────────────────────────────────

/**
 * `linked`: every recorded identifier for the job points at the SAME single settlement
 * record. `not_linked`: none points anywhere. `ambiguous`: one identifier matches more
 * than one record. `conflicting`: identifiers disagree (they point at different records,
 * or a record found through one identifier contradicts another recorded identifier).
 * `unavailable`: the settlement store could not be read. Only `linked` carries a record.
 */
export type SettlementLink = "linked" | "not_linked" | "ambiguous" | "conflicting" | "unavailable";

/**
 * An identifier that ties a job to an escrow record. The job's negotiation session
 * records the escrow it created for the job (its contract address and CWM id); the job
 * row carries its own CWM id. `job_cwm` alone is accepted only when the job has no
 * negotiation session.
 */
export type SettlementLinkBasis =
  | "negotiation_session_escrow_address"
  | "negotiation_session_cwm"
  | "job_cwm";

/** A money status exactly as the canonical @pcc/spec money map classifies it. */
export interface MoneyStateView {
  /** The exact status value from the source record. */
  sourceStatus: string;
  /** Which documented vocabulary the value belongs to. */
  vocabulary: "escrow_record" | "escrow_milestone";
  /** From `classifyMoneyStatus`. Never re-derive it in a surface. */
  tone: MoneyTone;
  label: string | null;
  known: boolean;
}

export interface SettlementRecordView {
  /**
   * `gateway_escrow_record`: the gateway's own record of a V2/V3 escrow. It is updated
   * after the gateway's settlement steps. It is NOT a finalized chain read.
   */
  kind: "gateway_escrow_record";
  escrowId: string;
  contractAddress: string;
  contractVersion: string | null;
  /** True for a mock-settlement escrow: there is no contract and no money. */
  simulated: boolean;
  escrow: MoneyStateView;
  /**
   * Match of the job's step against the escrow's milestones:
   *   exact               exactly one milestone is this job's step
   *   no_milestones       the escrow records no milestones. That does not prove one
   *                       whole-escrow payment for this job (several jobs can share an
   *                       escrow), so the payout is unknown.
   *   step_not_in_escrow  milestones exist, none for this step: the record does not
   *                       cover this job, so other steps' releases say nothing about it
   *   ambiguous           more than one milestone claims this step
   */
  milestoneMatch: "exact" | "no_milestones" | "step_not_in_escrow" | "ambiguous";
  /** The milestone for THIS job's step, when exactly one matches. */
  milestone: {
    milestoneId: string;
    stepId: string;
    status: MoneyStateView;
    /** Amount the milestone is for, as recorded. Not an amount paid. */
    amount: string;
    challengeWindowEnd: string | null;
  } | null;
  /** Whole-escrow total, as recorded. Not an amount paid. */
  escrowTotal: { amount: string; currency: string };
  createdAt: string;
  deadline: string;
  /**
   * When the recorded statuses were last observed or changed. The escrow record stores no
   * such time today, so this is null: a fresh `asOf` dates the READ, not the settlement.
   */
  statusObservedAt: string | null;
}

/**
 * Whether the operator was paid for this job, per the linked settlement record. It is read
 * from the job's OWN milestone and reconciled with the escrow's own status; any
 * disagreement is `unknown`.
 *
 *   paid               RESERVED for an authoritative settlement read model: a V-next
 *                      lifecycle or receipt that classifySettlementRecord (@pcc/spec) shows
 *                      as released, its fields agreeing. The gateway's escrow records are
 *                      bare status words, which never prove payment (PX-1; steward #2490),
 *                      so they never produce it.
 *   reported_released  this job's milestone record says released, and the escrow record
 *                      does not contradict it. A RECORD claim that no settlement read
 *                      confirms (on a V-next escrow "released" can mean the outcome was
 *                      allocated, not paid out): never shown as paid. See `payoutConfirmation`.
 *   refunded           this job's milestone record says refunded to the payer, and the escrow
 *                      record does not contradict it. The operator was NOT paid.
 *   not_paid           this job's milestone is not released and the escrow record does not
 *                      claim everything was released
 *   simulated          the linked escrow is a mock-settlement record. Nothing was paid.
 *   unknown            not linked, ambiguous, conflicting, unreadable, no milestone for this
 *                      job, an unrecognized or ambiguous status, or milestone and escrow
 *                      records that disagree
 */
export type PayoutState = "paid" | "reported_released" | "refunded" | "not_paid" | "simulated" | "unknown";

export interface SettlementAxis {
  link: SettlementLink;
  /** The strongest identifier that points at the linked record (null unless linked). */
  linkBasis: SettlementLinkBasis | null;
  /** Every recorded identifier that points at the linked record (empty unless linked). */
  linkMatches: SettlementLinkBasis[];
  source: "gateway_escrow_record";
  record: SettlementRecordView | null;
  payout: PayoutState;
  /** The job's own milestone record when it decided the payout; otherwise null. */
  payoutBasis: "milestone_record" | null;
  /**
   * How far a `reported_released` or `refunded` claim is confirmed. `record_only`: it comes
   * from the gateway's escrow record; no settlement read, chain receipt or finalized read
   * confirms it. Null when the payout claims no movement of money.
   */
  payoutConfirmation: "record_only" | null;
  error: ReadError | null;
}

// ── Whole read model ────────────────────────────────────────────────────────

export interface ReadError {
  code: "source_read_failed";
  /** A safe, generic description. Internal details stay in the gateway log. */
  message: string;
}

/**
 * Conditions a surface must show, as a closed list. They are computed from the sources,
 * so no surface has to re-derive them.
 */
export type JobExecutionNoticeCode =
  /** The job row says `settled`. Money is read only from the settlement record. */
  | "job_row_reports_settled"
  /** The job row says `disputed`. */
  | "job_row_reports_dispute"
  /** At least one evidence event is fabricated-by-design (mock or simulated source). */
  | "fabricated_evidence"
  /** The linked settlement record is a mock-settlement escrow. */
  | "simulated_settlement"
  /** The job's milestone record and the escrow record disagree about money. */
  | "settlement_records_conflict"
  /**
   * The job row says `settled`, but this job's milestone record says not released or
   * refunded: one of them is wrong, so the payout is unknown.
   */
  | "settlement_row_conflict"
  /** The job's recorded settlement identifiers point at different records. */
  | "settlement_link_conflict"
  /** The job-row status is not a documented job status. */
  | "unknown_execution_status";

export interface JobIdentityView {
  jobId: string;
  stepId: string;
  capabilityId: string;
  kernelId: string;
  /** Display labels. Null when the row is missing or could not be read. */
  capabilityType: string | null;
  capabilityName: string | null;
  kernelName: string | null;
  /** Tier the job was contracted at. Null for legacy rows that never recorded one. */
  contractedTier: number | null;
  /**
   * When the job row was created. The column is `started_at`, but every writer sets it
   * at creation, so it is NOT an execution start time.
   */
  createdAt: string | null;
}

export interface JobExecutionDTO {
  schemaId: typeof JOB_EXECUTION_SCHEMA_ID;
  /**
   * ISO-8601 UTC: when the gateway read the sources. Every axis is read in one synchronous
   * pass over one store, so a single `asOf` covers all of them.
   */
  asOf: string;
  job: JobIdentityView;
  execution: ExecutionAxis;
  evidence: EvidenceAxis;
  verification: VerificationAxis;
  settlement: SettlementAxis;
  notices: JobExecutionNoticeCode[];
}

// ── Compile-time coverage ───────────────────────────────────────────────────
// If a documented job vocabulary gains a value with no map entry, `tsc` fails here. The
// test suite checks the same keys at runtime, plus the gateway's JOB_STATUSES.
const KERNEL_JOB_STATUS_COVERAGE: { readonly [K in KernelJobStatus]: KnownPhase } = {
  queued: "queued",
  dispatched: "dispatched",
  accepted: "running",
  preparing: "running",
  executing: "running",
  collecting_evidence: "running",
  awaiting_pickup: "awaiting_handoff",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed_out",
};
const STEP_STATUS_COVERAGE: { readonly [K in StepStatus]: KnownPhase } = {
  pending: "pending",
  scheduled: "queued",
  in_progress: "running",
  awaiting_verification: "completed",
  verified: "completed",
  disputed: "completed",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/** Every documented job vocabulary value with its expected phase. Used by the coverage tests. */
export const DOCUMENTED_JOB_STATUS_PHASES: Readonly<Record<string, KnownPhase>> = Object.freeze({
  ...KERNEL_JOB_STATUS_COVERAGE,
  ...STEP_STATUS_COVERAGE,
});

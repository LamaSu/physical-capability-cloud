/**
 * Presentation for the JobExecutionDTO (PX-6). Wording and color only: every meaning comes
 * from the DTO the gateway built, never from re-reading raw statuses here.
 *
 * Rules this module keeps:
 *  - Green is reserved for a payout the gateway classified as `paid`. Work completing is
 *    not green money; a refund, a simulated escrow or an unknown state is never green.
 *    The raw escrow and milestone statuses are shown as neutral record text: they are
 *    the inputs the gateway reconciled, not a second verdict.
 *  - Every axis says where its state came from, in plain words.
 *  - "Not linked", "unavailable" and "unknown" read as what they are. They never read as
 *    "none" or "$0".
 *  - Work-phase chips never use a success color, so a finished job never looks paid.
 */
import type {
  EvidenceAxis,
  ExecutionPhase,
  JobExecutionDTO,
  JobExecutionNoticeCode,
  MoneyStateView,
  PayoutState,
  SettlementAxis,
} from "@pcc/spec";
import type { MoneyBadgeColor } from "./money-badge.js";

export type PhasePulse = "online" | "executing" | "completed" | "failed" | "offline";

/**
 * Execution phase -> label and StatusChip pulse. Exhaustive over the spec union. Only
 * "executing" (amber, work in motion) and "failed" (red) carry color; waiting, paused,
 * finished and unknown phases use the neutral "offline" dot, so no work phase is ever
 * painted in a success color (green means money released, and only on the payout badge).
 */
export const PHASE_VIEW: Readonly<Record<ExecutionPhase, { label: string; pulse: PhasePulse }>> = Object.freeze({
  pending: { label: "Pending", pulse: "offline" },
  queued: { label: "Queued", pulse: "offline" },
  dispatched: { label: "Sent to executor", pulse: "offline" },
  running: { label: "In progress", pulse: "executing" },
  awaiting_handoff: { label: "Awaiting handoff", pulse: "executing" },
  paused: { label: "Paused", pulse: "offline" },
  completed: { label: "Work reported complete", pulse: "offline" },
  failed: { label: "Failed", pulse: "failed" },
  timed_out: { label: "Timed out", pulse: "failed" },
  cancelled: { label: "Cancelled", pulse: "offline" },
  unknown: { label: "Unrecognized status", pulse: "offline" },
});

/**
 * Payout summary. Only `paid` is green, and only a settlement read model sets it; the
 * gateway's escrow records never do (their "released" is `reported_released`, gray).
 */
export const PAYOUT_VIEW: Readonly<Record<PayoutState, { label: string; color: MoneyBadgeColor }>> = Object.freeze({
  paid: { label: "Released to the operator", color: "green" },
  reported_released: { label: "Recorded as released (not confirmed)", color: "gray" },
  refunded: { label: "Refunded to the payer (operator not paid)", color: "gray" },
  not_paid: { label: "Not released", color: "gray" },
  simulated: { label: "Simulated escrow: no money moved", color: "gray" },
  unknown: { label: "Payment status unknown", color: "gray" },
});

export const SOURCE_LABEL = Object.freeze({
  gateway_job_row: "Gateway job record (executor reports)",
  gateway_evidence_store: "Gateway evidence store",
  gateway_capture_verdicts: "Capture verification records",
  gateway_escrow_record: "Gateway escrow record (not a finalized chain read)",
} as const);

export const NOTICE_TEXT: Readonly<Record<JobExecutionNoticeCode, string>> = Object.freeze({
  job_row_reports_settled:
    'The job record says "settled". Payment is shown only from the settlement record below.',
  job_row_reports_dispute: "The job record reports a dispute.",
  fabricated_evidence: "Some evidence came from a simulated or mock source. It is not a physical reading.",
  simulated_settlement: "This job's escrow is simulated. No money moved.",
  unknown_execution_status: "This job has a status this view does not recognize, so it is shown as-is.",
  settlement_records_conflict:
    "This job's milestone record and its escrow record disagree about the money, so the payment is shown as unknown.",
  settlement_row_conflict:
    'The job record says "settled", but this job\'s milestone record does not show the money released, so the payment is shown as unknown.',
  settlement_link_conflict:
    "The records that tie this job to an escrow point at different escrows, so no payment record is shown.",
});

/** One sentence for the settlement axis when there is no usable record. */
export function settlementLinkText(s: SettlementAxis): string | null {
  switch (s.link) {
    case "not_linked":
      return "No settlement record is linked to this job.";
    case "ambiguous":
      return "More than one settlement record matches this job, so none is shown.";
    case "conflicting":
      return "The records that tie this job to an escrow disagree, so none is shown.";
    case "unavailable":
      return "The settlement record could not be read.";
    default:
      return null;
  }
}

/** Where the payout came from, or why it could not be read. */
export function payoutBasisText(s: SettlementAxis): string | null {
  if (s.link !== "linked" || !s.record) return null;
  if (s.record.simulated) return "Simulated escrow.";
  if (s.payoutBasis === "milestone_record") {
    if (s.payout === "unknown") return "This job's milestone and the escrow record disagree, so the payment is unknown.";
    if (s.payoutConfirmation === "record_only") {
      return "From this job's milestone in the gateway's escrow record. No settlement read or chain receipt confirms it.";
    }
    return "From this job's milestone in the gateway's escrow record.";
  }
  switch (s.record.milestoneMatch) {
    case "no_milestones":
      return "The escrow records no milestones, so this job's payment cannot be read from it.";
    case "step_not_in_escrow":
      return "The escrow has no milestone for this job's step.";
    case "ambiguous":
      return "More than one milestone claims this job's step.";
    default:
      return null;
  }
}

/**
 * A recorded escrow or milestone status, shown as neutral record text. Always gray: the
 * statuses are the inputs the gateway reconciled into the payout, not a verdict of their
 * own, and on a simulated escrow they describe no money at all. Uses the DTO's own
 * classification label; it never re-reads the raw string.
 */
export function recordStatusBadge(view: MoneyStateView, simulated: boolean): { color: MoneyBadgeColor; label: string } {
  const label = view.label ?? `unrecognized status "${view.sourceStatus}"`;
  return { color: "gray", label: simulated ? `Simulated: ${label}` : label };
}

/** How often the page re-reads a job (ms): in motion vs finished. Never zero. */
export const JOB_EXECUTION_REFRESH_MS = 15_000;
export const JOB_EXECUTION_TERMINAL_REFRESH_MS = 60_000;

/**
 * Freshness of the shown read. Stale when the last refresh failed, or when the read is
 * older than two refresh intervals (the page stopped refreshing, the tab slept, the
 * clock moved). Execution finishing never makes money final, so a finished job is still
 * refreshed and can still go stale.
 */
export function freshness(
  asOfIso: string,
  nowMs: number,
  terminal: boolean,
  refreshFailed: boolean,
): { stale: boolean; reason: "refresh_failed" | "too_old" | null } {
  if (refreshFailed) return { stale: true, reason: "refresh_failed" };
  const asOf = Date.parse(asOfIso);
  const budget = 2 * (terminal ? JOB_EXECUTION_TERMINAL_REFRESH_MS : JOB_EXECUTION_REFRESH_MS);
  if (!Number.isFinite(asOf) || nowMs - asOf > budget) return { stale: true, reason: "too_old" };
  return { stale: false, reason: null };
}

/** One sentence for the evidence axis. Received evidence is never called verified. */
export function evidenceSummaryText(e: EvidenceAxis): string {
  switch (e.state) {
    case "unavailable":
      return "Evidence could not be read.";
    case "none":
      return "No evidence has been received.";
    default: {
      const n = e.bundleCount ?? 0;
      return `${n} evidence bundle${n === 1 ? "" : "s"} received (received, not verified).`;
    }
  }
}

/** The page title: the capability's name, then its type, then the raw id. */
export function jobTitle(dto: JobExecutionDTO): string {
  return dto.job.capabilityName ?? dto.job.capabilityType ?? dto.job.jobId;
}

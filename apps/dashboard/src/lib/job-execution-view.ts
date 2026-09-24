/**
 * Presentation for the JobExecutionDTO (PX-6). Wording and color only: every meaning comes
 * from the DTO the gateway built, never from re-reading raw statuses here.
 *
 * Rules this module keeps:
 *  - Green is reserved for a payout the gateway classified as `paid`. Work completing is
 *    not green money; a refund, a simulated escrow or an unknown state is never green.
 *  - Every axis says where its state came from, in plain words.
 *  - "Not linked", "unavailable" and "unknown" read as what they are. They never read as
 *    "none" or "$0".
 */
import type {
  EvidenceAxis,
  ExecutionPhase,
  JobExecutionDTO,
  JobExecutionNoticeCode,
  PayoutState,
  SettlementAxis,
} from "@pcc/spec";
import { moneyBadgeColor, type MoneyBadgeColor } from "./money-badge.js";

export type PhasePulse = "online" | "executing" | "completed" | "failed" | "offline";

/** Execution phase -> label and StatusChip pulse. Exhaustive over the spec union. */
export const PHASE_VIEW: Readonly<Record<ExecutionPhase, { label: string; pulse: PhasePulse }>> = Object.freeze({
  pending: { label: "Pending", pulse: "online" },
  queued: { label: "Queued", pulse: "online" },
  dispatched: { label: "Sent to executor", pulse: "online" },
  running: { label: "In progress", pulse: "executing" },
  awaiting_handoff: { label: "Awaiting handoff", pulse: "executing" },
  paused: { label: "Paused", pulse: "offline" },
  completed: { label: "Work reported complete", pulse: "completed" },
  failed: { label: "Failed", pulse: "failed" },
  timed_out: { label: "Timed out", pulse: "failed" },
  cancelled: { label: "Cancelled", pulse: "offline" },
  unknown: { label: "Unrecognized status", pulse: "offline" },
});

/** Payout summary. Only `paid` is green, and the gateway sets it only from a release record. */
export const PAYOUT_VIEW: Readonly<Record<PayoutState, { label: string; color: MoneyBadgeColor }>> = Object.freeze({
  paid: { label: "Released to the operator", color: "green" },
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
});

/** One sentence for the settlement axis when there is no usable record. */
export function settlementLinkText(s: SettlementAxis): string | null {
  switch (s.link) {
    case "not_linked":
      return "No settlement record is linked to this job.";
    case "ambiguous":
      return "More than one settlement record matches this job, so none is shown.";
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
  if (s.payoutBasis === "milestone_record") return "From this job's milestone in the escrow record.";
  if (s.payoutBasis === "escrow_record") return "From the escrow record (it has no milestones).";
  switch (s.record.milestoneMatch) {
    case "step_not_in_escrow":
      return "The escrow has no milestone for this job's step.";
    case "ambiguous":
      return "More than one milestone claims this job's step.";
    default:
      return null;
  }
}

/** The color of a recorded money status (escrow or milestone), from the canonical map. */
export function moneyStatusColor(sourceStatus: string): MoneyBadgeColor {
  return moneyBadgeColor(sourceStatus);
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

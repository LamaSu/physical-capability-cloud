/**
 * OperatorWorkDTO and OperatorIncomeDTO (PX-7 for operator-ux's Work Inbox, PX-11).
 *
 * One list of the work an operator can act on, from four gateway sources that model work
 * differently (job offers, skill jobs, kernel jobs, approvals), with every field assigned
 * by the server so the UI infers nothing:
 *   - `phase` comes from an exact map of each source's own status, and `phaseSource` says
 *     who asserted it (the gateway, the operator's own report, or a verifier).
 *   - `pay` says where the amount comes from and whether any money backs it. A declared
 *     price is never income; a mock escrow is `simulated`, never `escrowed`.
 *   - `actions` are computed from ownership and state, each with the route to call and,
 *     when not allowed, the reason.
 *   - A source that could not be read, or cannot be attributed to the caller, is reported
 *     as such in `sources`; it is never an empty list that looks like "no work".
 *
 * OperatorIncomeDTO lists what the gateway's escrow records show for the caller's kernel
 * jobs. Its totals are sums of its rows only, and it says plainly that no per-operator
 * payout history exists yet.
 */
import type { MoneyStateView, PayoutState } from "./job-execution.js";

export const OPERATOR_WORK_SCHEMA_ID = "pcc.operator-work/v1" as const;
export const OPERATOR_INCOME_SCHEMA_ID = "pcc.operator-income/v1" as const;

export type OperatorWorkSource = "job_offer" | "skill_job" | "kernel_job" | "approval";

/**
 * Where a piece of work stands, for the operator. `unknown` is a source status this map does
 * not know: it is never shown as progress or success.
 */
export type OperatorWorkPhase =
  | "offered"
  | "awaiting_me"
  | "accepted"
  | "in_progress"
  | "reported_done"
  | "verified"
  | "failed"
  | "cancelled"
  | "expired"
  | "disputed"
  | "unknown";

/** Who asserted the phase: the gateway itself, the operator's own report, or a verifier. */
export type OperatorWorkPhaseSource = "server" | "operator_reported" | "verifier";

/**
 * Job-offer statuses (gateway job-offers store) to operator phases.
 * `settled` exists in the offer vocabulary, but nothing links an offer to money, so it is
 * the work reported done, not a payment.
 */
export const JOB_OFFER_PHASE_MAP: Readonly<Record<string, { phase: OperatorWorkPhase; source: OperatorWorkPhaseSource }>> =
  Object.freeze({
    open: { phase: "offered", source: "server" },
    claimed: { phase: "accepted", source: "operator_reported" },
    in_progress: { phase: "in_progress", source: "operator_reported" },
    delivered: { phase: "reported_done", source: "operator_reported" },
    settled: { phase: "reported_done", source: "operator_reported" },
    cancelled: { phase: "cancelled", source: "server" },
    expired: { phase: "expired", source: "server" },
    disputed: { phase: "disputed", source: "server" },
  });

/**
 * Kernel-job execution phases (JobExecutionDTO's `ExecutionPhase`) to operator phases.
 * Completion is the executor's report: `reported_done`, never `verified` (no public verifier
 * verdict exists) and never paid.
 */
export const KERNEL_JOB_PHASE_MAP: Readonly<Record<string, { phase: OperatorWorkPhase; source: OperatorWorkPhaseSource }>> =
  Object.freeze({
    pending: { phase: "accepted", source: "server" },
    queued: { phase: "accepted", source: "server" },
    dispatched: { phase: "in_progress", source: "operator_reported" },
    running: { phase: "in_progress", source: "operator_reported" },
    awaiting_handoff: { phase: "in_progress", source: "operator_reported" },
    paused: { phase: "in_progress", source: "operator_reported" },
    completed: { phase: "reported_done", source: "operator_reported" },
    failed: { phase: "failed", source: "operator_reported" },
    timed_out: { phase: "failed", source: "server" },
    cancelled: { phase: "cancelled", source: "server" },
  });

/** Exact lookup; anything unmapped is `unknown` (asserted by the server, which could not read it). */
export function operatorPhaseOf(
  map: Readonly<Record<string, { phase: OperatorWorkPhase; source: OperatorWorkPhaseSource }>>,
  status: unknown,
): { phase: OperatorWorkPhase; source: OperatorWorkPhaseSource } {
  const key = String(status == null ? "" : status).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key]! : { phase: "unknown", source: "server" };
}

// ── Money amounts ─────────────────────────────────────────────────────────────

/** Decimals of the currencies the gateway records. Anything else is unknown, never guessed. */
export const KNOWN_CURRENCY_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  USDC: 6,
  USDT: 6,
  EURC: 6,
  ETH: 18,
  WETH: 18,
  USD: 2,
  EUR: 2,
});

export function currencyDecimals(currency: unknown): number | null {
  if (typeof currency !== "string") return null;
  const key = currency.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(KNOWN_CURRENCY_DECIMALS, key) ? KNOWN_CURRENCY_DECIMALS[key]! : null;
}

/**
 * An amount in currency units ("12.50", or a finite non-negative number) as an integer
 * string of base units, or null when it cannot be converted EXACTLY: unknown decimals, a
 * negative or malformed amount, or more fractional digits than the currency has (no rounding).
 */
export function toBaseUnits(amount: unknown, decimals: number | null): string | null {
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0) return null;
  let s: string;
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0) return null;
    s = String(amount);
    if (/e/i.test(s)) return null;
  } else if (typeof amount === "string") {
    s = amount.trim();
  } else {
    return null;
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const whole = m[1]!;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) return null;
  const digits = (whole + frac.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  return digits;
}

// ── OperatorWorkDTO ───────────────────────────────────────────────────────────

export interface OperatorWorkPay {
  /** The amount as the source recorded it, in currency units (a decimal string). */
  amount: string | null;
  /** The same amount in the currency's base units (an integer string); null unless exact. */
  amountBaseUnits: string | null;
  currency: string | null;
  decimals: number | null;
  /** How the source prices the work. `escrow_milestone`: this job's milestone in its escrow. */
  model: "fixed" | "quote_required" | "per_unit" | "escrow_milestone" | "unknown";
  unit: string | null;
  /**
   * What backs the amount:
   *   escrowed           this job's milestone in a real escrow record holds it (record only)
   *   declared_unfunded  a price the poster declared; nothing funds it
   *   simulated          a mock-settlement escrow: no money exists
   *   unknown            no amount, or a settlement link that is ambiguous, conflicting,
   *                      unreadable or missing this job's milestone
   */
  funding: "escrowed" | "declared_unfunded" | "simulated" | "unknown";
  fundingRef: string | null;
  basis: "job_offer_pricing" | "escrow_milestone_record" | null;
}

export interface OperatorWorkLocation {
  /**
   * remote: the source says so explicitly. point / area: from the source's coordinates or
   * geofence. operator_site: work done at one of the caller's own kernels. unknown: the
   * source records no location (absence is not "remote").
   */
  kind: "remote" | "point" | "area" | "operator_site" | "unknown";
  /** True when coordinates are rounded because the work is not the caller's yet. */
  approximate: boolean;
  lat: number | null;
  lng: number | null;
  kernelId: string | null;
}

export interface OperatorWorkEvidence {
  assuranceTier: 0 | 1 | 2 | 3 | null;
  /** The evidence the source requires, as recorded; null when the source records none. */
  requirements: {
    eventsRequired: string[];
    photosRequired: boolean | null;
    rawDataRequired: boolean | null;
    chainOfCustody: boolean | null;
    tierRequired: 0 | 1 | 2 | 3 | null;
  } | null;
  source: "job_offer" | "none";
}

export type OperatorWorkOp = "claim" | "approve" | "reject" | "update_status" | "report_progress";

export interface OperatorWorkAction {
  op: OperatorWorkOp;
  allowed: boolean;
  /** Why the caller cannot do it now; null when allowed. */
  reasonIfNot: string | null;
  route: { method: "GET" | "POST" | "PATCH"; path: string };
  /** For a claim: the caller's kernels that offer this capability type. */
  kernelIds?: string[];
}

export interface OperatorWorkItem {
  /** `<source>:<source id>`, stable across reads. */
  id: string;
  source: OperatorWorkSource;
  capabilityType: string | null;
  title: string | null;
  executorKind: "kernel" | "human" | "unknown";
  phase: OperatorWorkPhase;
  phaseSource: OperatorWorkPhaseSource;
  /** The source's own status word, unchanged. */
  sourceStatus: string;
  pay: OperatorWorkPay;
  /**
   * For a kernel job, the execution read model's payout (from this job's milestone in its
   * escrow record; never `paid` from gateway records). Null for sources with no settlement
   * link (offers, approvals).
   */
  payout: PayoutState | null;
  deadline: string | null;
  /** The last time the work can be accepted (a job offer's validUntil). */
  acceptBy: string | null;
  postedAt: string | null;
  location: OperatorWorkLocation;
  evidence: OperatorWorkEvidence;
  assuranceTier: 0 | 1 | 2 | 3 | null;
  actions: OperatorWorkAction[];
  /** True when the work is assigned to one of the caller's kernels. */
  mine: boolean;
  kernelId: string | null;
  refs: {
    offerId?: string;
    jobId?: string;
    skillJobId?: string;
    approvalId?: string;
    escrowRef?: string;
    executionRef?: string;
  };
  /** When the source last changed this work, if it records that; never the read time. */
  changedAt: string | null;
}

export interface OperatorWorkSourceState {
  /**
   * read: listed. unavailable: the read failed; nothing is listed. not_attributable: the
   * source cannot be tied to the caller yet, so nothing is listed rather than guessed.
   */
  state: "read" | "unavailable" | "not_attributable";
  /** memory: the gateway keeps this source in process memory (lost on restart). */
  durability: "durable" | "memory";
  count: number;
  reason: string | null;
}

export interface OperatorWorkDTO {
  schemaId: typeof OPERATOR_WORK_SCHEMA_ID;
  /** When the gateway read the sources (ISO-8601). */
  asOf: string;
  /** The caller's kernels that scope this read: kernels whose operatorAddress is the caller. */
  kernels: Array<{ kernelId: string; name: string | null }>;
  items: OperatorWorkItem[];
  total: number;
  /** True when `items` was cut to the limit; `total` counts everything. */
  truncated: boolean;
  sources: Record<OperatorWorkSource, OperatorWorkSourceState>;
}

// ── OperatorIncomeDTO ─────────────────────────────────────────────────────────

export interface OperatorIncomeRow {
  /** `kernel_job:<jobId>`, the same id as the OperatorWorkDTO item. */
  workRef: string;
  jobId: string;
  kernelId: string;
  amount: string | null;
  amountBaseUnits: string | null;
  currency: string | null;
  decimals: number | null;
  /** This job's milestone status through the canonical money map; null without a milestone. */
  moneyStatus: MoneyStateView | null;
  /** The execution read model's payout for the job (never `paid` from gateway records). */
  payout: PayoutState;
  simulated: boolean;
  escrowRef: string | null;
  /** The escrow record keeps no release time. */
  settledAt: null;
  source: "gateway_escrow_record";
}

export interface OperatorIncomeTotal {
  status: PayoutState;
  currency: string;
  decimals: number;
  amountBaseUnits: string;
  rows: number;
}

export interface OperatorIncomeDTO {
  schemaId: typeof OPERATOR_INCOME_SCHEMA_ID;
  asOf: string;
  kernels: Array<{ kernelId: string; name: string | null }>;
  rows: OperatorIncomeRow[];
  /** Sums of `rows` only, per payout status and currency. */
  totalsByStatus: OperatorIncomeTotal[];
  /** Rows left out of the totals because their amount or decimals are unknown. */
  uncountedRows: number;
  /** False until a per-operator settlement index exists. */
  historyAvailable: boolean;
  reasonIfNot: string | null;
  sources: {
    kernel_jobs: { state: "read" | "unavailable"; reason: string | null };
    settlement: { state: "read" | "partial" | "unavailable"; unreadableJobs: number };
  };
}

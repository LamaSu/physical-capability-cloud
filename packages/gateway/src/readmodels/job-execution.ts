/**
 * JobExecutionDTO read model (product pack section 7, PX-6): loader + pure builder.
 *
 * The loader reads every source for one job in a single synchronous pass over the
 * store and records, per source, either the rows or the fact that the read failed. The
 * builder turns those reads into the typed DTO defined in @pcc/spec
 * (readmodels/job-execution.ts) without inferring meaning across axes:
 *
 *   - execution    comes ONLY from the job row (exact phase table, unknown fails closed)
 *   - evidence     comes ONLY from the evidence store (received is not verified)
 *   - verification comes ONLY from verdict sources (none public for the outcome yet)
 *   - settlement   comes ONLY from the linked escrow record, classified by the canonical
 *                  money map (completed is not paid; a mock escrow is never paid). The
 *                  job-to-escrow link must be proven by every recorded identifier, and the
 *                  job's own milestone must agree with the escrow's own status; anything
 *                  less is `unknown`.
 *
 * A failed read becomes `unavailable` with a generic error. It never becomes an empty
 * list or a default, because absence is not evidence.
 *
 * Reading a job is object-authorized, and identity comes first (precheckJobRead): an admin,
 * or a PROVEN wallet (SIWE) that is the job's kernel operator or its recorded buyer
 * (authorizeJobRead). No credential is 401 and an unproven one is 403, both before the job is
 * read. A proven wallet that is not a party gets the same 404 as a missing job, independent
 * of the tenant flag.
 */

import {
  JOB_EXECUTION_SCHEMA_ID,
  JOB_EXECUTION_EVIDENCE_LIMIT,
  classifyMoneyStatus,
  executionPhaseOf,
  isFabricated,
  isTerminalExecutionPhase,
  normalizeJobRowStatus,
  normalizeMoneyStatus,
  type CaptureCheckSummary,
  type CaptureCheckVerdict,
  type EvidenceAxis,
  type EvidenceBundleSummary,
  type EvidenceEvent,
  type ExecutionAxis,
  type JobExecutionDTO,
  type JobExecutionNoticeCode,
  type MoneyStateView,
  type PayoutState,
  type ReadError,
  type SettlementAxis,
  type SettlementLinkBasis,
  type SettlementRecordView,
  type VerificationAxis,
} from "@pcc/spec";
import { timingSafeEqual } from "node:crypto";
import { schema, eq, and, or } from "@pcc/store";

// ── Source shapes (structural; the builder never touches the DB) ─────────────

export interface JobRow {
  id: string;
  stepId: string;
  cwmId: string;
  capabilityId: string;
  kernelId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: number | null;
  assuranceTier?: number | null;
  tenantId?: string | null;
}

export interface EvidenceBundleRow {
  id: string;
  jobId: string;
  stepId: string;
  assuranceTier: number;
  bundleHash: string;
  kernelSignature?: { signer?: string; algorithm?: string } | null;
  createdAt: string;
  /** Events of this bundle, as stored. */
  events: ReadonlyArray<Pick<EvidenceEvent, "source" | "payload">>;
}

export interface CaptureVerdictRow {
  id: string;
  verdict: string;
  declaredClassStr: string;
  verifiedClassStr: string;
  createdAt: string;
}

export interface EscrowRow {
  id: string;
  cwmId?: string | null;
  contractAddress: string;
  totalAmount: string;
  currency: string;
  status: string;
  createdAt: string;
  deadline: string;
  version?: string | null;
}

export interface MilestoneRow {
  id: string;
  stepId: string;
  amount: string;
  status: string;
  challengeWindowEnd?: string | null;
}

export type SettlementSource =
  | { link: "not_linked" }
  | { link: "ambiguous"; basis: SettlementLinkBasis | "negotiation_session"; candidates: number }
  | { link: "conflicting"; reason: string }
  | {
      link: "linked";
      /** The strongest identifier that points at `escrow`. */
      basis: SettlementLinkBasis;
      /** Every recorded identifier that points at `escrow` (none points elsewhere). */
      matches: SettlementLinkBasis[];
      escrow: EscrowRow;
      milestones: MilestoneRow[];
      /**
       * How many jobs could claim a milestone for THIS job's step in `escrow`, this job
       * included: jobs with the escrow's CWM and this step, and jobs whose negotiation session
       * names the escrow. A milestone records no job, so more than one is not attributable.
       */
      stepClaimants: number;
    };

/** One source read: the value, or the fact that the read failed. */
export type SourceRead<T> = { ok: true; value: T } | { ok: false };

export interface JobExecutionSources {
  job: JobRow;
  capability: SourceRead<{ type?: string | null; name?: string | null } | null>;
  kernel: SourceRead<{ name?: string | null } | null>;
  evidence: SourceRead<EvidenceBundleRow[]>;
  captureVerdicts: SourceRead<CaptureVerdictRow[]>;
  settlement: SourceRead<SettlementSource>;
}

// ── Builder (pure) ────────────────────────────────────────────────────────────

const READ_FAILED = (what: string): ReadError => ({
  code: "source_read_failed",
  message: `The ${what} could not be read.`,
});

/** Mock-settlement escrows are created with this address prefix (paid-job-flow.ts). */
export const MOCK_ESCROW_ADDRESS_PREFIX = "mock-escrow-";

export function buildJobExecutionDTO(src: JobExecutionSources, asOf: string): JobExecutionDTO {
  const execution = buildExecution(src.job);
  const evidence = buildEvidence(src.evidence);
  const verification = buildVerification(src.captureVerdicts);
  const settlement = buildSettlement(src.job, src.settlement);

  const capability = src.capability.ok ? src.capability.value : null;
  const kernel = src.kernel.ok ? src.kernel.value : null;

  return {
    schemaId: JOB_EXECUTION_SCHEMA_ID,
    asOf,
    job: {
      jobId: src.job.id,
      stepId: src.job.stepId,
      capabilityId: src.job.capabilityId,
      kernelId: src.job.kernelId,
      capabilityType: nonEmpty(capability?.type),
      capabilityName: nonEmpty(capability?.name),
      kernelName: nonEmpty(kernel?.name),
      contractedTier: typeof src.job.assuranceTier === "number" && Number.isFinite(src.job.assuranceTier)
        ? src.job.assuranceTier
        : null,
      createdAt: nonEmpty(src.job.startedAt),
    },
    execution,
    evidence,
    verification,
    settlement,
    notices: buildNotices(src.job, execution, evidence, settlement),
  };
}

function buildExecution(job: JobRow): ExecutionAxis {
  const phase = executionPhaseOf(job.status);
  const reported = typeof job.progress === "number" && Number.isFinite(job.progress) && job.progress > 0;
  return {
    phase,
    sourceStatus: String(job.status ?? ""),
    source: "gateway_job_row",
    terminal: isTerminalExecutionPhase(phase),
    progressPercent:
      (phase === "running" || phase === "paused") && reported
        ? Math.min(100, Math.max(0, job.progress as number))
        : null,
    completedAt: nonEmpty(job.completedAt),
  };
}

function buildEvidence(read: SourceRead<EvidenceBundleRow[]>): EvidenceAxis {
  if (!read.ok) {
    return {
      state: "unavailable",
      source: "gateway_evidence_store",
      bundleCount: null,
      bundles: [],
      truncated: false,
      eventCount: null,
      fabricatedEventCount: null,
      latestStoredAt: null,
      error: READ_FAILED("evidence store"),
    };
  }
  const summaries: EvidenceBundleSummary[] = read.value.map((b) => {
    const events = Array.isArray(b.events) ? b.events : [];
    const fabricated = events.filter((e) => isFabricated(e as EvidenceEvent)).length;
    const sig = b.kernelSignature;
    return {
      bundleId: b.id,
      stepId: b.stepId,
      bundleHash: b.bundleHash,
      claimedTier: b.assuranceTier,
      eventCount: events.length,
      fabricatedEventCount: fabricated,
      signer:
        sig && typeof sig.signer === "string" && sig.signer && typeof sig.algorithm === "string"
          ? { algorithm: sig.algorithm, id: sig.signer }
          : null,
      storedAt: b.createdAt,
    };
  });
  summaries.sort(newestFirst((s) => s.storedAt));
  return {
    state: summaries.length === 0 ? "none" : "received",
    source: "gateway_evidence_store",
    bundleCount: summaries.length,
    bundles: summaries.slice(0, JOB_EXECUTION_EVIDENCE_LIMIT),
    truncated: summaries.length > JOB_EXECUTION_EVIDENCE_LIMIT,
    eventCount: summaries.reduce((n, s) => n + s.eventCount, 0),
    fabricatedEventCount: summaries.reduce((n, s) => n + s.fabricatedEventCount, 0),
    latestStoredAt: summaries[0]?.storedAt ?? null,
    error: null,
  };
}

const CAPTURE_VERDICTS: Readonly<Record<string, Exclude<CaptureCheckVerdict, "unknown">>> = Object.freeze({
  PASS: "pass",
  PARTIAL: "partial",
  FAIL: "fail",
});

function buildVerification(read: SourceRead<CaptureVerdictRow[]>): VerificationAxis {
  const outcome = { state: "not_available", reason: "no_public_outcome_verdict" } as const;
  if (!read.ok) {
    return {
      outcome,
      captureChecks: {
        state: "unavailable",
        source: "gateway_capture_verdicts",
        pass: null,
        partial: null,
        fail: null,
        unrecognized: null,
        latestAt: null,
        items: [],
        error: READ_FAILED("capture verification store"),
      },
    };
  }
  const items: CaptureCheckSummary[] = read.value.map((v) => ({
    verdictId: v.id,
    verdict: Object.prototype.hasOwnProperty.call(CAPTURE_VERDICTS, v.verdict)
      ? CAPTURE_VERDICTS[v.verdict]!
      : "unknown",
    sourceVerdict: v.verdict,
    declaredClass: v.declaredClassStr,
    verifiedClass: v.verifiedClassStr,
    checkedAt: v.createdAt,
  }));
  items.sort(newestFirst((i) => i.checkedAt));
  const count = (k: CaptureCheckVerdict) => items.filter((i) => i.verdict === k).length;
  return {
    outcome,
    captureChecks: {
      state: items.length === 0 ? "none" : "present",
      source: "gateway_capture_verdicts",
      pass: count("pass"),
      partial: count("partial"),
      fail: count("fail"),
      unrecognized: count("unknown"),
      latestAt: items[0]?.checkedAt ?? null,
      items: items.slice(0, JOB_EXECUTION_EVIDENCE_LIMIT),
      error: null,
    },
  };
}

function moneyView(status: string, vocabulary: MoneyStateView["vocabulary"]): MoneyStateView {
  const c = classifyMoneyStatus(status);
  return { sourceStatus: String(status ?? ""), vocabulary, tone: c.tone, label: c.label, known: c.known };
}

/** Milestone words (escrow_milestones.status) that claim this job's money was released. */
const MILESTONE_RELEASED = new Set(["RELEASED", "SETTLED_RELEASED"]);
/** A milestone word that may or may not mean released: never read either way. */
const MILESTONE_AMBIGUOUS = new Set(["COMPLETED"]);
/** Milestone words that say the payer was refunded. */
const MILESTONE_REFUNDED = new Set(["REFUNDED", "SETTLED_REFUNDED"]);
/** Escrow words (escrows.status) that claim everything in the escrow was released. */
const ESCROW_ALL_RELEASED = new Set(["COMPLETED", "RELEASED", "SETTLED_RELEASED"]);
/** Escrow words that contradict a release of this job's milestone. */
const ESCROW_AGAINST_RELEASE = new Set(["REFUNDED", "SETTLED_REFUNDED", "DISPUTED", "SLASHED", "EXPIRED"]);

/** Every word the reconciliation reads, for the test that each one is in the canonical map. */
export const RECONCILED_WORDS: readonly string[] = Object.freeze([
  ...new Set([
    ...MILESTONE_RELEASED,
    ...MILESTONE_AMBIGUOUS,
    ...MILESTONE_REFUNDED,
    ...ESCROW_ALL_RELEASED,
    ...ESCROW_AGAINST_RELEASE,
  ]),
]);

export type PayoutUnknownReason = NonNullable<SettlementAxis["payoutUnknownReason"]>;

/**
 * The payout for a REAL (non-simulated) record: this job's milestone status, reconciled
 * with the escrow's own status. Both are exact words from the gateway's escrow tables (their
 * source schema), and every decision below reads those exact words through the sets above.
 * The canonical money map is used only to RECOGNIZE a word: a status it does not know is
 * unrecognized. (Under PX-1 a bare "released" is a waiting tone, so tones must not decide:
 * a release claim must not turn into "not paid".)
 *
 *   either status unrecognized                        -> unknown  (status_unrecognized)
 *   milestone COMPLETED (ambiguous for a milestone)   -> unknown  (status_ambiguous)
 *   milestone released + escrow refunded, settled_refunded, disputed, slashed or expired
 *                                                     -> unknown  (records_conflict)
 *   milestone released + any other escrow word        -> reported_released (never paid)
 *   milestone refunded + escrow says all released     -> unknown  (records_conflict)
 *   milestone refunded + any other escrow word        -> refunded
 *   any other milestone + escrow says all released    -> unknown  (records_conflict)
 *   any other milestone + any other escrow word       -> not_paid
 *
 * No branch returns `paid`: a gateway escrow record never proves payment.
 */
export function reconcilePayout(
  milestone: MoneyStateView,
  escrow: MoneyStateView,
): {
  payout: Exclude<PayoutState, "simulated" | "paid">;
  unknownReason: Extract<PayoutUnknownReason, "records_conflict" | "status_unrecognized" | "status_ambiguous"> | null;
} {
  if (!milestone.known || !escrow.known) return { payout: "unknown", unknownReason: "status_unrecognized" };
  const m = normalizeMoneyStatus(milestone.sourceStatus);
  const e = normalizeMoneyStatus(escrow.sourceStatus);
  const conflict = { payout: "unknown", unknownReason: "records_conflict" } as const;
  if (MILESTONE_AMBIGUOUS.has(m)) return { payout: "unknown", unknownReason: "status_ambiguous" };
  if (MILESTONE_RELEASED.has(m)) {
    return ESCROW_AGAINST_RELEASE.has(e) ? conflict : { payout: "reported_released", unknownReason: null };
  }
  if (MILESTONE_REFUNDED.has(m)) {
    return ESCROW_ALL_RELEASED.has(e) ? conflict : { payout: "refunded", unknownReason: null };
  }
  // Not released (waiting / running / failed): this job's money has not been released.
  return ESCROW_ALL_RELEASED.has(e) ? conflict : { payout: "not_paid", unknownReason: null };
}

/**
 * The settlement axis alone, for read models that need only this job's money (operator
 * work and income). Same resolver output, same payout rule, same notices basis.
 */
export function buildSettlementAxis(job: JobRow, read: SourceRead<SettlementSource>): SettlementAxis {
  return buildSettlement(job, read);
}

function buildSettlement(job: JobRow, read: SourceRead<SettlementSource>): SettlementAxis {
  const empty = {
    source: "gateway_escrow_record" as const,
    linkBasis: null,
    linkMatches: [] as SettlementLinkBasis[],
    record: null,
    payout: "unknown" as const,
    payoutBasis: null,
    payoutUnknownReason: null,
    payoutConfirmation: null,
    error: null,
  };
  if (!read.ok) return { ...empty, link: "unavailable", error: READ_FAILED("settlement store") };
  const s = read.value;
  if (s.link !== "linked") return { ...empty, link: s.link };

  const escrow = s.escrow;
  const simulated = String(escrow.contractAddress ?? "").startsWith(MOCK_ESCROW_ADDRESS_PREFIX);
  const mine = s.milestones.filter((m) => m.stepId === job.stepId);
  // One milestone for this step is this job's only when no other job could claim it: a
  // milestone records no job, so a shared CWM and step (a re-run, a duplicate) is not
  // attributable (cross-family review r3 of #353, P1-1).
  const milestoneMatch: SettlementRecordView["milestoneMatch"] =
    mine.length === 1
      ? s.stepClaimants > 1
        ? "shared_by_jobs"
        : "exact"
      : mine.length > 1
        ? "ambiguous"
        : s.milestones.length === 0
          ? "no_milestones"
          : "step_not_in_escrow";
  const ms = milestoneMatch === "exact" ? mine[0]! : null;

  const record: SettlementRecordView = {
    kind: "gateway_escrow_record",
    escrowId: escrow.id,
    contractAddress: escrow.contractAddress,
    contractVersion: nonEmpty(escrow.version),
    simulated,
    escrow: moneyView(escrow.status, "escrow_record"),
    milestoneMatch,
    milestoneClaimants: mine.length === 1 ? s.stepClaimants : null,
    milestone: ms
      ? {
          milestoneId: ms.id,
          stepId: ms.stepId,
          status: moneyView(ms.status, "escrow_milestone"),
          amount: String(ms.amount),
          challengeWindowEnd: nonEmpty(ms.challengeWindowEnd),
        }
      : null,
    escrowTotal: { amount: String(escrow.totalAmount), currency: String(escrow.currency) },
    createdAt: escrow.createdAt,
    deadline: escrow.deadline,
    // The escrow record stores no time for its current statuses.
    statusObservedAt: null,
  };

  // Payout comes ONLY from this job's own milestone, reconciled with the escrow's status.
  // No milestone for this job (none recorded, not this step, or several) is unknown: an
  // escrow-level status can cover several jobs and never proves this job's payment.
  let payout: PayoutState = "unknown";
  let payoutBasis: SettlementAxis["payoutBasis"] = null;
  let payoutUnknownReason: SettlementAxis["payoutUnknownReason"] = null;
  if (simulated) {
    payout = "simulated";
  } else if (record.milestone) {
    const r = reconcilePayout(record.milestone.status, record.escrow);
    payout = r.payout;
    payoutUnknownReason = r.unknownReason;
    payoutBasis = "milestone_record";
    // The job row saying `settled` while this job's milestone record says not released (or
    // refunded) means one of the two records is wrong. SettlementService.releaseMilestone,
    // for one, updates the job row after an on-chain release and never the milestone
    // record. So the payout is unknown, never "not paid". The row never makes it released.
    if ((payout === "not_paid" || payout === "refunded") && normalizeJobRowStatus(job.status) === "settled") {
      payout = "unknown";
      payoutUnknownReason = "job_row_conflict";
    }
  } else {
    payoutUnknownReason = milestoneMatch === "shared_by_jobs" ? "milestone_shared" : "no_single_milestone";
  }

  return {
    source: "gateway_escrow_record",
    link: "linked",
    linkBasis: s.basis,
    linkMatches: s.matches,
    record,
    payout,
    payoutBasis,
    payoutUnknownReason,
    payoutConfirmation: payout === "reported_released" || payout === "refunded" ? "record_only" : null,
    error: null,
  };
}

function buildNotices(
  job: JobRow,
  execution: ExecutionAxis,
  evidence: EvidenceAxis,
  settlement: SettlementAxis,
): JobExecutionNoticeCode[] {
  const notices: JobExecutionNoticeCode[] = [];
  const raw = normalizeJobRowStatus(job.status);
  if (raw === "settled") notices.push("job_row_reports_settled");
  if (raw === "disputed") notices.push("job_row_reports_dispute");
  if (execution.phase === "unknown") notices.push("unknown_execution_status");
  if ((evidence.fabricatedEventCount ?? 0) > 0) notices.push("fabricated_evidence");
  if (settlement.record?.simulated) notices.push("simulated_settlement");
  if (settlement.payoutUnknownReason === "records_conflict") notices.push("settlement_records_conflict");
  if (settlement.payoutUnknownReason === "job_row_conflict") notices.push("settlement_row_conflict");
  if (settlement.payoutUnknownReason === "status_unrecognized") notices.push("settlement_status_unrecognized");
  if (settlement.payoutUnknownReason === "milestone_shared") notices.push("milestone_shared_by_jobs");
  if (settlement.link === "conflicting") notices.push("settlement_link_conflict");
  return notices;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function newestFirst<T>(at: (x: T) => string): (a: T, b: T) => number {
  const t = (x: T) => {
    const ms = Date.parse(at(x));
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return (a, b) => t(b) - t(a);
}

// ── Loader (one synchronous pass over the store) ─────────────────────────────

/** Narrow view of the repositories the loader uses. */
export interface JobExecutionRepos {
  jobs: { findById(id: string): unknown };
  capabilities: { findById(id: string): unknown };
  kernels: { findById(id: string): unknown };
  evidence: {
    findByJob(jobId: string, opts?: { tenantId?: string | null }): unknown[];
    findEventsByBundle(bundleId: string): unknown[];
    findCaptureVerdictsByJob(jobId: string): unknown[];
  };
  escrows: {
    findMilestonesByEscrow(escrowId: string): unknown[];
  };
}

/** Drizzle db handle (better-sqlite3), for the reads the repositories do not offer. */
export interface JobExecutionDb {
  select(): any;
}

export interface JobExecutionLoadOptions {
  /** Called with the source name and error when a read fails, for the gateway log. */
  onReadError?: (source: string, error: unknown) => void;
}

/**
 * Read every source for one job the caller is already authorized to read (see
 * authorizeJobRead). Each source is read separately; a failed read is recorded, never
 * replaced with an empty value.
 */
export function loadJobExecutionSources(
  job: JobRow,
  repos: JobExecutionRepos,
  db: JobExecutionDb,
  opts: JobExecutionLoadOptions = {},
): JobExecutionSources {
  const attempt = <T>(source: string, fn: () => T): SourceRead<T> => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      opts.onReadError?.(source, error);
      return { ok: false };
    }
  };

  return {
    job,
    capability: attempt("capability", () => (repos.capabilities.findById(job.capabilityId) ?? null) as any),
    kernel: attempt("kernel", () => (repos.kernels.findById(job.kernelId) ?? null) as any),
    // Evidence is scoped through the job, which the caller is already authorized to read
    // (tenancy included). It is NOT filtered by evidence_bundles.tenant_id: no writer sets that
    // column, so a tenant filter matched no rows and reported "no evidence" for a job that has it.
    evidence: attempt("evidence", () => {
      const bundles = repos.evidence.findByJob(job.id) as Array<Omit<EvidenceBundleRow, "events">>;
      return bundles.map((b) => ({
        ...b,
        events: repos.evidence.findEventsByBundle(b.id) as EvidenceBundleRow["events"],
      }));
    }),
    captureVerdicts: attempt("capture_verdicts", () => repos.evidence.findCaptureVerdictsByJob(job.id) as CaptureVerdictRow[]),
    settlement: attempt("settlement", () => resolveSettlement(job, repos, db)),
  };
}

const BASIS_STRENGTH: readonly SettlementLinkBasis[] = [
  "negotiation_session_escrow_address",
  "negotiation_session_cwm",
  "job_cwm",
];

/**
 * Prove the job-to-escrow relationship from EVERY recorded identifier.
 *
 * The paid-job flow creates the escrow and the job together from one negotiation
 * session, and records on that session the escrow's contract address and the CWM id; the
 * job row carries a CWM id too. Each identifier is looked up in full (cardinality, not
 * "first match"):
 *   - any identifier matching more than one escrow            -> ambiguous
 *   - identifiers matching different escrows                  -> conflicting
 *   - the one escrow found contradicting a recorded identifier
 *     (its address or CWM differs from the session's)         -> conflicting
 *   - a session that records no escrow identifier while the
 *     job's CWM matches an escrow (the link is unproven)       -> conflicting
 *   - more than one session naming the job                    -> ambiguous
 *   - nothing matches                                          -> not_linked
 * The job's CWM alone links only when the job has no negotiation session (legacy rows):
 * the V2 escrow schema is one escrow per CWM with one milestone per step, and the payout
 * still needs this job's own milestone.
 */
export function resolveSettlement(
  job: JobRow,
  repos: Pick<JobExecutionRepos, "escrows" | "jobs">,
  db: JobExecutionDb,
): SettlementSource {
  const { negotiationSessions, escrows } = schema;
  const sessions = db
    .select()
    .from(negotiationSessions)
    .where(eq(negotiationSessions.jobId, job.id))
    .all() as Array<{ cwmId: string | null; escrowAddress: string | null }>;
  if (sessions.length > 1) return { link: "ambiguous", basis: "negotiation_session", candidates: sessions.length };
  const session = sessions[0] ?? null;

  const byCwm = (cwmId: string) => db.select().from(escrows).where(eq(escrows.cwmId, cwmId)).all() as EscrowRow[];
  const byAddress = (address: string) =>
    db.select().from(escrows).where(eq(escrows.contractAddress, address)).all() as EscrowRow[];

  const lookups: Array<[SettlementLinkBasis, EscrowRow[]]> = [];
  const sessionAddress = nonEmpty(session?.escrowAddress);
  const sessionCwm = nonEmpty(session?.cwmId);
  const jobCwm = nonEmpty(job.cwmId);
  if (sessionAddress) lookups.push(["negotiation_session_escrow_address", byAddress(sessionAddress)]);
  if (sessionCwm) lookups.push(["negotiation_session_cwm", byCwm(sessionCwm)]);
  if (jobCwm) lookups.push(["job_cwm", byCwm(jobCwm)]);

  for (const [basis, rows] of lookups) {
    if (rows.length > 1) return { link: "ambiguous", basis, candidates: rows.length };
  }
  const found = new Map<string, EscrowRow>();
  for (const [, rows] of lookups) for (const r of rows) found.set(r.id, r);
  if (found.size === 0) return { link: "not_linked" };
  if (found.size > 1) return { link: "conflicting", reason: "the recorded identifiers point at different escrow records" };

  const escrow = [...found.values()][0]!;
  if (sessionAddress && escrow.contractAddress !== sessionAddress) {
    return { link: "conflicting", reason: "the escrow found does not have the address the negotiation session recorded" };
  }
  if (sessionCwm && nonEmpty(escrow.cwmId) !== sessionCwm) {
    return { link: "conflicting", reason: "the escrow found does not have the CWM id the negotiation session recorded" };
  }
  if (session && !sessionAddress && !sessionCwm) {
    return { link: "conflicting", reason: "the negotiation session records no escrow, yet the job's CWM matches one" };
  }

  const matches = lookups.filter(([, rows]) => rows.some((r) => r.id === escrow.id)).map(([b]) => b);
  const basis = BASIS_STRENGTH.find((b) => matches.includes(b))!;
  return {
    link: "linked",
    basis,
    matches,
    escrow,
    milestones: repos.escrows.findMilestonesByEscrow(escrow.id) as MilestoneRow[],
    stepClaimants: countStepClaimants(job, escrow, repos, db),
  };
}

/**
 * How many jobs could claim a milestone for `job`'s step in `escrow`, `job` included. A
 * milestone records only its escrow and its step, never a job, so every job tied to the same
 * escrow with the same step is a candidate: jobs carrying the escrow's CWM, and jobs whose
 * negotiation session names the escrow (by contract address or CWM). Jobs on other steps of
 * the same CWM are not candidates: one escrow per CWM with one milestone per step is the V2
 * schema.
 */
function countStepClaimants(
  job: JobRow,
  escrow: EscrowRow,
  repos: Pick<JobExecutionRepos, "jobs">,
  db: JobExecutionDb,
): number {
  const { jobs, negotiationSessions } = schema;
  const claimants = new Set<string>([job.id]);
  const cwm = nonEmpty(escrow.cwmId);
  if (cwm) {
    const sameStep = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.cwmId, cwm), eq(jobs.stepId, job.stepId)))
      .all() as Array<{ id: string }>;
    for (const j of sameStep) claimants.add(j.id);
  }
  const naming = db
    .select()
    .from(negotiationSessions)
    .where(
      cwm
        ? or(eq(negotiationSessions.escrowAddress, escrow.contractAddress), eq(negotiationSessions.cwmId, cwm))
        : eq(negotiationSessions.escrowAddress, escrow.contractAddress),
    )
    .all() as Array<{ jobId: string | null }>;
  for (const session of naming) {
    const id = nonEmpty(session.jobId);
    if (!id || claimants.has(id)) continue;
    const other = repos.jobs.findById(id) as { stepId?: string } | undefined;
    if (other && other.stepId === job.stepId) claimants.add(id);
  }
  return claimants.size;
}

// ── Object authorization ──────────────────────────────────────────────────────

/** Who is asking, as the API gate resolved it. */
export interface JobReadCaller {
  /** True when the API gate accepted a credential (an API key or a session). */
  authenticated: boolean;
  /**
   * The caller's PROVEN wallet (lowercase), or null. Only a SIWE signature proves one: the
   * API gate sets it (WP-A #326, `req.provenWallet`) for a SIWE session and for an API key
   * minted from one. An API key's operatorId or an email is never used here: self-service
   * provisioning lets anyone claim those (cross-family review r3 of #353, P1-5).
   */
  provenWallet: string | null;
  /** The raw X-Admin-Key header, when sent. */
  adminKey?: string | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The caller, from what the API gate set on the request. */
export function jobReadCallerOf(req: { headers: Record<string, unknown> }): JobReadCaller {
  const r = req as { operatorId?: unknown; userId?: unknown; provenWallet?: unknown };
  const principal = r.operatorId ?? r.userId;
  const proven = typeof r.provenWallet === "string" && ADDRESS.test(r.provenWallet) ? r.provenWallet.toLowerCase() : null;
  const adminHeader = req.headers["x-admin-key"];
  return {
    authenticated: proven !== null || (typeof principal === "string" && principal.trim() !== ""),
    provenWallet: proven,
    adminKey: typeof adminHeader === "string" ? adminHeader : null,
  };
}

/**
 * The checks that need no job. They run BEFORE the job is read, so a refusal is the same
 * for every job id, existing or not (P1-5: an anonymous request used to get 404 for a missing
 * job and 401 for an existing one).
 *   valid X-Admin-Key               -> proceed as admin
 *   no credential                   -> refuse: unauthenticated (401)
 *   a credential, no proven wallet  -> refuse: identity_unverified (403)
 *   a proven wallet                 -> proceed; authorizeJobRead decides against the job
 * Before WP-A (#326) sets `provenWallet`, no caller has one, so only an admin reads: this
 * fails closed rather than trusting a self-asserted id.
 */
export type JobReadPrecheck =
  | { proceed: true; as: "admin" }
  | { proceed: true; as: "proven"; wallet: string }
  | { proceed: false; reason: "unauthenticated" | "identity_unverified" };

export function precheckJobRead(caller: JobReadCaller): JobReadPrecheck {
  if (hasValidAdminKey(caller.adminKey)) return { proceed: true, as: "admin" };
  if (!caller.authenticated) return { proceed: false, reason: "unauthenticated" };
  if (!caller.provenWallet) return { proceed: false, reason: "identity_unverified" };
  return { proceed: true, as: "proven", wallet: caller.provenWallet };
}

/** The response bodies for a refused precheck. */
export const JOB_READ_REFUSAL: Readonly<Record<"unauthenticated" | "identity_unverified", { status: 401 | 403; body: { error: string; message: string } }>> =
  Object.freeze({
    unauthenticated: {
      status: 401,
      body: { error: "unauthenticated", message: "Sign in or send an API key to read a job." },
    },
    identity_unverified: {
      status: 403,
      body: {
        error: "identity_unverified",
        message:
          "A job's records are shown only to a proven identity: sign in with a wallet (SIWE), or use an API key " +
          "minted from a wallet session. An email or a self-declared operator id is not proof.",
      },
    },
  });

export type JobReadDecision =
  | { allow: true; as: "kernel_operator" | "buyer" }
  | { allow: false; reason: "not_a_party" };

/**
 * True only when PCC_ADMIN_KEY is set to a value that is not empty or whitespace-only
 * and the header equals it exactly (constant-time; neither side is trimmed). There is
 * no development bypass: an unset, empty or whitespace-only key grants nothing.
 */
export function hasValidAdminKey(provided: unknown, expected: string | undefined = process.env.PCC_ADMIN_KEY): boolean {
  if (typeof expected !== "string" || expected.trim().length === 0 || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sameWallet = (recorded: unknown, wallet: string) =>
  typeof recorded === "string" && ADDRESS.test(recorded.trim()) && recorded.trim().toLowerCase() === wallet;

/**
 * May this PROVEN wallet read this job's execution, evidence and money? Only when it is:
 *   - the job's kernel operator: the kernel's operatorAddress, which the gateway records
 *     from the registering caller, not from the request body; or
 *   - the job's recorded buyer: the userAgentId of the job's single negotiation session.
 * Both are compared as addresses. A recorded operator or buyer that is not an address (an
 * email, a label) never matches, since no signature proves those. Anyone else is refused,
 * whatever the tenant flag says.
 *
 * Limit (stated, not hidden): the buyer is the userAgentId that the session's creator
 * supplied. The session records no proven creator. Jobs without a negotiation session
 * record no buyer at all, so only their operator and admins can read them here.
 */
export function authorizeJobRead(
  job: JobRow,
  wallet: string,
  repos: Pick<JobExecutionRepos, "kernels">,
  db: JobExecutionDb,
): JobReadDecision {
  const kernel = repos.kernels.findById(job.kernelId) as { operatorAddress?: string } | undefined;
  if (kernel && sameWallet(kernel.operatorAddress, wallet)) return { allow: true, as: "kernel_operator" };

  const { negotiationSessions } = schema;
  const sessions = db
    .select()
    .from(negotiationSessions)
    .where(eq(negotiationSessions.jobId, job.id))
    .all() as Array<{ userAgentId: string | null }>;
  if (sessions.length === 1 && sameWallet(sessions[0]!.userAgentId, wallet)) return { allow: true, as: "buyer" };

  return { allow: false, reason: "not_a_party" };
}

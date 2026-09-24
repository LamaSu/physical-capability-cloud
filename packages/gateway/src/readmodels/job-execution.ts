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
 *                  money map (completed is not paid; a mock escrow is never paid)
 *
 * A failed read becomes `unavailable` with a generic error. It never becomes an empty
 * list or a default, because absence is not evidence.
 */

import {
  JOB_EXECUTION_SCHEMA_ID,
  JOB_EXECUTION_EVIDENCE_LIMIT,
  classifyMoneyStatus,
  executionPhaseOf,
  isFabricated,
  isTerminalExecutionPhase,
  normalizeJobRowStatus,
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
import { schema, eq } from "@pcc/store";

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
  | { link: "ambiguous"; basis: SettlementLinkBasis; candidates: number }
  | { link: "linked"; basis: SettlementLinkBasis; escrow: EscrowRow; milestones: MilestoneRow[] };

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

/** Tone -> payout, for a REAL (non-simulated) record. Unknown tones stay unknown. */
function payoutOf(view: MoneyStateView): PayoutState {
  switch (view.tone) {
    case "settled":
      return "paid";
    case "refunded":
      return "refunded";
    case "waiting":
    case "running":
    case "failed":
      return "not_paid";
    default:
      return "unknown";
  }
}

function buildSettlement(job: JobRow, read: SourceRead<SettlementSource>): SettlementAxis {
  const base = { source: "gateway_escrow_record" as const };
  if (!read.ok) {
    return {
      ...base,
      link: "unavailable",
      linkBasis: null,
      record: null,
      payout: "unknown",
      payoutBasis: null,
      error: READ_FAILED("settlement store"),
    };
  }
  const s = read.value;
  if (s.link === "not_linked") {
    return { ...base, link: "not_linked", linkBasis: null, record: null, payout: "unknown", payoutBasis: null, error: null };
  }
  if (s.link === "ambiguous") {
    return { ...base, link: "ambiguous", linkBasis: s.basis, record: null, payout: "unknown", payoutBasis: null, error: null };
  }

  const escrow = s.escrow;
  const simulated = String(escrow.contractAddress ?? "").startsWith(MOCK_ESCROW_ADDRESS_PREFIX);
  const mine = s.milestones.filter((m) => m.stepId === job.stepId);
  const milestoneMatch: SettlementRecordView["milestoneMatch"] =
    mine.length === 1
      ? "exact"
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
  };

  // Payout: the job's own milestone. The whole escrow's status is used ONLY when the
  // escrow records no milestones at all (a single payment). When milestones exist but
  // none is this job's step, other steps' releases say nothing about this job: unknown.
  // An ambiguous match or a mock escrow is never read as payment.
  let payout: PayoutState;
  let payoutBasis: SettlementAxis["payoutBasis"];
  if (simulated) {
    payout = "simulated";
    payoutBasis = null;
  } else if (record.milestone) {
    payout = payoutOf(record.milestone.status);
    payoutBasis = "milestone_record";
  } else if (milestoneMatch === "no_milestones") {
    payout = payoutOf(record.escrow);
    payoutBasis = "escrow_record";
  } else {
    payout = "unknown";
    payoutBasis = null;
  }

  return { ...base, link: "linked", linkBasis: s.basis, record, payout, payoutBasis, error: null };
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
    findByContractAddress(address: string): unknown;
    findMilestonesByEscrow(escrowId: string): unknown[];
  };
}

/** Drizzle db handle (better-sqlite3), for the two reads the repositories do not offer. */
export interface JobExecutionDb {
  select(): any;
}

export interface JobExecutionLoadOptions {
  /** From tenantOpts(req): undefined = no tenant filter; otherwise rows must match. */
  tenant?: { tenantId: string | null };
  /** Called with the source name and error when a read fails, for the gateway log. */
  onReadError?: (source: string, error: unknown) => void;
}

/**
 * Read every source for one job. Returns null when the job does not exist, or is not
 * visible to the caller's tenant. Throws only when the job row itself cannot be read.
 */
export function loadJobExecutionSources(
  jobId: string,
  repos: JobExecutionRepos,
  db: JobExecutionDb,
  opts: JobExecutionLoadOptions = {},
): JobExecutionSources | null {
  const job = repos.jobs.findById(jobId) as JobRow | undefined;
  if (!job) return null;
  if (opts.tenant && (job.tenantId ?? null) !== opts.tenant.tenantId) return null;

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
    evidence: attempt("evidence", () => {
      const bundles = repos.evidence.findByJob(job.id, opts.tenant) as Array<Omit<EvidenceBundleRow, "events">>;
      return bundles.map((b) => ({
        ...b,
        events: repos.evidence.findEventsByBundle(b.id) as EvidenceBundleRow["events"],
      }));
    }),
    captureVerdicts: attempt("capture_verdicts", () => repos.evidence.findCaptureVerdictsByJob(job.id) as CaptureVerdictRow[]),
    settlement: attempt("settlement", () => resolveSettlement(job, repos, db)),
  };
}

/**
 * Tie the job to its escrow record the same way the paid-job flow does (negotiation
 * session -> cwmId -> escrow; milestone by stepId), falling back to the job's own cwmId
 * and then to the session's escrow address. More than one candidate is `ambiguous`:
 * nothing is chosen.
 */
function resolveSettlement(job: JobRow, repos: JobExecutionRepos, db: JobExecutionDb): SettlementSource {
  const { negotiationSessions, escrows } = schema;
  const sessions = db
    .select()
    .from(negotiationSessions)
    .where(eq(negotiationSessions.jobId, job.id))
    .all() as Array<{ cwmId: string | null; escrowAddress: string | null }>;
  if (sessions.length > 1) {
    return { link: "ambiguous", basis: "negotiation_session_cwm", candidates: sessions.length };
  }
  const session = sessions[0];

  const byCwm = (cwmId: string) =>
    db.select().from(escrows).where(eq(escrows.cwmId, cwmId)).all() as EscrowRow[];

  const tries: Array<[SettlementLinkBasis, () => EscrowRow[]]> = [];
  if (session?.cwmId) tries.push(["negotiation_session_cwm", () => byCwm(session.cwmId!)]);
  if (job.cwmId) tries.push(["job_cwm", () => byCwm(job.cwmId)]);
  if (session?.escrowAddress) {
    tries.push([
      "negotiation_session_escrow_address",
      () => {
        const e = repos.escrows.findByContractAddress(session.escrowAddress!) as EscrowRow | undefined;
        return e ? [e] : [];
      },
    ]);
  }

  for (const [basis, find] of tries) {
    const found = find();
    if (found.length > 1) return { link: "ambiguous", basis, candidates: found.length };
    if (found.length === 1) {
      const escrow = found[0]!;
      return {
        link: "linked",
        basis,
        escrow,
        milestones: repos.escrows.findMilestonesByEscrow(escrow.id) as MilestoneRow[],
      };
    }
  }
  return { link: "not_linked" };
}

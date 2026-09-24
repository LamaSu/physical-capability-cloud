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
 * Reading a job is object-authorized (authorizeJobRead): admin, the job's kernel
 * operator, or its recorded buyer. Everyone else gets a 404, independent of the tenant
 * flag.
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
  const { recordsConflict, ...settlement } = buildSettlement(src.job, src.settlement);

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
    notices: buildNotices(src.job, execution, evidence, settlement, recordsConflict),
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
/** Escrow words (escrows.status) that claim everything in the escrow was released. */
const ESCROW_ALL_RELEASED = new Set(["COMPLETED", "RELEASED", "SETTLED_RELEASED"]);

/**
 * The payout for a REAL (non-simulated) record: this job's milestone status, reconciled
 * with the escrow's own status. Both are exact words from the gateway's escrow tables (their
 * source schema), so the words are read here, not only their display tone: under PX-1 a
 * bare "released" is a waiting tone, and that must not turn a release claim into "not paid".
 * A combination the two records cannot both be true for is a conflict, and a conflict is
 * `unknown`.
 *
 *   milestone released  + escrow refunded/disputed/slashed/unrecognized -> conflict
 *   milestone released  + anything else                  -> reported_released (never paid)
 *   milestone refunded  + escrow says everything released -> conflict
 *   milestone unreleased + escrow says everything released -> conflict
 *   milestone "completed" (ambiguous for a milestone)      -> unknown
 *   either status unrecognized                             -> unknown
 */
export function reconcilePayout(
  milestone: MoneyStateView,
  escrow: MoneyStateView,
): { payout: Exclude<PayoutState, "simulated" | "paid">; conflict: boolean } {
  if (!milestone.known || !escrow.known || milestone.tone === "unknown" || escrow.tone === "unknown") {
    return { payout: "unknown", conflict: false };
  }
  const m = normalizeMoneyStatus(milestone.sourceStatus);
  const escrowAllReleased = ESCROW_ALL_RELEASED.has(normalizeMoneyStatus(escrow.sourceStatus));
  const escrowAgainstRelease = escrow.tone === "refunded" || escrow.tone === "failed";
  if (MILESTONE_AMBIGUOUS.has(m)) return { payout: "unknown", conflict: false };
  if (MILESTONE_RELEASED.has(m)) {
    return escrowAgainstRelease ? { payout: "unknown", conflict: true } : { payout: "reported_released", conflict: false };
  }
  if (milestone.tone === "refunded") {
    return escrowAllReleased ? { payout: "unknown", conflict: true } : { payout: "refunded", conflict: false };
  }
  // Not released (waiting / running / failed): this job's money has not been released.
  return escrowAllReleased ? { payout: "unknown", conflict: true } : { payout: "not_paid", conflict: false };
}

function buildSettlement(
  job: JobRow,
  read: SourceRead<SettlementSource>,
): SettlementAxis & { recordsConflict: boolean } {
  const empty = {
    source: "gateway_escrow_record" as const,
    linkBasis: null,
    linkMatches: [] as SettlementLinkBasis[],
    record: null,
    payout: "unknown" as const,
    payoutBasis: null,
    payoutConfirmation: null,
    error: null,
    recordsConflict: false,
  };
  if (!read.ok) return { ...empty, link: "unavailable", error: READ_FAILED("settlement store") };
  const s = read.value;
  if (s.link !== "linked") return { ...empty, link: s.link };

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
    // The escrow record stores no time for its current statuses.
    statusObservedAt: null,
  };

  // Payout comes ONLY from this job's own milestone, reconciled with the escrow's status.
  // No milestone for this job (none recorded, not this step, or several) is unknown: an
  // escrow-level status can cover several jobs and never proves this job's payment.
  let payout: PayoutState = "unknown";
  let payoutBasis: SettlementAxis["payoutBasis"] = null;
  let recordsConflict = false;
  if (simulated) {
    payout = "simulated";
  } else if (record.milestone) {
    const r = reconcilePayout(record.milestone.status, record.escrow);
    payout = r.payout;
    recordsConflict = r.conflict;
    payoutBasis = "milestone_record";
  }

  return {
    source: "gateway_escrow_record",
    link: "linked",
    linkBasis: s.basis,
    linkMatches: s.matches,
    record,
    payout,
    payoutBasis,
    payoutConfirmation: payout === "reported_released" || payout === "refunded" ? "record_only" : null,
    error: null,
    recordsConflict,
  };
}

function buildNotices(
  job: JobRow,
  execution: ExecutionAxis,
  evidence: EvidenceAxis,
  settlement: SettlementAxis,
  recordsConflict: boolean,
): JobExecutionNoticeCode[] {
  const notices: JobExecutionNoticeCode[] = [];
  const raw = normalizeJobRowStatus(job.status);
  if (raw === "settled") notices.push("job_row_reports_settled");
  if (raw === "disputed") notices.push("job_row_reports_dispute");
  if (execution.phase === "unknown") notices.push("unknown_execution_status");
  if ((evidence.fabricatedEventCount ?? 0) > 0) notices.push("fabricated_evidence");
  if (settlement.record?.simulated) notices.push("simulated_settlement");
  if (recordsConflict) notices.push("settlement_records_conflict");
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
export function resolveSettlement(job: JobRow, repos: Pick<JobExecutionRepos, "escrows">, db: JobExecutionDb): SettlementSource {
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
  };
}

// ── Object authorization ──────────────────────────────────────────────────────

/** Who is asking, as the API gate resolved it. */
export interface JobReadCaller {
  /** The API key's operator id, or the SIWE wallet address. Null when anonymous. */
  principal: string | null;
  /** The raw X-Admin-Key header, when sent. */
  adminKey?: string | null;
}

export type JobReadDecision =
  | { allow: true; as: "admin" | "kernel_operator" | "buyer" }
  | { allow: false; reason: "unauthenticated" | "not_a_party" };

/**
 * True only when PCC_ADMIN_KEY is set and the header equals it (constant-time). There is
 * no development bypass: an unset key grants nothing.
 */
export function hasValidAdminKey(provided: unknown, expected: string | undefined = process.env.PCC_ADMIN_KEY): boolean {
  if (typeof expected !== "string" || expected.length === 0 || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const samePrincipal = (a: unknown, b: string) =>
  typeof a === "string" && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * May this caller read this job's execution, evidence and money? Only:
 *   - an admin (valid X-Admin-Key),
 *   - the job's kernel operator (the kernel's operatorAddress is the caller), or
 *   - the job's recorded buyer (the negotiation session's userAgentId is the caller).
 * Anyone else is refused, whatever the tenant flag says.
 *
 * Limits (stated, not hidden): the caller principal is the API key's operatorId, which
 * self-service provisioning does not yet bind to a proven identity (board N2, gateway);
 * the buyer is recorded only as the session's userAgentId, which the session creator
 * supplied. Jobs submitted without a negotiation session record no buyer at all, so only
 * their operator and admins can read them here.
 */
export function authorizeJobRead(
  job: JobRow,
  caller: JobReadCaller,
  repos: Pick<JobExecutionRepos, "kernels">,
  db: JobExecutionDb,
): JobReadDecision {
  if (hasValidAdminKey(caller.adminKey)) return { allow: true, as: "admin" };
  const principal = caller.principal;
  if (!principal || principal.trim() === "") return { allow: false, reason: "unauthenticated" };

  const kernel = repos.kernels.findById(job.kernelId) as { operatorAddress?: string } | undefined;
  if (kernel && samePrincipal(kernel.operatorAddress, principal)) return { allow: true, as: "kernel_operator" };

  const { negotiationSessions } = schema;
  const sessions = db
    .select()
    .from(negotiationSessions)
    .where(eq(negotiationSessions.jobId, job.id))
    .all() as Array<{ userAgentId: string | null }>;
  if (sessions.length === 1 && samePrincipal(sessions[0]!.userAgentId, principal)) return { allow: true, as: "buyer" };

  return { allow: false, reason: "not_a_party" };
}

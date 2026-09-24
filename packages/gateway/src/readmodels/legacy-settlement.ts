/**
 * The two legacy settlement reads, GET /api/settlement/:jobId and
 * GET /api/jobs/:jobId/settlement, as projections of JobExecutionDTO's settlement axis
 * (PX-6). Both now report only what the job's own escrow records show, through the same
 * resolver and payout rule as GET /api/jobs/:jobId/execution, so the three surfaces cannot
 * disagree about money.
 *
 * What they used to claim (readmodels finding F1, reproduced against real local state):
 *   - "settled" whenever the JOB ROW said completed or settled, whatever the money did;
 *   - a mock-settlement escrow reported as settled, with its total as `paidAmount`;
 *   - `paidAmount` = the escrow total or the quote, never an amount the records show released;
 *   - a currency of "USDC" when nothing recorded one;
 *   - `settledAt` = the job's completion time;
 *   - the escrow read through the FIRST negotiation session and its CWM, with no check
 *     that the recorded identifiers agree.
 */
import type { FastifyRequest } from "fastify";
import {
  normalizeJobRowStatus,
  type JobExecutionDTO,
  type JobExecutionNoticeCode,
  type PayoutState,
  type SettlementAxis,
  type SettlementLink,
} from "@pcc/spec";
import { schema, eq } from "@pcc/store";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import { gateJobRead } from "./job-read-gate.js";
import {
  buildJobExecutionDTO,
  loadJobExecutionSources,
  type EvidenceBundleRow,
  type JobExecutionRepos,
  type JobExecutionSources,
  type JobRow,
} from "./job-execution.js";

/** A job row as the legacy reads use it (the read-model row plus the recorded bundle id). */
export interface LegacyJobRow {
  id: string;
  stepId: string;
  status: string;
  evidenceBundleId?: string | null;
}

/** A negotiation session as recorded (only the fields these reads return). */
export interface LegacySessionRow {
  id: string;
  capabilityType?: string | null;
  committedAt?: string | null;
  escrowAddress?: string | null;
  quote?: unknown;
}

/** One milestone row of the linked escrow, as stored. */
interface MilestoneRecord {
  id: string;
  stepId: string;
  amount: string;
  status: string;
  bondAmount?: string | null;
  evidenceBundleHash?: string | null;
  challengeWindowStart?: string | null;
  challengeWindowEnd?: string | null;
}

/** Escrow record statuses the paid-job flow writes for money that is held. */
const HELD_ESCROW_STATUSES = new Set(["funded", "active"]);

/**
 * Where this job's money stands, as its records show it. Money states come only from the
 * settlement axis; the job row only places a job whose money is recorded and not released
 * (or has no record) in its pipeline stage.
 *
 *   unavailable            the settlement records could not be read
 *   unknown                the records cannot say: an ambiguous or conflicting link, no
 *                          milestone for this job, or statuses that contradict each other
 *   simulated              a mock-settlement escrow: no real money exists for this job
 *   settled                a settlement read model confirms this job's release (payout
 *                          "paid"). The gateway's escrow records never do (PX-1, steward
 *                          #2490), so today no job reads settled.
 *   reported_released      this job's milestone record says released; no settlement read
 *                          confirms it (on a V-next escrow it can mean allocated, not paid)
 *   refunded               this job's milestone record says refunded
 *   funded                 job pending; its escrow record says funded or active
 *   awaiting_settlement    job reported complete; its milestone is recorded and not released
 *   no_settlement_record   job reported complete; no escrow record is linked to it
 *   pending | executing | evidence_submitted | cancelled
 *                          the job's stage while its money is held or unrecorded
 *   anything else          the job row's own status, unchanged
 */
export function legacySettlementStatus(dto: JobExecutionDTO): string {
  const s = dto.settlement;
  if (s.link === "unavailable") return "unavailable";
  if (s.link === "ambiguous" || s.link === "conflicting") return "unknown";
  if (s.record?.simulated) return "simulated";
  if (s.payout === "paid") return "settled";
  if (s.payout === "reported_released") return "reported_released";
  if (s.payout === "refunded") return "refunded";
  if (s.link === "linked" && s.payout !== "not_paid") return "unknown";

  // Not linked, or linked with this job's own milestone recorded and not released.
  const row = normalizeJobRowStatus(dto.execution.sourceStatus);
  switch (row) {
    case "pending":
      return s.record && HELD_ESCROW_STATUSES.has(normalizeJobRowStatus(s.record.escrow.sourceStatus))
        ? "funded"
        : "pending";
    case "active":
    case "executing":
    case "queued":
    case "preparing":
      return "executing";
    case "evidence_stored":
    case "evidence_submitted":
    case "collecting_evidence":
      return "evidence_submitted";
    case "completed":
    case "settled":
      return s.link === "linked" ? "awaiting_settlement" : "no_settlement_record";
    case "failed":
    case "cancelled":
      return "cancelled";
    default:
      return dto.execution.sourceStatus;
  }
}

/** Notices about money, carried over from the execution read model. */
const SETTLEMENT_NOTICES: ReadonlySet<JobExecutionNoticeCode> = new Set<JobExecutionNoticeCode>([
  "job_row_reports_settled",
  "simulated_settlement",
  "settlement_records_conflict",
  "settlement_row_conflict",
  "settlement_link_conflict",
]);

/** The fields both legacy reads share: the money claim, stated with its basis. */
export interface LegacySettlementClaim {
  status: string;
  /** The job row's own status, as recorded. */
  jobStatus: string;
  /**
   * True only when a settlement read model confirms this job's release (payout "paid").
   * The gateway's escrow records never do: a recorded release is status reported_released.
   */
  settled: boolean;
  /** The escrow record keeps no release time, so none is reported. */
  settledAt: null;
  payout: PayoutState;
  payoutBasis: SettlementAxis["payoutBasis"];
  payoutConfirmation: SettlementAxis["payoutConfirmation"];
  /** A mock-settlement escrow: nothing on this record is real money. */
  simulated: boolean;
  settlementLink: SettlementLink;
  notices: JobExecutionNoticeCode[];
  /** Sources that could not be read; their fields are null, never defaulted. */
  unavailable: string[];
  /** When the gateway read these records (ISO-8601). */
  asOf: string;
}

function claimOf(dto: JobExecutionDTO, unavailable: string[]): LegacySettlementClaim {
  const s = dto.settlement;
  return {
    status: legacySettlementStatus(dto),
    jobStatus: dto.execution.sourceStatus,
    settled: s.payout === "paid",
    settledAt: null,
    payout: s.payout,
    payoutBasis: s.payoutBasis,
    payoutConfirmation: s.payoutConfirmation,
    simulated: s.record?.simulated === true,
    settlementLink: s.link,
    notices: dto.notices.filter((n) => SETTLEMENT_NOTICES.has(n)),
    unavailable,
    asOf: dto.asOf,
  };
}

function latestBundle(read: JobExecutionSources["evidence"]): EvidenceBundleRow | null {
  if (!read.ok || read.value.length === 0) return null;
  // Same pick as before: the last bundle the evidence repository returns for the job.
  return read.value[read.value.length - 1] ?? null;
}

function unavailableSources(src: JobExecutionSources, extra: string[] = []): string[] {
  const out: string[] = [];
  if (!src.settlement.ok) out.push("settlement");
  if (!src.evidence.ok) out.push("evidence");
  return [...out, ...extra];
}

/** GET /api/settlement/:jobId */
export function buildSettlementStatusRead(
  job: LegacyJobRow,
  src: JobExecutionSources,
  dto: JobExecutionDTO,
) {
  const bundle = latestBundle(src.evidence);
  return {
    jobId: job.id,
    ...claimOf(dto, unavailableSources(src)),
    evidenceBundleId: bundle?.id ?? job.evidenceBundleId ?? null,
    evidenceHash: bundle?.bundleHash ?? null,
    assuranceTier: bundle?.assuranceTier ?? null,
  };
}

/** What the caller knows about the job's negotiation session(s). */
export type SessionRead =
  | { ok: true; sessions: LegacySessionRow[] }
  | { ok: false };

/** GET /api/jobs/:jobId/settlement */
export function buildJobSettlementRead(
  job: LegacyJobRow,
  src: JobExecutionSources,
  dto: JobExecutionDTO,
  sessionRead: SessionRead,
) {
  const s = dto.settlement;
  // A session's recorded fields are shown only when exactly one session names the job;
  // with several, which one applies is unknown (the settlement link says "ambiguous").
  const session = sessionRead.ok && sessionRead.sessions.length === 1 ? sessionRead.sessions[0]! : null;
  const quote = session?.quote && typeof session.quote === "object" ? (session.quote as Record<string, unknown>) : null;
  const linked = src.settlement.ok && src.settlement.value.link === "linked" ? src.settlement.value : null;
  const bundle = latestBundle(src.evidence);
  const milestone = s.record?.milestone ?? null;
  const quotedCurrency = typeof quote?.currency === "string" && quote.currency.trim() !== "" ? quote.currency : null;
  const quotedAmount = quote?.totalPrice == null ? null : String(quote.totalPrice);

  return {
    jobId: job.id,
    ...claimOf(dto, unavailableSources(src, sessionRead.ok ? [] : ["negotiation_session"])),
    escrowAddress: session?.escrowAddress ?? null,
    evidenceHash: bundle?.bundleHash ?? null,
    evidenceBundleId: bundle?.id ?? job.evidenceBundleId ?? null,
    // Every milestone of the linked escrow record; an escrow covers all steps of one CWM.
    milestones: linked
      ? (linked.milestones as unknown as MilestoneRecord[]).map((ms) => ({
          id: ms.id,
          stepId: ms.stepId,
          forThisJob: ms.stepId === job.stepId,
          amount: ms.amount,
          bondAmount: ms.bondAmount ?? null,
          status: ms.status,
          evidenceBundleHash: ms.evidenceBundleHash ?? null,
          challengeWindowStart: ms.challengeWindowStart ?? null,
          challengeWindowEnd: ms.challengeWindowEnd ?? null,
        }))
      : [],
    // Only a confirmed release's amount; never the escrow total or the quote.
    paidAmount: s.payout === "paid" && milestone ? milestone.amount : null,
    /** This job's milestone amount when its record says released, unconfirmed: not a payment. */
    reportedReleasedAmount: s.payout === "reported_released" && milestone ? milestone.amount : null,
    /** The price quoted in the negotiation session: a quote, not a payment. */
    quotedAmount,
    currency: linked ? linked.escrow.currency : quotedCurrency,
    escrow: linked
      ? {
          id: linked.escrow.id,
          contractAddress: linked.escrow.contractAddress,
          totalAmount: linked.escrow.totalAmount,
          currency: linked.escrow.currency,
          escrowStatus: linked.escrow.status,
          deadline: linked.escrow.deadline,
          simulated: s.record?.simulated === true,
        }
      : null,
    session: session
      ? { id: session.id, capabilityType: session.capabilityType ?? null, committedAt: session.committedAt ?? null }
      : null,
  };
}

// ── Loading (shared by both routes) ──────────────────────────────────────────

export type LegacySettlementLoad =
  | {
      kind: "ok";
      job: JobRow & LegacyJobRow;
      sources: JobExecutionSources;
      dto: JobExecutionDTO;
      sessions: SessionRead;
    }
  | { kind: "not_found" }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

/**
 * Read one job's records for a legacy settlement read. The job read gate runs first (F3):
 * a failed read is `unavailable`, an anonymous caller `unauthenticated`, and a missing
 * job, another tenant's, or one the caller is not a party to is `not_found`. Then the same
 * sources as the execution read model. The read time is taken before any read.
 */
export function loadLegacySettlement(
  req: FastifyRequest,
  jobId: string,
  opts: { sessions?: boolean } = {},
): LegacySettlementLoad {
  const asOf = new Date().toISOString();
  const gate = gateJobRead(req, jobId);
  if (!gate.ok) return { kind: gate.kind };
  const job = gate.job as JobRow & LegacyJobRow;
  const store = getStore();
  const tenant = tenantOpts(req as any);

  const onReadError = (source: string, error: unknown) =>
    req.log.warn({ jobId, source, err: error }, "legacy settlement read: source read failed");
  // The job's tenant was checked above; its evidence is read through the job (#353 @938a180e).
  const sources = loadJobExecutionSources(job, store.repos as unknown as JobExecutionRepos, store.db, { onReadError });
  const dto = buildJobExecutionDTO(sources, asOf);

  let sessions: SessionRead = { ok: true, sessions: [] };
  if (opts.sessions) {
    try {
      const { negotiationSessions } = schema;
      sessions = {
        ok: true,
        sessions: store.db
          .select()
          .from(negotiationSessions)
          .where(eq(negotiationSessions.jobId, job.id))
          .all() as LegacySessionRow[],
      };
    } catch (error) {
      onReadError("negotiation_session", error);
      sessions = { ok: false };
    }
  }
  return { kind: "ok", job, sources, dto, sessions };
}

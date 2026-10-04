/**
 * OperatorWorkDTO and OperatorIncomeDTO (@pcc/spec readmodels/operator-work.ts): the loader
 * (one pass over the store and the job-offers store) and the pure builders.
 *
 * Scope: the caller's kernels, i.e. kernels whose recorded operatorAddress is the caller's
 * PROVEN wallet (SIWE; the route passes req.provenWallet), compared as addresses as in
 * authorizeJobRead. A recorded operator that is not an address (an email) never matches, since
 * no signature proves it (#353 review r3, P1-5).
 */
import {
  JOB_OFFER_PHASE_MAP,
  KERNEL_JOB_PHASE_MAP,
  OPERATOR_INCOME_SCHEMA_ID,
  OPERATOR_WORK_SCHEMA_ID,
  currencyDecimals,
  executionPhaseOf,
  isTerminalExecutionPhase,
  normalizeJobRowStatus,
  normalizeMoneyStatus,
  operatorPhaseOf,
  toBaseUnits,
  type OperatorIncomeDTO,
  type OperatorIncomeRow,
  type OperatorIncomeTotal,
  type OperatorWorkAction,
  type OperatorWorkDTO,
  type OperatorWorkEvidence,
  type OperatorWorkItem,
  type OperatorWorkLocation,
  type OperatorWorkPay,
  type OperatorWorkPhase,
  type OperatorWorkSource,
  type OperatorWorkSourceState,
  type PayoutState,
  type SettlementAxis,
} from "@pcc/spec";
import { createHash } from "node:crypto";
import { schema, eq, and } from "@pcc/store";
import type { JobOffer, JobOfferEvent } from "../services/job-offers-store.js";
import { extractRequirementsCoords } from "../services/job-offers-store.js";
import {
  buildSettlementAxis,
  resolveSettlement,
  type JobExecutionDb,
  type JobExecutionRepos,
  type JobRow,
  type SourceRead,
} from "./job-execution.js";

// ── Source shapes (structural) ───────────────────────────────────────────────

export interface KernelLite {
  id: string;
  name?: string | null;
  operatorAddress?: string | null;
  location?: { lat?: unknown; lng?: unknown } | null;
}

export interface CapabilityLite {
  id: string;
  kernelId: string;
  type: string;
  name?: string | null;
}

export interface ApprovalRow {
  id: string;
  kernelId: string;
  jobId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  jobSummary?: Record<string, unknown> | null;
}

export interface KernelJobSource {
  job: JobRow;
  /** This job's settlement axis, from the same resolver as the execution read model. */
  settlement: SettlementAxis;
  /**
   * The disputes recorded on this job's milestone in its linked escrow (review r2 of #389,
   * HIGH): an open one contests the money. Empty when the job has no linked escrow record.
   */
  disputes: SourceRead<DisputeLite[]>;
}

/** A dispute row (disputes table), as the funding decision reads it. */
export interface DisputeLite {
  escrowId: string;
  milestoneStepId: string;
  status: string;
}

export interface OperatorWorkSources {
  kernels: KernelLite[];
  capabilities: SourceRead<CapabilityLite[]>;
  kernelJobs: SourceRead<KernelJobSource[]>;
  approvals: SourceRead<ApprovalRow[]>;
  /** Job offers are kept in process memory by the gateway (write-through, best effort). */
  claimedOffers: SourceRead<Array<{ offer: JobOffer; events: JobOfferEvent[] }>>;
  openOffers: SourceRead<JobOffer[]>;
}

/** What the job-offers store must offer this read model. */
export interface OffersReader {
  listOpen(filters?: { capabilityType?: string }): JobOffer[];
  listClaimedBy(kernelIds: ReadonlySet<string>): JobOffer[];
  getEvents(id: string): JobOfferEvent[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const sameWallet = (recorded: unknown, wallet: string) =>
  typeof recorded === "string" && ADDRESS.test(recorded.trim()) && recorded.trim().toLowerCase() === wallet.toLowerCase();

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const SKILL_JOBS_NOT_ATTRIBUTABLE =
  "Skill jobs are keyed by a self-asserted humanDid, and no API key or wallet is bound to a humanDid yet " +
  "(OperatorBinding). They are not listed rather than guessed.";

const OFFERS_UNINITIALISED = "The job-offers store is not running on this gateway.";

// ── Loader ────────────────────────────────────────────────────────────────────

export interface OperatorWorkLoadOptions {
  tenant?: { tenantId: string | null };
  onReadError?: (source: string, error: unknown) => void;
}

/**
 * The caller's kernels. A failure here is not recoverable for this read (nothing can be
 * scoped), so it throws, and the route answers 503.
 */
export function findOperatorKernels(wallet: string, db: JobExecutionDb): KernelLite[] {
  const rows = db.select().from(schema.shopKernels).all() as KernelLite[];
  return rows.filter((k) => sameWallet(k.operatorAddress, wallet));
}

/**
 * Read every source for the caller's kernels. Each source is read separately; a failed read
 * is recorded, never replaced with an empty list.
 */
export function loadOperatorWorkSources(
  kernels: KernelLite[],
  repos: JobExecutionRepos & {
    jobs: { findByKernel(kernelId: string, opts?: { tenantId?: string | null }): unknown[] };
    capabilities: { findByKernel(kernelId: string, opts?: unknown): unknown[] };
  },
  db: JobExecutionDb,
  offers: OffersReader | null,
  opts: OperatorWorkLoadOptions = {},
): OperatorWorkSources {
  const attempt = <T>(source: string, fn: () => T): SourceRead<T> => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      opts.onReadError?.(source, error);
      return { ok: false };
    }
  };
  const kernelIds = kernels.map((k) => k.id);
  const kernelSet = new Set(kernelIds);

  const capabilities = attempt("capabilities", () =>
    kernelIds.flatMap((id) => repos.capabilities.findByKernel(id) as CapabilityLite[]),
  );

  const kernelJobs = attempt("kernel_jobs", () =>
    kernelIds.flatMap((id) => repos.jobs.findByKernel(id, opts.tenant) as JobRow[]).map((job): KernelJobSource => {
      const settlement = buildSettlementAxis(
        job,
        attempt(`settlement:${job.id}`, () => resolveSettlement(job, repos, db)),
      );
      // A linked record's money can be contested by a dispute on this job's milestone: read them.
      // A linked record without an escrow id cannot be checked, so it reads as a failed read.
      const linkedRecord = settlement.link === "linked" ? settlement.record : undefined;
      const disputes: SourceRead<DisputeLite[]> = !linkedRecord
        ? { ok: true, value: [] }
        : linkedRecord.escrowId
          ? attempt(`disputes:${job.id}`, () => disputesOnMilestone(db, linkedRecord.escrowId!, job.stepId))
          : { ok: false };
      return { job, settlement, disputes };
    }),
  );

  const approvals = attempt("approvals", () =>
    kernelIds.flatMap(
      (id) =>
        db
          .select()
          .from(schema.pendingApprovals)
          .where(and(eq(schema.pendingApprovals.kernelId, id), eq(schema.pendingApprovals.status, "pending")))
          .all() as ApprovalRow[],
    ),
  );

  const claimedOffers = attempt("job_offers_claimed", () => {
    if (!offers) throw new Error(OFFERS_UNINITIALISED);
    return offers.listClaimedBy(kernelSet).map((offer) => ({ offer, events: offers.getEvents(offer.id) }));
  });

  const openOffers = attempt("job_offers_open", () => {
    if (!offers) throw new Error(OFFERS_UNINITIALISED);
    return offers.listOpen({});
  });

  return { kernels, capabilities, kernelJobs, approvals, claimedOffers, openOffers };
}

/** The disputes filed against one milestone (by its step) of one escrow. */
function disputesOnMilestone(db: JobExecutionDb, escrowId: string, stepId: string): DisputeLite[] {
  const rows = db.select().from(schema.disputes).where(eq(schema.disputes.escrowId, escrowId)).all() as DisputeLite[];
  return rows.filter((d) => d.milestoneStepId === stepId);
}

// ── Builders (pure) ───────────────────────────────────────────────────────────

const PHASE_ORDER: readonly OperatorWorkPhase[] = [
  "awaiting_me",
  "in_progress",
  "accepted",
  "offered",
  "reported_done",
  "disputed",
  "failed",
  "unknown",
  "verified",
  "expired",
  "cancelled",
];

const NO_PAY: OperatorWorkPay = Object.freeze({
  amount: null,
  amountBaseUnits: null,
  currency: null,
  decimals: null,
  model: "unknown",
  unit: null,
  funding: "unknown",
  fundingRef: null,
  basis: null,
}) as OperatorWorkPay;

const NO_EVIDENCE = (tier: 0 | 1 | 2 | 3 | null): OperatorWorkEvidence => ({ assuranceTier: tier, requirements: null, source: "none" });

function tierOf(v: unknown): 0 | 1 | 2 | 3 | null {
  return v === 0 || v === 1 || v === 2 || v === 3 ? v : null;
}

function kernelSite(kernel: KernelLite | undefined, kernelId: string): OperatorWorkLocation {
  const lat = typeof kernel?.location?.lat === "number" && Number.isFinite(kernel.location.lat) ? kernel.location.lat : null;
  const lng = typeof kernel?.location?.lng === "number" && Number.isFinite(kernel.location.lng) ? kernel.location.lng : null;
  return { kind: "operator_site", approximate: false, lat, lng, kernelId };
}

/**
 * Escrow-record words (escrows.status, or a V-next unit name) under which the escrow holds its
 * funds, uncontested, with nothing yet returned to the payer or paid out. RELEASE_ALLOCATED (the
 * release is decided, the payout outstanding) still holds the funds.
 */
const ESCROW_HOLDS = new Set(["FUNDED", "ACTIVE", "COMPLETING", "LOCKED", "RELEASING", "MILESTONE_MET", "FUNDED_ACTIVE", "RELEASE_ALLOCATED"]);
/**
 * Escrow-record words under which the escrow still holds the funds while the outcome is contested
 * (review r2 of #389, HIGH): the V-next contest and escalation states (canonical phases `contest`
 * and `escalation`), and a disputed escrow.
 */
const ESCROW_CONTESTED = new Set(["PRIMARY_ASSERTED", "CHALLENGED", "BACKUP_PENDING", "BACKUP_ASSERTED", "DISPUTED"]);
/** Milestone words (escrow_milestones.status) under which this job's milestone is funded and still open. */
const MILESTONE_HOLDS = new Set(["FUNDED", "LOCKED", "RELEASING"]);
/** Milestone words under which this job's milestone is held but contested. */
const MILESTONE_CONTESTED = new Set(["DISPUTED"]);
/** Words under which a refund to the payer is decided but not yet made (review r2 of #389, MEDIUM). */
const REFUND_PENDING = new Set(["REFUND_ALLOCATED"]);
/** Words, in either record, that say the money is not or no longer held: never funded, refunded, or released. */
const NOT_HELD = new Set(["CREATED", "UNFUNDED", "PENDING", "REFUNDED", "SETTLED_REFUNDED", "RELEASED", "SETTLED_RELEASED"]);
/** Dispute statuses (disputes.status) that contest the money, and those that leave it the operator's. */
const DISPUTE_OPEN = new Set(["filed", "under_review"]);
const DISPUTE_SETTLED_FOR_OPERATOR = new Set(["resolved_for_operator", "dismissed"]);

/** Every word the funding decision reads, for the test that each one is in the canonical money map. */
export const FUNDING_WORDS: readonly string[] = Object.freeze([
  ...new Set([...ESCROW_HOLDS, ...ESCROW_CONTESTED, ...MILESTONE_HOLDS, ...MILESTONE_CONTESTED, ...REFUND_PENDING, ...NOT_HELD]),
]);

/** What can contest a job's money besides its escrow and milestone words (review r2 of #389, HIGH). */
export interface FundingContest {
  /** The job row's own status is disputed (the item's phase says so too). */
  jobDisputed: boolean;
  /** The disputes recorded on this job's milestone. */
  disputes: SourceRead<DisputeLite[]>;
}

/**
 * Whether a REAL escrow record holds this job's milestone, and whether anything contests it
 * (astra r1 on #389: a linked record was called escrowed without reading its status; r2: nor
 * reading what contests it). Read from the exact words of both records, after the payout
 * reconciliation, and from every other record that can contest the money: the job's own status
 * and the disputes on its milestone.
 *   the payout is unknown (conflicting, unrecognized or ambiguous records)    -> unknown
 *   either word says never funded, refunded or released                       -> not_held
 *   a refund to the payer is decided but not made                             -> refund_pending
 *   the words do not say the escrow holds the funds and the milestone is open -> unknown
 *   the disputes cannot be read, or one went to the challenger, or has a
 *   status this rule does not know                                            -> unknown
 *   held, and a contest or escalation word, the job's disputed status or an
 *   open dispute contests it                                                  -> contested
 *   held, and nothing contests it                                             -> escrowed
 */
function recordFunding(s: SettlementAxis, contest: FundingContest): OperatorWorkPay["funding"] {
  const record = s.record!;
  const ms = record.milestone!;
  if (s.payout === "unknown" || !record.escrow.known || !ms.status.known) return "unknown";
  const e = normalizeMoneyStatus(record.escrow.sourceStatus);
  const m = normalizeMoneyStatus(ms.status.sourceStatus);
  if (NOT_HELD.has(e) || NOT_HELD.has(m)) return "not_held";
  if (REFUND_PENDING.has(e) || REFUND_PENDING.has(m)) return "refund_pending";
  const held = (ESCROW_HOLDS.has(e) || ESCROW_CONTESTED.has(e)) && (MILESTONE_HOLDS.has(m) || MILESTONE_CONTESTED.has(m));
  if (!held) return "unknown";
  const disputes = contest.disputes;
  if (!disputes || !disputes.ok) return "unknown";
  const statuses = disputes.value.map((d) => (typeof d.status === "string" ? d.status.trim().toLowerCase() : ""));
  if (statuses.some((st) => !DISPUTE_OPEN.has(st) && !DISPUTE_SETTLED_FOR_OPERATOR.has(st))) return "unknown";
  const contested =
    ESCROW_CONTESTED.has(e) || MILESTONE_CONTESTED.has(m) || contest.jobDisputed || statuses.some((st) => DISPUTE_OPEN.has(st));
  return contested ? "contested" : "escrowed";
}

/*
 * No kernel job offers update_status (review r2 of #389, MEDIUM). PATCH /api/jobs/:jobId/status
 * authorizes a caller by an operator or user id it does not prove, and by a kernel field kernels do
 * not record. This read model knows the caller only by its proven wallet, so it cannot say whether
 * that route would accept the caller: offering the action as refused was false for a submitter the
 * route accepts, and offering it as allowed would be false for everyone else. It returns when the
 * route authorizes proven identities (routed to gateway).
 */
/** The kernel-job source's reason when the jobs were read but the capabilities they name were not. */
export const CAPABILITY_NAMES_UNREAD =
  "The capability records could not be read, so each job's capabilityType and title are null (not known), not absent.";

/** Pay for a kernel job: only from this job's own milestone in its linked escrow record. */
export function kernelJobPay(s: SettlementAxis, contest: FundingContest): OperatorWorkPay {
  if (s.link !== "linked" || !s.record) return { ...NO_PAY };
  const ms = s.record.milestone;
  if (!ms) return { ...NO_PAY, fundingRef: s.record.escrowId };
  const currency = nonEmpty(s.record.escrowTotal.currency);
  const decimals = currencyDecimals(currency);
  return {
    amount: ms.amount,
    amountBaseUnits: toBaseUnits(ms.amount, decimals),
    currency,
    decimals,
    model: "escrow_milestone",
    unit: null,
    funding: s.record.simulated ? "simulated" : recordFunding(s, contest),
    fundingRef: s.record.escrowId,
    basis: "escrow_milestone_record",
  };
}

/** Pay for a job offer: the poster's declared price. Nothing funds an offer. */
export function offerPay(offer: JobOffer): OperatorWorkPay {
  const p = offer.pricing as Partial<JobOffer["pricing"]> | undefined;
  const currency = nonEmpty(p?.currency);
  const decimals = currencyDecimals(currency);
  const amount = typeof p?.amount === "number" && Number.isFinite(p.amount) && p.amount >= 0 ? String(p.amount) : null;
  const model =
    p?.model === "fixed" ? "fixed" : p?.model === "quote-required" ? "quote_required" : p?.model === "per-unit" ? "per_unit" : "unknown";
  return {
    amount,
    amountBaseUnits: amount == null ? null : toBaseUnits(p!.amount, decimals),
    currency,
    decimals,
    model,
    unit: nonEmpty(p?.unit),
    funding: amount == null ? "unknown" : "declared_unfunded",
    fundingRef: null,
    basis: amount == null ? null : "job_offer_pricing",
  };
}

/** Round to 2 decimals (about 1 km) when the work is not the caller's yet. */
const coarse = (v: number) => Math.round(v * 100) / 100;

export function offerLocation(offer: JobOffer, mine: boolean): OperatorWorkLocation {
  const req = (offer.requirements ?? {}) as Record<string, unknown>;
  const coords = extractRequirementsCoords(req);
  if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    return mine
      ? { kind: "point", approximate: false, lat: coords.lat, lng: coords.lng, kernelId: null }
      : { kind: "point", approximate: true, lat: coarse(coords.lat), lng: coarse(coords.lng), kernelId: null };
  }
  if (offer.serviceAreaGeofence) return { kind: "area", approximate: false, lat: null, lng: null, kernelId: null };
  if (req.remote === true) return { kind: "remote", approximate: false, lat: null, lng: null, kernelId: null };
  return { kind: "unknown", approximate: false, lat: null, lng: null, kernelId: null };
}

export function offerEvidence(offer: JobOffer): OperatorWorkEvidence {
  const tier = tierOf(offer.assuranceTier);
  const e = offer.evidenceRequirements;
  if (!e || typeof e !== "object") return NO_EVIDENCE(tier);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    assuranceTier: tier,
    requirements: {
      eventsRequired: Array.isArray(e.events_required) ? e.events_required.filter((x): x is string => typeof x === "string") : [],
      photosRequired: bool(e.photos_required),
      rawDataRequired: bool(e.raw_data_required),
      chainOfCustody: bool(e.chain_of_custody),
      tierRequired: tierOf(e.tier_required),
    },
    source: "job_offer",
  };
}

const approveActions = (approvalId: string): OperatorWorkAction[] => [
  { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: `/api/operator/approvals/${approvalId}/approve` } },
  { op: "reject", allowed: true, reasonIfNot: null, route: { method: "POST", path: `/api/operator/approvals/${approvalId}/reject` } },
];

function lastEventAt(events: JobOfferEvent[]): string | null {
  let best: string | null = null;
  for (const e of events) {
    if (typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)) && (best == null || Date.parse(e.at) > Date.parse(best))) best = e.at;
  }
  return best;
}

function kernelJobItem(
  src: KernelJobSource,
  kernel: KernelLite | undefined,
  capability: CapabilityLite | undefined,
  approval: ApprovalRow | undefined,
): OperatorWorkItem {
  const { job, settlement, disputes } = src;
  const execPhase = executionPhaseOf(job.status);
  const raw = normalizeJobRowStatus(job.status);
  let phase: OperatorWorkPhase;
  let phaseSource: OperatorWorkItem["phaseSource"];
  if (raw === "disputed") {
    phase = "disputed";
    phaseSource = "server";
  } else if (approval) {
    phase = "awaiting_me";
    phaseSource = "server";
  } else {
    const m = operatorPhaseOf(KERNEL_JOB_PHASE_MAP, execPhase);
    phase = m.phase;
    phaseSource = m.source;
  }
  const terminal = isTerminalExecutionPhase(execPhase) || raw === "disputed";
  const actions: OperatorWorkAction[] = approval ? approveActions(approval.id) : [];
  const tier = tierOf(job.assuranceTier);
  return {
    id: `kernel_job:${job.id}`,
    source: "kernel_job",
    capabilityType: nonEmpty(capability?.type),
    title: nonEmpty(capability?.name),
    executorKind: "kernel",
    phase,
    phaseSource,
    sourceStatus: String(job.status ?? ""),
    pay: kernelJobPay(settlement, { jobDisputed: raw === "disputed", disputes }),
    payout: settlement.payout,
    deadline: null,
    acceptBy: approval ? nonEmpty(approval.expiresAt) : null,
    postedAt: nonEmpty(job.startedAt),
    location: kernelSite(kernel, job.kernelId),
    evidence: NO_EVIDENCE(tier),
    assuranceTier: tier,
    actions,
    mine: true,
    kernelId: job.kernelId,
    refs: {
      jobId: job.id,
      ...(settlement.record ? { escrowRef: settlement.record.escrowId } : {}),
      ...(approval ? { approvalId: approval.id } : {}),
    },
    changedAt: terminal ? nonEmpty(job.completedAt) : null,
  };
}

function approvalItem(a: ApprovalRow, kernel: KernelLite | undefined): OperatorWorkItem {
  const summary = (a.jobSummary ?? {}) as Record<string, unknown>;
  return {
    id: `approval:${a.id}`,
    source: "approval",
    capabilityType: nonEmpty(summary.capabilityType),
    title: null,
    executorKind: "kernel",
    phase: "awaiting_me",
    phaseSource: "server",
    sourceStatus: String(a.status ?? ""),
    pay: { ...NO_PAY },
    payout: null,
    deadline: null,
    acceptBy: nonEmpty(a.expiresAt),
    postedAt: nonEmpty(a.createdAt),
    location: kernelSite(kernel, a.kernelId),
    evidence: NO_EVIDENCE(null),
    assuranceTier: null,
    actions: approveActions(a.id),
    mine: true,
    kernelId: a.kernelId,
    refs: { approvalId: a.id },
    changedAt: null,
  };
}

function offerItem(
  offer: JobOffer,
  events: JobOfferEvent[],
  mine: boolean,
  candidateKernels: string[],
  nowMs: number,
): OperatorWorkItem {
  const { phase, source } = operatorPhaseOf(JOB_OFFER_PHASE_MAP, offer.status);
  const actions: OperatorWorkAction[] = [];
  if (offer.status === "open") {
    const lapsed = Number.isFinite(Date.parse(offer.validUntil)) && Date.parse(offer.validUntil) < nowMs;
    const reasonIfNot =
      candidateKernels.length === 0
        ? `None of your kernels offers the capability type '${offer.capabilityType}'.`
        : lapsed
          ? "The time to accept this offer has passed."
          : null;
    actions.push({
      op: "claim",
      allowed: reasonIfNot == null,
      reasonIfNot,
      route: { method: "POST", path: `/api/job-offers/${offer.id}/claim` },
      kernelIds: candidateKernels,
    });
  } else if (mine && (offer.status === "claimed" || offer.status === "in_progress")) {
    actions.push({
      op: "report_progress",
      allowed: true,
      reasonIfNot: null,
      route: { method: "POST", path: `/api/job-offers/${offer.id}/events` },
    });
  }
  const req = (offer.requirements ?? {}) as Record<string, unknown>;
  const title = nonEmpty(req.title) ?? nonEmpty(req.summary);
  return {
    id: `job_offer:${offer.id}`,
    source: "job_offer",
    capabilityType: nonEmpty(offer.capabilityType),
    title,
    executorKind: "kernel",
    phase,
    phaseSource: source,
    sourceStatus: String(offer.status ?? ""),
    pay: offerPay(offer),
    payout: null,
    deadline: nonEmpty(offer.deadlineIso),
    acceptBy: nonEmpty(offer.validUntil),
    postedAt: nonEmpty(offer.postedAt),
    location: offerLocation(offer, mine),
    evidence: offerEvidence(offer),
    assuranceTier: tierOf(offer.assuranceTier),
    actions,
    mine,
    kernelId: mine ? offer.claimedByKernelId : null,
    refs: { offerId: offer.id },
    changedAt: lastEventAt(events),
  };
}

const sourceState = (
  read: SourceRead<unknown[]>,
  durability: OperatorWorkSourceState["durability"],
  reasonIfFailed: string,
  count: number,
): OperatorWorkSourceState =>
  read.ok
    ? { state: "read", durability, count, reason: null }
    : { state: "unavailable", durability, count: 0, reason: reasonIfFailed };

/** The work list's and the income rows' page bounds (astra r1 on #389, MEDIUM: a cut list had no continuation). */
export const OPERATOR_PAGE_DEFAULT_LIMIT = 200;
export const OPERATOR_PAGE_MAX_LIMIT = 500;

export interface OperatorPage {
  limit: number;
  offset: number;
}

/**
 * A snapshot of a whole sorted list (review r2 of #389, MEDIUM): a digest of its keys, in order.
 * Two reads give the same snapshot only when they list the same items in the same order, so a
 * client that sends the first page's snapshot with each next page is told (409 list_changed) when
 * the list moved, instead of being given a page that repeats or skips rows.
 */
export function listSnapshot(keys: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex").slice(0, 32);
}

/** One page of a sorted list, where the next one starts, and the whole list's snapshot. */
function pageOf<T>(all: readonly T[], page: OperatorPage, keyOf: (item: T) => string) {
  const end = page.offset + page.limit;
  return {
    page: all.slice(page.offset, end),
    total: all.length,
    offset: page.offset,
    truncated: end < all.length,
    nextOffset: end < all.length ? end : null,
    snapshot: listSnapshot(all.map(keyOf)),
  };
}

export interface OperatorWorkBuildOptions {
  limit: number;
  /** Where the page starts in the sorted list; 0 when absent. */
  offset?: number;
  nowMs: number;
}

export function buildOperatorWorkDTO(src: OperatorWorkSources, asOf: string, opts: OperatorWorkBuildOptions): OperatorWorkDTO {
  const kernelById = new Map(src.kernels.map((k) => [k.id, k]));
  const caps = src.capabilities.ok ? src.capabilities.value : [];
  const capById = new Map(caps.map((c) => [c.id, c]));
  const kernelsByType = new Map<string, string[]>();
  for (const c of caps) {
    const list = kernelsByType.get(c.type) ?? [];
    if (!list.includes(c.kernelId)) list.push(c.kernelId);
    kernelsByType.set(c.type, list);
  }

  const items: OperatorWorkItem[] = [];

  // Kernel jobs, with any pending approval for the job folded into the job's item.
  const approvals = src.approvals.ok ? src.approvals.value : [];
  const approvalByJob = new Map<string, ApprovalRow>();
  for (const a of approvals) if (!approvalByJob.has(a.jobId)) approvalByJob.set(a.jobId, a);
  const jobIds = new Set<string>();
  if (src.kernelJobs.ok) {
    for (const kj of src.kernelJobs.value) {
      jobIds.add(kj.job.id);
      items.push(kernelJobItem(kj, kernelById.get(kj.job.kernelId), capById.get(kj.job.capabilityId), approvalByJob.get(kj.job.id)));
    }
  }
  // Approvals whose job has no row are their own items.
  for (const a of approvals) {
    if (!jobIds.has(a.jobId)) items.push(approvalItem(a, kernelById.get(a.kernelId)));
  }

  // Offers: the caller's claimed offers, then open offers for the caller's capability types.
  // One source: if any read it needs failed (the claimed offers, the open offers, or the
  // capabilities open offers are matched against), no offer is listed: a partial list, or an
  // empty match, would look complete (astra r1 on #389, MEDIUM).
  const offersOk = src.claimedOffers.ok && src.openOffers.ok && src.capabilities.ok;
  const claimedIds = new Set<string>();
  if (offersOk && src.claimedOffers.ok) {
    for (const { offer, events } of src.claimedOffers.value) {
      claimedIds.add(offer.id);
      items.push(offerItem(offer, events, true, [], opts.nowMs));
    }
  }
  let offeredCount = 0;
  if (offersOk && src.openOffers.ok) {
    for (const offer of src.openOffers.value) {
      const candidates = kernelsByType.get(offer.capabilityType);
      if (!candidates || claimedIds.has(offer.id)) continue;
      offeredCount++;
      items.push(offerItem(offer, [], false, candidates, opts.nowMs));
    }
  }

  items.sort((a, b) => {
    const pa = PHASE_ORDER.indexOf(a.phase);
    const pb = PHASE_ORDER.indexOf(b.phase);
    if (pa !== pb) return pa - pb;
    const ta = a.postedAt ? Date.parse(a.postedAt) : -Infinity;
    const tb = b.postedAt ? Date.parse(b.postedAt) : -Infinity;
    if (ta !== tb) return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const shown = pageOf(items, { limit: opts.limit, offset: opts.offset ?? 0 }, (item) => item.id);
  const offersRead: SourceRead<unknown[]> = offersOk ? { ok: true, value: [] } : { ok: false };
  const kernelJobCount = src.kernelJobs.ok ? src.kernelJobs.value.length : 0;
  const approvalOnlyCount = approvals.filter((a) => !jobIds.has(a.jobId)).length;
  const offersCount = offersOk && src.claimedOffers.ok ? src.claimedOffers.value.length + offeredCount : 0;

  return {
    schemaId: OPERATOR_WORK_SCHEMA_ID,
    asOf,
    kernels: src.kernels.map((k) => ({ kernelId: k.id, name: nonEmpty(k.name) })),
    items: shown.page,
    total: shown.total,
    offset: shown.offset,
    truncated: shown.truncated,
    nextOffset: shown.nextOffset,
    snapshot: shown.snapshot,
    sources: {
      kernel_job: {
        ...sourceState(src.kernelJobs, "durable", "The gateway's job records could not be read.", kernelJobCount),
        // The jobs are listed, but each one's capabilityType and title come from the capability read.
        ...(src.kernelJobs.ok && !src.capabilities.ok ? { reason: CAPABILITY_NAMES_UNREAD } : {}),
      },
      approval: sourceState(src.approvals, "durable", "The gateway's approval records could not be read.", approvalOnlyCount),
      job_offer: sourceState(offersRead, "memory", "The job-offers store, or the capabilities offers are matched against, could not be read.", offersCount),
      skill_job: { state: "not_attributable", durability: "durable", count: 0, reason: SKILL_JOBS_NOT_ATTRIBUTABLE },
    } satisfies Record<OperatorWorkSource, OperatorWorkSourceState>,
  };
}

// ── Income ────────────────────────────────────────────────────────────────────

export const INCOME_HISTORY_REASON =
  "The gateway has no per-operator settlement index. The operator's share is paid through MilestoneReleased " +
  "events, which it does not index per operator, so these rows show only what the escrow records say about " +
  "your kernels' jobs.";

export function buildOperatorIncomeDTO(
  src: OperatorWorkSources,
  asOf: string,
  page: OperatorPage = { limit: OPERATOR_PAGE_DEFAULT_LIMIT, offset: 0 },
): OperatorIncomeDTO {
  const rows: OperatorIncomeRow[] = [];
  let unreadableJobs = 0;
  if (src.kernelJobs.ok) {
    for (const { job, settlement, disputes } of src.kernelJobs.value) {
      if (settlement.link === "not_linked") continue;
      if (settlement.link === "unavailable") unreadableJobs++;
      const pay = kernelJobPay(settlement, { jobDisputed: normalizeJobRowStatus(job.status) === "disputed", disputes });
      rows.push({
        workRef: `kernel_job:${job.id}`,
        jobId: job.id,
        kernelId: job.kernelId,
        amount: pay.amount,
        amountBaseUnits: pay.amountBaseUnits,
        currency: pay.currency,
        decimals: pay.decimals,
        moneyStatus: settlement.record?.milestone?.status ?? null,
        payout: settlement.payout,
        simulated: settlement.record?.simulated === true,
        escrowRef: settlement.record?.escrowId ?? null,
        settledAt: null,
        source: "gateway_escrow_record",
      });
    }
  }

  // A stable order, so pages do not overlap or skip while the rows are unchanged.
  rows.sort((a, b) => (a.workRef < b.workRef ? -1 : a.workRef > b.workRef ? 1 : 0));
  const totals = new Map<string, OperatorIncomeTotal & { sum: bigint }>();
  let uncountedRows = 0;
  for (const r of rows) {
    if (r.amountBaseUnits == null || r.currency == null || r.decimals == null) {
      uncountedRows++;
      continue;
    }
    const currency = r.currency.trim().toUpperCase();
    const key = `${r.payout}|${currency}`;
    const t = totals.get(key) ?? { status: r.payout, currency, decimals: r.decimals, amountBaseUnits: "0", rows: 0, sum: 0n };
    t.sum += BigInt(r.amountBaseUnits);
    t.rows++;
    totals.set(key, t);
  }
  const shown = pageOf(rows, page, (row) => row.workRef);
  const totalsByStatus: OperatorIncomeTotal[] = [...totals.values()]
    .map(({ sum, ...t }) => ({ ...t, amountBaseUnits: sum.toString() }))
    .sort((a, b) => (a.status + a.currency < b.status + b.currency ? -1 : 1));

  return {
    schemaId: OPERATOR_INCOME_SCHEMA_ID,
    asOf,
    kernels: src.kernels.map((k) => ({ kernelId: k.id, name: nonEmpty(k.name) })),
    rows: shown.page,
    total: shown.total,
    offset: shown.offset,
    truncated: shown.truncated,
    nextOffset: shown.nextOffset,
    snapshot: shown.snapshot,
    totalsByStatus,
    uncountedRows,
    historyAvailable: false,
    reasonIfNot: INCOME_HISTORY_REASON,
    sources: {
      kernel_jobs: src.kernelJobs.ok
        ? { state: "read", reason: null }
        : { state: "unavailable", reason: "The gateway's job records could not be read." },
      settlement: {
        state: !src.kernelJobs.ok ? "unavailable" : unreadableJobs > 0 ? "partial" : "read",
        unreadableJobs,
      },
    },
  };
}

export type { PayoutState };

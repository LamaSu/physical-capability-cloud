/**
 * OperatorWorkDTO and OperatorIncomeDTO (@pcc/spec readmodels/operator-work.ts): the loader
 * (one pass over the store and the job-offers store) and the pure builders.
 *
 * Scope: the caller's kernels, i.e. kernels whose operatorAddress is the caller's principal
 * (the API key's operatorId or the SIWE wallet), compared case-insensitively as in
 * authorizeJobRead. The principal is self-asserted at provisioning until the gateway's N2
 * fix lands; this read model shows each operator only work on kernels recorded as theirs.
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

const samePrincipal = (a: unknown, b: string) =>
  typeof a === "string" && a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

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
export function findOperatorKernels(principal: string, db: JobExecutionDb): KernelLite[] {
  const rows = db.select().from(schema.shopKernels).all() as KernelLite[];
  return rows.filter((k) => samePrincipal(k.operatorAddress, principal));
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
    kernelIds.flatMap((id) => repos.jobs.findByKernel(id, opts.tenant) as JobRow[]).map((job) => ({
      job,
      settlement: buildSettlementAxis(
        job,
        attempt(`settlement:${job.id}`, () => resolveSettlement(job, repos, db)),
      ),
    })),
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

/** Pay for a kernel job: only from this job's own milestone in its linked escrow record. */
export function kernelJobPay(s: SettlementAxis): OperatorWorkPay {
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
    funding: s.record.simulated ? "simulated" : "escrowed",
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
  const { job, settlement } = src;
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
  actions.push({
    op: "update_status",
    allowed: !terminal,
    reasonIfNot: terminal ? "The job is finished." : null,
    route: { method: "PATCH", path: `/api/jobs/${job.id}/status` },
  });
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
    pay: kernelJobPay(settlement),
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

export interface OperatorWorkBuildOptions {
  limit: number;
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
  // One source: if either read failed, no offer is listed (a partial list would look complete).
  const offersOk = src.claimedOffers.ok && src.openOffers.ok;
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

  const offersRead: SourceRead<unknown[]> = offersOk ? { ok: true, value: [] } : { ok: false };
  const kernelJobCount = src.kernelJobs.ok ? src.kernelJobs.value.length : 0;
  const approvalOnlyCount = approvals.filter((a) => !jobIds.has(a.jobId)).length;
  const offersCount = offersOk && src.claimedOffers.ok ? src.claimedOffers.value.length + offeredCount : 0;

  return {
    schemaId: OPERATOR_WORK_SCHEMA_ID,
    asOf,
    kernels: src.kernels.map((k) => ({ kernelId: k.id, name: nonEmpty(k.name) })),
    items: items.slice(0, opts.limit),
    total: items.length,
    truncated: items.length > opts.limit,
    sources: {
      kernel_job: sourceState(src.kernelJobs, "durable", "The gateway's job records could not be read.", kernelJobCount),
      approval: sourceState(src.approvals, "durable", "The gateway's approval records could not be read.", approvalOnlyCount),
      job_offer: sourceState(offersRead, "memory", "The job-offers store could not be read.", offersCount),
      skill_job: { state: "not_attributable", durability: "durable", count: 0, reason: SKILL_JOBS_NOT_ATTRIBUTABLE },
    } satisfies Record<OperatorWorkSource, OperatorWorkSourceState>,
  };
}

// ── Income ────────────────────────────────────────────────────────────────────

export const INCOME_HISTORY_REASON =
  "The gateway has no per-operator settlement index. The operator's share is paid through MilestoneReleased " +
  "events, which it does not index per operator, so these rows show only what the escrow records say about " +
  "your kernels' jobs.";

export function buildOperatorIncomeDTO(src: OperatorWorkSources, asOf: string): OperatorIncomeDTO {
  const rows: OperatorIncomeRow[] = [];
  let unreadableJobs = 0;
  if (src.kernelJobs.ok) {
    for (const { job, settlement } of src.kernelJobs.value) {
      if (settlement.link === "not_linked") continue;
      if (settlement.link === "unavailable") unreadableJobs++;
      const pay = kernelJobPay(settlement);
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
  const totalsByStatus: OperatorIncomeTotal[] = [...totals.values()]
    .map(({ sum, ...t }) => ({ ...t, amountBaseUnits: sum.toString() }))
    .sort((a, b) => (a.status + a.currency < b.status + b.currency ? -1 : 1));

  return {
    schemaId: OPERATOR_INCOME_SCHEMA_ID,
    asOf,
    kernels: src.kernels.map((k) => ({ kernelId: k.id, name: nonEmpty(k.name) })),
    rows,
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

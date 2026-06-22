/**
 * Courier-jobs store — BACKWARD-COMPAT SHIM over JobOffersStore.
 *
 * This file used to be xray's standalone fold of pcc-courier-jobs v0.2 into
 * the gateway. It has been generalized: the actual storage + business logic
 * now lives in services/job-offers-store.ts, which is category-agnostic
 * (every PCC adapter shares it: pcc-courier, pcc-dominos, pcc-hamilton,
 * pcc-kdense, pcc-opentrons, ...). This file remains as a thin shim that:
 *
 *   1. Translates v0.2 courier-shaped inputs (deliveryId, pickup, dropoff,
 *      feeUSD, tipUSD, externalRef, requireHeartbeat, sourceVerifyUrl)
 *      to the generic JobOfferStore CreateJobOfferInput shape with
 *      capability_type = "courier.dispatch".
 *
 *   2. Re-projects generic JobOffer rows back to the courier-shaped DTO
 *      that v0.2 callers (pcc-courier `manual.ts`, Skylar's driver agent,
 *      tests) expect.
 *
 * Lifetime: kept for a 30-day cutover window. Once pcc-courier posts to
 * /api/job-offers natively, this file (and routes/courier-jobs.ts) can be
 * deleted. Tracker for that: see docs/JOB_OFFERS.md migration section.
 *
 * Public API exports preserved for source compatibility with xray's
 * vitest suite (it imports initCourierJobsStore /
 * _resetCourierJobsStoreForTests / VerifyFn).
 */

import {
  type CapabilitySchemaValidator,
  type JobOffer,
  type JobOffersStoreOptions,
  type JobOfferEvent,
  type VerifyFn,
  type VerifyResult,
  type VerifyFail,
  type VerifyOk,
  type SqliteDatabaseLike,
  initJobOffersStore,
  getJobOffersStore,
  _resetJobOffersStoreForTests,
  nowIso,
  nowMs,
  haversineMiles,
  computeValidUntilMs,
} from "./job-offers-store.js";

// Re-export everything callers might still import. Source-compat.
export type {
  CapabilitySchemaValidator,
  JobOffersStoreOptions as CourierJobsStoreOptions,
  VerifyFn,
  VerifyResult,
  VerifyFail,
  VerifyOk,
  SqliteDatabaseLike,
};
export { nowIso, nowMs, haversineMiles, computeValidUntilMs };

// ── Legacy types preserved for callers ─────────────────────────────────────

export interface CourierLocation {
  name?: string;
  lat?: number;
  lng?: number;
  address?: string;
  [k: string]: unknown;
}

export type CourierJobStatus =
  | "open"
  | "claimed"
  | "in_transit"
  | "delivered"
  | "cancelled"
  | "expired";

export interface CourierJob {
  id: string;
  status: CourierJobStatus;
  postedAt: string;
  postedBy: string | null;
  pickup: CourierLocation;
  dropoff: CourierLocation;
  pickupReadyAt: string | null;
  feeUSD: number | null;
  tipUSD: number | null;
  externalRef: string | null;
  description: string | null;
  raw: unknown;
  sourceVerifyUrl: string | null;
  verified: boolean;
  lastVerifyAt: string | null;
  requireHeartbeat: boolean;
  lastHeartbeatAt: string | null;
  validUntil: string;
  claimedBy?: string | null;
  claimedAt?: string | null;
  driverEtaMin?: number | null;
  driverContact?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  expiredAt?: string | null;
}

export interface CourierJobEvent {
  at: string;
  event: string;
  [k: string]: unknown;
}

export interface CreateJobInput {
  deliveryId: string;
  pickup: CourierLocation;
  dropoff: CourierLocation;
  pickupReadyAt?: string | null;
  feeUSD?: number | null;
  tipUSD?: number | null;
  externalRef?: string | null;
  description?: string | null;
  raw?: unknown;
  sourceVerifyUrl?: string | null;
  requireHeartbeat?: boolean;
  postedBy?: string | null;
}

export interface ClaimInput {
  driverAgent: string;
  etaMin?: number;
  contact?: string;
}

// ── Shape translators ──────────────────────────────────────────────────────

const COURIER_CAPABILITY_TYPE = "courier.dispatch";

/**
 * Project a generic JobOffer (capability_type=courier.dispatch) back to the
 * legacy CourierJob shape that v0.2 callers expect. Field mapping:
 *   - id ← offer.id  (caller-supplied deliveryId became offer.id)
 *   - pickup/dropoff ← offer.requirements.pickup/dropoff
 *   - feeUSD ← offer.pricing.amount (when currency=USD model=fixed)
 *   - tipUSD ← offer.requirements.tipUSD
 *   - externalRef/description/raw ← offer.requirements.*
 *   - postedBy ← offer.posterDid
 *   - claimedBy ← offer.claimedByKernelId  (in v0.2 this is a driver-agent name)
 *   - in_transit ← offer.status === "in_progress"  (renamed in generic)
 */
function offerToCourierJob(o: JobOffer): CourierJob {
  const r = o.requirements as Record<string, unknown>;
  const pickup = (r.pickup as CourierLocation | undefined) ?? {};
  const dropoff = (r.dropoff as CourierLocation | undefined) ?? {};
  const tipUSD = typeof r.tipUSD === "number" ? r.tipUSD : null;
  const externalRef = typeof r.externalRef === "string" ? r.externalRef : null;
  const description = typeof r.description === "string" ? r.description : null;
  const raw = r.raw ?? null;
  const pickupReadyAt = typeof r.pickupReadyAt === "string" ? r.pickupReadyAt : null;

  // Map generic status back to v0.2's slightly different vocab.
  const status = genericStatusToCourier(o.status);

  const feeUSD = o.pricing.currency === "USD" && o.pricing.model === "fixed"
    ? o.pricing.amount
    : (typeof r.feeUSD === "number" ? r.feeUSD : null);

  return {
    id: o.id,
    status,
    postedAt: o.postedAt,
    postedBy: o.posterDid,
    pickup,
    dropoff,
    pickupReadyAt,
    feeUSD,
    tipUSD,
    externalRef,
    description,
    raw,
    sourceVerifyUrl: o.sourceVerifyUrl,
    verified: o.verified,
    lastVerifyAt: o.lastVerifyAt,
    requireHeartbeat: o.requireHeartbeat,
    lastHeartbeatAt: o.lastHeartbeatAt,
    validUntil: o.validUntil,
    claimedBy: o.claimedByKernelId,
    claimedAt: o.claimedAt,
    driverEtaMin: o.driverEtaMin,
    driverContact: o.driverContact,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
    expiredAt: o.expiredAt,
  };
}

/**
 * Map a generic JobOfferStatus string back to v0.2 CourierJobStatus vocab
 * (in_progress → in_transit, settled/disputed → delivered as a safe collapse).
 * Pure string lookup — no offer object required.
 */
function genericStatusToCourier(status: string): CourierJobStatus {
  switch (status) {
    case "open": return "open";
    case "claimed": return "claimed";
    case "in_progress": return "in_transit";
    case "delivered": return "delivered";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    case "settled": return "delivered";
    case "disputed": return "delivered";
    default: return "open";
  }
}

function eventsToCourier(events: JobOfferEvent[]): CourierJobEvent[] {
  // Pass through unchanged — JobOfferEvent and CourierJobEvent share the same
  // {at, event, ...} structure. The only difference might be the absence of
  // legacy event kinds; the v0.2 surface emitted "posted", "claimed",
  // "patched", "deleted_by_poster", "heartbeat", "expired", "cancelled",
  // "pickup", "delivered", "note". Generic emits a superset; same shape.
  return events;
}

// ── Shim class — preserves the public surface xray's tests use ─────────────

export class CourierJobsStore {
  // Note: callers should not construct this directly anymore. Kept for
  // source-compat with anything that imported the class. The class is a
  // stateless façade — all state lives in the JobOffersStore singleton. We
  // accept `opts` to preserve the historical signature but never re-init.
  // (Callers that want to set up a store should call `initCourierJobsStore`,
  // which delegates to `initJobOffersStore` once at boot.)
  constructor(_opts: JobOffersStoreOptions = {}) {
    void _opts;
  }

  has(id: string): boolean { return getJobOffersStore().has(id); }

  get(id: string): CourierJob | undefined {
    const o = getJobOffersStore().get(id);
    return o ? offerToCourierJob(o) : undefined;
  }

  getEvents(id: string): CourierJobEvent[] {
    return eventsToCourier(getJobOffersStore().getEvents(id));
  }

  size(): number { return getJobOffersStore().size(); }

  countByStatus(status: CourierJobStatus): number {
    const store = getJobOffersStore();
    // v0.2's "in_transit" maps to generic "in_progress" — count by mapped status.
    let n = 0;
    for (const o of (store as unknown as { offers: Map<string, JobOffer> }).offers?.values() ?? []) {
      if (o.capabilityType !== COURIER_CAPABILITY_TYPE) continue;
      const mapped = offerToCourierJob(o).status;
      if (mapped === status) n++;
    }
    // Defensive fallback if private offers map isn't exposed (shouldn't
    // happen in same-process use, but covers future internal refactor).
    if (n === 0 && status === "open") n = store.countByStatus("open");
    if (n === 0 && status === "expired") n = store.countByStatus("expired");
    if (n === 0 && status === "claimed") n = store.countByStatus("claimed");
    if (n === 0 && status === "in_transit") n = store.countByStatus("in_progress");
    if (n === 0 && status === "delivered") n = store.countByStatus("delivered");
    if (n === 0 && status === "cancelled") n = store.countByStatus("cancelled");
    return n;
  }

  async create(
    input: CreateJobInput,
  ): Promise<{ ok: true; job: CourierJob; created: boolean } | (VerifyFail & { ok: false })> {
    const store = getJobOffersStore();
    const requirements: Record<string, unknown> = {
      pickup: input.pickup,
      dropoff: input.dropoff,
    };
    if (input.pickupReadyAt !== undefined && input.pickupReadyAt !== null) {
      requirements.pickupReadyAt = input.pickupReadyAt;
    }
    if (input.tipUSD != null) requirements.tipUSD = input.tipUSD;
    if (input.externalRef) requirements.externalRef = input.externalRef;
    if (input.description) requirements.description = input.description;
    if (input.raw !== undefined && input.raw !== null) requirements.raw = input.raw;
    const result = await store.create({
      id: input.deliveryId,
      capabilityType: COURIER_CAPABILITY_TYPE,
      requirements,
      pricing: {
        amount: typeof input.feeUSD === "number" ? input.feeUSD : 0,
        currency: "USD",
        model: "fixed",
      },
      sourceVerifyUrl: input.sourceVerifyUrl ?? null,
      requireHeartbeat: !!input.requireHeartbeat,
      posterDid: input.postedBy ?? null,
    });
    if (!result.ok) {
      // Schema validation never fires in shim path (graceful degrade).
      if (result.reason === "schema_validation_failed") {
        return {
          ok: false,
          reason: "verify_request_failed",
          error: result.error,
        };
      }
      return result;
    }
    return { ok: true, job: offerToCourierJob(result.offer), created: result.created };
  }

  listOpen(filters: {
    verified?: boolean;
    minFeeUSD?: number | null;
    maxFeeUSD?: number | null;
    within?: { lat: number; lng: number; miles: number } | null;
  } = {}): CourierJob[] {
    const open = getJobOffersStore().listOpen({
      capabilityType: COURIER_CAPABILITY_TYPE,
      verified: filters.verified,
      // v0.2 feeUSD ↔ generic pricing.amount (USD currency, fixed model)
      minAmount: filters.minFeeUSD,
      maxAmount: filters.maxFeeUSD,
      currency: "USD",
      within: filters.within,
    });
    return open.map(offerToCourierJob);
  }

  async claim(
    id: string,
    claim: ClaimInput,
  ): Promise<
    | { ok: true; job: CourierJob }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "not_open"; currentStatus: CourierJobStatus; claimedBy: string | null }
  > {
    const result = await getJobOffersStore().claim(id, {
      kernelId: claim.driverAgent,    // v0.2 names this driverAgent
      etaMin: claim.etaMin,
      contact: claim.contact,
    });
    if (!result.ok) {
      if (result.reason === "not_found") return { ok: false, reason: "not_found" };
      if (result.reason === "not_open") {
        return {
          ok: false,
          reason: "not_open",
          // Map generic status name back to v0.2 vocab without round-tripping
          // a synthetic offer (which would fail on requirements.pickup access).
          currentStatus: genericStatusToCourier(result.currentStatus),
          claimedBy: result.claimedBy,
        };
      }
    }
    return { ok: true, job: offerToCourierJob((result as { ok: true; offer: JobOffer }).offer) };
  }

  recordEvent(
    id: string,
    event: "pickup" | "delivered" | "cancelled" | "note",
    by: string | null,
    proof: unknown,
    note: string | null,
  ): { ok: true; status: CourierJobStatus; event: CourierJobEvent } | { ok: false; reason: "not_found" } {
    const result = getJobOffersStore().recordEvent(id, event, by, proof, note);
    if (!result.ok) return { ok: false, reason: "not_found" };
    // Re-project status: generic "in_progress" → v0.2 "in_transit"
    const o = getJobOffersStore().get(id)!;
    return { ok: true, status: offerToCourierJob(o).status, event: result.event };
  }

  patch(
    id: string,
    poster: string,
    patch: Partial<Pick<CourierJob, "pickupReadyAt" | "feeUSD" | "description" | "validUntil">>,
  ):
    | { ok: true; job: CourierJob }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" }
    | { ok: false; reason: "not_editable"; currentStatus: CourierJobStatus } {
    const store = getJobOffersStore();
    const requirements: Record<string, unknown> = {};
    if (patch.pickupReadyAt !== undefined) requirements.pickupReadyAt = patch.pickupReadyAt;
    if (patch.description !== undefined) requirements.description = patch.description;
    const result = store.patch(id, poster, {
      ...(patch.feeUSD !== undefined ? {
        pricing: {
          amount: patch.feeUSD ?? 0,
          currency: "USD",
          model: "fixed",
        },
      } : {}),
      ...(patch.validUntil !== undefined ? { validUntil: patch.validUntil } : {}),
      ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    });
    if (!result.ok) {
      if (result.reason === "not_found") return { ok: false, reason: "not_found" };
      if (result.reason === "forbidden") return { ok: false, reason: "forbidden" };
      if (result.reason === "not_editable") {
        return {
          ok: false,
          reason: "not_editable",
          currentStatus: genericStatusToCourier(result.currentStatus),
        };
      }
    }
    return { ok: true, job: offerToCourierJob((result as { ok: true; offer: JobOffer }).offer) };
  }

  cancel(id: string, poster: string):
    | { ok: true; status: CourierJobStatus }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" } {
    const result = getJobOffersStore().cancel(id, poster);
    if (!result.ok) return result;
    const o = getJobOffersStore().get(id)!;
    return { ok: true, status: offerToCourierJob(o).status };
  }

  heartbeat(id: string, poster: string):
    | { ok: true; lastHeartbeatAt: string }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" } {
    return getJobOffersStore().heartbeat(id, poster);
  }

  async sweep(): Promise<{ expired: number; reverified: number; autoCancelled: number }> {
    return getJobOffersStore().sweep();
  }
}

// ── Singleton API (preserved for source-compat with xray's test imports) ───

export function initCourierJobsStore(opts: JobOffersStoreOptions = {}): CourierJobsStore {
  initJobOffersStore(opts);
  return new CourierJobsStore();
}

export function getCourierJobsStore(): CourierJobsStore {
  // Ensure underlying store exists (otherwise the shim's class methods will
  // throw on the first delegated call).
  getJobOffersStore(); // throws cleanly if not init'd
  return new CourierJobsStore({});
  // ^ The class is purely a façade over the singleton; constructing extra
  //   instances is cheap (no per-instance state).
}

/** Test helper: reset the singleton so each test gets a clean store. */
export function _resetCourierJobsStoreForTests(): void {
  _resetJobOffersStoreForTests();
}

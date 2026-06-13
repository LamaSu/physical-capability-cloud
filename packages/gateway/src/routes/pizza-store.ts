/**
 * pizza-store — shared in-memory state + lifecycle logic for the vibecodenights
 * pizza demo (oracle + commitments + escrow + user-confirms-delivery).
 *
 * Two thin route layers sit on top of this store so they can share state
 * without a circular import:
 *   - pizza-demo.ts   → order lifecycle (order, confirm, accept, …, confirm-delivery)
 *   - pizza-oracle.ts → pre-commit, stake, evidence, reveal, commitments
 *
 * The flow the user asked for — NOTHING ships before every party pre-commits:
 *   1. confirm order
 *   2. PRE-COMMIT: the oracle is told the expected events (commitment templates
 *      with evidence requirements) and emits `pre_commit_required` to each party
 *   3. shop + driver + user each STAKE (hash-commit a secret + lock funds)
 *   4. ESCROW LOCK once all three have staked → emits `escrow_locked`
 *   5. only THEN is the make-pizza job dispatched
 *   6. shop submits an EvidenceBundle (photo + GPS + timestamp); oracle verifies
 *   7. delivery dispatched; driver submits breadcrumb + pickup + delivery bundles
 *   8. order enters `awaiting_user_confirmation` with a window → `awaiting_confirmation`
 *   9. user confirms → settle + reveal; OR the window lapses → `user_confirmation_timeout`
 *
 * Storage is in-memory (matches the demo substrate). Production swaps to facades
 * + the real EAS V2 escrow.
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  CommitmentEvidenceBundle,
  CommitmentEvidenceItem,
  CommitmentPartyRole,
  EvidenceRequirement,
  JobCommitment,
} from "@pcc/spec";

// ── Tunables ─────────────────────────────────────────────────────────────────

/** Parties must all stake within this window or the order auto-cancels. */
export const DEFAULT_STAKE_WINDOW_SEC = 120;
/** User must confirm delivery within this window or a penalty is applied. */
export const DEFAULT_CONFIRMATION_WINDOW_SEC = 300;
/** Demo geofence: shops cluster around this point. */
const DEFAULT_SHOP_CENTER = { lat: 37.77, lng: -122.42 };
const SHOP_GEOFENCE_RADIUS_M = 5_000;
/** Generous — covers transit breadcrumbs across the metro for the demo. */
const DELIVERY_GEOFENCE_RADIUS_M = 30_000;
/** Protocol fee, mirrors the on-chain MilestoneEscrow constant. */
const PCC_FEE_RATE = 0.0235;

// ── Types ────────────────────────────────────────────────────────────────────

export type OrderStatus =
  | "proposed"
  | "confirmed"
  | "staking"
  | "escrow_locked"
  | "awaiting_shop"
  | "making"
  | "ready_for_pickup"
  | "awaiting_driver"
  | "in_transit"
  | "awaiting_user_confirmation"
  | "delivered"
  | "rejected"
  | "cancelled"
  | "failed";

export interface ProviderRef {
  capabilityId: string;
  kernelId: string;
  name: string;
  priceUSD: number;
  etaSec: number;
}

export interface EscrowState {
  locked: boolean;
  totalLockedUSD: number;
  lockedAt?: string;
  /** Mock on-chain handle — real impl returns the EAS V2 attestation/tx. */
  txHash?: string;
  returned?: boolean;
}

export interface SettlementState {
  reason: "user_confirmed" | "user_timeout";
  shopPayoutUSD: number;
  driverPayoutUSD: number;
  pccFeeUSD: number;
  stakesReturnedUSD: number;
  reputation: { shopDelta: number; driverDelta: number; userDelta: number };
  settledAt: string;
}

export interface DemoOrder {
  orderId: string;
  userId: string;
  description: string;
  deliveryAddress: string;
  deliveryLocation: { lat: number; lng: number };
  maxPriceUSD: number;
  maxTimeMin: number;
  status: OrderStatus;
  composition?: {
    compositionId: string;
    shop: ProviderRef;
    driver: ProviderRef;
    totalPriceUSD: number;
    etaSec: number;
  };
  /** Oracle fulfillment job id — the spine for commitments + evidence. */
  jobId?: string;
  jobs: {
    makePizza?: string; // operator ticket jobId
    delivery?: string; // operator ticket jobId
  };
  escrow?: EscrowState;
  stakeDeadline?: string;
  confirmationDeadline?: string;
  userConfirmation?: "confirmed" | "timed_out";
  userPenaltyApplied?: boolean;
  settlement?: SettlementState;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DemoJob {
  jobId: string;
  orderId: string;
  type: "make-pizza" | "deliver-pizza";
  assigneeSlug: string;
  status:
    | "queued"
    | "accepted"
    | "picked_up"
    | "complete"
    | "rejected"
    | "expired";
  details: {
    description: string;
    priceUSD: number;
    deliveryAddress?: string;
    pickupAddress?: string;
    deadlineSec: number;
  };
  evidenceHash?: string;
  acceptedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface LoggedEvent {
  topic: string;
  event: unknown;
  ts: string;
}

/** Outcome shape returned by lifecycle helpers so routes can pick a status code. */
export interface OpResult<T> {
  ok: boolean;
  status: number; // HTTP status the route should send
  error?: string;
  message?: string;
  data?: T;
}

function ok<T>(data: T, status = 200): OpResult<T> {
  return { ok: true, status, data };
}
function fail(status: number, error: string, message?: string): OpResult<never> {
  return { ok: false, status, error, message };
}

// ── State ────────────────────────────────────────────────────────────────────

export const orders = new Map<string, DemoOrder>();
export const jobs = new Map<string, DemoJob>();
export const jobsByAssignee = new Map<string, string[]>(); // slug → ticket jobId[]
export const commitments = new Map<string, JobCommitment>(); // commitmentId → commitment
export const commitmentsByJob = new Map<string, string[]>(); // oracle jobId → commitmentId[]
export const evidenceBundles = new Map<string, CommitmentEvidenceBundle>(); // bundleId → bundle
export const evidenceByJob = new Map<string, string[]>(); // oracle jobId → bundleId[]
export const orderByJobId = new Map<string, string>(); // oracle jobId → orderId

const eventLog: LoggedEvent[] = [];
const MAX_EVENT_LOG = 1_000;

export const emitter = new EventEmitter();
emitter.setMaxListeners(500);

// ── Primitive helpers ──────────────────────────────────────────────────────—

export function nowIso(): string {
  return new Date().toISOString();
}

/** capability-id "cap_shop-roma" → "shop-roma"; "skill_x" → "x". */
export function deriveSlug(refId: string): string {
  return refId.replace(/^cap_/, "").replace(/^skill_/, "");
}

export function emit(topic: string, event: unknown): void {
  emitter.emit(topic, event);
  eventLog.push({ topic, event, ts: nowIso() });
  if (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
}

export function updateOrder(order: DemoOrder, status: OrderStatus): void {
  order.status = status;
  order.updatedAt = nowIso();
  emit(`order:${order.orderId}`, { type: "status", order });
}

/** hash(secret + jobId + partyId) — the hash-commit primitive. */
export function computeCommitmentHash(
  secret: string,
  jobId: string,
  partyId: string,
): string {
  return (
    "sha256:" +
    createHash("sha256").update(`${secret}:${jobId}:${partyId}`).digest("hex")
  );
}

/** sha256 over the canonicalized evidence array. */
export function hashEvidence(evidence: CommitmentEvidenceItem[]): string {
  return (
    "sha256:" + createHash("sha256").update(JSON.stringify(evidence)).digest("hex")
  );
}

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pushIndex(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

// ── Operator ticket dispatch (drives the operator/driver demo UIs) ───────────—

export function dispatchMakePizza(order: DemoOrder): DemoJob {
  if (!order.composition) throw new Error("no composition");
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const job: DemoJob = {
    jobId,
    orderId: order.orderId,
    type: "make-pizza",
    assigneeSlug: deriveSlug(order.composition.shop.capabilityId),
    status: "queued",
    details: {
      description: order.description,
      priceUSD: order.composition.shop.priceUSD,
      deadlineSec: order.composition.shop.etaSec,
    },
    createdAt: nowIso(),
  };
  jobs.set(jobId, job);
  pushIndex(jobsByAssignee, job.assigneeSlug, jobId);
  order.jobs.makePizza = jobId;
  emit(`operator:${job.assigneeSlug}`, { type: "job_assigned", job });
  return job;
}

export function dispatchDelivery(order: DemoOrder): DemoJob {
  if (!order.composition) throw new Error("no composition");
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const job: DemoJob = {
    jobId,
    orderId: order.orderId,
    type: "deliver-pizza",
    assigneeSlug: deriveSlug(order.composition.driver.capabilityId),
    status: "queued",
    details: {
      description: `Deliver ${order.description}`,
      priceUSD: order.composition.driver.priceUSD,
      pickupAddress: order.composition.shop.name,
      deliveryAddress: order.deliveryAddress,
      deadlineSec: order.composition.driver.etaSec,
    },
    createdAt: nowIso(),
  };
  jobs.set(jobId, job);
  pushIndex(jobsByAssignee, job.assigneeSlug, jobId);
  order.jobs.delivery = jobId;
  emit(`driver:${job.assigneeSlug}`, { type: "job_assigned", job });
  return job;
}

// ── Pre-commit ───────────────────────────────────────────────────────────────

export interface PreCommitOptions {
  stakeWindowSec?: number;
  /** Override the shop geofence centre (defaults to the demo SF cluster). */
  shopLocation?: { lat: number; lng: number };
}

function buildCommitment(
  jobId: string,
  orderId: string,
  partyId: string,
  partyRole: CommitmentPartyRole,
  description: string,
  evidenceRequirements: EvidenceRequirement[],
  deadlineSec: number,
  priceUSD: number | undefined,
  stakeUSD: number,
): JobCommitment {
  return {
    commitmentId: `cmt_${randomUUID().slice(0, 8)}`,
    jobId,
    orderId,
    partyId,
    partyRole,
    promise: { description, evidenceRequirements, deadlineSec, priceUSD },
    commitmentHash: "",
    stakeUSD,
    status: "pending",
    createdAt: nowIso(),
  };
}

/**
 * Generate the three commitment templates (shop, driver, user), tell each party
 * via SSE, and move the order into `staking`. Idempotent: if pre-commit already
 * ran for this order, returns the existing commitments.
 */
export function beginPreCommit(
  order: DemoOrder,
  opts: PreCommitOptions = {},
): OpResult<{ jobId: string; commitments: JobCommitment[] }> {
  if (!order.composition) {
    return fail(409, "no_composition", "order has no composition to commit to");
  }
  // Idempotent re-entry.
  if (order.jobId && commitmentsByJob.has(order.jobId)) {
    return ok({
      jobId: order.jobId,
      commitments: getCommitments(order.jobId),
    });
  }

  const jobId = `job_${randomUUID().slice(0, 8)}`;
  order.jobId = jobId;
  orderByJobId.set(jobId, order.orderId);

  const shopSlug = order.composition.shop.name;
  const driverSlug = order.composition.driver.name;
  const shopCenter = opts.shopLocation ?? DEFAULT_SHOP_CENTER;
  const deliveryCenter = order.deliveryLocation;
  const stakeWindowSec = opts.stakeWindowSec ?? DEFAULT_STAKE_WINDOW_SEC;
  order.stakeDeadline = new Date(Date.now() + stakeWindowSec * 1_000).toISOString();

  const shopReqs: EvidenceRequirement[] = [
    { kind: "photo", description: "photo of the finished pizza in its box" },
    {
      kind: "geolocation",
      description: "GPS reading at the shop when ready",
      geoConstraint: { ...shopCenter, radiusM: SHOP_GEOFENCE_RADIUS_M },
    },
    {
      kind: "timestamp",
      description: "timestamp the pizza was ready",
      timeConstraint: { withinSec: 3_600 },
    },
  ];
  const driverReqs: EvidenceRequirement[] = [
    {
      kind: "geolocation",
      description: "GPS breadcrumbs sampled ~every 30s during transit",
      geoConstraint: { ...deliveryCenter, radiusM: DELIVERY_GEOFENCE_RADIUS_M },
    },
    { kind: "photo", description: "photo of the pizza at pickup and at delivery" },
    { kind: "timestamp", description: "pickup + delivered timestamps" },
  ];
  const userReqs: EvidenceRequirement[] = [
    {
      kind: "attestation",
      description: "confirm receipt of the pizza within the confirmation window",
      timeConstraint: { withinSec: DEFAULT_CONFIRMATION_WINDOW_SEC },
    },
  ];

  const shopPrice = order.composition.shop.priceUSD;
  const driverPrice = order.composition.driver.priceUSD;
  const totalPrice = order.composition.totalPriceUSD;

  const shop = buildCommitment(
    jobId,
    order.orderId,
    shopSlug,
    "shop",
    `Make "${order.description}" and prove it's ready`,
    shopReqs,
    order.composition.shop.etaSec,
    shopPrice,
    Math.max(1, Math.round(shopPrice * 0.25)),
  );
  const driver = buildCommitment(
    jobId,
    order.orderId,
    driverSlug,
    "driver",
    `Pick up and deliver "${order.description}" to ${order.deliveryAddress}`,
    driverReqs,
    order.composition.driver.etaSec,
    driverPrice,
    Math.max(1, Math.round(driverPrice * 0.25)),
  );
  const user = buildCommitment(
    jobId,
    order.orderId,
    order.userId,
    "user",
    `Fund the order and confirm delivery within ${DEFAULT_CONFIRMATION_WINDOW_SEC}s`,
    userReqs,
    DEFAULT_CONFIRMATION_WINDOW_SEC,
    totalPrice,
    Math.round(totalPrice),
  );

  for (const c of [shop, driver, user]) {
    commitments.set(c.commitmentId, c);
    pushIndex(commitmentsByJob, jobId, c.commitmentId);
  }

  updateOrder(order, "staking");

  // Tell each party — distinct topics.
  emit(`operator:${shopSlug}`, { type: "pre_commit_required", commitment: shop });
  emit(`driver:${driverSlug}`, { type: "pre_commit_required", commitment: driver });
  emit(`order:${order.orderId}`, { type: "pre_commit_required", commitment: user });

  return ok({ jobId, commitments: [shop, driver, user] }, 201);
}

// ── Stake ────────────────────────────────────────────────────────────────────

export interface StakeBody {
  partyId?: string;
  stakeUSD?: number;
  commitmentHash?: string;
}

export function stakeCommitment(
  jobId: string,
  body: StakeBody,
): OpResult<{ commitment: JobCommitment; allStaked: boolean; order: DemoOrder }> {
  const orderId = orderByJobId.get(jobId);
  const order = orderId ? orders.get(orderId) : undefined;
  if (!order) return fail(404, "not_found", `no order for job ${jobId}`);

  if (!body || typeof body.partyId !== "string" || !body.partyId) {
    return fail(400, "invalid_request", "partyId required");
  }
  if (typeof body.commitmentHash !== "string" || !body.commitmentHash) {
    return fail(400, "invalid_request", "commitmentHash required");
  }
  if (typeof body.stakeUSD !== "number" || body.stakeUSD < 0 || Number.isNaN(body.stakeUSD)) {
    return fail(400, "invalid_request", "stakeUSD must be a non-negative number");
  }

  // Lazily enforce the stake window before accepting a (possibly late) stake.
  sweepStakeWindow(order);
  if (order.status !== "staking") {
    return fail(
      409,
      "stake_window_closed",
      `order is ${order.status}; staking is closed`,
    );
  }

  const commitment = getCommitments(jobId).find((c) => c.partyId === body.partyId);
  if (!commitment) {
    return fail(404, "no_commitment", `no commitment for party ${body.partyId}`);
  }
  if (commitment.status !== "pending") {
    return fail(409, "already_staked", `party ${body.partyId} already staked`);
  }

  commitment.commitmentHash = body.commitmentHash;
  commitment.stakeUSD = body.stakeUSD;
  commitment.status = "committed";
  commitment.stakedAt = nowIso();
  emit(`order:${order.orderId}`, {
    type: "party_staked",
    partyId: commitment.partyId,
    partyRole: commitment.partyRole,
  });

  const all = getCommitments(jobId);
  const allStaked = all.every((c) => c.status !== "pending");
  if (allStaked) lockEscrowAndDispatch(order);

  return ok({ commitment, allStaked, order });
}

function lockEscrowAndDispatch(order: DemoOrder): void {
  const stakeTotal = getCommitments(order.jobId!).reduce(
    (sum, c) => sum + c.stakeUSD,
    0,
  );
  const totalLockedUSD = +(
    (order.composition?.totalPriceUSD ?? 0) + stakeTotal
  ).toFixed(2);
  order.escrow = {
    locked: true,
    totalLockedUSD,
    lockedAt: nowIso(),
    txHash: `0xmock${randomUUID().replace(/-/g, "").slice(0, 24)}`,
  };
  updateOrder(order, "escrow_locked");
  emit(`order:${order.orderId}`, { type: "escrow_locked", escrow: order.escrow });

  // Only NOW is work dispatched.
  updateOrder(order, "awaiting_shop");
  dispatchMakePizza(order);
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export interface EvidenceBody {
  bundleId?: string;
  jobId?: string;
  partyId?: string;
  evidence?: CommitmentEvidenceItem[];
  bundleHash?: string;
  createdAt?: string;
}

function hasPhoto(b: CommitmentEvidenceBundle): boolean {
  return b.evidence.some((e) => e.kind === "photo" && !!e.photoBase64);
}

/**
 * Validate a submitted bundle against the submitting party's commitment
 * requirements. Returns null when valid, or an OpResult error.
 *
 * The shop submits ONE complete bundle, so every requirement (photo, in-fence
 * GPS, timestamp) must be satisfied. The driver submits INCREMENTALLY —
 * geolocation breadcrumbs in transit, then photo+timestamp on pickup/delivery —
 * so per-bundle we only enforce what's universal (any GPS present must be
 * inside the geofence) and require each bundle to carry location; the photo +
 * timestamp arrive on the pickup/delivery bundles and drive the transitions.
 */
function validateAgainstCommitment(
  bundle: CommitmentEvidenceBundle,
  commitment: JobCommitment,
): OpResult<never> | null {
  // The driver's evidence arrives across many bundles; the shop's is one shot.
  const incremental = commitment.partyRole === "driver";

  for (const req of commitment.promise.evidenceRequirements) {
    if (req.kind === "geolocation") {
      const geos = bundle.evidence.filter((e) => e.kind === "geolocation" && e.geo);
      if (geos.length === 0) {
        return fail(
          400,
          "missing_geolocation",
          `evidence is missing required geolocation: ${req.description}`,
        );
      }
      // Geofence is universal — a bad GPS reading fails for any party.
      if (req.geoConstraint) {
        const center = { lat: req.geoConstraint.lat, lng: req.geoConstraint.lng };
        for (const g of geos) {
          const dist = haversineMeters(center, g.geo!);
          if (dist > req.geoConstraint.radiusM) {
            return fail(
              400,
              "geo_outside_geofence",
              `geolocation ${dist.toFixed(0)}m from required point exceeds ${req.geoConstraint.radiusM}m geofence`,
            );
          }
        }
      }
    } else if (req.kind === "photo" && !incremental) {
      const photo = bundle.evidence.find(
        (e) => e.kind === "photo" && !!e.photoBase64,
      );
      if (!photo) {
        return fail(400, "missing_photo", `evidence is missing required photo: ${req.description}`);
      }
    } else if (req.kind === "timestamp" && !incremental) {
      const ts = bundle.evidence.some(
        (e) => e.kind === "timestamp" && !!e.timestamp,
      );
      if (!ts) {
        return fail(
          400,
          "missing_timestamp",
          `evidence is missing required timestamp: ${req.description}`,
        );
      }
    }
    // "hash" / "attestation" requirements are advisory in the demo.
  }
  return null;
}

export function submitEvidence(
  jobId: string,
  body: EvidenceBody,
): OpResult<{ bundle: CommitmentEvidenceBundle; order: DemoOrder; phase: string }> {
  const orderId = orderByJobId.get(jobId);
  const order = orderId ? orders.get(orderId) : undefined;
  if (!order) return fail(404, "not_found", `no order for job ${jobId}`);

  if (!order.escrow?.locked) {
    return fail(
      409,
      "escrow_not_locked",
      "cannot submit evidence before escrow locks (all parties must stake first)",
    );
  }
  if (!body || typeof body.partyId !== "string" || !body.partyId) {
    return fail(400, "invalid_request", "partyId required");
  }
  if (!Array.isArray(body.evidence) || body.evidence.length === 0) {
    return fail(400, "invalid_request", "evidence[] required and must be non-empty");
  }

  const commitment = getCommitments(jobId).find((c) => c.partyId === body.partyId);
  if (!commitment) {
    return fail(400, "no_commitment", `party ${body.partyId} did not pre-commit`);
  }

  const bundleId = body.bundleId ?? `bundle_${randomUUID().slice(0, 8)}`;
  if (evidenceBundles.has(bundleId)) {
    return fail(409, "duplicate_evidence", `bundle ${bundleId} already submitted`);
  }

  const bundle: CommitmentEvidenceBundle = {
    bundleId,
    jobId,
    partyId: body.partyId,
    evidence: body.evidence,
    bundleHash: hashEvidence(body.evidence),
    createdAt: body.createdAt ?? nowIso(),
  };

  // Oracle verification: shape + geofence + required kinds.
  const invalid = validateAgainstCommitment(bundle, commitment);
  if (invalid) return invalid;

  evidenceBundles.set(bundleId, bundle);
  pushIndex(evidenceByJob, jobId, bundleId);
  emit(`order:${order.orderId}`, {
    type: "oracle_verified",
    bundleId,
    partyId: bundle.partyId,
    partyRole: commitment.partyRole,
    bundleHash: bundle.bundleHash,
  });

  const phase = advanceOnEvidence(order, commitment.partyRole, bundle);
  return ok({ bundle, order, phase });
}

/** Move the order forward based on who submitted what. Returns the phase label. */
function advanceOnEvidence(
  order: DemoOrder,
  role: CommitmentPartyRole,
  bundle: CommitmentEvidenceBundle,
): string {
  if (role === "shop") {
    if (order.status === "awaiting_shop" || order.status === "making" || order.status === "escrow_locked") {
      markTicket(order.jobs.makePizza, "complete", bundle.bundleHash);
      updateOrder(order, "awaiting_driver");
      dispatchDelivery(order);
      return "shop_complete";
    }
    return "shop_extra";
  }

  if (role === "driver") {
    const photo = hasPhoto(bundle);
    if (photo && (order.status === "awaiting_driver" || order.status === "ready_for_pickup")) {
      markTicket(order.jobs.delivery, "picked_up");
      updateOrder(order, "in_transit");
      emit(`order:${order.orderId}`, { type: "driver_pickup", bundleId: bundle.bundleId });
      return "driver_pickup";
    }
    if (photo && order.status === "in_transit") {
      markTicket(order.jobs.delivery, "complete", bundle.bundleHash);
      openConfirmationWindow(order);
      return "driver_delivered";
    }
    // Breadcrumb-only (no photo) — accumulate, no transition.
    emit(`order:${order.orderId}`, {
      type: "breadcrumb",
      count: (evidenceByJob.get(order.jobId!) ?? []).length,
    });
    return "breadcrumb";
  }

  return "noop";
}

function markTicket(
  ticketId: string | undefined,
  status: DemoJob["status"],
  evidenceHash?: string,
): void {
  if (!ticketId) return;
  const t = jobs.get(ticketId);
  if (!t) return;
  t.status = status;
  if (status === "complete") t.completedAt = nowIso();
  if (evidenceHash) t.evidenceHash = evidenceHash;
}

function openConfirmationWindow(order: DemoOrder): void {
  order.confirmationDeadline = new Date(
    Date.now() + DEFAULT_CONFIRMATION_WINDOW_SEC * 1_000,
  ).toISOString();
  updateOrder(order, "awaiting_user_confirmation");
  emit(`order:${order.orderId}`, {
    type: "awaiting_confirmation",
    confirmationDeadline: order.confirmationDeadline,
    windowSec: DEFAULT_CONFIRMATION_WINDOW_SEC,
  });
}

// ── Reveal (fraud detection) ─────────────────────────────────────────────────

export interface RevealBody {
  partyId?: string;
  secret?: string;
}

export function revealSecret(
  jobId: string,
  body: RevealBody,
): OpResult<{ commitment: JobCommitment; fraud: boolean }> {
  if (!orderByJobId.has(jobId)) {
    return fail(404, "not_found", `no order for job ${jobId}`);
  }
  if (!body || typeof body.partyId !== "string" || !body.partyId) {
    return fail(400, "invalid_request", "partyId required");
  }
  if (typeof body.secret !== "string" || !body.secret) {
    return fail(400, "invalid_request", "secret required");
  }
  const commitment = getCommitments(jobId).find((c) => c.partyId === body.partyId);
  if (!commitment) {
    return fail(404, "no_commitment", `no commitment for party ${body.partyId}`);
  }
  if (commitment.status === "pending") {
    return fail(409, "not_staked", `party ${body.partyId} has not staked`);
  }

  const expected = computeCommitmentHash(body.secret, jobId, body.partyId);
  const fraud = expected !== commitment.commitmentHash;
  commitment.revealedSecret = body.secret;
  commitment.resolvedAt = nowIso();
  if (fraud) {
    commitment.status = "slashed";
    emit(`order:${commitment.orderId}`, {
      type: "fraud_detected",
      partyId: commitment.partyId,
      partyRole: commitment.partyRole,
      action: "stake_slashed",
    });
  } else if (commitment.status !== "released") {
    commitment.status = "revealed";
    emit(`order:${commitment.orderId}`, {
      type: "secret_revealed",
      partyId: commitment.partyId,
      partyRole: commitment.partyRole,
    });
  }
  return ok({ commitment, fraud });
}

// ── Confirm delivery + settlement ────────────────────────────────────────────

export function confirmDelivery(
  orderId: string,
): OpResult<{ order: DemoOrder; settlement: SettlementState }> {
  const order = orders.get(orderId);
  if (!order) return fail(404, "not_found", `no order ${orderId}`);

  // A late poll may have already timed the window out.
  sweepConfirmationWindow(order);
  if (order.status !== "awaiting_user_confirmation") {
    if (order.userConfirmation === "timed_out") {
      return fail(409, "confirmation_window_expired", "user confirmation window already expired");
    }
    return fail(409, "wrong_state", `expected awaiting_user_confirmation, got ${order.status}`);
  }

  order.userConfirmation = "confirmed";
  const settlement = releaseSettlement(order, "user_confirmed");
  updateOrder(order, "delivered");
  emitToAllParties(order, { type: "delivery_confirmed", confirmedBy: "user", settlement });
  return ok({ order, settlement });
}

function releaseSettlement(
  order: DemoOrder,
  reason: SettlementState["reason"],
): SettlementState {
  // Honest completion → every committed/revealed stake is returned (released).
  for (const c of getCommitments(order.jobId ?? "")) {
    if (c.status === "committed" || c.status === "revealed") {
      c.status = "released";
      c.resolvedAt = nowIso();
    }
  }
  const shopPayoutUSD = order.composition?.shop.priceUSD ?? 0;
  const driverPayoutUSD = order.composition?.driver.priceUSD ?? 0;
  const totalPrice = order.composition?.totalPriceUSD ?? 0;
  const stakesReturnedUSD = getCommitments(order.jobId ?? "").reduce(
    (sum, c) => sum + (c.status === "released" ? c.stakeUSD : 0),
    0,
  );
  const settlement: SettlementState = {
    reason,
    shopPayoutUSD,
    driverPayoutUSD,
    pccFeeUSD: +(totalPrice * PCC_FEE_RATE).toFixed(2),
    stakesReturnedUSD: +stakesReturnedUSD.toFixed(2),
    reputation: {
      shopDelta: 15,
      driverDelta: 15,
      // Confirming on time is rewarded; timing out is penalized.
      userDelta: reason === "user_confirmed" ? 5 : -10,
    },
    settledAt: nowIso(),
  };
  order.settlement = settlement;
  if (order.escrow) order.escrow.locked = false;
  emit(`order:${order.orderId}`, { type: "settlement_released", settlement });
  return settlement;
}

function emitToAllParties(order: DemoOrder, event: unknown): void {
  emit(`order:${order.orderId}`, event);
  if (order.composition) {
    emit(`operator:${order.composition.shop.name}`, event);
    emit(`driver:${order.composition.driver.name}`, event);
  }
}

// ── Window sweeps (lazy timers; deterministic for tests) ─────────────────────—

/** Auto-cancel + return escrow if not all parties staked before the deadline. */
export function sweepStakeWindow(order: DemoOrder, nowMs = Date.now()): boolean {
  if (order.status !== "staking" || !order.stakeDeadline) return false;
  if (nowMs <= Date.parse(order.stakeDeadline)) return false;
  const all = getCommitments(order.jobId ?? "");
  if (all.length > 0 && all.every((c) => c.status !== "pending")) return false; // all staked in time

  const unstaked = all.filter((c) => c.status === "pending").map((c) => c.partyId);
  order.rejectionReason = `stake window expired — not all parties staked (${unstaked.join(", ")})`;
  // No escrow was locked yet; any early stakes are returned.
  if (order.escrow) order.escrow.returned = true;
  updateOrder(order, "cancelled");
  emit(`order:${order.orderId}`, {
    type: "stake_window_expired",
    unstaked,
  });
  emit(`order:${order.orderId}`, {
    type: "escrow_returned",
    reason: "stake_window_expired",
  });
  return true;
}

/** Penalize the user if they don't confirm before the deadline. */
export function sweepConfirmationWindow(order: DemoOrder, nowMs = Date.now()): boolean {
  if (order.status !== "awaiting_user_confirmation" || !order.confirmationDeadline) {
    return false;
  }
  if (nowMs <= Date.parse(order.confirmationDeadline)) return false;
  if (order.userConfirmation) return false;

  order.userConfirmation = "timed_out";
  order.userPenaltyApplied = true;
  // Providers did their job (evidence on file) → they're paid; the user is dinged.
  const settlement = releaseSettlement(order, "user_timeout");
  updateOrder(order, "delivered");
  emit(`order:${order.orderId}`, {
    type: "user_confirmation_timeout",
    penalty: { userReputationDelta: settlement.reputation.userDelta, forcedDispute: true },
  });
  emitToAllParties(order, { type: "delivery_confirmed", confirmedBy: "timeout", settlement });
  return true;
}

// ── Read accessors ───────────────────────────────────────────────────────────

export function getCommitments(jobId: string): JobCommitment[] {
  return (commitmentsByJob.get(jobId) ?? [])
    .map((id) => commitments.get(id))
    .filter((c): c is JobCommitment => !!c);
}

export function getEvidence(jobId: string): CommitmentEvidenceBundle[] {
  return (evidenceByJob.get(jobId) ?? [])
    .map((id) => evidenceBundles.get(id))
    .filter((b): b is CommitmentEvidenceBundle => !!b);
}

export function getEventsForTopics(topics: string[]): LoggedEvent[] {
  const set = new Set(topics);
  return eventLog.filter((e) => set.has(e.topic));
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _clearPizzaForTests(): void {
  orders.clear();
  jobs.clear();
  jobsByAssignee.clear();
  commitments.clear();
  commitmentsByJob.clear();
  evidenceBundles.clear();
  evidenceByJob.clear();
  orderByJobId.clear();
  eventLog.length = 0;
  emitter.removeAllListeners();
}

/** All logged events (optionally filtered by event `type`). */
export function _getEvents(type?: string): LoggedEvent[] {
  return type
    ? eventLog.filter((e) => (e.event as { type?: string })?.type === type)
    : [...eventLog];
}

export function _hasEvent(type: string): boolean {
  return eventLog.some((e) => (e.event as { type?: string })?.type === type);
}

/** Force the stake window past its deadline and run the sweep. */
export function _expireStakeWindow(jobId: string): DemoOrder | undefined {
  const orderId = orderByJobId.get(jobId);
  const order = orderId ? orders.get(orderId) : undefined;
  if (!order) return undefined;
  order.stakeDeadline = new Date(Date.now() - 1_000).toISOString();
  sweepStakeWindow(order);
  return order;
}

/** Force the confirmation window past its deadline and run the sweep. */
export function _expireConfirmationWindow(orderId: string): DemoOrder | undefined {
  const order = orders.get(orderId);
  if (!order) return undefined;
  order.confirmationDeadline = new Date(Date.now() - 1_000).toISOString();
  sweepConfirmationWindow(order);
  return order;
}

/**
 * Seed a `proposed` order with a shop+driver composition without going through
 * the compose engine — keeps oracle-lifecycle tests focused and deterministic.
 */
export function _seedOrderForTests(
  over: Partial<{
    orderId: string;
    userId: string;
    shopSlug: string;
    driverSlug: string;
    shopPriceUSD: number;
    driverPriceUSD: number;
    deliveryLocation: { lat: number; lng: number };
  }> = {},
): DemoOrder {
  const orderId = over.orderId ?? `order_${randomUUID().slice(0, 8)}`;
  const shopSlug = over.shopSlug ?? "shop-roma";
  const driverSlug = over.driverSlug ?? "driver-alex";
  const shopPriceUSD = over.shopPriceUSD ?? 15;
  const driverPriceUSD = over.driverPriceUSD ?? 5;
  const order: DemoOrder = {
    orderId,
    userId: over.userId ?? "user_demo",
    description: "Margherita pizza",
    deliveryAddress: "123 Maker St, SF",
    deliveryLocation: over.deliveryLocation ?? { lat: 37.77, lng: -122.42 },
    maxPriceUSD: 30,
    maxTimeMin: 30,
    status: "proposed",
    composition: {
      compositionId: `cmp_${randomUUID().slice(0, 8)}`,
      shop: {
        capabilityId: `cap_${shopSlug}`,
        kernelId: `k_${shopSlug}`,
        name: shopSlug,
        priceUSD: shopPriceUSD,
        etaSec: 900,
      },
      driver: {
        capabilityId: `cap_${driverSlug}`,
        kernelId: `k_${driverSlug}`,
        name: driverSlug,
        priceUSD: driverPriceUSD,
        etaSec: 1_500,
      },
      totalPriceUSD: shopPriceUSD + driverPriceUSD,
      etaSec: 2_400,
    },
    jobs: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  orders.set(orderId, order);
  return order;
}

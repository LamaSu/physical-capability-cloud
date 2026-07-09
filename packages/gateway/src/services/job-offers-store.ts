/**
 * Job-offers store — the generic matching primitive at the heart of PCC.
 *
 * Gateway holds primitives; adapters hold category-specific shape. Every
 * PCC adapter (pcc-courier, pcc-dominos, pcc-hamilton, pcc-kdense,
 * pcc-opentrons, future ones in their own repos) needs the same matching
 * surface: "post an open offer, operators with matching capabilities poll
 * + claim, lifecycle proceeds." This store IS that surface.
 *
 * Generalized from `courier-jobs-store.ts` (xray's v0.2 fold) so that
 * `capability_type` is first-class and `requirements` is opaque JSON
 * validated against the registered capability schema (when one exists).
 *
 * Mirrors the original surface, with names generalized:
 *   • POST   /api/job-offers                   — create open offer
 *   • GET    /api/job-offers/open              — operator/driver feed
 *   • GET    /api/job-offers/:id               — single offer + events
 *   • POST   /api/job-offers/:id/claim         — race-safe claim
 *   • POST   /api/job-offers/:id/events        — operator progress
 *   • POST   /api/job-offers/:id/heartbeat     — poster liveness
 *   • PATCH  /api/job-offers/:id               — poster edits
 *   • DELETE /api/job-offers/:id               — poster cancels
 *   • GET    /api/job-offers/healthz           — liveness
 *
 * Background sweeper handles: TTL expiry, heartbeat-loss expiry, and periodic
 * re-verify against sourceVerifyUrl.
 *
 * Persistence: SQLite (raw SQL via better-sqlite3), wired into the gateway
 * store at boot. In-memory mode (no sqlite handle) is the default for tests.
 *
 * Auth boundary: routes are auth-gated by apiGate; the *poster identity* is
 * the API key's operatorId (NOT the X-Posted-By header from v0.2 — the
 * standalone service had no auth, so it trusted the header).
 *   - PATCH/DELETE/heartbeat require poster === current operatorId.
 *   - claim/events/get are open to any authenticated caller (operator agents).
 */

// Structural type for the raw better-sqlite3 handle we get from
// drizzle's `db.$client`. Avoiding a direct better-sqlite3 import keeps
// the gateway's dependency surface unchanged (it pulls better-sqlite3
// transitively through @pcc/store).
export interface SqliteDatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec?(sql: string): unknown;
}

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Optional GeoJSON polygon for area-bound capabilities (e.g., service area
 * for courier, drone-survey footprint). When present, the offer is filtered
 * out of /open feeds whose ?within= probe falls outside this polygon.
 */
export type GeoFence = {
  type: "Polygon";
  coordinates: number[][][];
} | null;

/**
 * Pricing model — generalized from courier's flat feeUSD field. Covers:
 *   • fixed-amount (e.g. courier $7 fee, pizza $21.71 total)
 *   • quote-required (operator must respond with a quote before claim)
 *   • per-unit (e.g. $40/sample lab work, $2/gpu-hour compute)
 */
export interface PricingSpec {
  amount: number;                 // base amount or per-unit price
  currency: "USD" | "USDC" | "ETH" | "BTC" | string;
  model: "fixed" | "quote-required" | "per-unit";
  unit?: string;                  // e.g. "sample", "gpu-hour", "mile"
}

/**
 * Evidence requirements per category (Part C of categorization doc).
 * Lab work: chain-of-custody. Manufacturing: dimensional measurement +
 * photo-with-nonce-card. Compute: heartbeats + uptime metrics. Opaque to
 * the gateway; carried so operators can know what to deliver.
 */
export interface EvidenceRequirements {
  events_required?: string[];     // e.g. ["intake", "instrument_run", "completion"]
  photos_required?: boolean;
  raw_data_required?: boolean;
  chain_of_custody?: boolean;
  tier_required?: 0 | 1 | 2 | 3;
  [k: string]: unknown;
}

export type JobOfferStatus =
  | "open"
  | "claimed"
  | "in_progress"
  | "delivered"
  | "settled"
  | "cancelled"
  | "expired"
  | "disputed";

export interface JobOffer {
  id: string;
  capabilityType: string;            // e.g. "courier.dispatch", "pizza.order", "lab.hplc", "opentrons.runProtocol"
  requirements: Record<string, unknown>;  // category-specific opaque shape; validated against schema if registered
  requirementsValidated: boolean;    // true if capability type's schema matched; false if no schema registered (graceful degrade)
  serviceAreaGeofence: GeoFence;
  pricing: PricingSpec;
  deadlineIso: string | null;        // optional hard deadline
  assuranceTier: 0 | 1 | 2 | 3 | null;
  evidenceRequirements: EvidenceRequirements | null;
  sourceVerifyUrl: string | null;
  requireHeartbeat: boolean;

  posterDid: string | null;          // DID of the agent who posted the offer
  posterKernelId: string | null;     // optional — when poster is a kernel rebroadcasting
  idempotencyKey: string | null;

  status: JobOfferStatus;
  postedAt: string;
  validUntil: string;

  claimedByKernelId: string | null;
  claimedAt: string | null;
  claimSignature: string | null;
  driverEtaMin?: number | null;      // generic ETA (operator commit-by time)
  driverContact?: string | null;

  verified: boolean;
  lastVerifyAt: string | null;
  lastHeartbeatAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
}

export interface JobOfferEvent {
  at: string;
  event: string;                     // "posted" | "claimed" | "acknowledged" | "in_progress" | "progress_update" | "delivered" | "error" | "patched" | "expired" | "cancelled" | "heartbeat" | ...
  [k: string]: unknown;
}

export interface CreateJobOfferInput {
  id?: string;                       // optional — caller-provided id (used by courier-shim for deliveryId)
  capabilityType: string;
  requirements: Record<string, unknown>;
  serviceAreaGeofence?: GeoFence;
  pricing: PricingSpec;
  deadline?: string | null;
  assuranceTier?: 0 | 1 | 2 | 3 | null;
  evidenceRequirements?: EvidenceRequirements | null;
  sourceVerifyUrl?: string | null;
  requireHeartbeat?: boolean;
  posterDid?: string | null;
  posterKernelId?: string | null;
  idempotencyKey?: string | null;
  validUntilIso?: string | null;     // optional explicit TTL; otherwise default 2h or driven by requirements.pickupReadyAt
}

export interface ClaimInput {
  kernelId: string;
  claimSignature?: string;
  etaMin?: number;
  contact?: string;
}

/**
 * Fired once per NEWLY-created offer (never on an idempotent replay — see
 * the `created` guard at the call site in `create()`). Best-effort: the
 * store awaits it but swallows any error, so a broken notifier can never
 * fail the underlying job-offer creation. The real (DB + dispatchToChannels
 * backed) implementation lives in services/job-offer-notifier.ts and is
 * wired in at boot by server.ts; omit this option (as existing tests do) for
 * a pure no-op, matching pre-existing behaviour exactly.
 */
export type OperatorNotifier = (offer: JobOffer) => void | Promise<unknown>;

// ── Capability schema lookup (graceful degrade) ────────────────────────────

/**
 * Validator hook for capability-type-specific schemas. Returns:
 *   - { ok: true, validated: true } when a schema exists for the type and
 *     the requirements pass.
 *   - { ok: true, validated: false } when no schema is registered for the
 *     type — graceful degrade, accept the offer with `requirementsValidated:
 *     false`.
 *   - { ok: false, error: "<reason>" } when a schema exists and rejects.
 *
 * Today the capability-type schema infrastructure (capability-facade,
 * `buildExecuteInputSchema` in routes/capabilities.ts) is scoped to
 * templates; full schema-per-type isn't wired yet. We accept all requirements
 * shapes as opaque JSON and mark requirements_validated=false until the
 * capability schema registry lands. See followups in
 * docs/JOB_OFFERS.md.
 */
export type CapabilitySchemaValidator = (
  capabilityType: string,
  requirements: Record<string, unknown>,
) => Promise<{ ok: true; validated: boolean } | { ok: false; error: string }>;

const defaultSchemaValidator: CapabilitySchemaValidator = async () => {
  // Graceful degrade — no schema registry connected yet. Accept all
  // requirements shapes; downstream consumers (the LLM-at-user-agent layer,
  // the operator claim flow) are responsible for shape correctness.
  return { ok: true, validated: false };
};

// ── Helpers ────────────────────────────────────────────────────────────────

export const nowIso = (): string => new Date().toISOString();
export const nowMs = (): number => Date.now();

const isoToMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

export const haversineMiles = (
  lat1: number, lng1: number, lat2: number, lng2: number,
): number => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

/**
 * Compute default TTL. Logic:
 *   - If caller provided explicit validUntilIso, use it.
 *   - If the requirements blob carries a `pickupReadyAt` (courier convention)
 *     or `deadline` (generic), TTL = that + 30min grace.
 *   - Otherwise: postedAt + 2h.
 */
export const computeValidUntilMs = (
  requirements: Record<string, unknown>,
  postedAtIso: string,
  explicitValidUntilIso?: string | null,
): number => {
  if (explicitValidUntilIso) {
    const ms = isoToMs(explicitValidUntilIso);
    if (ms != null) return ms;
  }
  // Look for category-specific timing hints in requirements.
  const pickupReadyAt = typeof requirements.pickupReadyAt === "string"
    ? requirements.pickupReadyAt
    : null;
  const deadline = typeof requirements.deadline === "string"
    ? requirements.deadline
    : null;
  const hint = pickupReadyAt ?? deadline;
  const hintMs = hint ? isoToMs(hint) : null;
  if (hintMs != null) return hintMs + 30 * 60 * 1000;
  const postedMs = isoToMs(postedAtIso) ?? nowMs();
  return postedMs + 2 * 60 * 60 * 1000;
};

// Pull a {lat,lng} from common requirements shapes for haversine filtering.
// Tries pickup.{lat,lng} (courier shape), location.{lat,lng} (lab/site
// shape), and origin.{lat,lng}.
function extractRequirementsCoords(
  requirements: Record<string, unknown>,
): { lat: number; lng: number } | null {
  const probes: Array<Record<string, unknown> | undefined> = [
    requirements.pickup as Record<string, unknown> | undefined,
    requirements.location as Record<string, unknown> | undefined,
    requirements.origin as Record<string, unknown> | undefined,
    requirements,
  ];
  for (const p of probes) {
    if (!p) continue;
    const lat = p.lat;
    const lng = p.lng;
    if (typeof lat === "number" && typeof lng === "number") {
      return { lat, lng };
    }
  }
  return null;
}

// Verify against external source. Same semantics as v0.2:
//   ok=true if HTTP 2xx (treats non-JSON 2xx as alive),
//   ok=false on non-2xx, on placed:false/valid:false, on fetch error.
export type VerifyOk = { ok: true; body: unknown };
export type VerifyFail = {
  ok: false;
  reason: "http_non_2xx" | "source_says_not_real" | "verify_request_failed";
  status?: number;
  body?: unknown;
  error?: string;
};
export type VerifyResult = VerifyOk | VerifyFail;

export type VerifyFn = (url: string) => Promise<VerifyResult>;

const defaultVerifyFn: VerifyFn = async (url) => {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      let body: string | null = null;
      try { body = await res.text(); } catch { /* ignore */ }
      return {
        ok: false,
        reason: "http_non_2xx",
        status: res.status,
        body: body?.slice(0, 500) ?? null,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: true, body: null };
    }
    if (
      body && typeof body === "object" &&
      ((body as Record<string, unknown>).placed === false ||
       (body as Record<string, unknown>).valid === false)
    ) {
      return { ok: false, reason: "source_says_not_real", status: res.status, body };
    }
    return { ok: true, body };
  } catch (err) {
    return {
      ok: false,
      reason: "verify_request_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// ── Store ──────────────────────────────────────────────────────────────────

export interface JobOffersStoreOptions {
  /** Provide a sqlite db for persistent storage; omit for pure in-memory. */
  sqlite?: SqliteDatabaseLike;
  /** Override the source-verify implementation (tests inject a stub). */
  verify?: VerifyFn;
  /** Override "now" for tests. */
  now?: () => Date;
  /** Override the capability-schema validator (defaults to graceful-degrade no-op). */
  validateSchema?: CapabilitySchemaValidator;
  /** Called once per newly-created offer to notify eligible operators. Omit for a no-op. */
  notifyOperators?: OperatorNotifier;
}

/**
 * Storage + business logic for generic job offers. Pure functions over Map +
 * optional SQLite write-through for durability across restarts. Sweeper is
 * separate (services/job-offers-sweeper.ts).
 */
export class JobOffersStore {
  private readonly offers = new Map<string, JobOffer>();
  private readonly events = new Map<string, JobOfferEvent[]>();
  private readonly claimLocks = new Map<string, Promise<void>>();
  private readonly idempotencyIndex = new Map<string, string>(); // key -> id
  private readonly verify: VerifyFn;
  private readonly validateSchema: CapabilitySchemaValidator;
  private readonly nowFn: () => Date;
  private readonly sqlite: SqliteDatabaseLike | undefined;
  private readonly notifyOperators: OperatorNotifier | undefined;

  constructor(opts: JobOffersStoreOptions = {}) {
    this.sqlite = opts.sqlite;
    this.verify = opts.verify ?? defaultVerifyFn;
    this.validateSchema = opts.validateSchema ?? defaultSchemaValidator;
    this.nowFn = opts.now ?? (() => new Date());
    this.notifyOperators = opts.notifyOperators;
    if (this.sqlite) this.hydrateFromSqlite();
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }

  private nowMs(): number {
    return this.nowFn().getTime();
  }

  // ── Hydration (boot recovery) ────────────────────────────────────────────

  private hydrateFromSqlite(): void {
    if (!this.sqlite) return;
    try {
      const rows = this.sqlite
        .prepare("SELECT id, data FROM job_offers")
        .all() as Array<{ id: string; data: string }>;
      for (const r of rows) {
        try {
          const offer = JSON.parse(r.data) as JobOffer;
          this.offers.set(offer.id, offer);
          if (offer.idempotencyKey) {
            this.idempotencyIndex.set(offer.idempotencyKey, offer.id);
          }
        } catch { /* skip corrupt rows */ }
      }
      const eventRows = this.sqlite
        .prepare("SELECT offer_id, data FROM job_offer_events ORDER BY id ASC")
        .all() as Array<{ offer_id: string; data: string }>;
      for (const r of eventRows) {
        try {
          const evt = JSON.parse(r.data) as JobOfferEvent;
          if (!this.events.has(r.offer_id)) this.events.set(r.offer_id, []);
          this.events.get(r.offer_id)!.push(evt);
        } catch { /* skip */ }
      }
    } catch {
      // Tables may not exist yet on first boot — migrate.ts will create them.
    }
  }

  private persistOffer(offer: JobOffer): void {
    if (!this.sqlite) return;
    try {
      this.sqlite
        .prepare(`INSERT INTO job_offers
                    (id, capability_type, status, data, posted_at, poster_did, valid_until, idempotency_key)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    data = excluded.data,
                    valid_until = excluded.valid_until`)
        .run(
          offer.id,
          offer.capabilityType,
          offer.status,
          JSON.stringify(offer),
          offer.postedAt,
          offer.posterDid,
          offer.validUntil,
          offer.idempotencyKey,
        );
    } catch { /* non-fatal; in-memory copy is the source of truth */ }
  }

  private persistEvent(offerId: string, evt: JobOfferEvent): void {
    if (!this.sqlite) return;
    try {
      this.sqlite
        .prepare("INSERT INTO job_offer_events (offer_id, at, data) VALUES (?, ?, ?)")
        .run(offerId, evt.at, JSON.stringify(evt));
    } catch { /* non-fatal */ }
  }

  private appendEvent(offerId: string, evt: JobOfferEvent): void {
    if (!this.events.has(offerId)) this.events.set(offerId, []);
    this.events.get(offerId)!.push(evt);
    this.persistEvent(offerId, evt);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** True if an offer with this id is already in the store. */
  has(id: string): boolean { return this.offers.has(id); }

  get(id: string): JobOffer | undefined { return this.offers.get(id); }

  getEvents(id: string): JobOfferEvent[] { return this.events.get(id) ?? []; }

  size(): number { return this.offers.size; }

  countByStatus(status: JobOfferStatus): number {
    let n = 0;
    for (const o of this.offers.values()) if (o.status === status) n++;
    return n;
  }

  /** Look up an offer by idempotency key (if any). */
  getByIdempotencyKey(key: string): JobOffer | undefined {
    const id = this.idempotencyIndex.get(key);
    return id ? this.offers.get(id) : undefined;
  }

  /**
   * Create a new open offer. Returns the offer, or a typed failure for
   * verify or schema-validation problems.
   *
   * Idempotency: caller may supply `id` (used by courier-shim) or
   * `idempotencyKey` (standard). Either match → return existing offer with
   * `created:false`.
   */
  async create(
    input: CreateJobOfferInput,
  ): Promise<
    | { ok: true; offer: JobOffer; created: boolean }
    | (VerifyFail & { ok: false })
    | { ok: false; reason: "schema_validation_failed"; error: string }
  > {
    // Idempotency check 1: caller-supplied id
    if (input.id && this.offers.has(input.id)) {
      return { ok: true, offer: this.offers.get(input.id)!, created: false };
    }
    // Idempotency check 2: idempotency_key
    if (input.idempotencyKey) {
      const existing = this.getByIdempotencyKey(input.idempotencyKey);
      if (existing) return { ok: true, offer: existing, created: false };
    }

    // Schema validation — graceful degrade if no schema for this capability type
    const schemaResult = await this.validateSchema(input.capabilityType, input.requirements);
    if (!schemaResult.ok) {
      return { ok: false, reason: "schema_validation_failed", error: schemaResult.error };
    }
    const requirementsValidated = schemaResult.validated;

    // Source-verify (e.g., upstream POS or order-management API)
    let verified = false;
    let lastVerifyAt: string | null = null;
    if (input.sourceVerifyUrl) {
      const v = await this.verify(input.sourceVerifyUrl);
      if (!v.ok) return v;
      verified = true;
      lastVerifyAt = this.nowIso();
    }

    const postedAt = this.nowIso();
    const validUntilMs = computeValidUntilMs(input.requirements, postedAt, input.validUntilIso ?? null);
    const id = input.id ?? `offer-${Math.random().toString(36).slice(2, 14)}-${Date.now().toString(36)}`;

    const offer: JobOffer = {
      id,
      capabilityType: input.capabilityType,
      requirements: input.requirements,
      requirementsValidated,
      serviceAreaGeofence: input.serviceAreaGeofence ?? null,
      pricing: input.pricing,
      deadlineIso: input.deadline ?? null,
      assuranceTier: input.assuranceTier ?? null,
      evidenceRequirements: input.evidenceRequirements ?? null,
      sourceVerifyUrl: input.sourceVerifyUrl ?? null,
      requireHeartbeat: !!input.requireHeartbeat,
      posterDid: input.posterDid ?? null,
      posterKernelId: input.posterKernelId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      status: "open",
      postedAt,
      validUntil: new Date(validUntilMs).toISOString(),
      claimedByKernelId: null,
      claimedAt: null,
      claimSignature: null,
      driverEtaMin: null,
      driverContact: null,
      verified,
      lastVerifyAt,
      lastHeartbeatAt: input.requireHeartbeat ? postedAt : null,
      deliveredAt: null,
      cancelledAt: null,
      expiredAt: null,
    };

    this.offers.set(offer.id, offer);
    if (offer.idempotencyKey) this.idempotencyIndex.set(offer.idempotencyKey, offer.id);
    this.persistOffer(offer);
    this.appendEvent(offer.id, { at: postedAt, event: "posted", verified, capabilityType: offer.capabilityType });
    await this.notifyOperatorsOfNewOffer(offer);
    return { ok: true, offer, created: true };
  }

  /**
   * Best-effort operator notification for a freshly-posted offer. Never lets
   * a notifier failure fail the job post — see the OperatorNotifier doc
   * comment above for why. No-op when no notifier was configured (all
   * pre-existing callers/tests that construct the store without
   * `notifyOperators` see zero behaviour change).
   */
  private async notifyOperatorsOfNewOffer(offer: JobOffer): Promise<void> {
    if (!this.notifyOperators) return;
    try {
      await this.notifyOperators(offer);
    } catch {
      // Swallowed — notification is best-effort, never the source of truth.
    }
  }

  /**
   * Filtered open-offers feed. capabilityType is REQUIRED at the route
   * layer so operators only see what they can actually fulfill (driver
   * agents poll for `courier.dispatch`, lab kernels poll for `lab.hplc`,
   * etc). The store accepts it as a filter; callers MUST pass it.
   */
  listOpen(filters: {
    capabilityType?: string;
    verified?: boolean;
    minAmount?: number | null;
    maxAmount?: number | null;
    currency?: string;
    tier?: 0 | 1 | 2 | 3 | null;
    within?: { lat: number; lng: number; miles: number } | null;
  } = {}): JobOffer[] {
    let open = Array.from(this.offers.values()).filter((o) => o.status === "open");
    if (filters.capabilityType) {
      open = open.filter((o) => o.capabilityType === filters.capabilityType);
    }
    if (filters.verified === true) open = open.filter((o) => o.verified === true);
    if (filters.currency) open = open.filter((o) => o.pricing.currency === filters.currency);
    if (filters.tier != null) open = open.filter((o) => o.assuranceTier === filters.tier);
    if (filters.minAmount != null && Number.isFinite(filters.minAmount)) {
      open = open.filter((o) => o.pricing.amount >= (filters.minAmount as number));
    }
    if (filters.maxAmount != null && Number.isFinite(filters.maxAmount)) {
      open = open.filter((o) => o.pricing.amount <= (filters.maxAmount as number));
    }
    if (filters.within) {
      const { lat, lng, miles } = filters.within;
      open = open.filter((o) => {
        const coords = extractRequirementsCoords(o.requirements);
        if (!coords) return false;
        return haversineMiles(lat, lng, coords.lat, coords.lng) <= miles;
      });
    }
    open.sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || ""));
    return open;
  }

  /**
   * Race-safe claim. Uses a per-offer promise chain mutex so concurrent
   * claims on the same offer serialize. Returns the claimed offer or a
   * typed failure.
   */
  async claim(
    id: string,
    claim: ClaimInput,
  ): Promise<
    | { ok: true; offer: JobOffer }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "not_open"; currentStatus: JobOfferStatus; claimedBy: string | null }
  > {
    const prev = this.claimLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.claimLocks.set(id, prev.then(() => next));
    await prev;
    try {
      const o = this.offers.get(id);
      if (!o) return { ok: false, reason: "not_found" };
      if (o.status !== "open") {
        return {
          ok: false,
          reason: "not_open",
          currentStatus: o.status,
          claimedBy: o.claimedByKernelId,
        };
      }
      o.status = "claimed";
      o.claimedByKernelId = claim.kernelId;
      o.claimedAt = this.nowIso();
      o.claimSignature = claim.claimSignature ?? null;
      o.driverEtaMin = claim.etaMin ?? null;
      o.driverContact = claim.contact ?? null;
      this.persistOffer(o);
      this.appendEvent(o.id, {
        at: o.claimedAt,
        event: "claimed",
        kernelId: claim.kernelId,
      });
      return { ok: true, offer: o };
    } finally {
      release();
      if (this.claimLocks.get(id) === next) this.claimLocks.delete(id);
    }
  }

  /**
   * Record a category-agnostic progress event. Common event kinds:
   *   - acknowledged    (operator accepts after claim)
   *   - in_progress     (work has started)
   *   - progress_update (intermediate; carries payload)
   *   - delivered       (work complete; status → delivered)
   *   - error           (operator reports failure)
   *   - cancelled       (operator-side cancel; status → cancelled)
   *   - note            (free-form annotation, no status change)
   *
   * Courier-shim aliases pickup → in_progress and stays the convention
   * of v0.2 callers without leaking courier semantics into the generic
   * surface.
   */
  recordEvent(
    id: string,
    event: string,
    by: string | null,
    payload: unknown,
    note: string | null,
  ): { ok: true; status: JobOfferStatus; event: JobOfferEvent } | { ok: false; reason: "not_found" } {
    const o = this.offers.get(id);
    if (!o) return { ok: false, reason: "not_found" };
    const evt: JobOfferEvent = {
      at: this.nowIso(),
      event,
      by,
      payload: payload ?? null,
      note: note ?? null,
    };
    this.appendEvent(o.id, evt);
    // Status transitions — opt-in by event kind. Unknown event kinds leave
    // status alone (caller can post "progress_update" repeatedly).
    if (event === "in_progress" || event === "pickup") {
      if (o.status === "claimed" || o.status === "open") o.status = "in_progress";
    }
    if (event === "delivered") {
      o.status = "delivered";
      o.deliveredAt = evt.at;
    }
    if (event === "cancelled") {
      o.status = "cancelled";
      o.cancelledAt = evt.at;
    }
    this.persistOffer(o);
    return { ok: true, status: o.status, event: evt };
  }

  patch(
    id: string,
    poster: string,
    patch: Partial<Pick<JobOffer, "pricing" | "deadlineIso" | "validUntil"> & { requirements?: Record<string, unknown> }>,
  ):
    | { ok: true; offer: JobOffer }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" }
    | { ok: false; reason: "not_editable"; currentStatus: JobOfferStatus } {
    const o = this.offers.get(id);
    if (!o) return { ok: false, reason: "not_found" };
    if (o.posterDid && o.posterDid !== poster) return { ok: false, reason: "forbidden" };
    if (o.status !== "open") {
      return { ok: false, reason: "not_editable", currentStatus: o.status };
    }
    const before = {
      pricing: o.pricing,
      deadlineIso: o.deadlineIso,
      validUntil: o.validUntil,
      requirements: o.requirements,
    };
    const changed: Record<string, unknown> = {};
    if (patch.pricing !== undefined) { o.pricing = patch.pricing; changed.pricing = patch.pricing; }
    if (patch.deadlineIso !== undefined) { o.deadlineIso = patch.deadlineIso; changed.deadlineIso = patch.deadlineIso; }
    if (patch.validUntil !== undefined) { o.validUntil = patch.validUntil; changed.validUntil = patch.validUntil; }
    if (patch.requirements !== undefined) {
      // Shallow merge — let posters tweak fields without resending the entire
      // requirements blob (e.g. courier: bump pickupReadyAt).
      o.requirements = { ...o.requirements, ...patch.requirements };
      changed.requirements = patch.requirements;
      // If pickupReadyAt changed and no explicit validUntil, recompute.
      if ((patch.requirements as Record<string, unknown>).pickupReadyAt !== undefined && patch.validUntil === undefined) {
        o.validUntil = new Date(computeValidUntilMs(o.requirements, o.postedAt)).toISOString();
      }
    }
    this.persistOffer(o);
    this.appendEvent(o.id, {
      at: this.nowIso(),
      event: "patched",
      by: poster,
      before,
      after: changed,
    });
    return { ok: true, offer: o };
  }

  cancel(id: string, poster: string):
    | { ok: true; status: JobOfferStatus }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" } {
    const o = this.offers.get(id);
    if (!o) return { ok: false, reason: "not_found" };
    if (o.posterDid && o.posterDid !== poster) return { ok: false, reason: "forbidden" };
    o.status = "cancelled";
    o.cancelledAt = this.nowIso();
    this.persistOffer(o);
    this.appendEvent(o.id, {
      at: o.cancelledAt,
      event: "deleted_by_poster",
      by: poster,
    });
    return { ok: true, status: o.status };
  }

  heartbeat(id: string, poster: string):
    | { ok: true; lastHeartbeatAt: string }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" } {
    const o = this.offers.get(id);
    if (!o) return { ok: false, reason: "not_found" };
    if (o.posterDid && o.posterDid !== poster) return { ok: false, reason: "forbidden" };
    o.lastHeartbeatAt = this.nowIso();
    this.persistOffer(o);
    this.appendEvent(o.id, {
      at: o.lastHeartbeatAt,
      event: "heartbeat",
      by: poster,
    });
    return { ok: true, lastHeartbeatAt: o.lastHeartbeatAt };
  }

  /**
   * Run one sweep tick. Idempotent; safe to call from interval timers OR
   * directly in tests for deterministic state. Returns counts for observability.
   */
  async sweep(): Promise<{ expired: number; reverified: number; autoCancelled: number }> {
    const now = this.nowMs();
    const HEARTBEAT_GRACE_MS = 5 * 60 * 1000;
    const REVERIFY_EARLY_INTERVAL_MS = 60 * 1000;
    const REVERIFY_LATE_INTERVAL_MS = 5 * 60 * 1000;
    const REVERIFY_EARLY_WINDOW_MS = 10 * 60 * 1000;

    let expired = 0, reverified = 0, autoCancelled = 0;

    for (const o of this.offers.values()) {
      if (o.status !== "open") continue;

      // 1) TTL
      const validUntilMs = isoToMs(o.validUntil);
      if (validUntilMs != null && validUntilMs < now) {
        o.status = "expired";
        o.expiredAt = this.nowIso();
        this.persistOffer(o);
        this.appendEvent(o.id, { at: o.expiredAt, event: "expired", reason: "ttl_passed" });
        expired++;
        continue;
      }

      // 2) heartbeat grace
      if (o.requireHeartbeat) {
        const lastHbMs = isoToMs(o.lastHeartbeatAt) ?? isoToMs(o.postedAt);
        if (lastHbMs != null && now - lastHbMs > HEARTBEAT_GRACE_MS) {
          o.status = "expired";
          o.expiredAt = this.nowIso();
          this.persistOffer(o);
          this.appendEvent(o.id, {
            at: o.expiredAt,
            event: "expired",
            reason: "heartbeat_lost",
            lastHeartbeatAt: o.lastHeartbeatAt,
          });
          expired++;
          continue;
        }
      }

      // 3) periodic re-verify
      if (o.sourceVerifyUrl) {
        const postedMs = isoToMs(o.postedAt) ?? now;
        const lastVMs = isoToMs(o.lastVerifyAt) ?? postedMs;
        const inEarlyWindow = now - postedMs < REVERIFY_EARLY_WINDOW_MS;
        const interval = inEarlyWindow ? REVERIFY_EARLY_INTERVAL_MS : REVERIFY_LATE_INTERVAL_MS;
        if (now - lastVMs >= interval) {
          const v = await this.verify(o.sourceVerifyUrl);
          o.lastVerifyAt = this.nowIso();
          if (!v.ok) {
            o.status = "cancelled";
            o.cancelledAt = o.lastVerifyAt;
            o.verified = false;
            this.persistOffer(o);
            this.appendEvent(o.id, {
              at: o.cancelledAt,
              event: "cancelled",
              reason: "source_verify_failed_after_post",
              verifyReason: v.reason,
              sourceStatus: v.status ?? null,
            });
            autoCancelled++;
          } else {
            o.verified = true;
            this.persistOffer(o);
            reverified++;
          }
        }
      }
    }

    return { expired, reverified, autoCancelled };
  }
}

// ── Singleton (boot via initJobOffersStore in server.ts) ───────────────────

let _store: JobOffersStore | undefined;

export function initJobOffersStore(opts: JobOffersStoreOptions = {}): JobOffersStore {
  _store = new JobOffersStore(opts);
  return _store;
}

export function getJobOffersStore(): JobOffersStore {
  if (!_store) throw new Error("[job-offers] store not initialised — call initJobOffersStore() first");
  return _store;
}

/** Test helper: reset the singleton so each test gets a clean store. */
export function _resetJobOffersStoreForTests(): void {
  _store = undefined;
}

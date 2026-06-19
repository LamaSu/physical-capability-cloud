/**
 * Courier-jobs store — folded port of pcc-courier-jobs v0.2 (the standalone
 * matching layer at https://web-production-3c660.up.railway.app).
 *
 * Mirrors the original surface:
 *   • POST   /api/courier-jobs                    — create open job
 *   • GET    /api/courier-jobs/open               — driver-agent feed
 *   • GET    /api/courier-jobs/:id                — single job + events
 *   • POST   /api/courier-jobs/:id/claim          — race-safe claim
 *   • POST   /api/courier-jobs/:id/events         — driver progress
 *   • POST   /api/courier-jobs/:id/heartbeat      — poster liveness
 *   • PATCH  /api/courier-jobs/:id                — poster edits
 *   • DELETE /api/courier-jobs/:id                — poster cancels
 *   • GET    /api/courier-jobs/healthz            — liveness
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
 *   - claim/events/get are open to any authenticated caller (driver agents).
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
  // Lifecycle additions
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

export const computeValidUntilMs = (
  pickupReadyAt: string | null,
  postedAt: string,
): number => {
  const pickupMs = isoToMs(pickupReadyAt);
  const postedMs = isoToMs(postedAt) ?? nowMs();
  if (pickupMs) return pickupMs + 30 * 60 * 1000;
  return postedMs + 2 * 60 * 60 * 1000;
};

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

export interface CourierJobsStoreOptions {
  /** Provide a sqlite db for persistent storage; omit for pure in-memory. */
  sqlite?: SqliteDatabaseLike;
  /** Override the source-verify implementation (tests inject a stub). */
  verify?: VerifyFn;
  /** Override "now" for tests. */
  now?: () => Date;
}

/**
 * Storage + business logic for courier-jobs. Pure functions over Map +
 * optional SQLite write-through for durability across restarts. Sweeper is
 * separate (services/courier-jobs-sweeper.ts).
 */
export class CourierJobsStore {
  private readonly jobs = new Map<string, CourierJob>();
  private readonly events = new Map<string, CourierJobEvent[]>();
  private readonly claimLocks = new Map<string, Promise<void>>();
  private readonly verify: VerifyFn;
  private readonly nowFn: () => Date;
  private readonly sqlite: SqliteDatabaseLike | undefined;

  constructor(opts: CourierJobsStoreOptions = {}) {
    this.sqlite = opts.sqlite;
    this.verify = opts.verify ?? defaultVerifyFn;
    this.nowFn = opts.now ?? (() => new Date());
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
        .prepare("SELECT id, data FROM courier_jobs")
        .all() as Array<{ id: string; data: string }>;
      for (const r of rows) {
        try {
          const job = JSON.parse(r.data) as CourierJob;
          this.jobs.set(job.id, job);
        } catch { /* skip corrupt rows */ }
      }
      const eventRows = this.sqlite
        .prepare("SELECT job_id, data FROM courier_job_events ORDER BY id ASC")
        .all() as Array<{ job_id: string; data: string }>;
      for (const r of eventRows) {
        try {
          const evt = JSON.parse(r.data) as CourierJobEvent;
          if (!this.events.has(r.job_id)) this.events.set(r.job_id, []);
          this.events.get(r.job_id)!.push(evt);
        } catch { /* skip */ }
      }
    } catch {
      // Tables may not exist yet on first boot — migrate.ts will create them.
    }
  }

  private persistJob(job: CourierJob): void {
    if (!this.sqlite) return;
    try {
      this.sqlite
        .prepare(`INSERT INTO courier_jobs (id, status, data, posted_at, posted_by, valid_until)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    data = excluded.data,
                    valid_until = excluded.valid_until`)
        .run(job.id, job.status, JSON.stringify(job), job.postedAt, job.postedBy, job.validUntil);
    } catch { /* non-fatal; in-memory copy is the source of truth */ }
  }

  private persistEvent(jobId: string, evt: CourierJobEvent): void {
    if (!this.sqlite) return;
    try {
      this.sqlite
        .prepare("INSERT INTO courier_job_events (job_id, at, data) VALUES (?, ?, ?)")
        .run(jobId, evt.at, JSON.stringify(evt));
    } catch { /* non-fatal */ }
  }

  private appendEvent(jobId: string, evt: CourierJobEvent): void {
    if (!this.events.has(jobId)) this.events.set(jobId, []);
    this.events.get(jobId)!.push(evt);
    this.persistEvent(jobId, evt);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** True if a job with this id is already in the store. */
  has(id: string): boolean { return this.jobs.has(id); }

  get(id: string): CourierJob | undefined { return this.jobs.get(id); }

  getEvents(id: string): CourierJobEvent[] { return this.events.get(id) ?? []; }

  size(): number { return this.jobs.size; }

  countByStatus(status: CourierJobStatus): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === status) n++;
    return n;
  }

  /**
   * Create a new open job. Returns the job, or a verify-failure for callers
   * that supplied a sourceVerifyUrl that doesn't pass.
   */
  async create(
    input: CreateJobInput,
  ): Promise<{ ok: true; job: CourierJob; created: boolean } | (VerifyFail & { ok: false })> {
    if (this.jobs.has(input.deliveryId)) {
      return { ok: true, job: this.jobs.get(input.deliveryId)!, created: false };
    }

    let verified = false;
    let lastVerifyAt: string | null = null;
    if (input.sourceVerifyUrl) {
      const v = await this.verify(input.sourceVerifyUrl);
      if (!v.ok) return v;
      verified = true;
      lastVerifyAt = this.nowIso();
    }

    const postedAt = this.nowIso();
    const validUntilMs = computeValidUntilMs(input.pickupReadyAt ?? null, postedAt);

    const job: CourierJob = {
      id: input.deliveryId,
      status: "open",
      postedAt,
      postedBy: input.postedBy ?? null,
      pickup: input.pickup,
      dropoff: input.dropoff,
      pickupReadyAt: input.pickupReadyAt ?? null,
      feeUSD: typeof input.feeUSD === "number" ? input.feeUSD : null,
      tipUSD: typeof input.tipUSD === "number" ? input.tipUSD : null,
      externalRef: input.externalRef ?? null,
      description: input.description ?? null,
      raw: input.raw ?? null,
      sourceVerifyUrl: input.sourceVerifyUrl ?? null,
      verified,
      lastVerifyAt,
      requireHeartbeat: !!input.requireHeartbeat,
      lastHeartbeatAt: input.requireHeartbeat ? postedAt : null,
      validUntil: new Date(validUntilMs).toISOString(),
    };

    this.jobs.set(job.id, job);
    this.persistJob(job);
    this.appendEvent(job.id, { at: postedAt, event: "posted", verified });
    return { ok: true, job, created: true };
  }

  /** Filtered open-jobs feed. Mirrors v0.2 sort: postedAt desc. */
  listOpen(filters: {
    verified?: boolean;
    minFeeUSD?: number | null;
    maxFeeUSD?: number | null;
    within?: { lat: number; lng: number; miles: number } | null;
  } = {}): CourierJob[] {
    let open = Array.from(this.jobs.values()).filter((j) => j.status === "open");
    if (filters.verified === true) open = open.filter((j) => j.verified === true);
    if (filters.minFeeUSD != null && Number.isFinite(filters.minFeeUSD)) {
      open = open.filter(
        (j) => typeof j.feeUSD === "number" && j.feeUSD >= (filters.minFeeUSD as number),
      );
    }
    if (filters.maxFeeUSD != null && Number.isFinite(filters.maxFeeUSD)) {
      open = open.filter(
        (j) => typeof j.feeUSD === "number" && j.feeUSD <= (filters.maxFeeUSD as number),
      );
    }
    if (filters.within) {
      const { lat, lng, miles } = filters.within;
      open = open.filter((j) => {
        const plat = j.pickup?.lat;
        const plng = j.pickup?.lng;
        if (typeof plat !== "number" || typeof plng !== "number") return false;
        return haversineMiles(lat, lng, plat, plng) <= miles;
      });
    }
    open.sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || ""));
    return open;
  }

  /**
   * Race-safe claim. Uses a per-job promise chain mutex so concurrent claims
   * on the same job serialize. Returns the claimed job or a typed failure.
   */
  async claim(
    id: string,
    claim: ClaimInput,
  ): Promise<
    | { ok: true; job: CourierJob }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "not_open"; currentStatus: CourierJobStatus; claimedBy: string | null }
  > {
    const prev = this.claimLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.claimLocks.set(id, prev.then(() => next));
    await prev;
    try {
      const j = this.jobs.get(id);
      if (!j) return { ok: false, reason: "not_found" };
      if (j.status !== "open") {
        return {
          ok: false,
          reason: "not_open",
          currentStatus: j.status,
          claimedBy: j.claimedBy ?? null,
        };
      }
      j.status = "claimed";
      j.claimedBy = claim.driverAgent;
      j.claimedAt = this.nowIso();
      j.driverEtaMin = claim.etaMin ?? null;
      j.driverContact = claim.contact ?? null;
      this.persistJob(j);
      this.appendEvent(j.id, {
        at: j.claimedAt,
        event: "claimed",
        driverAgent: claim.driverAgent,
      });
      return { ok: true, job: j };
    } finally {
      release();
      if (this.claimLocks.get(id) === next) this.claimLocks.delete(id);
    }
  }

  recordEvent(
    id: string,
    event: "pickup" | "delivered" | "cancelled" | "note",
    by: string | null,
    proof: unknown,
    note: string | null,
  ): { ok: true; status: CourierJobStatus; event: CourierJobEvent } | { ok: false; reason: "not_found" } {
    const j = this.jobs.get(id);
    if (!j) return { ok: false, reason: "not_found" };
    const evt: CourierJobEvent = {
      at: this.nowIso(),
      event,
      by,
      proof: proof ?? null,
      note: note ?? null,
    };
    this.appendEvent(j.id, evt);
    if (event === "pickup") j.status = "in_transit";
    if (event === "delivered") { j.status = "delivered"; j.deliveredAt = evt.at; }
    if (event === "cancelled") { j.status = "cancelled"; j.cancelledAt = evt.at; }
    this.persistJob(j);
    return { ok: true, status: j.status, event: evt };
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
    const j = this.jobs.get(id);
    if (!j) return { ok: false, reason: "not_found" };
    if (j.postedBy && j.postedBy !== poster) return { ok: false, reason: "forbidden" };
    if (j.status !== "open") {
      return { ok: false, reason: "not_editable", currentStatus: j.status };
    }
    const before = {
      pickupReadyAt: j.pickupReadyAt,
      feeUSD: j.feeUSD,
      description: j.description,
      validUntil: j.validUntil,
    };
    const changed: Record<string, unknown> = {};
    for (const f of ["pickupReadyAt", "feeUSD", "description", "validUntil"] as const) {
      if (patch[f] !== undefined) {
        (j as unknown as Record<string, unknown>)[f] = patch[f];
        changed[f] = patch[f];
      }
    }
    if (changed.pickupReadyAt !== undefined && changed.validUntil === undefined) {
      j.validUntil = new Date(computeValidUntilMs(j.pickupReadyAt, j.postedAt)).toISOString();
    }
    this.persistJob(j);
    this.appendEvent(j.id, {
      at: this.nowIso(),
      event: "patched",
      by: poster,
      before,
      after: changed,
    });
    return { ok: true, job: j };
  }

  cancel(id: string, poster: string):
    | { ok: true; status: CourierJobStatus }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" } {
    const j = this.jobs.get(id);
    if (!j) return { ok: false, reason: "not_found" };
    if (j.postedBy && j.postedBy !== poster) return { ok: false, reason: "forbidden" };
    j.status = "cancelled";
    j.cancelledAt = this.nowIso();
    this.persistJob(j);
    this.appendEvent(j.id, {
      at: j.cancelledAt,
      event: "deleted_by_poster",
      by: poster,
    });
    return { ok: true, status: j.status };
  }

  heartbeat(id: string, poster: string):
    | { ok: true; lastHeartbeatAt: string }
    | { ok: false; reason: "not_found" }
    | { ok: false; reason: "forbidden" } {
    const j = this.jobs.get(id);
    if (!j) return { ok: false, reason: "not_found" };
    if (j.postedBy && j.postedBy !== poster) return { ok: false, reason: "forbidden" };
    j.lastHeartbeatAt = this.nowIso();
    this.persistJob(j);
    this.appendEvent(j.id, {
      at: j.lastHeartbeatAt,
      event: "heartbeat",
      by: poster,
    });
    return { ok: true, lastHeartbeatAt: j.lastHeartbeatAt };
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

    for (const j of this.jobs.values()) {
      if (j.status !== "open") continue;

      // 1) TTL
      const validUntilMs = isoToMs(j.validUntil);
      if (validUntilMs != null && validUntilMs < now) {
        j.status = "expired";
        j.expiredAt = this.nowIso();
        this.persistJob(j);
        this.appendEvent(j.id, { at: j.expiredAt, event: "expired", reason: "ttl_passed" });
        expired++;
        continue;
      }

      // 2) heartbeat grace
      if (j.requireHeartbeat) {
        const lastHbMs = isoToMs(j.lastHeartbeatAt) ?? isoToMs(j.postedAt);
        if (lastHbMs != null && now - lastHbMs > HEARTBEAT_GRACE_MS) {
          j.status = "expired";
          j.expiredAt = this.nowIso();
          this.persistJob(j);
          this.appendEvent(j.id, {
            at: j.expiredAt,
            event: "expired",
            reason: "heartbeat_lost",
            lastHeartbeatAt: j.lastHeartbeatAt,
          });
          expired++;
          continue;
        }
      }

      // 3) periodic re-verify
      if (j.sourceVerifyUrl) {
        const postedMs = isoToMs(j.postedAt) ?? now;
        const lastVMs = isoToMs(j.lastVerifyAt) ?? postedMs;
        const inEarlyWindow = now - postedMs < REVERIFY_EARLY_WINDOW_MS;
        const interval = inEarlyWindow ? REVERIFY_EARLY_INTERVAL_MS : REVERIFY_LATE_INTERVAL_MS;
        if (now - lastVMs >= interval) {
          const v = await this.verify(j.sourceVerifyUrl);
          j.lastVerifyAt = this.nowIso();
          if (!v.ok) {
            j.status = "cancelled";
            j.cancelledAt = j.lastVerifyAt;
            j.verified = false;
            this.persistJob(j);
            this.appendEvent(j.id, {
              at: j.cancelledAt,
              event: "cancelled",
              reason: "source_verify_failed_after_post",
              verifyReason: v.reason,
              sourceStatus: v.status ?? null,
            });
            autoCancelled++;
          } else {
            j.verified = true;
            this.persistJob(j);
            reverified++;
          }
        }
      }
    }

    return { expired, reverified, autoCancelled };
  }
}

// ── Singleton (boot via initCourierJobsStore in server.ts) ─────────────────

let _store: CourierJobsStore | undefined;

export function initCourierJobsStore(opts: CourierJobsStoreOptions = {}): CourierJobsStore {
  _store = new CourierJobsStore(opts);
  return _store;
}

export function getCourierJobsStore(): CourierJobsStore {
  if (!_store) throw new Error("[courier-jobs] store not initialised — call initCourierJobsStore() first");
  return _store;
}

/** Test helper: reset the singleton so each test gets a clean store. */
export function _resetCourierJobsStoreForTests(): void {
  _store = undefined;
}

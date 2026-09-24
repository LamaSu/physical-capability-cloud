/**
 * Carrier shipment store — the durable record of "we reserved this job,
 * dispatched a charge to EasyPost, recorded its outcome, bound the
 * commitment, and are watching for the carrier's own scan." One record per
 * print-and-mail job.
 *
 * STATE MACHINE (each edge is a sol #297 finding, rounds 1-3):
 *
 *   reserve()            INSERT row, status=reserved            (PK on job_id
 *                        is the cross-process spending lock; an EXPIRED
 *                        reserved row is reclaimed transactionally HERE, not
 *                        only at boot — R3-9)
 *   markBuyInFlight()    reserved -> buy_in_flight              (durable,
 *                        BEFORE /buy is dispatched, carrying the created
 *                        shipment id + rate so recovery can ask EasyPost
 *                        what actually happened — R3-1)
 *   markPurchased()      buy_in_flight -> purchased_pending      (the charge
 *                        is recorded the moment it is known)
 *   markReconciliation() buy_in_flight|purchased_pending ->
 *                        reconciliation_required                 (ambiguous or
 *                        defective post-charge outcomes PARK for a human;
 *                        never released, never expired, never auto-retried)
 *   finalize()           purchased_pending -> label_bought       (commitment)
 *   release()            deletes ONLY a `reserved` row           (after /buy
 *                        MAY have been dispatched, release is forbidden)
 *   recordCarrierEvent() label_bought -> in_transit -> delivered |
 *                        return_to_sender | failed               (explicit
 *                        lattice; terminal states terminal; ordered by the
 *                        CARRIER's clock; watermark advances on every matched
 *                        event; a scan predating commitment.committedAt is
 *                        refused — R3-4)
 *
 * CONCURRENCY: a per-job async mutex serializes every mutation in-process
 * (different webhook event ids can no longer interleave across the
 * evidence-build await — R3-3), and every SQL UPDATE is a version-CAS
 * (`WHERE job_id=? AND version=?`, bumping version) so a stale writer loses
 * loudly instead of overwriting newer state (R3-2). Creation is INSERT-only.
 * Webhook application claims the provider event id INSIDE the same
 * transaction as the state change (round-2 NEW-4).
 *
 * UNMATCHED SCANS: any signature-valid tracker event that cannot currently
 * be matched/applied (scan before purchase recorded, scan before finalize)
 * is durably LEDGERED in carrier_unmatched_events and replayed after
 * markPurchased/finalize — correctness never depends on the provider
 * retrying long enough (R3-5).
 *
 * Persistence: write-through SQLite via the same raw better-sqlite3 handle
 * job-offers-store.ts uses; tables created by db/src/migrate.ts. In-memory
 * mode (tests) mirrors the same ordering. `strictHydration` (production)
 * validates the full record schema and throws on disagreement between the
 * SQL columns and the serialized record (R3-8).
 */

import type { EvidenceEvent } from "@pcc/spec";
import type { SqliteDatabaseLike } from "./job-offers-store.js";
import type {
  BoughtShipment,
  CreatedShipment,
  FinalizedLabel,
  ProviderMode,
  ShipmentCommitment,
  TrackerWebhookEvent,
} from "./easypost-client.js";

export type { SqliteDatabaseLike };

export type CarrierShipmentStatus =
  | "reserved"
  | "buy_in_flight"
  | "purchased_pending"
  | "reconciliation_required"
  | "label_bought"
  | "in_transit"
  | "delivered"
  | "return_to_sender"
  | "failed";

const ALL_STATUSES: ReadonlySet<string> = new Set([
  "reserved",
  "buy_in_flight",
  "purchased_pending",
  "reconciliation_required",
  "label_bought",
  "in_transit",
  "delivered",
  "return_to_sender",
  "failed",
]);
const TERMINAL: ReadonlySet<CarrierShipmentStatus> = new Set(["delivered", "return_to_sender", "failed"]);
const TRACKABLE: ReadonlySet<CarrierShipmentStatus> = new Set([
  "label_bought",
  "in_transit",
  "delivered",
  "return_to_sender",
  "failed",
]);
/**
 * Statuses that REQUIRE tracking identity. reconciliation_required is
 * deliberately NOT here (sol R4-3): a purchase parked from buy_in_flight —
 * e.g. bought-but-unusable, where EasyPost returned no tracking code — is a
 * legitimate reachable state WITHOUT one, and strict hydration must accept
 * the states the machine can actually produce, not just the happy path.
 */
const REQUIRES_TRACKING: ReadonlySet<CarrierShipmentStatus> = new Set(["purchased_pending", ...TRACKABLE]);

export interface CarrierShipmentRecord {
  jobId: string;
  kernelId: string;
  /** operatorId/userId of the caller who reserved/bought — the only principal allowed to read it back. */
  ownerId: string;
  /** sha256 of canonical(request params) — a re-request with the same jobId but different params is a 409 (round-1 finding 12). */
  requestFingerprint: string;
  status: CarrierShipmentStatus;
  /** CAS token mirrored in the SQL column; bumped on every UPDATE. */
  version: number;
  reservedAt: string;
  // ── set by markBuyInFlight (the created-but-unbought shipment; recovery key) ──
  createdShipment: CreatedShipment | null;
  // ── set by markPurchased (immutable afterwards) ──
  shipmentId: string | null;
  trackerId: string | null;
  trackingCode: string | null;
  labelUrl: string | null;
  carrier: string | null;
  service: string | null;
  rate: string | null;
  currency: string | null;
  providerMode: ProviderMode | null;
  mock: boolean;
  // ── set by markReconciliationRequired ──
  reconciliationReason: string | null;
  // ── set by finalize ──
  labelHash: string | null;
  labelCid: string | null;
  commitment: ShipmentCommitment | null;
  // ── carrier tracking ──
  /** Carrier timestamp of the latest MATCHED event (applied or not); strictly older events are stale. */
  lastCarrierEventAt: string | null;
  events: EvidenceEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CarrierShipmentStoreOptions {
  sqlite?: SqliteDatabaseLike;
  now?: () => Date;
  /** Throw on missing tables / invalid rows instead of degrading (production). */
  strictHydration?: boolean;
  /** `reserved` rows older than this are reclaimable (crash between reserve and buy dispatch). Default 10 min. */
  reservationTtlMs?: number;
  /** Unmatched-scan ledger entries older than this are pruned. Default 7 days (covers finalize delays generously). */
  unmatchedTtlMs?: number;
  /** Row cap on the unmatched-scan ledger; oldest evicted past it. Default 5000. */
  unmatchedMaxRows?: number;
}

export type RecordCarrierEventOutcome = "applied" | "deduped" | "stale" | "terminal" | "no_transition";

export type RecordCarrierEventResult =
  | { ok: true; record: CarrierShipmentRecord; outcome: RecordCarrierEventOutcome; newStatus: CarrierShipmentStatus }
  | {
      ok: false;
      reason:
        | "unknown_tracking_code"
        | "not_finalized"
        | "tracker_missing"
        | "tracker_mismatch"
        | "shipment_mismatch"
        | "scan_predates_commitment";
      /** True when the scan was durably ledgered for post-purchase replay (unknown/not_finalized with ledgering requested). */
      ledgered?: boolean;
    };

export interface RecordCarrierEventOpts {
  /** Ledger the scan durably (R3-5) when it is unmatchable — done INSIDE the same lock that finalize/markPurchased take, so a concurrent finalize cannot slip between the decision and the insert (R4-2). */
  ledgerUnmatched?: boolean;
}

export interface UnmatchedLedgerEntry {
  eventId: string;
  trackingCode: string;
  at: string;
  data: unknown;
}

export class CarrierStoreError extends Error {
  constructor(
    readonly code:
      | "job_exists"
      | "job_in_flight"
      | "duplicate_tracking_code"
      | "empty_tracking_code"
      | "invalid_transition"
      | "cas_conflict"
      | "shipment_identity_mismatch"
      | "commitment_identity_mismatch"
      | "not_found",
  ) {
    super(code);
    this.name = "CarrierStoreError";
  }
}

/**
 * The transition lattice. Returns the next status for a carrier tracker
 * status, or null when no transition applies.
 */
export function nextStatus(trackerStatus: string, current: CarrierShipmentStatus): CarrierShipmentStatus | null {
  if (!TRACKABLE.has(current) || TERMINAL.has(current)) return null;
  switch (trackerStatus) {
    case "in_transit":
    case "out_for_delivery":
    case "available_for_pickup":
      return current === "label_bought" ? "in_transit" : null;
    case "delivered":
      return "delivered"; // from label_bought or in_transit (a first scan can be the delivery scan)
    case "return_to_sender":
      return "return_to_sender";
    case "failure":
    case "cancelled":
      return "failed";
    default:
      return null; // pre_transit / unknown: label exists with the carrier, nothing physically scanned
  }
}

interface StoredWebhookEvent {
  eventId: string;
  jobId: string;
  at: string;
  data: unknown;
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

function parseableIso(s: unknown): s is string {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

export class CarrierShipmentStore {
  private byJobId = new Map<string, CarrierShipmentRecord>();
  private byTrackingCode = new Map<string, string>(); // trackingCode -> jobId
  private seenEventIds = new Set<string>();
  private unmatchedByCode = new Map<string, UnmatchedLedgerEntry[]>();
  private unmatchedIds = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();
  private unmatchedEvictedCount = 0;
  private readonly sqlite: SqliteDatabaseLike | undefined;
  private readonly now: () => Date;
  private readonly strict: boolean;
  private readonly reservationTtlMs: number;
  private readonly unmatchedTtlMs: number;
  private readonly unmatchedMaxRows: number;

  constructor(opts: CarrierShipmentStoreOptions = {}) {
    this.sqlite = opts.sqlite;
    this.now = opts.now ?? (() => new Date());
    this.strict = opts.strictHydration ?? false;
    this.reservationTtlMs = opts.reservationTtlMs ?? 10 * 60_000;
    this.unmatchedTtlMs = opts.unmatchedTtlMs ?? 7 * 24 * 3600_000;
    this.unmatchedMaxRows = opts.unmatchedMaxRows ?? 5000;
    this.hydrate();
  }

  /** True when writes go to SQLite. Production boot refuses a non-durable store. */
  get isDurable(): boolean {
    return !!this.sqlite;
  }

  // ── per-job mutex (R3-3) ─────────────────────────────────────────────────

  private withLock<T>(jobKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(jobKey) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the previous holder's outcome
    // Park the chain tail; swallow rejections on the CHAIN only (the caller
    // still receives them from `run`). Tail-aware cleanup (R5-5): when the
    // tail settles and is STILL the current tail, drop the key — otherwise
    // every job/tracking-code ever seen leaves a promise resident forever.
    const tail = run.catch(() => {});
    this.locks.set(jobKey, tail);
    void tail.finally(() => {
      if (this.locks.get(jobKey) === tail) this.locks.delete(jobKey);
    });
    return run;
  }

  // ── hydration (R3-8) ─────────────────────────────────────────────────────

  private validateRecord(rec: unknown, row: { job_id: string; tracking_code: string | null; status: string; version: number }): CarrierShipmentRecord {
    const r = rec as CarrierShipmentRecord;
    const fail = (why: string): never => {
      throw new Error(`carrier store: invalid row for job ${row.job_id}: ${why}`);
    };
    if (!r || typeof r !== "object") fail("not an object");
    if (r.jobId !== row.job_id) fail("jobId disagrees with SQL column");
    if (!ALL_STATUSES.has(r.status)) fail(`unknown status ${String(r.status)}`);
    if (r.status !== row.status) fail("status disagrees with SQL column");
    if (typeof r.version !== "number" || r.version !== row.version) fail("version disagrees with SQL column");
    if ((r.trackingCode ?? null) !== (row.tracking_code ?? null)) fail("tracking_code disagrees with SQL column");
    if (!parseableIso(r.createdAt) || !parseableIso(r.updatedAt)) fail("unparseable timestamps");
    if (typeof r.kernelId !== "string" || !r.kernelId) fail("missing kernelId");
    if (typeof r.ownerId !== "string" || !r.ownerId) fail("missing ownerId");
    if (typeof r.requestFingerprint !== "string" || !r.requestFingerprint) fail("missing requestFingerprint");
    if (r.providerMode != null && r.providerMode !== "production" && r.providerMode !== "test" && r.providerMode !== "mock") {
      fail(`unknown providerMode ${String(r.providerMode)}`);
    }
    if (typeof r.mock !== "boolean") fail("mock flag not boolean");
    if (REQUIRES_TRACKING.has(r.status)) {
      if (!r.trackingCode || !r.shipmentId) fail("purchased status without tracking identity");
      if (!r.carrier || !r.service) fail("purchased status without carrier/service");
    }
    for (const ev of Array.isArray(r.events) ? r.events : []) {
      const e = ev as { id?: unknown; type?: unknown; timestamp?: unknown; hash?: unknown };
      if (typeof e?.id !== "string" || typeof e?.type !== "string" || typeof e?.hash !== "string" || !parseableIso(e?.timestamp)) {
        fail("malformed evidence event in record");
      }
    }
    if (r.status === "buy_in_flight" && !r.createdShipment?.shipmentId) {
      fail("buy_in_flight without a created shipment (recovery would be impossible)");
    }
    if (r.status === "purchased_pending" && (!r.labelUrl || !r.providerMode)) {
      fail("purchased_pending without labelUrl/providerMode (finalize would be impossible)");
    }
    if (TRACKABLE.has(r.status)) {
      const c = r.commitment;
      if (!c || typeof c.hash !== "string") fail("trackable status without a commitment");
      if (!parseableIso(c!.committedAt)) fail("commitment.committedAt unparseable");
      if (c!.jobId !== r.jobId || c!.kernelId !== r.kernelId || c!.trackingCode !== r.trackingCode || c!.shipmentId !== r.shipmentId) {
        fail("commitment identity disagrees with the record");
      }
      if (c!.labelHash !== r.labelHash || c!.labelCid !== r.labelCid) fail("commitment label binding disagrees with the record");
    }
    if (r.lastCarrierEventAt != null && !parseableIso(r.lastCarrierEventAt)) fail("lastCarrierEventAt unparseable");
    if (!Array.isArray(r.events)) fail("events not an array");
    return r;
  }

  private hydrate(): void {
    if (!this.sqlite) return;
    let rows: Array<{ job_id: string; tracking_code: string | null; status: string; version: number; data: string }>;
    let evts: Array<{ event_id: string }>;
    let unmatched: Array<{ event_id: string; tracking_code: string; at: string; data: string }>;
    try {
      rows = this.sqlite
        .prepare("SELECT job_id, tracking_code, status, version, data FROM carrier_shipments")
        .all() as typeof rows;
      evts = this.sqlite.prepare("SELECT event_id FROM carrier_webhook_events").all() as typeof evts;
      // Bound the ledger IN SQL before materializing anything (sol round-6 on
      // R4-6): TTL-expired rows are deleted, then everything past the row cap
      // (oldest first) — so an oversized persisted table cannot consume boot
      // memory even transiently.
      const cutoffIso = new Date(this.now().getTime() - this.unmatchedTtlMs).toISOString();
      const ttlDel = this.sqlite.prepare("DELETE FROM carrier_unmatched_events WHERE at < ?").run(cutoffIso) as { changes?: number } | undefined;
      const capDel = this.sqlite
        .prepare(
          `DELETE FROM carrier_unmatched_events WHERE event_id NOT IN
             (SELECT event_id FROM carrier_unmatched_events ORDER BY at DESC, event_id DESC LIMIT ?)`,
        )
        .run(this.unmatchedMaxRows) as { changes?: number } | undefined;
      // R7-1: hydration-time evictions count too, or healthz underreports.
      this.unmatchedEvictedCount += (ttlDel?.changes ?? 0) + (capDel?.changes ?? 0);
      unmatched = this.sqlite
        .prepare("SELECT event_id, tracking_code, at, data FROM carrier_unmatched_events ORDER BY at ASC LIMIT ?")
        .all(this.unmatchedMaxRows) as typeof unmatched;
    } catch (err) {
      if (this.strict) {
        throw new Error(
          `carrier store: tables missing or unreadable (run db migrate): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return; // dev/test without migrate: in-memory behaviour
    }
    for (const row of rows) {
      let rec: CarrierShipmentRecord;
      try {
        rec = this.validateRecord(JSON.parse(row.data), row);
      } catch (err) {
        if (this.strict) throw err;
        continue;
      }
      if (rec.status === "reserved") {
        // A reservation is pre-dispatch by definition; a crash left it behind.
        // NaN/old reservedAt both count as expired (R3-8: NaN must not
        // create an immortal lock). Reclaim happens in reserve() too (R3-9).
        const t = Date.parse(rec.reservedAt);
        if (Number.isNaN(t) || t < this.now().getTime() - this.reservationTtlMs) {
          this.sqlite.prepare("DELETE FROM carrier_shipments WHERE job_id = ? AND status = 'reserved'").run(rec.jobId);
          continue;
        }
      }
      if (rec.trackingCode && this.byTrackingCode.has(rec.trackingCode)) {
        const why = `duplicate tracking code ${rec.trackingCode} across jobs`;
        if (this.strict) throw new Error(`carrier store: ${why}`);
        continue;
      }
      this.byJobId.set(rec.jobId, rec);
      if (rec.trackingCode) this.byTrackingCode.set(rec.trackingCode, rec.jobId);
    }
    for (const e of evts) this.seenEventIds.add(e.event_id);
    // The unmatched ledger is bounded AT HYDRATION too (sol round-5 on R4-6):
    // TTL-expired rows are dropped (and deleted) as they load, and the row
    // cap keeps only the NEWEST entries — an oversized persisted ledger must
    // not consume unbounded memory during boot.
    const ttlCutoff = this.now().getTime() - this.unmatchedTtlMs;
    const loaded: UnmatchedLedgerEntry[] = [];
    for (const u of unmatched) {
      try {
        const t = Date.parse(u.at);
        if (Number.isNaN(t) || t < ttlCutoff) {
          this.unmatchedEvictedCount++;
          this.sqlite.prepare("DELETE FROM carrier_unmatched_events WHERE event_id = ?").run(u.event_id);
          continue;
        }
        loaded.push({ eventId: u.event_id, trackingCode: u.tracking_code, at: u.at, data: JSON.parse(u.data) });
      } catch (err) {
        if (this.strict) throw new Error(`carrier store: corrupt unmatched event ${u.event_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    loaded.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    while (loaded.length > this.unmatchedMaxRows) {
      const evicted = loaded.shift()!;
      this.unmatchedEvictedCount++;
      this.sqlite.prepare("DELETE FROM carrier_unmatched_events WHERE event_id = ?").run(evicted.eventId);
    }
    for (const entry of loaded) {
      this.unmatchedIds.add(entry.eventId);
      const list = this.unmatchedByCode.get(entry.trackingCode) ?? [];
      list.push(entry);
      this.unmatchedByCode.set(entry.trackingCode, list);
    }
  }

  // ── SQL helpers ──────────────────────────────────────────────────────────

  private sqlInsert(rec: CarrierShipmentRecord): void {
    if (!this.sqlite) return;
    this.sqlite
      .prepare(
        `INSERT INTO carrier_shipments (job_id, tracking_code, carrier, status, version, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.jobId, rec.trackingCode, rec.carrier, rec.status, rec.version, JSON.stringify(rec), rec.createdAt, rec.updatedAt);
  }

  /** Version-CAS UPDATE (R3-2): asserts the previous version, bumps it. Zero changes = a stale writer — loud, never silent. */
  private sqlUpdateCas(rec: CarrierShipmentRecord, expectedVersion: number): void {
    if (!this.sqlite) return;
    const res = this.sqlite
      .prepare(
        `UPDATE carrier_shipments
            SET tracking_code = ?, carrier = ?, status = ?, version = ?, data = ?, updated_at = ?
          WHERE job_id = ? AND version = ?`,
      )
      .run(rec.trackingCode, rec.carrier, rec.status, rec.version, JSON.stringify(rec), rec.updatedAt, rec.jobId, expectedVersion) as
      | { changes?: number }
      | undefined;
    if (res && typeof res.changes === "number" && res.changes === 0) {
      throw new CarrierStoreError("cas_conflict");
    }
  }

  private sqlInsertEvent(e: StoredWebhookEvent): void {
    if (!this.sqlite) return;
    this.sqlite
      .prepare("INSERT INTO carrier_webhook_events (event_id, job_id, at, data) VALUES (?, ?, ?, ?)")
      .run(e.eventId, e.jobId, e.at, JSON.stringify(e.data));
  }

  private tx<T>(fn: () => T): T {
    if (!this.sqlite) return fn();
    this.sqlite.prepare("BEGIN IMMEDIATE").run();
    try {
      const out = fn();
      this.sqlite.prepare("COMMIT").run();
      return out;
    } catch (err) {
      try {
        this.sqlite.prepare("ROLLBACK").run();
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  /** Apply a mutation: bump version, CAS-update SQL, then mirror into memory. */
  private commitMutation(rec: CarrierShipmentRecord, next: Partial<CarrierShipmentRecord>): CarrierShipmentRecord {
    const expected = rec.version;
    const updated: CarrierShipmentRecord = { ...rec, ...next, version: expected + 1, updatedAt: this.now().toISOString() };
    this.sqlUpdateCas(updated, expected);
    Object.assign(rec, updated);
    return rec;
  }

  // ── reservation + purchase lifecycle ─────────────────────────────────────

  /**
   * Reserve a jobId for a purchase attempt. Durable; the PK is the
   * cross-process lock. An EXPIRED `reserved` row (pre-dispatch crash) is
   * reclaimed here, transactionally (R3-9). Rows in any post-dispatch state
   * are never reclaimed.
   */
  reserve(input: { jobId: string; kernelId: string; ownerId: string; requestFingerprint: string }): CarrierShipmentRecord {
    const existing = this.byJobId.get(input.jobId);
    if (existing) {
      if (existing.status === "reserved") {
        const t = Date.parse(existing.reservedAt);
        const expired = Number.isNaN(t) || t < this.now().getTime() - this.reservationTtlMs;
        if (!expired) throw new CarrierStoreError("job_in_flight");
        this.tx(() => {
          if (this.sqlite) this.sqlite.prepare("DELETE FROM carrier_shipments WHERE job_id = ? AND status = 'reserved'").run(input.jobId);
        });
        this.byJobId.delete(input.jobId);
      } else {
        throw new CarrierStoreError(existing.status === "buy_in_flight" ? "job_in_flight" : "job_exists");
      }
    }
    const ts = this.now().toISOString();
    const rec: CarrierShipmentRecord = {
      jobId: input.jobId,
      kernelId: input.kernelId,
      ownerId: input.ownerId,
      requestFingerprint: input.requestFingerprint,
      status: "reserved",
      version: 0,
      reservedAt: ts,
      createdShipment: null,
      shipmentId: null,
      trackerId: null,
      trackingCode: null,
      labelUrl: null,
      carrier: null,
      service: null,
      rate: null,
      currency: null,
      providerMode: null,
      mock: false,
      reconciliationReason: null,
      labelHash: null,
      labelCid: null,
      commitment: null,
      lastCarrierEventAt: null,
      events: [],
      createdAt: ts,
      updatedAt: ts,
    };
    try {
      this.sqlInsert(rec);
    } catch (err) {
      if (isUniqueViolation(err)) throw new CarrierStoreError("job_in_flight"); // another process got there first
      throw err;
    }
    this.byJobId.set(rec.jobId, rec);
    return rec;
  }

  /** Free a reservation that never dispatched a charge. Any other state is never deleted. */
  release(jobId: string): void {
    const rec = this.byJobId.get(jobId);
    if (!rec || rec.status !== "reserved") return;
    if (this.sqlite) this.sqlite.prepare("DELETE FROM carrier_shipments WHERE job_id = ? AND status = 'reserved'").run(jobId);
    this.byJobId.delete(jobId);
  }

  /** Durably record "we are about to dispatch /buy for THIS created shipment" (R3-1). After this, release() is structurally impossible. */
  async markBuyInFlight(jobId: string, created: CreatedShipment): Promise<CarrierShipmentRecord> {
    return this.withLock(jobId, async () => {
      const rec = this.byJobId.get(jobId);
      if (!rec) throw new CarrierStoreError("not_found");
      if (rec.status !== "reserved") throw new CarrierStoreError("invalid_transition");
      return this.commitMutation(rec, { status: "buy_in_flight", createdShipment: created, shipmentId: created.shipmentId, mock: created.mock, providerMode: created.providerMode });
    });
  }

  /** Record that EasyPost has charged. */
  async markPurchased(jobId: string, bought: BoughtShipment): Promise<CarrierShipmentRecord> {
    return this.withLock(jobId, async () => {
      const rec = this.byJobId.get(jobId);
      if (!rec) throw new CarrierStoreError("not_found");
      if (rec.status !== "buy_in_flight") throw new CarrierStoreError("invalid_transition");
      // R5-3: the purchase being recorded must be for the shipment this row
      // dispatched — the store re-checks even though the client already did.
      if (rec.createdShipment && bought.shipmentId !== rec.createdShipment.shipmentId) {
        throw new CarrierStoreError("shipment_identity_mismatch");
      }
      const code = bought.trackingCode?.trim();
      if (!code) throw new CarrierStoreError("empty_tracking_code");
      // The tracking-code mapping is registered under the CODE lock too, so
      // an unknown-code scan being ledgered concurrently either lands before
      // (found by the post-finalize replay) or after (finds this record) —
      // never in an unobservable gap (R4-2).
      return this.withLock(`code:${code}`, async () => {
        if (this.byTrackingCode.has(code)) throw new CarrierStoreError("duplicate_tracking_code");
        try {
          this.commitMutation(rec, {
            status: "purchased_pending",
            shipmentId: bought.shipmentId,
            trackerId: bought.trackerId,
            trackingCode: code,
            labelUrl: bought.labelUrl,
            carrier: bought.carrier,
            service: bought.service,
            rate: bought.rate,
            currency: bought.currency,
            providerMode: bought.providerMode,
            mock: bought.mock,
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw new CarrierStoreError("duplicate_tracking_code");
          throw err;
        }
        this.byTrackingCode.set(code, rec.jobId);
        return rec;
      });
    });
  }

  /** Park a possibly-charged or defective purchase for a human. Never auto-resolved (R3-1/R3-10). */
  async markReconciliationRequired(jobId: string, reason: string): Promise<CarrierShipmentRecord> {
    return this.withLock(jobId, async () => {
      const rec = this.byJobId.get(jobId);
      if (!rec) throw new CarrierStoreError("not_found");
      if (rec.status !== "buy_in_flight" && rec.status !== "purchased_pending") {
        throw new CarrierStoreError("invalid_transition");
      }
      return this.commitMutation(rec, { status: "reconciliation_required", reconciliationReason: reason });
    });
  }

  /** Attach the label hash/CID + commitment to a recorded purchase. */
  async finalize(jobId: string, finalized: FinalizedLabel): Promise<CarrierShipmentRecord> {
    return this.withLock(jobId, async () => {
      const rec = this.byJobId.get(jobId);
      if (!rec) throw new CarrierStoreError("not_found");
      if (rec.status !== "purchased_pending") throw new CarrierStoreError("invalid_transition");
      if (rec.commitment) throw new CarrierStoreError("invalid_transition"); // a commitment is never replaced (R3-2)
      // R5-4: label_bought must never be entered with a commitment the
      // evidence gate would later reject — the commitment's identity must
      // equal THIS purchase, byte for byte, before the transition happens.
      const c = finalized.commitment;
      const identityOk =
        c.jobId === rec.jobId &&
        c.kernelId === rec.kernelId &&
        c.trackingCode === rec.trackingCode &&
        c.shipmentId === rec.shipmentId &&
        c.trackerId === rec.trackerId &&
        c.carrier === rec.carrier &&
        c.service === rec.service &&
        c.providerMode === rec.providerMode &&
        c.mock === rec.mock &&
        c.labelHash === finalized.labelHash &&
        c.labelCid === finalized.labelCid;
      if (!identityOk) throw new CarrierStoreError("commitment_identity_mismatch");
      return this.commitMutation(rec, {
        status: "label_bought",
        labelHash: finalized.labelHash,
        labelCid: finalized.labelCid,
        commitment: finalized.commitment,
      });
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  getByJobId(jobId: string): CarrierShipmentRecord | undefined {
    return this.byJobId.get(jobId);
  }

  getByTrackingCode(trackingCode: string): CarrierShipmentRecord | undefined {
    const jobId = this.byTrackingCode.get(trackingCode);
    return jobId ? this.byJobId.get(jobId) : undefined;
  }

  size(): number {
    return this.byJobId.size;
  }

  hasSeenEvent(eventId: string): boolean {
    return this.seenEventIds.has(eventId);
  }

  /** Purchases whose finalize step never completed — reconciled/finalized, never re-bought. */
  listPendingFinalize(): CarrierShipmentRecord[] {
    return [...this.byJobId.values()].filter((r) => r.status === "purchased_pending");
  }

  /** Ambiguous/defective post-charge outcomes awaiting a human decision. */
  listNeedsReconciliation(): CarrierShipmentRecord[] {
    return [...this.byJobId.values()].filter((r) => r.status === "reconciliation_required" || r.status === "buy_in_flight");
  }

  // ── unmatched-scan ledger (R3-5; non-destructive per R4-1, bounded per R4-6) ──

  /**
   * Durably ledger a signature-valid tracker event that cannot currently be
   * matched/applied. Idempotent per event id. Bounded: entries older than the
   * TTL are pruned and the oldest are evicted past the row cap — a shared
   * EasyPost account's unrelated tracker traffic must not grow this without
   * limit (R4-6). Evictions are counted for healthz.
   */
  ledgeUnmatched(evt: TrackerWebhookEvent, raw: unknown): void {
    if (this.seenEventIds.has(evt.easypostEventId) || this.unmatchedIds.has(evt.easypostEventId)) return;
    this.pruneUnmatched();
    if (this.sqlite) {
      this.sqlite
        .prepare("INSERT OR IGNORE INTO carrier_unmatched_events (event_id, tracking_code, at, data) VALUES (?, ?, ?, ?)")
        .run(evt.easypostEventId, evt.trackingCode, evt.occurredAt, JSON.stringify(raw));
    }
    this.unmatchedIds.add(evt.easypostEventId);
    const list = this.unmatchedByCode.get(evt.trackingCode) ?? [];
    list.push({ eventId: evt.easypostEventId, trackingCode: evt.trackingCode, at: evt.occurredAt, data: raw });
    this.unmatchedByCode.set(evt.trackingCode, list);
  }

  private pruneUnmatched(): void {
    const cutoff = this.now().getTime() - this.unmatchedTtlMs;
    const all: UnmatchedLedgerEntry[] = [];
    for (const [code, list] of this.unmatchedByCode) {
      const kept = list.filter((e) => {
        const t = Date.parse(e.at);
        const expired = Number.isNaN(t) || t < cutoff;
        if (expired) {
          this.unmatchedIds.delete(e.eventId);
          this.unmatchedEvictedCount++;
          if (this.sqlite) this.sqlite.prepare("DELETE FROM carrier_unmatched_events WHERE event_id = ?").run(e.eventId);
        }
        return !expired;
      });
      if (kept.length === 0) this.unmatchedByCode.delete(code);
      else this.unmatchedByCode.set(code, kept);
      all.push(...kept);
    }
    if (all.length >= this.unmatchedMaxRows) {
      all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const excess = all.length - this.unmatchedMaxRows + 1; // room for the incoming entry
      for (const e of all.slice(0, excess)) {
        this.unmatchedIds.delete(e.eventId);
        this.unmatchedEvictedCount++;
        const list = (this.unmatchedByCode.get(e.trackingCode) ?? []).filter((x) => x.eventId !== e.eventId);
        if (list.length === 0) this.unmatchedByCode.delete(e.trackingCode);
        else this.unmatchedByCode.set(e.trackingCode, list);
        if (this.sqlite) this.sqlite.prepare("DELETE FROM carrier_unmatched_events WHERE event_id = ?").run(e.eventId);
      }
    }
  }

  /**
   * Return (COPIES of) the ledgered events for a tracking code, oldest first,
   * WITHOUT deleting anything (R4-1: the ledger row is the sole durable copy;
   * it is removed only per-event via deleteUnmatched after the replay outcome
   * is known — applied, deduped, or permanently rejected. Exceptions keep it).
   */
  peekUnmatched(trackingCode: string): UnmatchedLedgerEntry[] {
    const list = [...(this.unmatchedByCode.get(trackingCode) ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    // Deep copies: a caller mutating a peeked entry must never corrupt the
    // ledger's own copy (sol round-5 note on R4-1).
    return list.map((e) => {
      try {
        return structuredClone(e);
      } catch {
        return { ...e, data: JSON.parse(JSON.stringify(e.data)) };
      }
    });
  }

  /** Remove ONE ledger entry after its replay reached a final outcome. */
  deleteUnmatched(eventId: string): void {
    if (!this.unmatchedIds.delete(eventId)) return;
    for (const [code, list] of this.unmatchedByCode) {
      const kept = list.filter((e) => e.eventId !== eventId);
      if (kept.length !== list.length) {
        if (kept.length === 0) this.unmatchedByCode.delete(code);
        else this.unmatchedByCode.set(code, kept);
        break;
      }
    }
    if (this.sqlite) this.sqlite.prepare("DELETE FROM carrier_unmatched_events WHERE event_id = ?").run(eventId);
  }

  unmatchedStats(): { count: number; evicted: number } {
    let count = 0;
    for (const list of this.unmatchedByCode.values()) count += list.length;
    return { count, evicted: this.unmatchedEvictedCount };
  }

  // ── webhook application ──────────────────────────────────────────────────

  /**
   * Applies a verified carrier tracking webhook to its pre-committed shipment.
   * Serialized per job by the store mutex; the provider event id is claimed
   * inside the same transaction as the state change. See the class comment.
   */
  async recordCarrierEvent(
    webhookEvent: TrackerWebhookEvent,
    buildEvidenceEvent: (
      record: CarrierShipmentRecord,
      newStatus: CarrierShipmentStatus,
    ) => Promise<EvidenceEvent | null> | EvidenceEvent | null,
    rawForLedger?: unknown,
    opts?: RecordCarrierEventOpts,
  ): Promise<RecordCarrierEventResult> {
    const pre = this.getByTrackingCode(webhookEvent.trackingCode);
    if (!pre) {
      // Unknown code: decide + (optionally) ledger under the CODE lock, the
      // same lock markPurchased registers the mapping under (R4-2). The code
      // lock is RELEASED before any job lock is taken — the universal lock
      // order stays job -> code, never nested the other way (sol round-5
      // lock-order note).
      const decision = await this.withLock<{ done: RecordCarrierEventResult } | { jobId: string }>(
        `code:${webhookEvent.trackingCode}`,
        async () => {
          const again = this.getByTrackingCode(webhookEvent.trackingCode);
          if (!again) {
            if (opts?.ledgerUnmatched) {
              this.ledgeUnmatched(webhookEvent, rawForLedger ?? webhookEvent);
              return { done: { ok: false, reason: "unknown_tracking_code", ledgered: true } };
            }
            return { done: { ok: false, reason: "unknown_tracking_code" } };
          }
          return { jobId: again.jobId };
        },
      );
      if ("done" in decision) return decision.done;
      return this.applyToJob(decision.jobId, webhookEvent, buildEvidenceEvent, rawForLedger, opts);
    }
    return this.applyToJob(pre.jobId, webhookEvent, buildEvidenceEvent, rawForLedger, opts);
  }

  private applyToJob(
    jobId: string,
    webhookEvent: TrackerWebhookEvent,
    buildEvidenceEvent: (
      record: CarrierShipmentRecord,
      newStatus: CarrierShipmentStatus,
    ) => Promise<EvidenceEvent | null> | EvidenceEvent | null,
    rawForLedger?: unknown,
    opts?: RecordCarrierEventOpts,
  ): Promise<RecordCarrierEventResult> {
    return this.withLock(jobId, async () => {
      const record = this.getByTrackingCode(webhookEvent.trackingCode);
      if (!record) return { ok: false, reason: "unknown_tracking_code" };
      if (!TRACKABLE.has(record.status)) {
        // Ours, but no commitment yet — ledger INSIDE this lock so a
        // concurrent finalize cannot run its replay before our insert (R4-2).
        if (opts?.ledgerUnmatched) {
          this.ledgeUnmatched(webhookEvent, rawForLedger ?? webhookEvent);
          return { ok: false, reason: "not_finalized", ledgered: true };
        }
        return { ok: false, reason: "not_finalized" };
      }

      // Identity: the webhook must name the tracker we bought when we know it,
      // and never a different shipment (round-2 finding 6).
      if (record.trackerId && !webhookEvent.trackerId) return { ok: false, reason: "tracker_missing" };
      if (record.trackerId && webhookEvent.trackerId && webhookEvent.trackerId !== record.trackerId) {
        return { ok: false, reason: "tracker_mismatch" };
      }
      if (webhookEvent.shipmentId && webhookEvent.shipmentId !== record.shipmentId) {
        return { ok: false, reason: "shipment_mismatch" };
      }
      // R3-4: a scan that happened BEFORE the commitment existed can never be
      // qualifying evidence — the claim "the commitment predates execution"
      // would be false for it. Refused permanently, not retried.
      if (record.commitment && Date.parse(webhookEvent.occurredAt) < Date.parse(record.commitment.committedAt)) {
        return { ok: false, reason: "scan_predates_commitment" };
      }

      const eventId = webhookEvent.easypostEventId;
      if (this.seenEventIds.has(eventId)) {
        return { ok: true, record, outcome: "deduped", newStatus: record.status };
      }

      const ledgerEntry: StoredWebhookEvent = { eventId, jobId: record.jobId, at: webhookEvent.occurredAt, data: rawForLedger ?? webhookEvent };
      const eventT = Date.parse(webhookEvent.occurredAt);
      const markT = record.lastCarrierEventAt ? Date.parse(record.lastCarrierEventAt) : -Infinity;
      // The watermark advances on EVERY matched event (applied or not), so a
      // newer no-op scan still shuts the door on older late arrivals.
      const newWatermark = eventT > markT ? webhookEvent.occurredAt : record.lastCarrierEventAt;

      let outcome: RecordCarrierEventOutcome;
      let next: CarrierShipmentStatus | null = null;
      if (eventT < markT) {
        outcome = "stale";
      } else if (TERMINAL.has(record.status)) {
        outcome = "terminal";
      } else {
        next = nextStatus(webhookEvent.status, record.status);
        outcome = next ? "applied" : "no_transition";
      }

      // Build evidence FIRST (round-2 finding 9). Nothing is written if this throws.
      const evidenceEvent =
        next === "in_transit" || next === "delivered" ? await buildEvidenceEvent(record, next) : null;

      const expected = record.version;
      const updated: CarrierShipmentRecord = {
        ...record,
        status: next ?? record.status,
        version: expected + 1,
        lastCarrierEventAt: newWatermark,
        events: evidenceEvent ? [...record.events, evidenceEvent] : record.events,
        updatedAt: this.now().toISOString(),
      };

      let deduped = false;
      this.tx(() => {
        try {
          this.sqlInsertEvent(ledgerEntry);
        } catch (err) {
          if (isUniqueViolation(err)) {
            deduped = true; // another process applied it between our check and now
            return;
          }
          throw err;
        }
        this.sqlUpdateCas(updated, expected);
      });
      if (deduped) {
        this.seenEventIds.add(eventId);
        return { ok: true, record, outcome: "deduped", newStatus: record.status };
      }

      Object.assign(record, updated);
      this.seenEventIds.add(eventId);
      return { ok: true, record, outcome, newStatus: record.status };
    });
  }
}

let singleton: CarrierShipmentStore | undefined;

export function initCarrierShipmentStore(opts: CarrierShipmentStoreOptions = {}): CarrierShipmentStore {
  singleton = new CarrierShipmentStore(opts);
  return singleton;
}

export function getCarrierShipmentStore(): CarrierShipmentStore {
  if (!singleton) singleton = new CarrierShipmentStore();
  return singleton;
}

export function _resetCarrierShipmentStoreForTests(): void {
  singleton = undefined;
}

/**
 * Carrier shipment store — the durable record of "we reserved this job,
 * EasyPost charged us for a label, we bound the commitment, and we are
 * watching for the carrier's own scan." One record per print-and-mail job.
 *
 * STATE MACHINE (each edge is a sol #297 finding):
 *
 *   reserve()          INSERT row, status=reserved           (finding 6 / NEW-6:
 *                      PK on job_id is the cross-process spending lock)
 *   markPurchased()    reserved -> purchased_pending          (NEW-2: recorded the
 *                      instant EasyPost has charged; BEFORE label download)
 *   finalize()         purchased_pending -> label_bought      (commitment built)
 *   release()          deletes ONLY a `reserved` row          (never a purchase)
 *   recordCarrierEvent label_bought -> in_transit -> delivered | return_to_sender | failed
 *                      (finding 7: explicit lattice, terminal states terminal,
 *                      ordered by the CARRIER's clock, watermark advances on
 *                      every matched event)
 *
 * A failure after /buy leaves `purchased_pending`; a retried request with the
 * same fingerprint finalizes that purchase instead of buying again. Stale
 * `reserved` rows (a crash between reserve and /buy) expire on hydrate.
 *
 * Persistence: write-through SQLite via the same raw better-sqlite3 handle
 * job-offers-store.ts uses (tables carrier_shipments + carrier_webhook_events,
 * created by db/src/migrate.ts). Creation is INSERT-only (never UPSERT — a
 * purchase's identity is immutable, NEW-3); status changes are UPDATEs that
 * verify the row's tracking identity. Webhook application claims the
 * provider event id INSIDE the same transaction as the state change (NEW-4 /
 * finding 5): a unique-conflict means "already applied" and nothing mutates.
 * In-memory mode (tests) mirrors the same ordering with a synchronous claim
 * set so the await on evidence construction cannot admit a duplicate.
 *
 * `strictHydration` (production): missing tables or corrupt rows throw at
 * boot instead of silently degrading to memory (NEW-7 / finding 8).
 */

import type { EvidenceEvent } from "@pcc/spec";
import type { SqliteDatabaseLike } from "./job-offers-store.js";
import type {
  BoughtShipment,
  FinalizedLabel,
  ProviderMode,
  ShipmentCommitment,
  TrackerWebhookEvent,
} from "./easypost-client.js";

export type { SqliteDatabaseLike };

export type CarrierShipmentStatus =
  | "reserved"
  | "purchased_pending"
  | "label_bought"
  | "in_transit"
  | "delivered"
  | "return_to_sender"
  | "failed";

const TERMINAL: ReadonlySet<CarrierShipmentStatus> = new Set(["delivered", "return_to_sender", "failed"]);
const TRACKABLE: ReadonlySet<CarrierShipmentStatus> = new Set([
  "label_bought",
  "in_transit",
  "delivered",
  "return_to_sender",
  "failed",
]);

export interface CarrierShipmentRecord {
  jobId: string;
  kernelId: string;
  /** operatorId/userId of the caller who reserved/bought — the only principal allowed to read it back. */
  ownerId: string;
  /** sha256 of canonical(request params) — a re-request with the same jobId but different params is a 409, not a silent reuse (finding 12). */
  requestFingerprint: string;
  status: CarrierShipmentStatus;
  reservedAt: string;
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
  /** True when the label was fabricated by mock mode (no EASYPOST_API_KEY). */
  mock: boolean;
  // ── set by finalize ──
  labelHash: string | null;
  /** CIDv1 of the label bytes in the gateway blob store — fetch via GET /api/storage/:cid. */
  labelCid: string | null;
  commitment: ShipmentCommitment | null;
  // ── carrier tracking ──
  /** Carrier timestamp of the latest MATCHED event (applied or not); older events are ignored. */
  lastCarrierEventAt: string | null;
  events: EvidenceEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CarrierShipmentStoreOptions {
  sqlite?: SqliteDatabaseLike;
  now?: () => Date;
  /** Throw on missing tables / corrupt rows instead of degrading (production). */
  strictHydration?: boolean;
  /** `reserved` rows older than this are dropped on hydrate (crash between reserve and /buy). Default 10 min. */
  reservationTtlMs?: number;
}

export type RecordCarrierEventOutcome = "applied" | "deduped" | "stale" | "terminal" | "no_transition";

export type RecordCarrierEventResult =
  | { ok: true; record: CarrierShipmentRecord; outcome: RecordCarrierEventOutcome; newStatus: CarrierShipmentStatus }
  | {
      ok: false;
      reason: "unknown_tracking_code" | "not_finalized" | "tracker_missing" | "tracker_mismatch" | "shipment_mismatch";
    };

export class CarrierStoreError extends Error {
  constructor(
    readonly code:
      | "job_exists"
      | "job_in_flight"
      | "duplicate_tracking_code"
      | "empty_tracking_code"
      | "invalid_transition"
      | "not_found",
  ) {
    super(code);
    this.name = "CarrierStoreError";
  }
}

/**
 * The transition lattice. Returns the next status for a carrier tracker
 * status, or null when no transition applies (no-op statuses like
 * pre_transit/unknown, or a transition the lattice forbids).
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

export class CarrierShipmentStore {
  private byJobId = new Map<string, CarrierShipmentRecord>();
  private byTrackingCode = new Map<string, string>(); // trackingCode -> jobId
  private seenEventIds = new Set<string>();
  /** Event ids currently being applied (between the synchronous check and the commit). */
  private claimingEventIds = new Set<string>();
  private readonly sqlite: SqliteDatabaseLike | undefined;
  private readonly now: () => Date;
  private readonly strict: boolean;
  private readonly reservationTtlMs: number;

  constructor(opts: CarrierShipmentStoreOptions = {}) {
    this.sqlite = opts.sqlite;
    this.now = opts.now ?? (() => new Date());
    this.strict = opts.strictHydration ?? false;
    this.reservationTtlMs = opts.reservationTtlMs ?? 10 * 60_000;
    this.hydrate();
  }

  /** True when writes go to SQLite. Production boot refuses a non-durable store. */
  get isDurable(): boolean {
    return !!this.sqlite;
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private hydrate(): void {
    if (!this.sqlite) return;
    let rows: Array<{ job_id: string; data: string }>;
    let evts: Array<{ event_id: string }>;
    try {
      rows = this.sqlite.prepare("SELECT job_id, data FROM carrier_shipments").all() as typeof rows;
      evts = this.sqlite.prepare("SELECT event_id FROM carrier_webhook_events").all() as typeof evts;
    } catch (err) {
      if (this.strict) {
        throw new Error(
          `carrier store: tables missing or unreadable (run db migrate): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return; // dev/test without migrate: in-memory behaviour
    }
    const cutoff = this.now().getTime() - this.reservationTtlMs;
    for (const r of rows) {
      let rec: CarrierShipmentRecord;
      try {
        rec = JSON.parse(r.data) as CarrierShipmentRecord;
        if (!rec || rec.jobId !== r.job_id || typeof rec.status !== "string") throw new Error("shape mismatch");
      } catch (err) {
        if (this.strict) throw new Error(`carrier store: corrupt row for job ${r.job_id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (rec.status === "reserved" && Date.parse(rec.reservedAt) < cutoff) {
        // Crash between reserve and /buy: nothing was bought; free the job.
        this.sqlite.prepare("DELETE FROM carrier_shipments WHERE job_id = ? AND status = 'reserved'").run(rec.jobId);
        continue;
      }
      this.byJobId.set(rec.jobId, rec);
      if (rec.trackingCode) this.byTrackingCode.set(rec.trackingCode, rec.jobId);
    }
    for (const e of evts) this.seenEventIds.add(e.event_id);
  }

  private sqlInsert(rec: CarrierShipmentRecord): void {
    if (!this.sqlite) return;
    this.sqlite
      .prepare(
        `INSERT INTO carrier_shipments (job_id, tracking_code, carrier, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.jobId, rec.trackingCode, rec.carrier, rec.status, JSON.stringify(rec), rec.createdAt, rec.updatedAt);
  }

  /** UPDATE that also asserts the row's tracking identity has not been swapped underneath us. */
  private sqlUpdate(rec: CarrierShipmentRecord, expectTrackingCode: string | null): void {
    if (!this.sqlite) return;
    const res = this.sqlite
      .prepare(
        `UPDATE carrier_shipments
            SET tracking_code = ?, carrier = ?, status = ?, data = ?, updated_at = ?
          WHERE job_id = ? AND (tracking_code IS ? OR tracking_code = ?)`,
      )
      .run(rec.trackingCode, rec.carrier, rec.status, JSON.stringify(rec), rec.updatedAt, rec.jobId, expectTrackingCode, expectTrackingCode) as
      | { changes?: number }
      | undefined;
    if (res && typeof res.changes === "number" && res.changes === 0) {
      throw new CarrierStoreError("invalid_transition");
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

  // ── reservation + purchase (finding 6 / NEW-2 / NEW-6) ──────────────────

  /** Reserve a jobId for an in-progress purchase. Durable; the PK is the cross-process lock. */
  reserve(input: { jobId: string; kernelId: string; ownerId: string; requestFingerprint: string }): CarrierShipmentRecord {
    const existing = this.byJobId.get(input.jobId);
    if (existing) throw new CarrierStoreError(existing.status === "reserved" ? "job_in_flight" : "job_exists");
    const ts = this.now().toISOString();
    const rec: CarrierShipmentRecord = {
      jobId: input.jobId,
      kernelId: input.kernelId,
      ownerId: input.ownerId,
      requestFingerprint: input.requestFingerprint,
      status: "reserved",
      reservedAt: ts,
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

  /** Free a reservation that never became a purchase. A purchased row is never deleted. */
  release(jobId: string): void {
    const rec = this.byJobId.get(jobId);
    if (!rec || rec.status !== "reserved") return;
    if (this.sqlite) this.sqlite.prepare("DELETE FROM carrier_shipments WHERE job_id = ? AND status = 'reserved'").run(jobId);
    this.byJobId.delete(jobId);
  }

  /** Record that EasyPost has charged. Called the moment /buy returns, BEFORE the label is downloaded. */
  markPurchased(jobId: string, bought: BoughtShipment): CarrierShipmentRecord {
    const rec = this.byJobId.get(jobId);
    if (!rec) throw new CarrierStoreError("not_found");
    if (rec.status !== "reserved") throw new CarrierStoreError("invalid_transition");
    const code = bought.trackingCode?.trim();
    if (!code) throw new CarrierStoreError("empty_tracking_code");
    if (this.byTrackingCode.has(code)) throw new CarrierStoreError("duplicate_tracking_code");

    const next: CarrierShipmentRecord = {
      ...rec,
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
      updatedAt: this.now().toISOString(),
    };
    try {
      this.sqlUpdate(next, null);
    } catch (err) {
      if (isUniqueViolation(err)) throw new CarrierStoreError("duplicate_tracking_code");
      throw err;
    }
    Object.assign(rec, next);
    this.byTrackingCode.set(code, rec.jobId);
    return rec;
  }

  /** Attach the label hash/CID + commitment to a recorded purchase. Idempotent target state: label_bought. */
  finalize(jobId: string, finalized: FinalizedLabel): CarrierShipmentRecord {
    const rec = this.byJobId.get(jobId);
    if (!rec) throw new CarrierStoreError("not_found");
    if (rec.status !== "purchased_pending") throw new CarrierStoreError("invalid_transition");
    const next: CarrierShipmentRecord = {
      ...rec,
      status: "label_bought",
      labelHash: finalized.labelHash,
      labelCid: finalized.labelCid,
      commitment: finalized.commitment,
      updatedAt: this.now().toISOString(),
    };
    this.sqlUpdate(next, rec.trackingCode);
    Object.assign(rec, next);
    return rec;
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

  /** Purchases whose finalize step never completed — surfaced so they are reconciled, never re-bought. */
  listPendingFinalize(): CarrierShipmentRecord[] {
    return [...this.byJobId.values()].filter((r) => r.status === "purchased_pending");
  }

  // ── webhook application (findings 5, 7, 9; NEW-4) ───────────────────────

  /**
   * Applies a verified carrier tracking webhook to its pre-committed shipment.
   *
   * Order of operations: identity checks -> synchronous claim of the provider
   * event id (dedupe) -> watermark/lattice decision -> evidence built (awaited,
   * BEFORE any mutation) -> ONE transaction that inserts the event id and
   * updates the row -> then memory. If anything throws before commit, the
   * claim is dropped and nothing is marked seen, so the provider's retry gets
   * a clean attempt (finding 9). A concurrent duplicate delivery is refused
   * by the claim set in-process and by the event_id primary key across
   * processes (NEW-4).
   */
  async recordCarrierEvent(
    webhookEvent: TrackerWebhookEvent,
    buildEvidenceEvent: (
      record: CarrierShipmentRecord,
      newStatus: CarrierShipmentStatus,
    ) => Promise<EvidenceEvent | null> | EvidenceEvent | null,
    rawForLedger?: unknown,
  ): Promise<RecordCarrierEventResult> {
    const record = this.getByTrackingCode(webhookEvent.trackingCode);
    if (!record) return { ok: false, reason: "unknown_tracking_code" };
    if (!TRACKABLE.has(record.status)) return { ok: false, reason: "not_finalized" };

    // Identity: the webhook must name the tracker we bought when we know it,
    // and never a different shipment (finding 6).
    if (record.trackerId && !webhookEvent.trackerId) return { ok: false, reason: "tracker_missing" };
    if (record.trackerId && webhookEvent.trackerId && webhookEvent.trackerId !== record.trackerId) {
      return { ok: false, reason: "tracker_mismatch" };
    }
    if (webhookEvent.shipmentId && webhookEvent.shipmentId !== record.shipmentId) {
      return { ok: false, reason: "shipment_mismatch" };
    }

    const eventId = webhookEvent.easypostEventId;
    if (this.seenEventIds.has(eventId) || this.claimingEventIds.has(eventId)) {
      return { ok: true, record, outcome: "deduped", newStatus: record.status };
    }
    this.claimingEventIds.add(eventId); // synchronous: closes the check-then-act window across the await below

    try {
      const ledgerEntry: StoredWebhookEvent = { eventId, jobId: record.jobId, at: webhookEvent.occurredAt, data: rawForLedger ?? webhookEvent };
      const eventT = Date.parse(webhookEvent.occurredAt);
      const markT = record.lastCarrierEventAt ? Date.parse(record.lastCarrierEventAt) : -Infinity;
      // The watermark advances on EVERY matched event (applied or not), so a
      // newer no-op scan still shuts the door on older late arrivals (finding 7).
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

      // Build evidence FIRST (finding 9). Nothing is written if this throws.
      const evidenceEvent =
        next === "in_transit" || next === "delivered" ? await buildEvidenceEvent(record, next) : null;

      const updated: CarrierShipmentRecord = {
        ...record,
        status: next ?? record.status,
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
        this.sqlUpdate(updated, record.trackingCode);
      });
      if (deduped) {
        this.seenEventIds.add(eventId);
        return { ok: true, record, outcome: "deduped", newStatus: record.status };
      }

      Object.assign(record, updated);
      this.seenEventIds.add(eventId);
      return { ok: true, record, outcome, newStatus: record.status };
    } finally {
      this.claimingEventIds.delete(eventId);
    }
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

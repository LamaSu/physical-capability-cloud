/**
 * Carrier shipment store — record of "we bought this real postage label,
 * pre-committed the job/document/destination/tracking claim before handoff,
 * and are watching for the carrier's own scan to confirm it entered the mail
 * stream." One record per print-and-mail job.
 *
 * Persistence: write-through SQLite via the same raw better-sqlite3 handle
 * job-offers-store.ts uses (tables carrier_shipments + carrier_webhook_events,
 * created by db/src/migrate.ts). In-memory when no handle is given (tests).
 * A commitment that only lived in memory would vanish on restart, making the
 * carrier's genuine webhook unmatched and permitting a second charged label
 * for the same job — sol #297 finding 8.
 *
 * Invariants (each is a sol #297 finding, each has a test):
 *  - a jobId is RESERVED before purchase so two concurrent buys cannot both
 *    charge (finding 6); a trackingCode indexes at most one job, never empty
 *    (6/13); tracker identity on the webhook must match the purchase (6)
 *  - status transitions are MONOTONIC on an explicit lattice; terminal states
 *    are terminal; events are ordered by the CARRIER's timestamp, so a late-
 *    delivered older event cannot regress or fabricate a transition (7)
 *  - evidence is built BEFORE any state is mutated; the provider event id is
 *    marked seen only after the whole step succeeds, so a failed build is
 *    retryable rather than silently lost (9)
 *  - webhook event ids are a persisted replay ledger (5/8)
 */

import type { EvidenceEvent } from "@pcc/spec";
import type { SqliteDatabaseLike } from "./job-offers-store.js";
import type { ShipmentCommitment, TrackerWebhookEvent } from "./easypost-client.js";

export type { SqliteDatabaseLike };

export type CarrierShipmentStatus =
  | "label_bought"
  | "in_transit"
  | "delivered"
  | "return_to_sender"
  | "failed";

const TERMINAL: ReadonlySet<CarrierShipmentStatus> = new Set(["delivered", "return_to_sender", "failed"]);

export interface CarrierShipmentRecord {
  jobId: string;
  kernelId: string;
  /** operatorId/userId of the caller who bought the label — the only principal allowed to read it back. */
  ownerId: string;
  shipmentId: string;
  trackerId: string | null;
  trackingCode: string;
  labelUrl: string;
  labelHash: string;
  /** CIDv1 of the label bytes in the gateway blob store — fetch via GET /api/storage/:cid (owner/offer-linked). */
  labelCid: string;
  carrier: string;
  service: string;
  commitment: ShipmentCommitment;
  /** sha256 of canonical(request params) — a re-request with the same jobId but different params is a 409, not a silent reuse (finding 12). */
  requestFingerprint: string;
  /** True when the label was fabricated by mock mode (no EASYPOST_API_KEY) — carries through to EvidenceEvent.source.simulated. */
  mock: boolean;
  status: CarrierShipmentStatus;
  /** Carrier timestamp of the latest APPLIED event; older events are ignored. */
  lastCarrierEventAt: string | null;
  events: EvidenceEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CarrierShipmentStoreOptions {
  sqlite?: SqliteDatabaseLike;
  now?: () => Date;
}

export type RecordCarrierEventResult =
  | {
      ok: true;
      record: CarrierShipmentRecord;
      /** "applied" = status changed (+ evidence appended when the transition has evidence semantics). */
      outcome: "applied" | "deduped" | "stale" | "terminal" | "no_transition";
      newStatus: CarrierShipmentStatus;
    }
  | { ok: false; reason: "unknown_tracking_code" | "tracker_mismatch" | "shipment_mismatch" };

export class CarrierStoreError extends Error {
  constructor(readonly code: "job_exists" | "job_in_flight" | "duplicate_tracking_code" | "empty_tracking_code") {
    super(code);
    this.name = "CarrierStoreError";
  }
}

/**
 * The transition lattice. Returns the next status for a carrier tracker
 * status, or null when no transition applies (no-op statuses like
 * pre_transit/unknown, or a transition the lattice forbids).
 */
export function nextStatus(
  trackerStatus: string,
  current: CarrierShipmentStatus,
): CarrierShipmentStatus | null {
  if (TERMINAL.has(current)) return null;
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

export class CarrierShipmentStore {
  private byJobId = new Map<string, CarrierShipmentRecord>();
  private byTrackingCode = new Map<string, string>(); // trackingCode -> jobId
  private seenEventIds = new Set<string>();
  private inFlight = new Set<string>();
  private readonly sqlite: SqliteDatabaseLike | undefined;
  private readonly now: () => Date;

  constructor(opts: CarrierShipmentStoreOptions = {}) {
    this.sqlite = opts.sqlite;
    this.now = opts.now ?? (() => new Date());
    this.hydrate();
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private hydrate(): void {
    if (!this.sqlite) return;
    try {
      const rows = this.sqlite.prepare("SELECT job_id, data FROM carrier_shipments").all() as Array<{
        job_id: string;
        data: string;
      }>;
      for (const r of rows) {
        try {
          const rec = JSON.parse(r.data) as CarrierShipmentRecord;
          this.byJobId.set(rec.jobId, rec);
          this.byTrackingCode.set(rec.trackingCode, rec.jobId);
        } catch {
          /* skip corrupt row */
        }
      }
      const evts = this.sqlite.prepare("SELECT event_id FROM carrier_webhook_events").all() as Array<{
        event_id: string;
      }>;
      for (const e of evts) this.seenEventIds.add(e.event_id);
    } catch {
      /* tables absent (migrate not run) -> in-memory behaviour */
    }
  }

  private persistRecord(rec: CarrierShipmentRecord): void {
    if (!this.sqlite) return;
    this.sqlite
      .prepare(
        `INSERT INTO carrier_shipments (job_id, tracking_code, carrier, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           status = excluded.status,
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(rec.jobId, rec.trackingCode, rec.carrier, rec.status, JSON.stringify(rec), rec.createdAt, rec.updatedAt);
  }

  private persistWebhookEvent(e: StoredWebhookEvent): void {
    if (!this.sqlite) return;
    this.sqlite
      .prepare("INSERT OR IGNORE INTO carrier_webhook_events (event_id, job_id, at, data) VALUES (?, ?, ?, ?)")
      .run(e.eventId, e.jobId, e.at, JSON.stringify(e.data));
  }

  // ── reservation (finding 6: concurrent double-purchase) ─────────────────

  /** Reserve a jobId for an in-progress purchase. Throws if it already has a record or a purchase in flight. */
  reserve(jobId: string): void {
    if (this.byJobId.has(jobId)) throw new CarrierStoreError("job_exists");
    if (this.inFlight.has(jobId)) throw new CarrierStoreError("job_in_flight");
    this.inFlight.add(jobId);
  }

  release(jobId: string): void {
    this.inFlight.delete(jobId);
  }

  // ── records ──────────────────────────────────────────────────────────────

  create(input: Omit<CarrierShipmentRecord, "status" | "lastCarrierEventAt" | "events" | "createdAt" | "updatedAt">): CarrierShipmentRecord {
    if (this.byJobId.has(input.jobId)) throw new CarrierStoreError("job_exists");
    const code = input.trackingCode?.trim();
    if (!code) throw new CarrierStoreError("empty_tracking_code");
    if (this.byTrackingCode.has(code)) throw new CarrierStoreError("duplicate_tracking_code");

    const ts = this.now().toISOString();
    const record: CarrierShipmentRecord = {
      ...input,
      trackingCode: code,
      status: "label_bought",
      lastCarrierEventAt: null,
      events: [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.persistRecord(record); // persist BEFORE indexing: if the DB rejects (UNIQUE), memory stays consistent
    this.byJobId.set(record.jobId, record);
    this.byTrackingCode.set(code, record.jobId);
    this.inFlight.delete(record.jobId);
    return record;
  }

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

  // ── webhook application ──────────────────────────────────────────────────

  /**
   * Applies a verified carrier tracking webhook to its pre-committed shipment.
   *
   * `buildEvidenceEvent` runs ONLY for a transition with evidence semantics
   * (-> in_transit, -> delivered) and BEFORE any mutation; if it throws, the
   * event is NOT marked seen, so the provider's retry gets a clean attempt.
   * `rawForLedger` is persisted alongside the event id so a verifier can
   * re-check the provider's signed bytes later.
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

    // Identity: a tracker/shipment id on the webhook must be the one we bought.
    if (webhookEvent.trackerId && record.trackerId && webhookEvent.trackerId !== record.trackerId) {
      return { ok: false, reason: "tracker_mismatch" };
    }
    if (webhookEvent.shipmentId && webhookEvent.shipmentId !== record.shipmentId) {
      return { ok: false, reason: "shipment_mismatch" };
    }

    if (this.seenEventIds.has(webhookEvent.easypostEventId)) {
      return { ok: true, record, outcome: "deduped", newStatus: record.status };
    }

    const ledgerEntry: StoredWebhookEvent = {
      eventId: webhookEvent.easypostEventId,
      jobId: record.jobId,
      at: webhookEvent.occurredAt,
      data: rawForLedger ?? webhookEvent,
    };

    // Ordering by the carrier's clock: an older event arriving late must not
    // move state (finding 7). It is still ledgered as seen.
    if (record.lastCarrierEventAt && Date.parse(webhookEvent.occurredAt) < Date.parse(record.lastCarrierEventAt)) {
      this.markSeen(ledgerEntry);
      return { ok: true, record, outcome: "stale", newStatus: record.status };
    }

    if (TERMINAL.has(record.status)) {
      this.markSeen(ledgerEntry);
      return { ok: true, record, outcome: "terminal", newStatus: record.status };
    }

    const next = nextStatus(webhookEvent.status, record.status);
    if (!next) {
      this.markSeen(ledgerEntry);
      return { ok: true, record, outcome: "no_transition", newStatus: record.status };
    }

    // Build evidence FIRST (finding 9). Nothing below runs if this throws.
    const evidenceEvent =
      next === "in_transit" || next === "delivered" ? await buildEvidenceEvent(record, next) : null;

    record.status = next;
    record.lastCarrierEventAt = webhookEvent.occurredAt;
    record.updatedAt = this.now().toISOString();
    if (evidenceEvent) record.events.push(evidenceEvent);
    this.persistRecord(record);
    this.markSeen(ledgerEntry);

    return { ok: true, record, outcome: "applied", newStatus: next };
  }

  private markSeen(e: StoredWebhookEvent): void {
    this.persistWebhookEvent(e);
    this.seenEventIds.add(e.eventId);
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

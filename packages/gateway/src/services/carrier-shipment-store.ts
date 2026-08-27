/**
 * Carrier shipment store — in-memory record of "we bought this real postage
 * label, pre-committed the destination + tracking claim before handoff, and
 * are watching for the carrier's own scan to confirm it entered the mail
 * stream." One record per print-and-mail job.
 *
 * In-memory + a Map, matching the lightweight service convention already in
 * this package (courier-jobs-store.ts) rather than a new SQLite table — this
 * is demo-scope infrastructure for one capability, not a shared cross-
 * operator store.
 */

import type { EvidenceEvent } from "@pcc/spec";
import type { ShipmentCommitment, TrackerWebhookEvent } from "./easypost-client.js";

export type CarrierShipmentStatus =
  | "label_bought"
  | "in_transit"
  | "delivered"
  | "return_to_sender"
  | "failed";

export interface CarrierShipmentRecord {
  jobId: string;
  kernelId: string;
  shipmentId: string;
  trackerId: string | null;
  trackingCode: string;
  labelUrl: string;
  carrier: string;
  service: string;
  commitment: ShipmentCommitment;
  /** True when the label was fabricated by the client's mock mode (no EASYPOST_API_KEY) — carries through to EvidenceEvent.source.simulated. */
  mock: boolean;
  status: CarrierShipmentStatus;
  events: EvidenceEvent[];
  seenEasyPostEventIds: Set<string>;
  createdAt: string;
  updatedAt: string;
}

export interface CarrierShipmentStoreOptions {
  now?: () => Date;
}

export type RecordCarrierEventResult =
  | { ok: true; record: CarrierShipmentRecord; deduped: boolean; newStatus: CarrierShipmentStatus }
  | { ok: false; reason: "unknown_tracking_code" };

function statusFromTrackerStatus(
  trackerStatus: string,
  current: CarrierShipmentStatus,
): CarrierShipmentStatus {
  switch (trackerStatus) {
    case "in_transit":
    case "out_for_delivery":
    case "available_for_pickup":
      return "in_transit";
    case "delivered":
      return "delivered";
    case "return_to_sender":
      return "return_to_sender";
    case "failure":
    case "cancelled":
      return "failed";
    // "pre_transit"/"unknown": label exists with the carrier but nothing has
    // been physically scanned yet — no meaningful transition for our purposes.
    default:
      return current;
  }
}

export class CarrierShipmentStore {
  private byJobId = new Map<string, CarrierShipmentRecord>();
  private byTrackingCode = new Map<string, string>(); // trackingCode -> jobId
  private now: () => Date;

  constructor(opts: CarrierShipmentStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  create(input: {
    jobId: string;
    kernelId: string;
    shipmentId: string;
    trackerId: string | null;
    trackingCode: string;
    labelUrl: string;
    carrier: string;
    service: string;
    commitment: ShipmentCommitment;
    mock: boolean;
  }): CarrierShipmentRecord {
    const ts = this.now().toISOString();
    const record: CarrierShipmentRecord = {
      ...input,
      status: "label_bought",
      events: [],
      seenEasyPostEventIds: new Set(),
      createdAt: ts,
      updatedAt: ts,
    };
    this.byJobId.set(input.jobId, record);
    this.byTrackingCode.set(input.trackingCode, input.jobId);
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

  /**
   * Records a carrier tracking webhook against its pre-committed shipment.
   * Idempotent on EasyPost's event id — a retried webhook delivery does not
   * append a duplicate EvidenceEvent. Returns { ok: false } if no shipment
   * was pre-committed for this tracking code: the physical-provenance point
   * is that a scan for an uncommitted tracking code proves nothing about any
   * PCC job and must never be treated as evidence for one.
   *
   * `buildEvidenceEvent` is called (and its result appended) only on a real
   * status transition that is evidentially meaningful (in_transit/delivered),
   * never on a dedup or a no-op status like "pre_transit".
   */
  async recordCarrierEvent(
    webhookEvent: TrackerWebhookEvent,
    buildEvidenceEvent: (
      record: CarrierShipmentRecord,
      newStatus: CarrierShipmentStatus,
    ) => Promise<EvidenceEvent | null> | EvidenceEvent | null,
  ): Promise<RecordCarrierEventResult> {
    const record = this.getByTrackingCode(webhookEvent.trackingCode);
    if (!record) return { ok: false, reason: "unknown_tracking_code" };

    if (record.seenEasyPostEventIds.has(webhookEvent.easypostEventId)) {
      return { ok: true, record, deduped: true, newStatus: record.status };
    }
    record.seenEasyPostEventIds.add(webhookEvent.easypostEventId);

    const previousStatus = record.status;
    const newStatus = statusFromTrackerStatus(webhookEvent.status, previousStatus);
    record.status = newStatus;
    record.updatedAt = this.now().toISOString();

    if (newStatus !== previousStatus) {
      const evidenceEvent = await buildEvidenceEvent(record, newStatus);
      if (evidenceEvent) record.events.push(evidenceEvent);
    }

    return { ok: true, record, deduped: false, newStatus };
  }
}

let singleton: CarrierShipmentStore | undefined;

export function initCarrierShipmentStore(
  opts: CarrierShipmentStoreOptions = {},
): CarrierShipmentStore {
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

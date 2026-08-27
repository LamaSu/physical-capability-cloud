/**
 * Lob letter store — in-memory record of "we created this real Lob letter,
 * committed the destination + document claim at creation, and are watching for
 * Lob's own webhook to report it mailed / delivered." One record per
 * print-and-mail job.
 *
 * This is a DELIBERATE, DOCUMENTED MIRROR of carrier-shipment-store.ts (the
 * human/USPS leg, PR #297 / origin/feat/carrier-integration) — same design:
 * idempotency on the provider's event id, append an EvidenceEvent only on an
 * evidentially-meaningful transition, and refuse to treat an event for an
 * uncommitted id as evidence for any job. It is a separate file, not a reuse of
 * that store, for two concrete reasons:
 *
 *   1. carrier-shipment-store.ts lives on an UNMERGED branch (PR #297); this
 *      worktree is off master and cannot import it.
 *   2. It keys records by `trackingCode`. Standard Lob letters have NO tracking
 *      number (see lob-client.ts asymmetry note), so the natural key here is
 *      Lob's `lobLetterId`, which is always present. A trackingCode-keyed store
 *      genuinely does not fit.
 *
 * When PR #297 lands, the shared shape (record + recordEvent + provenance
 * guard) should be hoisted into ONE operator-agnostic store keyed by a generic
 * correlationId. That unification is an operator/architecture decision
 * (#1310/#1618), out of scope here.
 *
 * In-memory + a Map, matching the lightweight service convention already in
 * this package (courier-jobs-store.ts / the carrier store) rather than a new
 * SQLite table — demo-scope infrastructure for one capability.
 */

import type { EvidenceEvent } from "@pcc/spec";
import type { LetterCommitment, LobLetterEvent } from "./lob-client.js";

/** Lob letter lifecycle, driven by `letter.*` webhook events. */
export type LobLetterStatus =
  | "created"
  | "rendered"
  | "mailed"
  | "in_transit"
  | "delivered"
  | "failed";

export interface LobLetterRecord {
  jobId: string;
  kernelId: string;
  lobLetterId: string;
  carrier: string;
  /** Usually null — only certified/registered Lob mail carries a USPS tracking_number. */
  trackingNumber: string | null;
  expectedDeliveryDate: string | null;
  url: string;
  commitment: LetterCommitment;
  /** True when the letter was fabricated by the client's mock mode (no LOB_API_KEY) — carries through to EvidenceEvent.source.simulated. */
  simulated: boolean;
  status: LobLetterStatus;
  events: EvidenceEvent[];
  seenLobEventIds: Set<string>;
  createdAt: string;
  updatedAt: string;
}

export interface LobLetterStoreOptions {
  now?: () => Date;
}

export type RecordLobEventResult =
  | { ok: true; record: LobLetterRecord; deduped: boolean; newStatus: LobLetterStatus }
  | { ok: false; reason: "unknown_letter" };

/** Maps a Lob `letter.*` event type to our lifecycle status. Unknown/uninteresting types leave status unchanged. */
function statusFromEventType(eventType: string, current: LobLetterStatus): LobLetterStatus {
  switch (eventType) {
    case "letter.created":
      return "created";
    case "letter.rendered_pdf":
      return "rendered";
    case "letter.mailed":
      return "mailed";
    case "letter.in_transit":
      return "in_transit";
    case "letter.delivered":
      return "delivered";
    case "letter.deleted":
    case "letter.failed":
      return "failed";
    default:
      return current;
  }
}

export class LobLetterStore {
  private byJobId = new Map<string, LobLetterRecord>();
  private byLetterId = new Map<string, string>(); // lobLetterId -> jobId
  private now: () => Date;

  constructor(opts: LobLetterStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  create(input: {
    jobId: string;
    kernelId: string;
    lobLetterId: string;
    carrier: string;
    trackingNumber: string | null;
    expectedDeliveryDate: string | null;
    url: string;
    commitment: LetterCommitment;
    simulated: boolean;
  }): LobLetterRecord {
    const ts = this.now().toISOString();
    const record: LobLetterRecord = {
      ...input,
      status: "created",
      events: [],
      seenLobEventIds: new Set(),
      createdAt: ts,
      updatedAt: ts,
    };
    this.byJobId.set(input.jobId, record);
    this.byLetterId.set(input.lobLetterId, input.jobId);
    return record;
  }

  getByJobId(jobId: string): LobLetterRecord | undefined {
    return this.byJobId.get(jobId);
  }

  getByLetterId(lobLetterId: string): LobLetterRecord | undefined {
    const jobId = this.byLetterId.get(lobLetterId);
    return jobId ? this.byJobId.get(jobId) : undefined;
  }

  size(): number {
    return this.byJobId.size;
  }

  /**
   * Records a Lob letter webhook against its committed letter. Idempotent on
   * Lob's event id — a retried webhook delivery does not append a duplicate
   * EvidenceEvent. Returns { ok: false } if no letter was committed for this
   * `lobLetterId`: an event for an uncommitted id proves nothing about any PCC
   * job and must never be treated as evidence for one (same provenance rule as
   * the carrier leg).
   *
   * `buildEvidenceEvent` is called (and its result appended) only on a real
   * status transition, and returns null for transitions with no matching
   * evidence-event type (created/rendered/in_transit/failed) — so only
   * `letter.mailed` and `letter.delivered` produce evidence.
   */
  async recordLetterEvent(
    event: LobLetterEvent,
    buildEvidenceEvent: (
      record: LobLetterRecord,
      newStatus: LobLetterStatus,
    ) => Promise<EvidenceEvent | null> | EvidenceEvent | null,
  ): Promise<RecordLobEventResult> {
    const record = this.getByLetterId(event.lobLetterId);
    if (!record) return { ok: false, reason: "unknown_letter" };

    if (record.seenLobEventIds.has(event.lobEventId)) {
      return { ok: true, record, deduped: true, newStatus: record.status };
    }
    record.seenLobEventIds.add(event.lobEventId);

    // A real USPS tracking_number can only appear on a later event (certified
    // mail); capture it if Lob ever provides one, but never overwrite a known
    // value with null.
    if (event.trackingNumber && !record.trackingNumber) {
      record.trackingNumber = event.trackingNumber;
    }

    const previousStatus = record.status;
    const newStatus = statusFromEventType(event.eventType, previousStatus);
    record.status = newStatus;
    record.updatedAt = this.now().toISOString();

    if (newStatus !== previousStatus) {
      const evidenceEvent = await buildEvidenceEvent(record, newStatus);
      if (evidenceEvent) record.events.push(evidenceEvent);
    }

    return { ok: true, record, deduped: false, newStatus };
  }
}

let singleton: LobLetterStore | undefined;

export function initLobLetterStore(opts: LobLetterStoreOptions = {}): LobLetterStore {
  singleton = new LobLetterStore(opts);
  return singleton;
}

export function getLobLetterStore(): LobLetterStore {
  if (!singleton) singleton = new LobLetterStore();
  return singleton;
}

export function _resetLobLetterStoreForTests(): void {
  singleton = undefined;
}

/**
 * Print-and-mail handoff store — in-memory record of "a gig worker claimed
 * this print-and-mail job, photographed the printed page + affixed label in
 * one frame before sealing, and dropped it at the post office." One record per
 * jobId.
 *
 * In-memory + a Map, matching the lightweight service convention already in
 * this package (courier-jobs-store.ts, and the sibling carrier-shipment-store.ts
 * on feat/carrier-integration) rather than a new SQLite table — this is
 * demo-scope infrastructure for one capability leg.
 *
 * INTEGRATION SEAM (why a bridge instead of an import)
 * ----------------------------------------------------
 * The carrier leg (POST /api/carrier/shipments + the tracking webhook) lives on
 * a SIBLING branch (feat/carrier-integration, PR #297), not on this one. This
 * module must NOT import that branch's code (it does not exist here, and the
 * task forbids modifying it). Instead it depends on a small `CarrierBridge`
 * interface that the sibling leg satisfies once both branches are on the same
 * tree. Until it is wired:
 *   - the referenced carrier commitment is recorded but NOT server-verified
 *     (`commitmentVerified: false` — nothing here falsely claims verification);
 *   - the mail-leg grader sees only handoff events, so the leg stays OPEN,
 *     which is the correct state — only the carrier scan can close it.
 * Post-merge wiring (a one-liner in server.ts, documented at the bottom of this
 * file) flips both on: commitment verification against the pre-committed label,
 * and the carrier `courier_pickup_confirmed` events flowing into the grader.
 */

import type { EvidenceEvent } from "@pcc/spec";

// ── Carrier-leg integration seam ────────────────────────────────────────────

export interface CarrierCommitmentRef {
  hash: string;
  trackingCode: string;
}

/**
 * The narrow view of the carrier leg this module needs. Satisfied by the
 * carrier-shipment-store on feat/carrier-integration once both branches merge.
 */
export interface CarrierBridge {
  /**
   * The pre-execution commitment for a job, if a carrier label was bought.
   * Used to VERIFY that a handoff's referenced commitmentHash/trackingCode
   * match the values committed BEFORE the envelope reached the human. Returns
   * null when no label was bought for this job.
   */
  getCommitment(jobId: string): CarrierCommitmentRef | null;
  /**
   * The carrier-emitted EvidenceEvents (courier_pickup_confirmed /
   * courier_delivery_confirmed) for a job. These are what actually close the
   * mail leg. Empty when no scan has arrived (or the bridge is not wired).
   */
  getEvents(jobId: string): readonly EvidenceEvent[];
}

let carrierBridge: CarrierBridge | null = null;

/** Wire the carrier leg in (called from server.ts once both legs are on-tree). Pass null to detach (tests). */
export function setCarrierBridge(bridge: CarrierBridge | null): void {
  carrierBridge = bridge;
}

export function getCarrierBridge(): CarrierBridge | null {
  return carrierBridge;
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface HandoffRecord {
  jobId: string;
  kernelId: string;
  driverAgent: string;
  commitmentHash: string;
  trackingCode: string;
  printJobId: string;
  /**
   * True ONLY when a wired CarrierBridge confirmed the referenced
   * commitmentHash + trackingCode match the pre-committed label for this job.
   * False on this branch (no bridge) — the binding is recorded as
   * caller-attested, never as verified.
   */
  commitmentVerified: boolean;
  /** The two handoff EvidenceEvents: custody_handoff_confirmed (human) + the envelope photo. */
  events: EvidenceEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface HandoffStoreOptions {
  now?: () => Date;
}

export class PrintAndMailHandoffStore {
  private byJobId = new Map<string, HandoffRecord>();
  private now: () => Date;

  constructor(opts: HandoffStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  getByJobId(jobId: string): HandoffRecord | undefined {
    return this.byJobId.get(jobId);
  }

  has(jobId: string): boolean {
    return this.byJobId.has(jobId);
  }

  size(): number {
    return this.byJobId.size;
  }

  /**
   * Persist a handoff record. The caller (route) has already built the two
   * EvidenceEvents and resolved `commitmentVerified` via the CarrierBridge.
   * Evidence is immutable here: one handoff record per job. A second call for
   * the same jobId is rejected by the route (409), never silently overwritten.
   */
  create(input: {
    jobId: string;
    kernelId: string;
    driverAgent: string;
    commitmentHash: string;
    trackingCode: string;
    printJobId: string;
    commitmentVerified: boolean;
    events: EvidenceEvent[];
  }): HandoffRecord {
    const ts = this.now().toISOString();
    const record: HandoffRecord = {
      ...input,
      createdAt: ts,
      updatedAt: ts,
    };
    this.byJobId.set(input.jobId, record);
    return record;
  }
}

// ── Singleton (mirrors carrier-shipment-store / courier-jobs-store) ──────────

let singleton: PrintAndMailHandoffStore | undefined;

export function initPrintAndMailHandoffStore(
  opts: HandoffStoreOptions = {},
): PrintAndMailHandoffStore {
  singleton = new PrintAndMailHandoffStore(opts);
  return singleton;
}

export function getPrintAndMailHandoffStore(): PrintAndMailHandoffStore {
  if (!singleton) singleton = new PrintAndMailHandoffStore();
  return singleton;
}

/** Test helper: reset the store AND detach any carrier bridge so each test is isolated. */
export function _resetPrintAndMailHandoffStoreForTests(): void {
  singleton = undefined;
  carrierBridge = null;
}

/*
 * ── Post-merge wiring (do NOT enable on this branch — carrier leg is a sibling) ──
 *
 * Once feat/carrier-integration is on the same tree, add to server.ts, right
 * after both `carrierRoutes` and `printAndMailRoutes` are registered:
 *
 *   import { getCarrierShipmentStore } from "./services/carrier-shipment-store.js";
 *   import { setCarrierBridge } from "./services/print-and-mail-handoff-store.js";
 *
 *   setCarrierBridge({
 *     getCommitment(jobId) {
 *       const r = getCarrierShipmentStore().getByJobId(jobId);
 *       return r ? { hash: r.commitment.hash, trackingCode: r.commitment.trackingCode } : null;
 *     },
 *     getEvents(jobId) {
 *       return getCarrierShipmentStore().getByJobId(jobId)?.events ?? [];
 *     },
 *   });
 *
 * That single wiring turns on (a) server-side verification that the handoff's
 * referenced commitment matches the pre-committed label, and (b) the carrier
 * scan events flowing into evaluateMailLeg so the leg can actually close.
 */

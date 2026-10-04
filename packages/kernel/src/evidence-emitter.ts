/**
 * Evidence Emitter — collects evidence events from all device adapters,
 * hashes them, and assembles signed Evidence Bundles.
 *
 * This is the core integrity component of the Shop Kernel. It ensures
 * every evidence event is content-addressed and every bundle is
 * cryptographically signed.
 */

import type {
  EvidenceEvent,
  EvidenceBundle,
  AssuranceTier,
  SHA256,
  Signature,
  TierEvidenceRequirements,
  Address,
} from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS, KERNEL_PULL_CAPTURE_TYPES, isFabricated, kernelPullCaptureIssue } from "@pcc/spec";
import { hashEvent, hashBundle } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { types } from "node:util";
import type { EvidenceStorageService, ArchiveResult } from "./evidence-storage.js";
import * as Sentry from "@sentry/node";

/** The camera event types; each counts toward a tier only as a closed LO-SE-1 capture for the job. */
const CAMERA_TYPES: readonly string[] = KERNEL_PULL_CAPTURE_TYPES;

/** An own data property's value, read without running a getter or a Proxy trap; otherwise undefined. */
function ownDataValue(target: unknown, key: string): unknown {
  if (target === null || typeof target !== "object" || types.isProxy(target)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/** The device that emitted `event`, named for a `missing` entry without running a getter or a trap. */
function deviceLabel(event: unknown): string {
  const deviceId = ownDataValue(ownDataValue(event, "source"), "deviceId");
  return typeof deviceId === "string" ? deviceId : "an unknown device";
}

/** In-memory store for evidence events per job step */
interface StepEvidence {
  jobId: string;
  stepId: string;
  events: EvidenceEvent[];
  assuranceTier: AssuranceTier;
  /** The escrow unit (milestone) and its challenge nonce, when the job names one. */
  unit?: StepUnitContext;
  /**
   * Settles once every addEvent called so far on the step has stored its event or failed. Each
   * call stores only after it, so the step's events are in call order (N123).
   */
  stored: Promise<void>;
}

/** `0x` + 64 lowercase hex each (LO-EV-9 unit binding). */
export interface StepUnitContext {
  settlementUnitId: string;
  challengeNonce: string;
}

const UNIT_FIELD = /^0x[0-9a-f]{64}$/;

export class EvidenceEmitter {
  private kernelId: string;
  private stepEvidence: Map<string, StepEvidence> = new Map();
  private bundleListeners: Array<(bundle: EvidenceBundle) => void> = [];
  /**
   * Signing function — async to support HSM/TEE/wallet signers in production.
   * Receives the tagged bundle digest; an Ed25519 signer must sign
   * `signingPreimage(data)` from @pcc/spec (LO-EV-1), never the raw digest bytes.
   */
  private signFn: (data: string) => Promise<Signature>;
  /** True when a real signing function was provided; false when using the test-only default */
  private _hasRealSignFn: boolean;
  /** Optional IPFS storage service — when set, bundles are archived after finalization */
  private storageService: EvidenceStorageService | null = null;
  /** Result from the most recent IPFS archive operation */
  private lastIpfsResult: ArchiveResult | undefined = undefined;

  constructor(
    kernelId: string,
    signFn?: (data: string) => Promise<Signature>,
  ) {
    this.kernelId = kernelId;
    this._hasRealSignFn = !!signFn;
    // TEST-ONLY default — replace with a real wallet signFn in production
    this.signFn = signFn ?? (async (data: string) => {
      console.warn(
        "[evidence-emitter] WARNING: Using test-only signing key (zero address). " +
          "Evidence bundles are NOT cryptographically verified. " +
          "Set a real signing key in production.",
      );
      return {
        signer: "0x0000000000000000000000000000000000000000" as Address,
        algorithm: "secp256k1" as const,
        value: `test_sig_${data.slice(0, 16)}`,
      };
    });
  }

  /** Returns true when using the test-only zero-address signing key. */
  isTestSigner(): boolean {
    return !this._hasRealSignFn;
  }

  /** Attach an IPFS storage service for automatic archiving */
  setStorageService(service: EvidenceStorageService): void {
    this.storageService = service;
  }

  /** Get the attached storage service (if any) */
  getStorageService(): EvidenceStorageService | null {
    return this.storageService;
  }

  /** Get the IPFS archive result from the most recent finalizeBundle call */
  getLastIpfsResult(): ArchiveResult | undefined {
    return this.lastIpfsResult;
  }

  /**
   * Register a job step to collect evidence for. `unit` names the escrow
   * settlement unit and its challenge nonce when the job has one; every event
   * of the step then commits both (LO-EV-9).
   */
  registerStep(jobId: string, stepId: string, assuranceTier: AssuranceTier, unit?: StepUnitContext): void {
    if (unit && !(UNIT_FIELD.test(unit.settlementUnitId) && UNIT_FIELD.test(unit.challengeNonce))) {
      throw new Error("registerStep: settlementUnitId and challengeNonce must be 0x + 64 lowercase hex");
    }
    const key = `${jobId}:${stepId}`;
    this.stepEvidence.set(key, {
      jobId,
      stepId,
      events: [],
      assuranceTier,
      ...(unit ? { unit } : {}),
      stored: Promise.resolve(),
    });
  }

  /**
   * Add an evidence event for a job step. The step's events are stored in the order this is
   * called, whatever order their hashes finish in (N123). The promise settles once this event
   * is stored, or rejects with the reason it was not.
   */
  async addEvent(
    jobId: string,
    stepId: string,
    rawEvent: Omit<EvidenceEvent, "id" | "hash">,
  ): Promise<EvidenceEvent> {
    const key = `${jobId}:${stepId}`;
    const stepEv = this.stepEvidence.get(key);
    if (!stepEv) {
      throw new Error(`No step registered for ${key}`);
    }

    // Every event names its job, and its unit when the step has one, inside the
    // hashed payload: LO-EV-9 and the oracle bind each event, not the bundle.
    // An adapter may pre-fill a field, but never with another job or unit, and
    // never with a unit the step was not given: the unit fields are reserved
    // for the binding.
    const payload: Record<string, unknown> = { ...((rawEvent.payload ?? {}) as Record<string, unknown>) };
    const commit: Record<string, string> = {
      jobId,
      ...(stepEv.unit ? { settlementUnitId: stepEv.unit.settlementUnitId, challengeNonce: stepEv.unit.challengeNonce } : {}),
    };
    if (!stepEv.unit) {
      for (const field of ["settlementUnitId", "challengeNonce"]) {
        if (payload[field] !== undefined) {
          throw new Error(`event payload.${field} is reserved for the step's unit, and this step has none`);
        }
      }
    }
    for (const [field, value] of Object.entries(commit)) {
      if (payload[field] !== undefined && payload[field] !== value) {
        throw new Error(`event payload.${field} ${String(payload[field])} does not match the step's ${value}`);
      }
      payload[field] = value;
    }
    const bound = { ...rawEvent, payload } as Omit<EvidenceEvent, "id" | "hash">;

    // Hashed now, from the event as called, and stored in call order (N123): an event waits for
    // the step's earlier events to be stored, or to fail, never for their hashes alone, so a slow
    // hash cannot put it after later events. The hashes still run concurrently. An event refused
    // above never takes a place.
    const id = ids.evidence();
    const hashed = hashEvent(bound);
    void hashed.catch(() => undefined); // a failed hash is this call's to report, in its turn; never unhandled meanwhile
    const stored = stepEv.stored.then(async () => {
      const event: EvidenceEvent = {
        ...bound,
        id,
        hash: await hashed,
      };
      stepEv.events.push(event);
      return event;
    });
    stepEv.stored = stored.then(
      () => undefined,
      () => undefined,
    );
    return stored;
  }

  /** Finalize and sign an evidence bundle for a job step */
  async finalizeBundle(jobId: string, stepId: string): Promise<EvidenceBundle> {
    const key = `${jobId}:${stepId}`;
    const stepEv = this.stepEvidence.get(key);
    if (!stepEv) {
      throw new Error(`No step registered for ${key}`);
    }
    if (stepEv.events.length === 0) {
      throw new Error(`No evidence events for ${key}`);
    }

    const bundleHashValue = await hashBundle(stepEv.events);
    const signature = await this.signFn(bundleHashValue);

    const bundle: EvidenceBundle = {
      id: ids.bundle(),
      jobId: stepEv.jobId,
      stepId: stepEv.stepId,
      kernelId: this.kernelId,
      assuranceTier: stepEv.assuranceTier,
      events: [...stepEv.events],
      bundleHash: bundleHashValue,
      kernelSignature: signature,
      createdAt: new Date().toISOString(),
    };

    // Mark bundles signed with the test key so consumers can distinguish them
    if (!this._hasRealSignFn) {
      (bundle as unknown as Record<string, unknown>)._testSigned = true;
    }

    // Archive to IPFS if storage service is available (best-effort)
    if (this.storageService?.isReady()) {
      try {
        const ipfsResult = await Sentry.startSpan(
          {
            name: "evidence.ipfs_archive",
            op: "storage",
            attributes: {
              "bundle.id": bundle.id,
              "job.id": bundle.jobId,
              "kernel.id": this.kernelId,
            },
          },
          async () => this.storageService!.archiveBundle(bundle),
        );
        this.lastIpfsResult = ipfsResult;
      } catch {
        // IPFS archival is best-effort — do not block bundle finalization
        this.lastIpfsResult = undefined;
      }
    }

    // Notify listeners
    for (const listener of this.bundleListeners) {
      listener(bundle);
    }

    return bundle;
  }

  /**
   * Check whether evidence meets the requirements for a tier.
   *
   * An event counts, both toward its required-type group and toward the
   * minimum-event floor, only when it is authentic:
   *   - A fabricated (mock/simulated) event never counts, so a bundle of
   *     all-fabricated events meets no tier (coord #312/#316).
   *   - A camera event (camera_snapshot, cv_inspection_result) counts only
   *     when it is a closed LO-SE-1 kernel-pull capture for `options.jobId`:
   *     kernelPullCaptureIssue(event, jobId) in @pcc/spec returns null (astra
   *     pack 155 HIGH 1). Its type alone never counts, and neither does a
   *     legacy, careless, empty or push-fed payload. With no `options.jobId`,
   *     no camera event counts: fail closed.
   *   - Each camera event that does not count adds a `missing` entry naming
   *     why. A bundle carrying one therefore does not meet the tier, even
   *     when another capture does count.
   * Other event types count by their type, as before.
   */
  checkTierRequirements(
    events: EvidenceEvent[],
    tier: AssuranceTier,
    requirements: TierEvidenceRequirements[] = DEFAULT_TIER_REQUIREMENTS,
    options: { jobId?: string } = {},
  ): { met: boolean; missing: string[] } {
    const tierReq = requirements.find((r) => r.tier === tier);
    if (!tierReq) {
      return { met: false, missing: [`No requirements defined for tier ${tier}`] };
    }

    // Each event's type is read once, and the same value is used to classify it
    // and to count it. A camera event gets the reason it does not count (null
    // when it does). These arrays are built by map/filter/flatMap and literals,
    // never by [[Set]], so no Array.prototype setter runs (astra pack 158).
    const jobId = options?.jobId ?? "";
    const assessed = events.map((event) => {
      const type = event.type;
      const cameraIssue = CAMERA_TYPES.includes(type) ? kernelPullCaptureIssue(event, jobId) : null;
      return { event, type, cameraIssue };
    });
    const counted = assessed.filter(({ event, cameraIssue }) => cameraIssue === null && !isFabricated(event));
    const countedTypes = new Set(counted.map(({ type }) => type));

    const missing = [
      // At least one event type from each group must be present.
      ...tierReq.requiredEventTypes.flatMap((group) =>
        group.some((t) => countedTypes.has(t)) ? [] : [`Missing one of: ${group.join(" | ")}`],
      ),
      ...assessed.flatMap(({ event, type, cameraIssue }) =>
        cameraIssue === null ? [] : [`${type} from ${deviceLabel(event)}: not an LO-SE-1 capture for this job (${cameraIssue})`],
      ),
      ...(counted.length < tierReq.minimumEvents
        ? [`Need at least ${tierReq.minimumEvents} events, have ${counted.length}`]
        : []),
    ];

    return { met: missing.length === 0, missing };
  }

  /** Get events for a job step */
  getEvents(jobId: string, stepId: string): EvidenceEvent[] {
    const key = `${jobId}:${stepId}`;
    return this.stepEvidence.get(key)?.events ?? [];
  }

  /** Subscribe to finalized bundles */
  onBundle(callback: (bundle: EvidenceBundle) => void): void {
    this.bundleListeners.push(callback);
  }

  /** Clean up evidence for a completed job step */
  cleanup(jobId: string, stepId: string): void {
    this.stepEvidence.delete(`${jobId}:${stepId}`);
  }
}

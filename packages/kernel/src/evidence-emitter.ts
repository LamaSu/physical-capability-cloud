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
import { DEFAULT_TIER_REQUIREMENTS } from "@pcc/spec";
import { hashEvent, hashBundle } from "@pcc/spec";
import { ids } from "@pcc/spec";
import type { EvidenceStorageService, ArchiveResult } from "./evidence-storage.js";
import * as Sentry from "@sentry/node";

/** In-memory store for evidence events per job step */
interface StepEvidence {
  jobId: string;
  stepId: string;
  events: EvidenceEvent[];
  assuranceTier: AssuranceTier;
}

export class EvidenceEmitter {
  private kernelId: string;
  private stepEvidence: Map<string, StepEvidence> = new Map();
  private bundleListeners: Array<(bundle: EvidenceBundle) => void> = [];
  /** Signing function — async to support HSM/TEE/wallet signers in production */
  private signFn: (data: string) => Promise<Signature>;
  /** Optional IPFS storage service — when set, bundles are archived after finalization */
  private storageService: EvidenceStorageService | null = null;
  /** Result from the most recent IPFS archive operation */
  private lastIpfsResult: ArchiveResult | undefined = undefined;

  constructor(
    kernelId: string,
    signFn?: (data: string) => Promise<Signature>,
  ) {
    this.kernelId = kernelId;
    // TEST-ONLY default — replace with a real wallet signFn in production
    this.signFn = signFn ?? (async (data: string) => ({
      signer: "0x0000000000000000000000000000000000000000" as Address,
      algorithm: "secp256k1" as const,
      value: `test_sig_${data.slice(0, 16)}`,
    }));
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

  /** Register a job step to collect evidence for */
  registerStep(jobId: string, stepId: string, assuranceTier: AssuranceTier): void {
    const key = `${jobId}:${stepId}`;
    this.stepEvidence.set(key, {
      jobId,
      stepId,
      events: [],
      assuranceTier,
    });
  }

  /** Add an evidence event for a job step */
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

    const id = ids.evidence();
    const hash = await hashEvent(rawEvent);

    const event: EvidenceEvent = {
      ...rawEvent,
      id,
      hash,
    };

    stepEv.events.push(event);
    return event;
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

  /** Check if evidence meets the requirements for a tier */
  checkTierRequirements(
    events: EvidenceEvent[],
    tier: AssuranceTier,
    requirements: TierEvidenceRequirements[] = DEFAULT_TIER_REQUIREMENTS,
  ): { met: boolean; missing: string[] } {
    const tierReq = requirements.find((r) => r.tier === tier);
    if (!tierReq) {
      return { met: false, missing: [`No requirements defined for tier ${tier}`] };
    }

    const eventTypes = new Set(events.map((e) => e.type));
    const missing: string[] = [];

    for (const group of tierReq.requiredEventTypes) {
      // At least one event type from each group must be present
      const found = group.some((t) => eventTypes.has(t));
      if (!found) {
        missing.push(`Missing one of: ${group.join(" | ")}`);
      }
    }

    if (events.length < tierReq.minimumEvents) {
      missing.push(`Need at least ${tierReq.minimumEvents} events, have ${events.length}`);
    }

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

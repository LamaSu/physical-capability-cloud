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
} from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS } from "@pcc/spec";
import { hashEvent, hashBundle } from "@pcc/spec";
import { ids } from "@pcc/spec";

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
  /** Mock signing function — in production, use HSM/TEE */
  private signFn: (data: string) => Signature;

  constructor(
    kernelId: string,
    signFn?: (data: string) => Signature,
  ) {
    this.kernelId = kernelId;
    this.signFn = signFn ?? ((data: string) => ({
      signer: "0x0000000000000000000000000000000000000000" as const,
      algorithm: "secp256k1" as const,
      value: `mock_sig_${data.slice(0, 16)}`,
    }));
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
    const signature = this.signFn(bundleHashValue);

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

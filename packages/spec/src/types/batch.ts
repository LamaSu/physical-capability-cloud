/**
 * Batch tracking types — for shared instruments that run multiple samples.
 *
 * A BatchManifest groups SampleSlots into a single instrument run (e.g. an
 * HPLC autosampler tray). Each slot maps one user's sample to a physical
 * position. BatchEvents track the lifecycle of the run.
 */

import type { Address, Id, SHA256, Timestamp } from "./common.js";

/** Batch manifest for shared instruments (chromatography autosampler, etc.) */
export interface BatchManifest {
  /** batch_xxx */
  id: Id;
  kernelId: Id;
  deviceId: Id;
  capabilityId: Id;
  status: "assembling" | "sealed" | "running" | "completed" | "failed" | "partial";
  sealedAt?: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  slots: SampleSlot[];
  runConfig: Record<string, unknown>;
  /** e.g. "HPLC_RP_C18_gradient_30min" */
  methodId?: string;
}

/** Maps one user's sample to a physical position in the batch instrument */
export interface SampleSlot {
  /** slot_xxx */
  id: Id;
  /** e.g. "A1", "vial-7", "well-H12" */
  position: string;
  jobId: Id;
  stepId: Id;
  userId: Address;
  sampleLabel: string;
  sampleType?: "unknown" | "standard" | "blank" | "system_suitability" | "sample" | "spike" | "duplicate";
  status: "pending" | "queued" | "injecting" | "acquiring" | "processing" | "completed" | "failed";
  acquisitionStart?: Timestamp;
  acquisitionEnd?: Timestamp;
  resultHash?: SHA256;
  resultRef?: string;
}

/** Batch lifecycle event */
export interface BatchEvent {
  id: Id;
  batchId: Id;
  timestamp: Timestamp;
  type:
    | "batch_created" | "sample_added" | "batch_sealed" | "batch_started"
    | "sample_injection_start" | "sample_acquisition_start" | "sample_acquisition_end"
    | "sample_result_available" | "sample_completed" | "sample_failed"
    | "batch_completed" | "batch_failed";
  slotId?: Id;
  payload: Record<string, unknown>;
}

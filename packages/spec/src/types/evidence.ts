/**
 * Evidence types — cryptographic proof that physical work happened.
 *
 * Evidence is collected at multiple layers (G-code, power, camera, vibration,
 * TEE attestation) and bundled into content-addressed bundles that are signed
 * by the Shop Kernel and attested by verifiers.
 */

import type { Id, SHA256, Timestamp, Signature, AssuranceTier } from "./common.js";

/** Types of evidence events */
export type EvidenceEventType =
  // G-code lifecycle
  | "gcode_received"
  | "gcode_hash_verified"
  | "gcode_loaded"
  // Execution lifecycle
  | "execution_started"
  | "execution_progress"
  | "execution_completed"
  | "execution_failed"
  // Sensor signals
  | "power_profile_sample"
  | "power_profile_summary"
  | "vibration_signature"
  | "acoustic_signature"
  | "temperature_log"
  // Camera / vision
  | "camera_snapshot"
  | "cv_inspection_result"
  // TEE
  | "tee_attestation"
  // Custody
  | "custody_sealed"
  | "custody_handoff_initiated"
  | "custody_handoff_confirmed"
  | "courier_pickup_confirmed"
  | "courier_delivery_confirmed";

/** Source device that produced an evidence event */
export interface EvidenceSource {
  deviceId: Id;
  deviceType: "controller" | "camera" | "power_monitor" | "vibration_sensor" |
              "acoustic_sensor" | "temperature_sensor" | "tee" | "courier_api" | "human";
  kernelId: Id;
  firmwareVersion?: string;
}

/** A single evidence event — one signal from one source */
export interface EvidenceEvent {
  id: Id;
  type: EvidenceEventType;
  timestamp: Timestamp;
  source: EvidenceSource;
  /** The actual data — varies by event type */
  payload: Record<string, unknown>;
  /** SHA-256 of canonical JSON of (type + timestamp + source + payload) */
  hash: SHA256;
}

/**
 * An Evidence Bundle — a collection of events for one job step,
 * content-addressed and signed by the Shop Kernel.
 *
 * This is what gets submitted for verification and referenced on-chain.
 */
export interface EvidenceBundle {
  id: Id;
  jobId: Id;
  stepId: Id;
  kernelId: Id;
  assuranceTier: AssuranceTier;
  /** All evidence events in this bundle */
  events: EvidenceEvent[];
  /** SHA-256 of canonical JSON of all event hashes, sorted */
  bundleHash: SHA256;
  /** Kernel's signature over bundleHash */
  kernelSignature: Signature;
  /** When this bundle was finalized */
  createdAt: Timestamp;
}

/** Requirements for each assurance tier */
export interface TierEvidenceRequirements {
  tier: AssuranceTier;
  requiredEventTypes: EvidenceEventType[][];  // outer = AND groups, inner = OR within group
  minimumEvents: number;
  description: string;
}

/** Default tier requirements */
export const DEFAULT_TIER_REQUIREMENTS: TierEvidenceRequirements[] = [
  {
    tier: 0,
    requiredEventTypes: [
      ["gcode_hash_verified"],
      ["execution_completed"],
    ],
    minimumEvents: 2,
    description: "G-code hash match + execution completion signal",
  },
  {
    tier: 1,
    requiredEventTypes: [
      ["gcode_hash_verified"],
      ["execution_completed"],
      ["power_profile_summary"],
    ],
    minimumEvents: 3,
    description: "Tier 0 + power consumption profile match",
  },
  {
    tier: 2,
    requiredEventTypes: [
      ["gcode_hash_verified"],
      ["execution_completed"],
      ["power_profile_summary"],
      ["cv_inspection_result", "camera_snapshot"],
    ],
    minimumEvents: 4,
    description: "Tier 1 + camera/CV verification",
  },
  {
    tier: 3,
    requiredEventTypes: [
      ["gcode_hash_verified"],
      ["execution_completed"],
      ["power_profile_summary"],
      ["cv_inspection_result"],
      ["tee_attestation"],
    ],
    minimumEvents: 5,
    description: "Tier 2 + TEE attestation + independent inspection",
  },
];

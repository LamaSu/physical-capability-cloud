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
  | "courier_delivery_confirmed"
  // Sensor pipeline events
  | "sensor_data_summary"
  | "sensor_anomaly_detected"
  | "process_log_summary"
  // Batch tracking events
  | "batch_session_started"
  | "batch_session_completed"
  | "batch_sample_result"
  | "instrument_result"
  // Encryption / ZK events
  | "evidence_committed"
  | "evidence_encrypted"
  | "zk_proof_generated"
  | "zk_proof_verified"
  // Universal device events
  | "device_birth"
  | "device_death"
  | "device_heartbeat"
  | "calibration_record"
  | "method_loaded"
  | "sequence_started"
  // Photo verification events (WS2)
  | "photo_captured"
  | "photo_reference_set"
  | "photo_comparison_result"
  | "photo_anti_spoof_check"
  // Machine log events (WS3)
  | "printer_log_captured"
  | "printer_job_verified"
  | "log_hash_chain_entry"
  // Digital workflow events
  | "workflow_step_completed"
  | "digital_task_started"
  | "digital_task_completed"
  | "touchstone_dispatched"
  | "touchstone_verified"
  // Capture Verification Protocol (CVP) events — one per meaningful
  // transition in the capture-verification lifecycle. Emitted by the
  // gateway and verifier as a capture flows from declaration to anchor.
  | "capture_class_declared"
  | "capture_nonce_issued"
  | "capture_submitted"
  | "capture_signature_verified"
  | "capture_liveness_result"
  | "capture_multi_sensor_fusion"
  | "capture_anchor_committed";

/** Source device that produced an evidence event */
export interface EvidenceSource {
  deviceId: Id;
  deviceType: "controller" | "camera" | "photo-camera" | "power_monitor" | "vibration_sensor" |
              "acoustic_sensor" | "temperature_sensor" | "tee" | "courier_api" | "human" |
              "instrument" | "chromatograph" | "bioreactor" | "autosampler" |
              "spectrometer" | "thermal_camera" | "force_sensor" | "flow_sensor" |
              "ph_sensor" | "gas_analyzer" | "plc" | "robot_arm" |
              "pcb_placer" | "gateway_bridge" |
              "digital_agent" | "workflow_engine";
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

/** Block anchor for anti-replay freshness binding */
export interface BlockAnchor {
  chainId: number;
  blockNumber: bigint;
  blockHash: string; // 0x-prefixed hex
  timestamp: bigint; // block timestamp in seconds
}

/** A challenge issued by a parent agent or gateway to bind execution to a point in time */
export interface WorkflowChallenge {
  challengeId: string; // UUID
  issuedBy: string; // ERC-8004 AgentRegistryId or kernel ID
  anchor: BlockAnchor; // The block at challenge issue time
  maxAgeSeconds: number; // Default 600 (10 min)
  scope: string; // Contract ID or job ID this binds to
}

/** Proof that execution happened after a challenge was issued */
export interface ExecutionProof {
  challengeId: string;
  proofHash: string; // SHA256(challengeId + blockHash + workOutputRoot)
  workOutputRoot: string; // Hash of work outputs
  computedAtBlock: bigint; // Block number when proof was computed
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

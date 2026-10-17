/**
 * Evidence types — cryptographic proof that physical work happened.
 *
 * Evidence is collected at multiple layers (G-code, power, camera, vibration,
 * TEE attestation) and bundled into content-addressed bundles that are signed
 * by the Shop Kernel and attested by verifiers.
 */

import type { Id, SHA256, Timestamp, Signature, AssuranceTier } from "./common.js";

/**
 * The single source of truth for evidence event types.
 *
 * The zod mirror (`schemas/index.ts` EvidenceEventTypeSchema) derives its enum
 * from THIS array, so the TS union and the runtime validator cannot drift.
 * (They had: the zod enum listed only 27 of these values, so sila
 * `instrument_result`, modbus `sensor_data_summary`, machine-log
 * `printer_log_captured` / `log_hash_chain_entry`, batch and digital-workflow
 * events all failed EvidenceEventSchema.parse wherever it was enforced —
 * the same drift bug as the deviceType enum, caught by the reconciliation
 * tests.)
 */
export const EVIDENCE_EVENT_TYPES = [
  // G-code lifecycle
  "gcode_received",
  "gcode_hash_verified",
  "gcode_loaded",
  // Execution lifecycle
  "execution_started",
  "execution_progress",
  "execution_completed",
  "execution_failed",
  // Sensor signals
  "power_profile_sample",
  "power_profile_summary",
  "vibration_signature",
  "acoustic_signature",
  "temperature_log",
  // Camera / vision
  "camera_snapshot",
  "cv_inspection_result",
  // TEE
  "tee_attestation",
  // Custody
  "custody_sealed",
  "custody_handoff_initiated",
  "custody_handoff_confirmed",
  "courier_pickup_confirmed",
  "courier_delivery_confirmed",
  // Sensor pipeline events
  "sensor_data_summary",
  "sensor_anomaly_detected",
  "process_log_summary",
  // Batch tracking events
  "batch_session_started",
  "batch_session_completed",
  "batch_sample_result",
  "instrument_result",
  // Encryption / ZK events
  "evidence_committed",
  "evidence_encrypted",
  "zk_proof_generated",
  "zk_proof_verified",
  // Universal device events
  "device_birth",
  "device_death",
  "device_heartbeat",
  "calibration_record",
  /**
   * Payload: { jobId, deviceJobId, inputHash }, plus settlementUnitId and
   * challengeNonce when the step has a settlement unit (LO-EV-9 binding);
   * a verifier must not require an exact key set. inputHash has format
   * `^sha256:[0-9a-f]{64}$`: SHA-256 of the exact input bytes, with no text,
   * newline or BOM normalization. The SHA256 type is only a brand.
   *
   * PR-1a's contract: on JobRunner's prepare and legacy load_gcode paths
   * only, a run in which an adapter or device emits method_loaded carrying
   * inputHash fails. PR-1a does not cover runPrintJob. The kernel writes its
   * method_loaded carrying inputHash after the device's prepare ack echoes
   * jobId and inputHash. The prepare path ALWAYS carries inputData; the
   * kernel computes inputHash itself from those bytes, and a hash-only
   * prepare is refused. The every-path refusal, runPrintJob included, and
   * the source.writer "kernel" marker (event hash v2) both arrive with ADK
   * PR-1d. On the prepare path EVERY adapter method_loaded is refused, with
   * or without inputHash. A legacy adapter's method_loaded without inputHash
   * may appear, and makes input.hash_bound NOT met. Before PR-1a (#665) the
   * kernel had no prepare command and wrote no method_loaded;
   * adapter-pylabrobot still emits its own method_loaded, on the legacy
   * path, until PR-1c.
   *
   * input.hash_bound requires at least one method_loaded. EVERY one must be
   * kernel-written and carry payload.inputHash equal to the funded subject
   * block's nonzero recipeRef, read only from the authenticated subjects
   * object. It must be on the same deviceJobId as the completion: spec's
   * LO-EV-9 step 8 and the oracle's input.hash_bound verifier mirror the
   * binding (#8973), failing closed when absent. Every method_loaded must
   * carry the same non-empty string payload.deviceJobId, and at least one
   * execution_completed must exist; EVERY execution_completed must carry
   * that exact deviceJobId. Until a producer stamps both event types
   * (PR-1a's kernel, or PR-2a's runDeviceJob), this rule cannot be met.
   * The oracle's process.batch_record verifier today reads payload.methodHash
   * (or hash, gcodeHash, recipeHash, programHash) of the FIRST method_loaded;
   * it must read inputHash before a template lists both primitives.
   *
   * Go-live precondition: input.hash_bound joins no verifiedPrimitives set
   * and never flips to live until (i) ADK PR-1a and PR-1d are merged (PR-1d
   * brings the every-path refusal, runPrintJob included, and the marker),
   * (ii) this marker and v2 hash are merged, and (iii) the oracle's verifier
   * SHIPs with the marker
   * requirement. It remains a stub until all three hold.
   */
  "method_loaded",
  "sequence_started",
  // Photo verification events (WS2)
  "photo_captured",
  "photo_reference_set",
  "photo_comparison_result",
  "photo_anti_spoof_check",
  // Machine log events (WS3)
  "printer_log_captured",
  "printer_job_verified",
  "log_hash_chain_entry",
  // Digital workflow events
  "workflow_step_completed",
  "digital_task_started",
  "digital_task_completed",
  "touchstone_dispatched",
  "touchstone_verified",
  // Capture Verification Protocol (CVP) events — one per meaningful
  // transition in the capture-verification lifecycle. Emitted by the
  // gateway and verifier as a capture flows from declaration to anchor.
  "capture_class_declared",
  "capture_nonce_issued",
  "capture_submitted",
  "capture_signature_verified",
  "capture_liveness_result",
  "capture_multi_sensor_fusion",
  "capture_anchor_committed",
] as const;

/** Types of evidence events */
export type EvidenceEventType = (typeof EVIDENCE_EVENT_TYPES)[number];

/**
 * The single source of truth for evidence-source device types.
 *
 * The zod mirror (`schemas/index.ts` EvidenceSourceSchema.deviceType) derives
 * its enum from THIS array, so the TS union and the runtime validator can
 * never drift again. (They had drifted: the zod enum listed only the first 9
 * values, so sila / modbus / opentrons / instrument events failed
 * EvidenceEventSchema.parse wherever it was enforced — see
 * ai/research/evidence-oracle-fabrication-detection-handoff.md §6.)
 */
export const EVIDENCE_DEVICE_TYPES = [
  "controller", "camera", "photo-camera", "power_monitor", "vibration_sensor",
  "acoustic_sensor", "temperature_sensor", "tee", "courier_api", "human",
  "instrument", "chromatograph", "bioreactor", "autosampler",
  "spectrometer", "thermal_camera", "force_sensor", "flow_sensor",
  "ph_sensor", "gas_analyzer", "plc", "robot_arm",
  "pcb_placer", "gateway_bridge",
  "digital_agent", "workflow_engine",
] as const;

/** A device type that can appear on an EvidenceSource. */
export type EvidenceDeviceType = (typeof EVIDENCE_DEVICE_TYPES)[number];

/** Source device that produced an evidence event */
export interface EvidenceSource {
  deviceId: Id;
  deviceType: EvidenceDeviceType;
  kernelId: Id;
  firmwareVersion?: string;
  /**
   * Reserved for events the kernel itself writes. Absent means not
   * kernel-attested. Adapters and devices never set it, and the kernel
   * refuses an event that arrives carrying it. An event carrying this
   * marker hashes under event hash v2 (util/canonical.ts).
   */
  writer?: "kernel";
  /**
   * True when the emitting adapter is a mock/simulated device or is running
   * in mock mode — i.e. every event from this source is fabricated-by-design
   * simulation data, NOT a reading from physical hardware. Detector layers
   * (ALCOA authenticity, oracle attestation) must treat evidence carrying
   * `source.simulated: true` (or `payload.mock: true`) as non-authentic.
   * Absent/undefined means the adapter claims to be real hardware.
   */
  simulated?: boolean;
}

/** A single evidence event — one signal from one source */
export interface EvidenceEvent {
  id: Id;
  type: EvidenceEventType;
  timestamp: Timestamp;
  source: EvidenceSource;
  /** The actual data — varies by event type */
  payload: Record<string, unknown>;
  /** SHA-256 of canonical event JSON; source.writer selects v2 (util/canonical.ts). */
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
  /**
   * Delegation proving that the ephemeral Ed25519 key in `kernelSignature`
   * was authorised by the kernel's registered principal signing key.
   * Binary values use lowercase hex on the JSON wire.
   */
  sessionKeyAuthorization?: SessionKeyAuthorization;
  /** When this bundle was finalized */
  createdAt: Timestamp;
}

/** JSON-wire form of a principal-authorised ephemeral session key. */
export interface SessionKeyAuthorization {
  sessionId: string;
  parentAgentId: string;
  /** Raw 32-byte Ed25519 session public key (64 hex chars, optional 0x). */
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
  scope: {
    allowedActions: string[];
    contractIds: string[];
    maxSignatures: number;
  };
  /** Principal signature over the canonical SessionKey body (64-byte hex). */
  parentSignature: string;
  derivationPath?: string;
}

/**
 * Requirements for each assurance tier. A supplied array carries no policy
 * provenance: EvidenceVerifier performs a precheck under the caller's ladder.
 * The oracle selects its ladder from the funded committed program identity.
 */
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

/** Default tier requirements, deeply frozen by the public evidence module's initialization. */
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

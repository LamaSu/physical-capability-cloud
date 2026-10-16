/**
 * Device adapter interfaces.
 *
 * A device adapter wraps a physical machine (CNC, printer, sensor, camera)
 * and exposes a standard interface for the kernel to control it and
 * collect evidence.
 *
 * The evidence handshake, quiesceEvidence() (#502 round 3b). The kernel records an event
 * under whichever job's window is open when it arrives, so a job's window closes, and its
 * devices pass to the next job, only on the adapter's word that it is done. Every adapter
 * must implement it, and the JobRunner refuses one that does not. The contract:
 *   - it resolves once the adapter has emitted every evidence event of the work it was
 *     given, and the adapter emits nothing for that work afterwards;
 *   - it must NOT resolve while given work can still emit: a running poll or execution loop
 *     that may still report a completion or failure, a sampling timer, an async callback or
 *     command in flight;
 *   - called again with no new work, it resolves at once.
 * The runner calls it at the end of every run, success or failure, bounded by its
 * evidenceQuiesceTimeoutMs; a device whose hook has not resolved stays unavailable to the
 * next job until it does (fail closed). An adapter that cannot know when it is done waits
 * for the strongest signal it has. OutstandingWork (outstanding-work.ts) counts what is
 * outstanding for an adapter that tracks its own work.
 *
 * Commands and the device job. The device names its own job for the PCC job:
 * prepare's ack supplies data.deviceJobId on the neutral path; runPrintJob uses
 * start's data.jobId on the print path. Every event of that device job carries
 * the id in payload.deviceJobId (neutral) or payload.ippJobId (print), compared
 * strictly. payload.jobId is the PCC job's id, committed by the emitter (LO-EV-9).
 * An event naming another device job is foreign; an event naming none is not
 * that job's. runPrintJob enforces this binding; JobRunner does not yet bind
 * events to the device job. The oracle's input.hash_bound check requires the
 * completion's deviceJobId to equal method_loaded's deviceJobId.
 */

import type { EvidenceEvent, EvidenceEventType, EvidenceSource, WorkflowChallenge } from "@pcc/spec";

/** Status a machine adapter can report */
export type MachineStatus = "idle" | "busy" | "error" | "offline" | "maintenance";

/**
 * A command to send to a machine. prepare { jobId, inputHash, inputData } only stages and
 * validates input: no motion, heat, dispense, or device-state change beyond
 * staging. Anything that actuates belongs to start, whose payload is { jobId }.
 * inputData is always a fresh Uint8Array of the exact bytes the kernel hashed
 * (a string's UTF-8 bytes). The adapter must stage exactly those bytes.
 * A hash-only prepare is refused until a verified resolve-by-hash exists.
 *
 * inputHash is sha256: followed by 64 lowercase hex digits, the SHA-256 of the
 * exact input bytes without text, newline or BOM normalization. gcodeHash is
 * its legacy alias. load_gcode carries { gcodeHash, jobId } and no input bytes.
 * Only the kernel emits method_loaded with an inputHash key. After a matching
 * prepare ack, it records { jobId, deviceJobId, inputHash } from its own values
 * as the kernel-signed input proof. On every path, an adapter method_loaded
 * carrying an inputHash key (any value) is never recorded and fails the job
 * closed. Every adapter method_loaded fails a prepare job. Legacy emissions
 * without inputHash remain recorded unchanged. The kernel rechecks after
 * evidence settles to catch events mutated after emission or recording.
 */
export interface MachineCommand {
  type: "prepare" | "load_gcode" | "start" | "pause" | "resume" | "stop" | "status";
  payload?: Record<string, unknown>;
}

/**
 * Result of a machine command. A prepare ack must have success: true and
 * data: { jobId, inputHash, deviceJobId }. jobId and inputHash echo the command
 * exactly; deviceJobId is a non-empty string naming the device's staged job.
 * Echo inputHash only for the exact bytes received in payload.inputData and
 * staged for that device job. The kernel signs an input proof only for bytes
 * it hashed itself; a hash-only prepare is refused until a verified
 * resolve-by-hash exists.
 * Any other ack fails the job closed before start.
 */
export interface MachineCommandResult {
  success: boolean;
  /** The device refused because it is busy; no job was accepted. */
  busy?: true;
  message?: string;
  data?: Record<string, unknown>;
}

/** Interface every machine adapter must implement */
export interface MachineAdapter {
  readonly id: string;
  readonly type: "fdm" | "cnc-3axis" | "cnc-5axis" | "sla" | "lathe" | "laser-cut" | "ipp-2d" | "liquid-handler" | (string & {});
  readonly source: EvidenceSource;

  /**
   * The complete list of command types this adapter implements. Absent means
   * a legacy adapter, driven as today: load_gcode then start. When present,
   * JobRunner sends no type outside this list: it uses prepare if listed,
   * otherwise load_gcode. Without start or either input command, it refuses
   * the job before sending any command.
   */
  readonly accepts?: readonly MachineCommand["type"][];

  /** Get current status */
  getStatus(): Promise<MachineStatus>;

  /** Send a command to the machine */
  execute(command: MachineCommand): Promise<MachineCommandResult>;

  /**
   * Cancel the named job while continuing to report it, so its terminal state arrives as evidence.
   * Bound post-cancel polling by a cancel-confirm deadline. If no terminal state arrives,
   * emit execution_failed with origin: "device" and stop polling that job, then quiesce.
   * The deadline (plus one poll) must expire within the caller's cancelWindowMs. Otherwise
   * the kernel records its own failure first, and that failure decides the verdict's origin.
   * Past cancelWindowMs + evidenceQuiesceTimeoutMs, the print fails without a bundle and
   * the device stays quiescing until the adapter's failure ends the job.
   * quiesceEvidence must still wait while the job's work can emit; the kernel finalizes
   * only after this confirmation, including when it has recorded its own failure event.
   */
  cancelJob?(jobId: string | number): Promise<void>;

  /** Get current progress (0-100) */
  getProgress(): Promise<number>;

  /**
   * Subscribe to evidence events from this machine.
   * execution_completed and execution_failed must report terminal states, because the kernel sends no cancel after either one.
   */
  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void;

  /**
   * Resolves once this adapter has emitted every evidence event of the work it was given,
   * and never while that work can still emit; it emits nothing for that work afterwards.
   * Required: see the contract at the top of this file.
   */
  quiesceEvidence(): Promise<void>;

  /** Disconnect / cleanup */
  dispose(): Promise<void>;
}

/** Interface for sensor adapters (power, vibration, acoustic, temperature) */
export interface SensorAdapter {
  readonly id: string;
  readonly type: "power_monitor" | "vibration_sensor" | "acoustic_sensor" | "temperature_sensor";
  readonly source: EvidenceSource;

  /** Start recording */
  startRecording(jobId: string): Promise<void>;

  /** Stop recording and return summary event */
  stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">>;

  /** Get current reading */
  getCurrentReading(): Promise<Record<string, unknown>>;

  /** Subscribe to evidence events */
  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void;

  /** Required: see MachineAdapter.quiesceEvidence and the contract at the top of this file. */
  quiesceEvidence(): Promise<void>;

  dispose(): Promise<void>;
}

/** Interface for camera/vision adapters */
/**
 * What a capture is for. A camera that acquires its own frames (the pull
 * adapter) binds these into the signed payload and refuses a capture without
 * `jobId`; adapters that ignore it are unchanged.
 */
export interface CaptureContext {
  jobId: string;
  /** The job's challenge, rendered in the camera's field as a visual nonce, when one was issued. */
  challenge?: WorkflowChallenge;
}

export interface CameraAdapter {
  readonly id: string;
  readonly source: EvidenceSource;

  /** Capture a snapshot */
  captureSnapshot(context?: CaptureContext): Promise<{ imageHash: string; storageRef: string }>;

  /** Run CV inspection on current view */
  runInspection(referenceHash?: string, context?: CaptureContext): Promise<{
    passed: boolean;
    confidence: number;
    findings: string[];
    imageHash: string;
  }>;

  /** Subscribe to evidence events */
  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void;

  /** Required: see MachineAdapter.quiesceEvidence and the contract at the top of this file. */
  quiesceEvidence(): Promise<void>;

  dispose(): Promise<void>;
}

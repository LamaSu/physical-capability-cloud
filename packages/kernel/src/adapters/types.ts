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
 */

import type { EvidenceEvent, EvidenceEventType, EvidenceSource } from "@pcc/spec";

/** Status a machine adapter can report */
export type MachineStatus = "idle" | "busy" | "error" | "offline" | "maintenance";

/** A command to send to a machine */
export interface MachineCommand {
  type: "load_gcode" | "start" | "pause" | "resume" | "stop" | "status";
  payload?: Record<string, unknown>;
}

/** Result of a machine command */
export interface MachineCommandResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

/** Interface every machine adapter must implement */
export interface MachineAdapter {
  readonly id: string;
  readonly type: "fdm" | "cnc-3axis" | "cnc-5axis" | "sla" | "lathe" | "laser-cut" | "ipp-2d" | "liquid-handler" | (string & {});
  readonly source: EvidenceSource;

  /** Get current status */
  getStatus(): Promise<MachineStatus>;

  /** Send a command to the machine */
  execute(command: MachineCommand): Promise<MachineCommandResult>;

  /** Get current progress (0-100) */
  getProgress(): Promise<number>;

  /** Subscribe to evidence events from this machine */
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
export interface CameraAdapter {
  readonly id: string;
  readonly source: EvidenceSource;

  /** Capture a snapshot */
  captureSnapshot(): Promise<{ imageHash: string; storageRef: string }>;

  /** Run CV inspection on current view */
  runInspection(referenceHash?: string): Promise<{
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

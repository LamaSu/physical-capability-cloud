/**
 * Device adapter interfaces.
 *
 * A device adapter wraps a physical machine (CNC, printer, sensor, camera)
 * and exposes a standard interface for the kernel to control it and
 * collect evidence.
 *
 * Evidence timing contract (#502 round 3). The kernel assigns an evidence event to a job
 * by when it arrives, so a job's evidence window stays open until the adapter is done:
 *   - an adapter WITH quiesceEvidence() resolves it once it has emitted every event of the
 *     work it was given, and emits nothing for that work afterwards;
 *   - an adapter WITHOUT it must not emit a job's evidence later than the runner's
 *     evidenceQuietMs (default 1000 ms) after that job's previous event. A later event is
 *     dropped, or, if the next job's window is open by then, recorded under that job.
 * A completion that a poll loop reports one poll interval after the device finished (OctoPrint,
 * IPP and Hamilton poll every 2-3 s) can break the second rule: such an adapter should
 * implement quiesceEvidence (one final poll, then stop polling).
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
   * Optional. Resolves once this adapter has emitted every evidence event of the work it
   * was given; it emits nothing for that work afterwards. Without it, the adapter must not
   * emit a job's evidence later than evidenceQuietMs after that job's previous event (see
   * the contract at the top of this file).
   */
  quiesceEvidence?(): Promise<void>;

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

  /** Optional: see MachineAdapter.quiesceEvidence. */
  quiesceEvidence?(): Promise<void>;

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

  /** Optional: see MachineAdapter.quiesceEvidence. */
  quiesceEvidence?(): Promise<void>;

  dispose(): Promise<void>;
}

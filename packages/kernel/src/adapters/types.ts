/**
 * Device adapter interfaces.
 *
 * A device adapter wraps a physical machine (CNC, printer, sensor, camera)
 * and exposes a standard interface for the kernel to control it and
 * collect evidence.
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
  readonly type: "fdm" | "cnc-3axis" | "cnc-5axis" | "sla" | "lathe" | "laser-cut";
  readonly source: EvidenceSource;

  /** Get current status */
  getStatus(): Promise<MachineStatus>;

  /** Send a command to the machine */
  execute(command: MachineCommand): Promise<MachineCommandResult>;

  /** Get current progress (0-100) */
  getProgress(): Promise<number>;

  /** Subscribe to evidence events from this machine */
  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void;

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

  dispose(): Promise<void>;
}

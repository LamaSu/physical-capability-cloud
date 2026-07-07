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

/**
 * Resource/precondition requirements declared for a job, checked by an
 * adapter's optional `preflight()` before any hardware dispatch, session
 * key mint, or escrow cost is incurred.
 */
export interface PreflightRequest {
  /** Named resource requirements, e.g. `{ filamentGrams: 42, buildVolumeMm3: 18000 }`. */
  requirements: Record<string, number>;
  /** Optional job id, for diagnostics/correlation only. */
  jobId?: string;
}

/** Typed refusal reason — never a bare string. */
export interface PreflightRefusal {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PreflightResult {
  ok: boolean;
  /** Present when ok === false. */
  refusal?: PreflightRefusal;
  /**
   * Present when ok === true and the adapter is holding a two-phase
   * reservation the caller must later finalize (commit on success,
   * rollback if the job never actually runs).
   */
  reservationId?: string;
}

/** Interface every machine adapter must implement */
export interface MachineAdapter {
  readonly id: string;
  readonly type: "fdm" | "cnc-3axis" | "cnc-5axis" | "sla" | "lathe" | "laser-cut" | "ipp-2d" | "liquid-handler" | (string & {});
  readonly source: EvidenceSource;

  /** Get current status */
  getStatus(): Promise<MachineStatus>;

  /**
   * Optional pre-flight resource/precondition check — refuse-to-start
   * BEFORE escrow/session-key/execute cost is incurred (the PyLabRobot
   * poka-yoke seam: a calibrated capacity check gates hardware dispatch).
   * Adapters that declare no resource model MAY omit this method
   * entirely; callers MUST treat a missing `preflight` as "no check
   * required" and proceed straight to `execute()`. This keeps preflight
   * strictly additive — existing adapters that don't implement it are
   * unaffected.
   */
  preflight?(input: PreflightRequest): Promise<PreflightResult>;

  /**
   * Optional two-phase finalizers for a hold returned by `preflight()`
   * (`PreflightResult.reservationId`). `commitReservation` permanently consumes
   * the held capacity once the job actually ran; `rollbackReservation` releases
   * the hold (consuming nothing) when the job never ran / was refused upstream.
   *
   * An adapter that implements `preflight()` with a two-phase reservation SHOULD
   * implement both; adapters that hold no reservation MAY omit them. The
   * composition-layer pre-flight gate finalizes each step's hold through these
   * (commit on success, rollback on refusal / unreached steps). Additive —
   * existing adapters that never held a reservation are unaffected.
   */
  commitReservation?(reservationId: string): void;
  rollbackReservation?(reservationId: string): void;

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

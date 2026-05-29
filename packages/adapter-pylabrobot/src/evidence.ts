/**
 * Evidence collection for PyLabRobot jobs.
 *
 * Folds three streams into the standard PCC evidence pipeline:
 *
 *   1. PLR atomic-op events pushed via the sidecar's `evidence` JSON-RPC
 *      notifications (one per aspirate/dispense/pickUpTips/dropTips).
 *   2. Optional camera-adapter hooks for Tier-2+ before/after photos
 *      surrounding each plate operation. Adapter is duck-typed (anything
 *      with a `captureSnapshot()` method); no hard dependency.
 *   3. Optional sensor-adapter readings (gravimetric scale, pressure trace,
 *      temperature/RPM from heater-shakers).
 *
 * Output shape matches `EvidenceEvent` from `@pcc/spec` minus `id` + `hash`,
 * which are computed by the kernel evidence emitter when it receives them.
 */

import type { EvidenceEventType, EvidenceSource } from "@pcc/spec";
import type {
  AdapterEvidenceEvent,
  EvidenceCallback,
} from "./types.js";
import type { EvidenceNotificationParams } from "./protocol.js";

/** Duck-typed camera hook — anything with a snapshot method works */
export interface CameraHook {
  captureSnapshot(): Promise<{ imageHash: string; storageRef: string }>;
}

/** Duck-typed sensor hook for gravimetric / pressure / temperature side-channels */
export interface SensorHook {
  /** Take a single instantaneous reading */
  getCurrentReading(): Promise<Record<string, unknown>>;
  /** Optional channel descriptor for evidence payloads */
  readonly channel?: string;
}

export interface EvidenceCollectorConfig {
  source: EvidenceSource;
  /** Tier the job is running at (0–3) — controls which extra hooks fire */
  assuranceTier?: 0 | 1 | 2 | 3;
  /** Optional camera adapter for before/after plate-op photos (Tier 2+) */
  camera?: CameraHook;
  /** Optional sensor adapters for environmental + gravimetric/pressure data */
  sensors?: SensorHook[];
}

/**
 * Maps the sidecar's free-form event type strings onto the PCC
 * `EvidenceEventType` union. Anything we don't recognize maps to
 * `instrument_result` so the kernel still receives + hashes it.
 */
function mapEventType(sidecarType: string): EvidenceEventType {
  switch (sidecarType) {
    case "execution_started":
    case "execution_progress":
    case "execution_completed":
    case "execution_failed":
    case "calibration_record":
    case "method_loaded":
    case "sequence_started":
    case "device_birth":
    case "device_death":
    case "device_heartbeat":
    case "instrument_result":
    case "process_log_summary":
    case "camera_snapshot":
    case "temperature_log":
      return sidecarType;
    case "log":
    case "plr_log":
      return "process_log_summary";
    case "atomic_op":
    case "aspirate":
    case "dispense":
    case "transfer":
    case "pickUpTips":
    case "dropTips":
    case "mix":
      return "instrument_result";
    case "ready":
    case "setup":
      return "device_birth";
    case "shutdown":
    case "dispose":
      return "device_death";
    default:
      return "instrument_result";
  }
}

/**
 * Per-job evidence collector. Construct one per `evidence.startRecording`
 * window. Buffers events in-memory and forwards them to the registered
 * listener.
 */
export class EvidenceCollector {
  private readonly listeners: EvidenceCallback[] = [];
  private readonly buffer: AdapterEvidenceEvent[] = [];
  private readonly config: EvidenceCollectorConfig;
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  /** Atomic-op counter for the current recording window */
  private opCount = 0;

  constructor(config: EvidenceCollectorConfig) {
    this.config = config;
  }

  /** Register a downstream listener (typically the adapter's emit pipeline) */
  onEvidence(cb: EvidenceCallback): void {
    this.listeners.push(cb);
  }

  /** Manually emit an event (used by the adapter for execution_started etc.) */
  emit(event: AdapterEvidenceEvent): void {
    this.buffer.push(event);
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // listener errors don't break the recording
      }
    }
  }

  /**
   * Fold an evidence notification coming from the Python sidecar into a
   * PCC EvidenceEvent and dispatch it.
   */
  ingestSidecarNotification(params: EvidenceNotificationParams): void {
    this.opCount += 1;
    const event: AdapterEvidenceEvent = {
      type: mapEventType(params.type),
      timestamp: params.timestamp ?? new Date().toISOString(),
      source: this.config.source,
      payload: {
        ...params.payload,
        sidecarType: params.type,
        jobId: params.jobId,
      },
    };
    this.emit(event);
  }

  /** Begin a recording window — emits `execution_started` */
  startRecording(jobId: string): void {
    this.startedAt = Date.now();
    this.opCount = 0;
    this.emit({
      type: "execution_started",
      timestamp: new Date().toISOString(),
      source: this.config.source,
      payload: { jobId },
    });
  }

  /**
   * End a recording window — emits `execution_completed` and returns the
   * full buffered event list (for the adapter's bundle hand-off to the
   * kernel evidence pipeline).
   */
  stopRecording(jobId: string, summary?: Record<string, unknown>): AdapterEvidenceEvent[] {
    this.endedAt = Date.now();
    this.emit({
      type: "execution_completed",
      timestamp: new Date().toISOString(),
      source: this.config.source,
      payload: {
        jobId,
        opCount: this.opCount,
        durationMs: this.endedAt - (this.startedAt ?? this.endedAt),
        ...(summary ?? {}),
      },
    });
    return [...this.buffer];
  }

  /**
   * Emit a failure event. Returns the buffered events for surfacing in the
   * kernel's failed-bundle path.
   */
  failRecording(jobId: string, reason: string, extra?: Record<string, unknown>): AdapterEvidenceEvent[] {
    this.endedAt = Date.now();
    this.emit({
      type: "execution_failed",
      timestamp: new Date().toISOString(),
      source: this.config.source,
      payload: {
        jobId,
        reason,
        opCount: this.opCount,
        durationMs: this.endedAt - (this.startedAt ?? this.endedAt),
        ...(extra ?? {}),
      },
    });
    return [...this.buffer];
  }

  /** Capture a snapshot via the camera hook (no-op if no camera configured) */
  async snapshot(label: string): Promise<void> {
    if (!this.config.camera) return;
    try {
      const { imageHash, storageRef } = await this.config.camera.captureSnapshot();
      this.emit({
        type: "camera_snapshot",
        timestamp: new Date().toISOString(),
        source: this.config.source,
        payload: { label, imageHash, storageRef },
      });
    } catch (err) {
      this.emit({
        type: "process_log_summary",
        timestamp: new Date().toISOString(),
        source: this.config.source,
        payload: {
          label,
          warning: "camera snapshot failed",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /** Sample every configured sensor and emit one `temperature_log` per */
  async sampleSensors(label: string): Promise<void> {
    if (!this.config.sensors || this.config.sensors.length === 0) return;
    for (const sensor of this.config.sensors) {
      try {
        const reading = await sensor.getCurrentReading();
        this.emit({
          type: "temperature_log",
          timestamp: new Date().toISOString(),
          source: this.config.source,
          payload: { label, channel: sensor.channel ?? "unknown", reading },
        });
      } catch (err) {
        this.emit({
          type: "process_log_summary",
          timestamp: new Date().toISOString(),
          source: this.config.source,
          payload: {
            label,
            warning: "sensor read failed",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  /** Snapshot of buffered events (mostly for tests / diagnostics) */
  snapshotBuffer(): readonly AdapterEvidenceEvent[] {
    return this.buffer;
  }

  /** Op counter for the current recording window */
  getOpCount(): number {
    return this.opCount;
  }
}

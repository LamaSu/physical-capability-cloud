/**
 * Mock FDM (Fused Deposition Modeling) 3D printer adapter.
 *
 * Simulates an OctoPrint/Klipper-connected printer with:
 * - G-code loading and execution
 * - Progress tracking
 * - Temperature reporting
 * - Evidence event emission
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import { ResourceTracker, type ResourceBounds, ResourceTrackerError } from "@pcc/resource-tracker";
import type {
  MachineAdapter,
  MachineCommand,
  MachineCommandResult,
  MachineStatus,
  PreflightRequest,
  PreflightResult,
} from "./types.js";

/**
 * Reference calibration for the mock printer's resource pool. Round,
 * documented placeholder numbers (this is a simulator, not a real
 * printer spec) — a spool's worth of filament and a desktop-FDM-sized
 * build volume.
 */
export interface MockFDMResourceConfig {
  filamentGrams?: { available: number; bounds?: ResourceBounds };
  buildVolumeMm3?: { available: number; bounds?: ResourceBounds };
}

const DEFAULT_RESOURCE_CONFIG: Required<MockFDMResourceConfig> = {
  filamentGrams: { available: 1000, bounds: { min: 1, max: 1000, unit: "g" } },
  buildVolumeMm3: { available: 12_100_000, bounds: { min: 1, max: 12_100_000, unit: "mm3" } },
};

export class MockFDMAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as const;
  readonly source: EvidenceSource;

  private status: MachineStatus = "idle";
  private progress = 0;
  private gcodeHash: string | null = null;
  private executionTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  /** Simulated job duration in ms */
  private jobDurationMs: number;

  /** Calibrated capacity + 2-phase reservation ledger backing preflight(). */
  private readonly resources: ResourceTracker;

  constructor(id: string, kernelId: string, jobDurationMs = 10_000, resourceConfig: MockFDMResourceConfig = {}) {
    this.id = id;
    this.jobDurationMs = jobDurationMs;
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId,
      firmwareVersion: "MockFDM-1.0.0",
    };

    const filament = { ...DEFAULT_RESOURCE_CONFIG.filamentGrams, ...resourceConfig.filamentGrams };
    const buildVolume = { ...DEFAULT_RESOURCE_CONFIG.buildVolumeMm3, ...resourceConfig.buildVolumeMm3 };
    this.resources = new ResourceTracker(
      { filamentGrams: filament.bounds!, buildVolumeMm3: buildVolume.bounds! },
      { filamentGrams: filament.available, buildVolumeMm3: buildVolume.available },
    );
  }

  async getStatus(): Promise<MachineStatus> {
    return this.status;
  }

  /**
   * Reference preflight() implementation: refuse-to-start before
   * execute()/escrow if the declared requirements are out of the
   * calibrated range OR exceed what's currently on hand (accounting for
   * other pending reservations). On success, capacity is held (not yet
   * consumed) — the caller commits after a successful run, or rolls back
   * if the job never executes.
   */
  async preflight(input: PreflightRequest): Promise<PreflightResult> {
    try {
      const reservation = this.resources.reserve(input.requirements);
      return { ok: true, reservationId: reservation.id };
    } catch (err) {
      if (err instanceof ResourceTrackerError) {
        return { ok: false, refusal: { code: err.code, message: err.message, details: err.details } };
      }
      throw err;
    }
  }

  /** Phase 2a: a preflight-approved job actually ran — permanently consume the held capacity. */
  commitReservation(reservationId: string): void {
    this.resources.commit(reservationId);
  }

  /** Phase 2b: a preflight-approved job never ran / aborted — release the hold, consume nothing. */
  rollbackReservation(reservationId: string): void {
    this.resources.rollback(reservationId);
  }

  async getProgress(): Promise<number> {
    return this.progress;
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    switch (command.type) {
      case "load_gcode": {
        const hash = command.payload?.gcodeHash as string;
        if (!hash) return { success: false, message: "No gcodeHash provided" };
        this.gcodeHash = hash;
        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { gcodeHash: hash },
        });
        this.emit({
          type: "gcode_hash_verified",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { gcodeHash: hash, verified: true },
        });
        return { success: true, message: "G-code loaded" };
      }

      case "start": {
        if (!this.gcodeHash) return { success: false, message: "No G-code loaded" };
        if (this.status === "busy") return { success: false, message: "Already running" };
        this.status = "busy";
        this.progress = 0;

        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { gcodeHash: this.gcodeHash },
        });

        // Simulate progress
        const intervalMs = this.jobDurationMs / 20;
        this.executionTimer = setInterval(() => {
          this.progress = Math.min(100, this.progress + 5);

          if (this.progress % 25 === 0 && this.progress < 100) {
            this.emit({
              type: "execution_progress",
              timestamp: new Date().toISOString(),
              source: this.source,
              payload: {
                progress: this.progress,
                bedTemp: 60 + Math.random() * 2,
                nozzleTemp: 200 + Math.random() * 5,
                layerCurrent: Math.floor(this.progress * 1.5),
                layerTotal: 150,
              },
            });
          }

          if (this.progress >= 100) {
            this.completeJob();
          }
        }, intervalMs);

        return { success: true, message: "Print started" };
      }

      case "pause": {
        if (this.executionTimer) clearInterval(this.executionTimer);
        this.executionTimer = null;
        this.status = "idle";
        return { success: true, message: "Paused" };
      }

      case "stop": {
        this.cancelJob();
        return { success: true, message: "Stopped" };
      }

      case "status": {
        return {
          success: true,
          data: {
            status: this.status,
            progress: this.progress,
            gcodeHash: this.gcodeHash,
          },
        };
      }

      default:
        return { success: false, message: `Unknown command: ${command.type}` };
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.cancelJob();
    this.listeners = [];
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private completeJob(): void {
    if (this.executionTimer) clearInterval(this.executionTimer);
    this.executionTimer = null;
    this.status = "idle";
    this.progress = 100;

    this.emit({
      type: "execution_completed",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        gcodeHash: this.gcodeHash,
        durationSeconds: this.jobDurationMs / 1000,
        layerCount: 150,
        filamentUsedMm: 4500,
        avgBedTemp: 60.5,
        avgNozzleTemp: 201.2,
      },
    });
  }

  private cancelJob(): void {
    if (this.executionTimer) clearInterval(this.executionTimer);
    this.executionTimer = null;
    this.status = "idle";
    this.progress = 0;
    this.gcodeHash = null;
  }
}

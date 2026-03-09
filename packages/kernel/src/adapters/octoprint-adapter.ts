/**
 * OctoPrint/Moonraker adapter for real FDM printers.
 *
 * Connects to an OctoPrint or Moonraker API over HTTP.
 * Polls printer state and emits evidence events.
 *
 * OctoPrint API docs: https://docs.octoprint.org/en/master/api/
 * Moonraker API docs: https://moonraker.readthedocs.io/
 *
 * In production: set PRINTER_URL and PRINTER_API_KEY environment variables.
 * In development: uses built-in mock mode (no real printer needed).
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "./types.js";

export interface OctoPrintConfig {
  /** Printer URL (e.g., "http://192.168.1.50:5000") */
  url: string;
  /** API key for authentication */
  apiKey: string;
  /** Kernel ID this printer belongs to */
  kernelId: string;
  /** Poll interval in ms (default 2000) */
  pollIntervalMs?: number;
  /** Use mock mode (no real HTTP calls) */
  mockMode?: boolean;
}

interface PrinterState {
  state: string; // "Operational", "Printing", "Paused", "Error", "Offline"
  progress: number;
  temperatures: {
    bed: { actual: number; target: number };
    tool0: { actual: number; target: number };
  };
  job: {
    name: string | null;
    estimatedPrintTime: number | null;
    filamentLength: number | null;
  };
}

export class OctoPrintAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as const;
  readonly source: EvidenceSource;

  private config: OctoPrintConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastState: PrinterState | null = null;
  private mockProgress = 0;
  private mockStatus: MachineStatus = "idle";

  constructor(id: string, config: OctoPrintConfig) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId: config.kernelId,
      firmwareVersion: "OctoPrint-Adapter-1.0.0",
    };
  }

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) return this.mockStatus;

    try {
      const state = await this.fetchPrinterState();
      return this.mapStatus(state.state);
    } catch {
      return "offline";
    }
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return this.mockProgress;

    try {
      const state = await this.fetchPrinterState();
      return state.progress;
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.config.mockMode) return this.executeMock(command);

    try {
      switch (command.type) {
        case "load_gcode": {
          const filename = command.payload?.filename as string;
          if (!filename) return { success: false, message: "No filename provided" };

          // OctoPrint: select file for printing
          await this.apiPost("/api/files/local/" + encodeURIComponent(filename), {
            command: "select",
          });

          this.emit({
            type: "gcode_received",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { filename, gcodeHash: command.payload?.gcodeHash },
          });
          return { success: true, message: `File ${filename} selected` };
        }

        case "start": {
          await this.apiPost("/api/job", { command: "start" });
          this.startPolling();
          this.emit({
            type: "execution_started",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {},
          });
          return { success: true, message: "Print started" };
        }

        case "pause": {
          await this.apiPost("/api/job", { command: "pause", action: "pause" });
          return { success: true, message: "Print paused" };
        }

        case "resume": {
          await this.apiPost("/api/job", { command: "pause", action: "resume" });
          return { success: true, message: "Print resumed" };
        }

        case "stop": {
          await this.apiPost("/api/job", { command: "cancel" });
          this.stopPolling();
          return { success: true, message: "Print cancelled" };
        }

        case "status": {
          const state = await this.fetchPrinterState();
          return {
            success: true,
            data: {
              state: state.state,
              progress: state.progress,
              bedTemp: state.temperatures.bed.actual,
              nozzleTemp: state.temperatures.tool0.actual,
              jobName: state.job.name,
            },
          };
        }

        default:
          return { success: false, message: `Unknown command: ${command.type}` };
      }
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "OctoPrint API error",
      };
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.stopPolling();
    this.listeners = [];
  }

  // ---------------------------------------------------------------------------
  // OctoPrint API helpers
  // ---------------------------------------------------------------------------

  private async fetchPrinterState(): Promise<PrinterState> {
    const [printerRes, jobRes] = await Promise.all([
      this.apiGet("/api/printer"),
      this.apiGet("/api/job"),
    ]);

    return {
      state: printerRes.state?.text ?? "Unknown",
      progress: jobRes.progress?.completion ?? 0,
      temperatures: {
        bed: printerRes.temperature?.bed ?? { actual: 0, target: 0 },
        tool0: printerRes.temperature?.tool0 ?? { actual: 0, target: 0 },
      },
      job: {
        name: jobRes.job?.file?.name ?? null,
        estimatedPrintTime: jobRes.job?.estimatedPrintTime ?? null,
        filamentLength: jobRes.job?.filament?.tool0?.length ?? null,
      },
    };
  }

  private async apiGet(path: string): Promise<Record<string, any>> {
    const res = await fetch(`${this.config.url}${path}`, {
      headers: { "X-Api-Key": this.config.apiKey },
    });
    if (!res.ok) throw new Error(`OctoPrint ${path}: ${res.status}`);
    return res.json();
  }

  private async apiPost(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.config.url}${path}`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OctoPrint ${path}: ${res.status}`);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config.pollIntervalMs ?? 2000;

    this.pollTimer = setInterval(async () => {
      try {
        const state = await this.fetchPrinterState();
        this.handleStateChange(state);
        this.lastState = state;
      } catch {
        // Silently handle poll failures
      }
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private handleStateChange(state: PrinterState): void {
    const prev = this.lastState;

    // Emit progress at 25% intervals
    if (prev && Math.floor(state.progress / 25) > Math.floor(prev.progress / 25)) {
      this.emit({
        type: "execution_progress",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          progress: state.progress,
          bedTemp: state.temperatures.bed.actual,
          nozzleTemp: state.temperatures.tool0.actual,
        },
      });
    }

    // Detect completion
    if (prev && prev.state === "Printing" && state.state === "Operational" && prev.progress > 95) {
      this.emit({
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          jobName: prev.job.name,
          finalBedTemp: state.temperatures.bed.actual,
          finalNozzleTemp: state.temperatures.tool0.actual,
        },
      });
      this.stopPolling();
    }
  }

  // ---------------------------------------------------------------------------
  // Mock mode
  // ---------------------------------------------------------------------------

  private executeMock(command: MachineCommand): MachineCommandResult {
    switch (command.type) {
      case "load_gcode":
        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { gcodeHash: command.payload?.gcodeHash, mock: true },
        });
        return { success: true, message: "G-code loaded (mock)" };

      case "start":
        this.mockStatus = "busy";
        this.mockProgress = 0;
        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { mock: true },
        });
        return { success: true, message: "Print started (mock)" };

      case "stop":
        this.mockStatus = "idle";
        this.mockProgress = 0;
        return { success: true, message: "Stopped (mock)" };

      case "status":
        return {
          success: true,
          data: { status: this.mockStatus, progress: this.mockProgress, mock: true },
        };

      default:
        return { success: true, message: `${command.type} (mock)` };
    }
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private mapStatus(octoprintState: string): MachineStatus {
    switch (octoprintState) {
      case "Operational": return "idle";
      case "Printing": return "busy";
      case "Paused": case "Pausing": return "idle";
      case "Error": case "Closed": return "error";
      case "Offline": return "offline";
      default: return "idle";
    }
  }
}

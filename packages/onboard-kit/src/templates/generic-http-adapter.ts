/**
 * Generic HTTP adapter template.
 *
 * Wraps any device that exposes an HTTP/REST API into a PCC MachineAdapter.
 * Configure it with your device's specific endpoints, then the kernel can
 * control it and collect evidence.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

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

/** Configuration for an HTTP endpoint on the device */
export interface HttpEndpointConfig {
  /** HTTP method */
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** URL path (relative to baseUrl) */
  path: string;
  /** Optional request body template — ${key} placeholders replaced with command payload values */
  bodyTemplate?: Record<string, unknown>;
  /** Optional headers */
  headers?: Record<string, string>;
}

/** Status mapping: map your device's status string to PCC status */
export interface StatusMapping {
  /** Field in the JSON response that contains the status */
  statusField: string;
  /** Map of device status value → PCC MachineStatus */
  map: Record<string, MachineStatus>;
  /** Default PCC status if no match */
  default: MachineStatus;
}

/** Progress mapping: extract progress from device response */
export interface ProgressMapping {
  /** Field in the JSON response that contains progress (0-100) */
  progressField: string;
  /** If the device uses a different scale, provide min/max to normalize to 0-100 */
  scale?: { min: number; max: number };
}

/** Full configuration for the generic HTTP adapter */
export interface GenericHttpAdapterConfig {
  /** Base URL of the device API (e.g., "http://192.168.1.100:8080") */
  baseUrl: string;
  /** Kernel ID this device belongs to */
  kernelId: string;
  /** Machine type (PCC capability type) */
  machineType: string;
  /** Authentication */
  auth?: {
    type: "header" | "bearer" | "query";
    key: string;
    value: string;
  };
  /** Endpoint configurations */
  endpoints: {
    status: HttpEndpointConfig;
    progress: HttpEndpointConfig;
    loadProgram: HttpEndpointConfig;
    start: HttpEndpointConfig;
    stop: HttpEndpointConfig;
    pause?: HttpEndpointConfig;
    resume?: HttpEndpointConfig;
  };
  /** How to map device status to PCC status */
  statusMapping: StatusMapping;
  /** How to extract progress */
  progressMapping: ProgressMapping;
  /** Poll interval in ms (default 2000) */
  pollIntervalMs?: number;
  /** Use mock mode (no real HTTP calls) */
  mockMode?: boolean;
}

export class GenericHttpAdapter {
  readonly id: string;
  readonly type: string;
  readonly source: EvidenceSource;

  private config: GenericHttpAdapterConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgress = 0;
  private mockStatus: MachineStatus = "idle";
  private mockProgress = 0;

  constructor(id: string, config: GenericHttpAdapterConfig) {
    this.id = id;
    this.type = config.machineType;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId: config.kernelId,
      firmwareVersion: `GenericHttp-${config.machineType}-1.0.0`,
    };
  }

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) return this.mockStatus;

    try {
      const data = await this.callEndpoint(this.config.endpoints.status);
      const rawStatus = this.extractField(data, this.config.statusMapping.statusField);
      return this.config.statusMapping.map[String(rawStatus)] ?? this.config.statusMapping.default;
    } catch {
      return "offline";
    }
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return this.mockProgress;

    try {
      const data = await this.callEndpoint(this.config.endpoints.progress);
      const raw = Number(this.extractField(data, this.config.progressMapping.progressField));
      if (this.config.progressMapping.scale) {
        const { min, max } = this.config.progressMapping.scale;
        return Math.min(100, Math.max(0, ((raw - min) / (max - min)) * 100));
      }
      return Math.min(100, Math.max(0, raw));
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.config.mockMode) return this.executeMock(command);

    try {
      switch (command.type) {
        case "load_gcode": {
          const endpoint = this.config.endpoints.loadProgram;
          const body = this.resolveBodyTemplate(endpoint.bodyTemplate, command.payload);
          await this.callEndpoint({ ...endpoint, bodyTemplate: body });

          this.emit({
            type: "gcode_received",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { filename: command.payload?.filename, gcodeHash: command.payload?.gcodeHash },
          });
          return { success: true, message: "Program loaded" };
        }

        case "start": {
          await this.callEndpoint(this.config.endpoints.start);
          this.startPolling();
          this.emit({
            type: "execution_started",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {},
          });
          return { success: true, message: "Started" };
        }

        case "pause": {
          if (this.config.endpoints.pause) {
            await this.callEndpoint(this.config.endpoints.pause);
          }
          return { success: true, message: "Paused" };
        }

        case "resume": {
          if (this.config.endpoints.resume) {
            await this.callEndpoint(this.config.endpoints.resume);
          }
          return { success: true, message: "Resumed" };
        }

        case "stop": {
          await this.callEndpoint(this.config.endpoints.stop);
          this.stopPolling();
          return { success: true, message: "Stopped" };
        }

        case "status": {
          const status = await this.getStatus();
          const progress = await this.getProgress();
          return { success: true, data: { status, progress } };
        }

        default:
          return { success: false, message: `Unknown command: ${command.type}` };
      }
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "API error" };
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.stopPolling();
    this.listeners = [];
  }

  // ── HTTP helpers ──────────────────────────────────────────────────

  private async callEndpoint(endpoint: HttpEndpointConfig): Promise<Record<string, unknown>> {
    const url = `${this.config.baseUrl}${endpoint.path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...endpoint.headers,
    };

    if (this.config.auth) {
      if (this.config.auth.type === "bearer") {
        headers["Authorization"] = `Bearer ${this.config.auth.value}`;
      } else if (this.config.auth.type === "header") {
        headers[this.config.auth.key] = this.config.auth.value;
      }
    }

    const fetchOpts: RequestInit = {
      method: endpoint.method,
      headers,
    };

    if (endpoint.bodyTemplate && (endpoint.method === "POST" || endpoint.method === "PUT")) {
      fetchOpts.body = JSON.stringify(endpoint.bodyTemplate);
    }

    const res = await fetch(url, fetchOpts);
    if (!res.ok) throw new Error(`${endpoint.method} ${endpoint.path}: ${res.status}`);

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  private extractField(data: Record<string, unknown>, fieldPath: string): unknown {
    const parts = fieldPath.split(".");
    let current: unknown = data;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private resolveBodyTemplate(
    template: Record<string, unknown> | undefined,
    payload: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!template || !payload) return template;
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
        const payloadKey = value.slice(2, -1);
        resolved[key] = payload[payloadKey] ?? value;
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  // ── Polling ───────────────────────────────────────────────────────

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config.pollIntervalMs ?? 2000;
    this.lastProgress = 0;

    this.pollTimer = setInterval(async () => {
      try {
        const progress = await this.getProgress();
        const status = await this.getStatus();

        if (Math.floor(progress / 25) > Math.floor(this.lastProgress / 25)) {
          this.emit({
            type: "execution_progress",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { progress },
          });
        }

        if (this.lastProgress < 100 && progress >= 100) {
          this.emit({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { progress: 100 },
          });
          this.stopPolling();
        }

        if (status === "error") {
          this.emit({
            type: "execution_failed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { error: "Device reported error status" },
          });
          this.stopPolling();
        }

        this.lastProgress = progress;
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

  // ── Mock mode ─────────────────────────────────────────────────────

  private executeMock(command: MachineCommand): MachineCommandResult {
    switch (command.type) {
      case "load_gcode":
        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { gcodeHash: command.payload?.gcodeHash, mock: true },
        });
        return { success: true, message: "Program loaded (mock)" };

      case "start":
        this.mockStatus = "busy";
        this.mockProgress = 0;
        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { mock: true },
        });
        // Simulate progress
        const timer = setInterval(() => {
          this.mockProgress = Math.min(100, this.mockProgress + 10);
          if (this.mockProgress % 25 === 0 && this.mockProgress < 100) {
            this.emit({
              type: "execution_progress",
              timestamp: new Date().toISOString(),
              source: this.source,
              payload: { progress: this.mockProgress, mock: true },
            });
          }
          if (this.mockProgress >= 100) {
            clearInterval(timer);
            this.mockStatus = "idle";
            this.emit({
              type: "execution_completed",
              timestamp: new Date().toISOString(),
              source: this.source,
              payload: { progress: 100, mock: true },
            });
          }
        }, 500);
        return { success: true, message: "Started (mock)" };

      case "stop":
        this.mockStatus = "idle";
        this.mockProgress = 0;
        return { success: true, message: "Stopped (mock)" };

      case "status":
        return { success: true, data: { status: this.mockStatus, progress: this.mockProgress, mock: true } };

      default:
        return { success: true, message: `${command.type} (mock)` };
    }
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

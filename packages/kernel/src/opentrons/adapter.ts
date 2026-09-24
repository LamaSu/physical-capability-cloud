/**
 * Opentrons Machine Adapter — REST API client for OT-2/OT-3/Flex.
 *
 * Implements MachineAdapter to plug into the PCC kernel's JobRunner.
 * Talks to the Opentrons HTTP API (port 31950) to upload protocols,
 * start/pause/stop runs, and poll status.
 *
 * Mock mode provides full simulation without hardware.
 *
 * Evidence uses the closed vocabulary (EVIDENCE_EVENT_TYPES):
 *   protocol upload        -> method_loaded       {opentronsProtocolId, name, protocolHash}
 *   first play of a run    -> execution_started   {opentronsRunId}
 *   pause / resume         -> execution_progress  {opentronsRunId, action}
 *   stop                   -> execution_failed    {opentronsRunId, reason}
 *   the robot reports the run succeeded / failed / stopped (read when the
 *   runner polls progress) -> execution_completed / execution_failed, once per run
 * Robot-local ids take their own names (opentronsRunId, opentronsProtocolId):
 * payload.jobId and the unit fields are reserved for the PCC binding, which the
 * kernel's EvidenceEmitter stamps on every event.
 */

import { createHash } from "node:crypto";
import type { EvidenceEvent, EvidenceEventType, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "../adapters/types.js";
import type {
  OpentronAdapterConfig,
  OpentronRobotInfo,
  OTRun,
  OTProtocol,
  PipetteInfo,
  OpentronModule,
  LiquidHandlerCapability,
  LiquidAction,
} from "./types.js";

// ── Adapter ───────────────────────────────────────────────────────

export class OpentronsMachineAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "liquid-handler" as any; // extending MachineAdapter.type
  readonly source: EvidenceSource;

  private config: OpentronAdapterConfig;
  private evidenceCallbacks: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private currentRunId: string | null = null;
  /** Runs that have had their first play (so a later play is a resume). */
  private startedRuns = new Set<string>();
  private mockProgress = 0;
  private mockInterval: ReturnType<typeof setInterval> | null = null;
  private mockStatus: MachineStatus = "idle";

  constructor(id: string, config: OpentronAdapterConfig) {
    this.id = id;
    this.config = {
      pollIntervalMs: 1000,
      apiVersion: "2.18",
      mockMode: false,
      maxConcurrent: 1,
      maxQueueDepth: 10,
      ...config,
    };
    this.source = {
      deviceId: id,
      deviceType: "instrument" as const,
      kernelId: id.split("-")[0] ?? id,
      // Honesty marker: events from a mock-mode adapter are simulation.
      ...(this.config.mockMode ? { simulated: true } : {}),
    };
  }

  // ── MachineAdapter Interface ──────────────────────────────────

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) return this.mockStatus;

    try {
      const res = await this.fetch("/health");
      if (!res.ok) return "error";
      return this.currentRunId ? "busy" : "idle";
    } catch {
      return "offline";
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.config.mockMode) return this.mockExecute(command);

    switch (command.type) {
      case "load_gcode": {
        // For OT, "load_gcode" means upload a protocol
        const protocolSource = command.payload?.protocolSource as string;
        const protocolName = command.payload?.protocolName as string ?? "pcc-protocol";
        if (!protocolSource) {
          return { success: false, message: "No protocol source provided" };
        }
        return this.uploadProtocol(protocolName, protocolSource);
      }

      case "start": {
        if (!this.currentRunId) {
          // Create a run from the most recent protocol
          const createRes = await this.createRun();
          if (!createRes.success) return createRes;
        }
        return this.startRun();
      }

      case "pause":
        return this.pauseRun();

      case "resume":
        return this.resumeRun();

      case "stop":
        return this.stopRun();

      case "status": {
        const status = await this.getRunStatus();
        return { success: true, data: status as any };
      }

      default:
        return { success: false, message: `Unknown command: ${command.type}` };
    }
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return this.mockProgress;

    if (!this.currentRunId) return 0;
    try {
      const res = await this.fetch(`/runs/${this.currentRunId}`);
      if (!res.ok) return 0;
      const data = await res.json() as { data: OTRun };
      const run = data.data;
      this.observeRun(this.currentRunId, run);

      if (run.status === "succeeded") return 100;
      if (run.status === "failed" || run.status === "stopped") return 0;

      // Estimate from commands completed vs total
      const total = run.commands?.length ?? 1;
      const completed = run.commands?.filter((c) => c.status === "succeeded").length ?? 0;
      return Math.round((completed / Math.max(total, 1)) * 100);
    } catch {
      return 0;
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.evidenceCallbacks.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
    this.currentRunId = null;
  }

  // ── Opentrons-Specific Methods ────────────────────────────────

  /** Get robot identity and firmware info */
  async getRobotInfo(): Promise<OpentronRobotInfo | null> {
    if (this.config.mockMode) {
      return {
        name: "Mock OT-2",
        model: "OT-2",
        serialNumber: "MOCK-OT2-001",
        firmwareVersion: "7.3.0",
        apiVersion: this.config.apiVersion!,
        apiUrl: this.config.url,
      };
    }

    try {
      const res = await this.fetch("/health");
      if (!res.ok) return null;
      const health = await res.json() as any;
      return {
        name: health.name ?? "Opentrons Robot",
        model: health.robot_model ?? "OT-2",
        serialNumber: health.robot_serial ?? "unknown",
        firmwareVersion: health.fw_version ?? "unknown",
        apiVersion: health.minimum_protocol_api_version ?? this.config.apiVersion!,
        apiUrl: this.config.url,
      };
    } catch {
      return null;
    }
  }

  /** List attached pipettes */
  async getPipettes(): Promise<PipetteInfo[]> {
    if (this.config.mockMode) {
      return [
        { mount: "left", name: "P300 Single GEN2", pipetteId: "p300_single_gen2", minVolume: 20, maxVolume: 300, channels: 1 },
        { mount: "right", name: "P20 Single GEN2", pipetteId: "p20_single_gen2", minVolume: 1, maxVolume: 20, channels: 1 },
      ];
    }

    try {
      const res = await this.fetch("/instruments");
      if (!res.ok) return [];
      const data = await res.json() as { data: any[] };
      return data.data
        .filter((i: any) => i.instrumentType === "pipette")
        .map((p: any) => ({
          mount: p.mount as "left" | "right",
          name: p.instrumentName ?? p.instrumentModel ?? "Unknown Pipette",
          pipetteId: p.instrumentModel ?? "unknown",
          minVolume: p.data?.min_volume ?? 1,
          maxVolume: p.data?.max_volume ?? 300,
          channels: p.data?.channels ?? 1,
        }));
    } catch {
      return [];
    }
  }

  /** List attached modules (thermocycler, temp, magnetic, etc.) */
  async getModules(): Promise<OpentronModule[]> {
    if (this.config.mockMode) {
      return [
        { moduleType: "temperatureModuleV2", serial: "mock-temp-001", slot: "3", status: { currentTemp: 25 } },
      ];
    }

    try {
      const res = await this.fetch("/modules");
      if (!res.ok) return [];
      const data = await res.json() as { data: any[] };
      return data.data.map((m: any) => ({
        moduleType: m.moduleType,
        serial: m.serialNumber ?? "unknown",
        slot: String(m.port ?? m.usbPort ?? "?"),
        status: m.data ?? {},
      }));
    } catch {
      return [];
    }
  }

  /** Build capability descriptor for the network */
  async getCapabilities(): Promise<LiquidHandlerCapability> {
    const pipettes = await this.getPipettes();
    const modules = await this.getModules();
    const actions: LiquidAction[] = [
      "aspirate", "dispense", "mix", "transfer", "distribute",
      "consolidate", "blow_out", "touch_tip", "air_gap",
      "drop_tip", "pick_up_tip",
    ];

    return {
      pipettes,
      modules,
      deckSlots: 11, // OT-2 default
      maxTipRacks: 4,
      supportedLabware: [
        "corning_96_wellplate_360ul_flat",
        "opentrons_96_tiprack_300ul",
        "opentrons_96_tiprack_20ul",
        "nest_12_reservoir_15ml",
        "opentrons_24_tuberack_eppendorf_1.5ml_safelock_snapcap",
      ],
      supportedActions: actions,
    };
  }

  /** Get list of protocols on the robot */
  async listProtocols(): Promise<OTProtocol[]> {
    if (this.config.mockMode) return [];
    try {
      const res = await this.fetch("/protocols");
      if (!res.ok) return [];
      const data = await res.json() as { data: any[] };
      return data.data.map((p: any) => ({
        id: p.id,
        name: p.metadata?.protocolName ?? p.files?.[0]?.name ?? "Unknown",
        source: "",
        metadata: p.metadata ?? {},
      }));
    } catch {
      return [];
    }
  }

  /** List runs */
  async listRuns(): Promise<OTRun[]> {
    if (this.config.mockMode) return [];
    try {
      const res = await this.fetch("/runs");
      if (!res.ok) return [];
      const data = await res.json() as { data: any[] };
      return data.data.map((r: any) => ({
        id: r.id,
        protocolId: r.protocolId ?? "",
        status: r.status ?? "idle",
        progress: 0,
        errors: r.errors ?? [],
        createdAt: r.createdAt ?? "",
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        commands: [],
      }));
    } catch {
      return [];
    }
  }

  // ── Private: OT REST API Calls ────────────────────────────────

  private async uploadProtocol(name: string, source: string): Promise<MachineCommandResult> {
    try {
      // Opentrons expects multipart/form-data with the .py file
      const boundary = `----PCC${Date.now()}`;
      const filename = `${name.replace(/\s+/g, "_")}.py`;
      const body = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="files"; filename="${filename}"`,
        `Content-Type: text/x-python`,
        ``,
        source,
        `--${boundary}--`,
      ].join("\r\n");

      const res = await fetch(`${this.config.url}/protocols`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "opentrons-version": this.config.apiVersion!,
        },
        body,
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, message: `Protocol upload failed: ${err}` };
      }

      const data = await res.json() as { data: { id: string } };
      this.emitEvidence("method_loaded", {
        opentronsProtocolId: data.data.id,
        name,
        protocolHash: protocolHashOf(source),
      });
      return { success: true, data: { protocolId: data.data.id } };
    } catch (err) {
      return { success: false, message: `Upload error: ${err}` };
    }
  }

  private async createRun(): Promise<MachineCommandResult> {
    try {
      // Get most recent protocol
      const protocols = await this.listProtocols();
      if (protocols.length === 0) {
        return { success: false, message: "No protocol uploaded" };
      }
      const protocolId = protocols[protocols.length - 1].id;

      const res = await this.fetch("/runs", {
        method: "POST",
        body: JSON.stringify({ data: { protocolId } }),
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, message: `Create run failed: ${err}` };
      }

      const data = await res.json() as { data: { id: string } };
      this.currentRunId = data.data.id;
      return { success: true, data: { runId: this.currentRunId } };
    } catch (err) {
      return { success: false, message: `Create run error: ${err}` };
    }
  }

  private async startRun(): Promise<MachineCommandResult> {
    if (!this.currentRunId) return { success: false, message: "No active run" };
    return this.runAction("play");
  }

  private async pauseRun(): Promise<MachineCommandResult> {
    if (!this.currentRunId) return { success: false, message: "No active run" };
    return this.runAction("pause");
  }

  private async resumeRun(): Promise<MachineCommandResult> {
    if (!this.currentRunId) return { success: false, message: "No active run" };
    return this.runAction("play");
  }

  private async stopRun(): Promise<MachineCommandResult> {
    if (!this.currentRunId) return { success: false, message: "No active run" };
    const result = await this.runAction("stop");
    this.currentRunId = null;
    return result;
  }

  private async runAction(action: string): Promise<MachineCommandResult> {
    try {
      const res = await this.fetch(`/runs/${this.currentRunId}/actions`, {
        method: "POST",
        body: JSON.stringify({ data: { actionType: action } }),
      });

      if (!res.ok) {
        const err = await res.text();
        return { success: false, message: `Action ${action} failed: ${err}` };
      }

      this.emitActionEvidence(this.currentRunId, action);
      return { success: true };
    } catch (err) {
      return { success: false, message: `Action error: ${err}` };
    }
  }

  private async getRunStatus(): Promise<Record<string, unknown> | null> {
    if (!this.currentRunId) return null;
    try {
      const res = await this.fetch(`/runs/${this.currentRunId}`);
      if (!res.ok) return null;
      const data = await res.json() as { data: any };
      return data.data;
    } catch {
      return null;
    }
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.url}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "opentrons-version": this.config.apiVersion!,
        ...init?.headers,
      },
    });
  }

  // ── Mock Mode ─────────────────────────────────────────────────

  private mockExecute(command: MachineCommand): MachineCommandResult {
    switch (command.type) {
      case "load_gcode": {
        const source = command.payload?.protocolSource;
        this.emitEvidence("method_loaded", {
          opentronsProtocolId: "mock-proto-001",
          ...(typeof source === "string" ? { protocolHash: protocolHashOf(source) } : {}),
          mock: true,
        });
        return { success: true, data: { protocolId: "mock-proto-001" } };
      }

      case "start": {
        this.mockStatus = "busy";
        this.mockProgress = 0;
        this.currentRunId = `mock-run-${Date.now()}`;

        // Simulate progress over ~10 seconds
        this.mockInterval = setInterval(() => {
          this.mockProgress += 10;
          this.emitEvidence("execution_progress", {
            opentronsRunId: this.currentRunId,
            progress: this.mockProgress,
            mock: true,
          });

          if (this.mockProgress >= 100) {
            if (this.mockInterval) clearInterval(this.mockInterval);
            this.mockInterval = null;
            this.mockStatus = "idle";
            this.emitEvidence("execution_completed", { opentronsRunId: this.currentRunId, mock: true });
          }
        }, 1000);

        this.emitEvidence("execution_started", { opentronsRunId: this.currentRunId, mock: true });
        return { success: true, data: { runId: this.currentRunId } };
      }

      case "pause":
        if (this.mockInterval) clearInterval(this.mockInterval);
        this.mockInterval = null;
        this.mockStatus = "idle";
        return { success: true };

      case "stop":
        if (this.mockInterval) clearInterval(this.mockInterval);
        this.mockInterval = null;
        if (this.currentRunId && this.mockProgress < 100) {
          this.emitEvidence("execution_failed", {
            opentronsRunId: this.currentRunId,
            reason: "stopped before completion",
            mock: true,
          });
        }
        this.mockStatus = "idle";
        this.mockProgress = 0;
        this.currentRunId = null;
        return { success: true };

      case "status":
        return {
          success: true,
          data: {
            status: this.mockStatus,
            progress: this.mockProgress,
            runId: this.currentRunId,
          },
        };

      default:
        return { success: true };
    }
  }

  // ── Evidence ──────────────────────────────────────────────────

  /** Evidence for a run action the robot accepted. */
  private emitActionEvidence(runId: string | null, action: string): void {
    if (!runId) return;
    if (action === "stop") {
      this.emitEvidence("execution_failed", { opentronsRunId: runId, reason: "stopped before completion" });
      return;
    }
    if (action === "play" && !this.startedRuns.has(runId)) {
      this.startedRuns.add(runId);
      this.emitEvidence("execution_started", { opentronsRunId: runId });
      return;
    }
    this.emitEvidence("execution_progress", { opentronsRunId: runId, action: action === "play" ? "resume" : action });
  }

  /**
   * The robot's own report of a run's outcome, read when the runner polls
   * progress. On a terminal status the run is released: the outcome is
   * reported once (a released run is not polled again), and the next job
   * creates its own run instead of replaying this one.
   */
  private observeRun(runId: string, run: OTRun): void {
    const commands = run.commands ?? [];
    if (run.status === "succeeded") {
      this.emitEvidence("execution_completed", {
        opentronsRunId: runId,
        status: run.status,
        commandsSucceeded: commands.filter((c) => c.status === "succeeded").length,
        commandsTotal: commands.length,
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      });
      this.currentRunId = null;
    } else if (run.status === "failed" || run.status === "stopped") {
      this.emitEvidence("execution_failed", {
        opentronsRunId: runId,
        status: run.status,
        errors: (run.errors ?? []).map((e) => e.detail),
      });
      this.currentRunId = null;
    }
  }

  private emitEvidence(type: EvidenceEventType, payload: Record<string, unknown>): void {
    const event: Omit<EvidenceEvent, "id" | "hash"> = {
      type,
      timestamp: new Date().toISOString(),
      source: this.source,
      payload,
    };
    for (const cb of this.evidenceCallbacks) {
      cb(event);
    }
  }
}

/** The tagged sha256 of a protocol's source text: what the robot was told to run. */
function protocolHashOf(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

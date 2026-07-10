/**
 * OPC-UA adapter for industrial machines (CNC, PLC, robots).
 *
 * OPC-UA is the standard protocol for industrial automation.
 * This adapter connects to an OPC-UA server and maps nodes to
 * PCC capabilities.
 *
 * Common OPC-UA servers:
 * - Siemens S7 PLCs (via S7-1500 built-in OPC-UA)
 * - FANUC CNC (via FOCAS-to-OPC-UA bridge)
 * - Haas CNC (via HaasConnect or MTConnect-to-OPC-UA bridge)
 * - ABB/KUKA robots (built-in OPC-UA)
 * - Beckhoff TwinCAT (built-in OPC-UA)
 *
 * In production: use node-opcua npm package.
 * In development: built-in mock mode.
 *
 * NOTE: real OPC-UA writes are NOT wired yet. In real mode (mockMode falsy)
 * the actuation commands (load_gcode / start / stop) FAIL LOUDLY with
 * success:false instead of pretending the machine acted — see execute().
 * The READ path is equally honest: getStatus() reports "offline" (never a
 * fabricated "idle"), and getProgress() / execute(status) fail loudly
 * instead of returning fabricated zeros.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "./types.js";

export interface OPCUAConfig {
  /** OPC-UA server endpoint (e.g., "opc.tcp://192.168.1.100:4840") */
  endpoint: string;
  /** Kernel ID */
  kernelId: string;
  /** Machine type */
  machineType: "cnc-3axis" | "cnc-5axis" | "lathe" | "laser-cut";
  /** Node map: maps OPC-UA node IDs to semantic names */
  nodeMap: OPCUANodeDef[];
  /** Poll interval in ms */
  pollIntervalMs?: number;
  /** Security mode */
  securityMode?: "none" | "sign" | "signAndEncrypt";
  /** Use mock mode */
  mockMode?: boolean;
}

export interface OPCUANodeDef {
  /** OPC-UA node ID (e.g., "ns=2;s=CNC.SpindleSpeed") */
  nodeId: string;
  /** Semantic name for PCC */
  name: string;
  /** Data type */
  dataType: "number" | "boolean" | "string";
  /** Unit */
  unit?: string;
  /** Is this a command node (write) or sensor node (read)? */
  direction: "read" | "write" | "readwrite";
}

interface CNCState {
  spindleSpeed: number;
  feedRate: number;
  position: { x: number; y: number; z: number };
  toolNumber: number;
  programName: string | null;
  programProgress: number;
  status: string;
  alarmActive: boolean;
}

export class OPCUAAdapter implements MachineAdapter {
  readonly id: string;
  readonly type: "cnc-3axis" | "cnc-5axis" | "lathe" | "laser-cut";
  readonly source: EvidenceSource;

  private config: OPCUAConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastState: CNCState | null = null;
  private mockState: CNCState = {
    spindleSpeed: 0,
    feedRate: 0,
    position: { x: 0, y: 0, z: 0 },
    toolNumber: 1,
    programName: null,
    programProgress: 0,
    status: "Idle",
    alarmActive: false,
  };

  constructor(id: string, config: OPCUAConfig) {
    this.id = id;
    this.type = config.machineType;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "controller",
      kernelId: config.kernelId,
      firmwareVersion: "OPCUA-Adapter-1.0.0",
      // Honesty marker: events from a mock-mode adapter are simulation.
      ...(config.mockMode ? { simulated: true } : {}),
    };
  }

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) {
      return this.mockState.status === "Running" ? "busy"
        : this.mockState.alarmActive ? "error"
        : "idle";
    }
    // No OPC-UA client is wired (node-opcua pending), so this adapter has
    // NEVER contacted the machine. Reporting "idle" here made a phantom CNC
    // show healthStatus:"healthy" in the devices/health APIs. "offline" is
    // the honest value for a device we cannot observe.
    return "offline";
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return this.mockState.programProgress;
    // FAIL LOUD: no live progress node is readable. The previous hardcoded 0
    // was a plausible-looking fabricated read.
    throw new Error(
      `[opcua-adapter] real-mode read not implemented — no progress value is available from ` +
        `${this.config.endpoint}. Set mockMode: true for simulated progress.`,
    );
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.config.mockMode) return this.executeMock(command);

    // Real OPC-UA writes are NOT implemented (node-opcua wiring pending).
    // FAIL LOUD: a real-mode actuation command that sent nothing to the machine
    // must never report success, and must not emit evidence events for actions
    // that did not happen. ("Executor success ≠ outcome success" must not be
    // inverted inside the adapter.) Set mockMode: true for simulated execution.
    switch (command.type) {
      case "load_gcode": {
        // Pending real wiring:
        // await this.writeNode("CNC.ProgramName", command.payload?.filename);
        return {
          success: false,
          message:
            `OPC-UA write not implemented — the program was NOT sent to ${this.config.endpoint}. ` +
            `Real node-opcua wiring is pending; set mockMode: true for simulated execution.`,
        };
      }

      case "start": {
        // Pending real wiring:
        // await this.writeNode("CNC.CycleStart", true);
        return {
          success: false,
          message:
            `OPC-UA write not implemented — CycleStart was NOT sent to ${this.config.endpoint}. ` +
            `Real node-opcua wiring is pending; set mockMode: true for simulated execution.`,
        };
      }

      case "stop": {
        // Pending real wiring:
        // await this.writeNode("CNC.CycleStop", true);
        // Local poll cleanup is real; the machine command is not.
        this.stopPolling();
        return {
          success: false,
          message:
            `OPC-UA write not implemented — CycleStop was NOT sent to ${this.config.endpoint}; ` +
            `if the machine is running it has NOT been stopped (use the physical e-stop). ` +
            `Real node-opcua wiring is pending; set mockMode: true for simulated execution.`,
        };
      }

      case "status": {
        // FAIL LOUD: previously returned success:true with fabricated zeros
        // (spindleSpeed/feedRate/position all 0) — confident zeroed telemetry
        // indistinguishable from a real idle machine. No node reads exist yet.
        return {
          success: false,
          message:
            `OPC-UA read not implemented — no live node values are available from ` +
            `${this.config.endpoint}. Real node-opcua wiring is pending; set mockMode: true ` +
            `for simulated status.`,
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
    this.stopPolling();
    this.listeners = [];
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config.pollIntervalMs ?? 1000;

    this.pollTimer = setInterval(() => {
      if (this.config.mockMode) {
        this.updateMockState();
      }
      // In production: read all sensor nodes via OPC-UA subscription
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mock mode
  // ---------------------------------------------------------------------------

  private executeMock(command: MachineCommand): MachineCommandResult {
    switch (command.type) {
      case "load_gcode":
        this.mockState.programName = (command.payload?.filename as string) ?? "test.nc";
        this.mockState.programProgress = 0;
        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { filename: this.mockState.programName, mock: true },
        });
        return { success: true, message: "Program loaded (mock)" };

      case "start":
        this.mockState.status = "Running";
        this.mockState.spindleSpeed = 12000;
        this.mockState.feedRate = 2000;
        this.startPolling();
        this.emit({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { mock: true },
        });
        return { success: true, message: "Cycle started (mock)" };

      case "stop":
        this.mockState.status = "Idle";
        this.mockState.spindleSpeed = 0;
        this.mockState.programProgress = 0;
        this.stopPolling();
        return { success: true, message: "Stopped (mock)" };

      case "status":
        return { success: true, data: { ...this.mockState, mock: true } };

      default:
        return { success: true, message: `${command.type} (mock)` };
    }
  }

  private updateMockState(): void {
    if (this.mockState.status !== "Running") return;

    this.mockState.programProgress = Math.min(100, this.mockState.programProgress + 2);
    this.mockState.position.x += Math.random() * 10 - 5;
    this.mockState.position.y += Math.random() * 10 - 5;
    this.mockState.position.z = -Math.random() * 5;
    this.mockState.spindleSpeed = 12000 + Math.random() * 500 - 250;

    if (this.mockState.programProgress % 25 === 0 && this.mockState.programProgress < 100) {
      this.emit({
        type: "execution_progress",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          progress: this.mockState.programProgress,
          spindleSpeed: this.mockState.spindleSpeed,
          feedRate: this.mockState.feedRate,
          position: { ...this.mockState.position },
        },
      });
    }

    if (this.mockState.programProgress >= 100) {
      this.mockState.status = "Idle";
      this.mockState.spindleSpeed = 0;
      this.stopPolling();
      this.emit({
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          programName: this.mockState.programName,
          mock: true,
        },
      });
    }
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

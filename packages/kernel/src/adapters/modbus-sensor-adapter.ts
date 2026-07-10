/**
 * Modbus TCP sensor adapter for industrial equipment.
 *
 * Reads sensor registers over Modbus TCP. Common for:
 * - Power meters (Schneider PM5xxx, Siemens PAC3200)
 * - Temperature controllers (Eurotherm, Watlow)
 * - PLCs (Siemens S7, Allen-Bradley)
 * - Industrial sensors (pressure, flow, vibration)
 *
 * In production: uses a real Modbus TCP client (e.g., modbus-serial npm package).
 * In development: built-in mock mode with simulated register values.
 */

import type { EvidenceEvent, EvidenceSource, SensorReading, SensorChannelDescriptor } from "@pcc/spec";
import type { SensorAdapter, MachineStatus } from "./types.js";
import type { UniversalSensorAdapter } from "./universal-sensor-adapter.js";

export interface ModbusConfig {
  /** Modbus device IP address */
  host: string;
  /** Modbus TCP port (default 502) */
  port?: number;
  /** Modbus unit/slave ID */
  unitId?: number;
  /** Kernel ID */
  kernelId: string;
  /** Register map: channel name → register definition */
  registerMap: ModbusRegisterDef[];
  /** Poll interval in ms (default 1000) */
  pollIntervalMs?: number;
  /** Use mock mode */
  mockMode?: boolean;
}

export interface ModbusRegisterDef {
  channel: string;
  label: string;
  /** Modbus register address */
  address: number;
  /** Register type */
  registerType: "holding" | "input" | "coil" | "discrete";
  /** Data type for decoding */
  dataType: "uint16" | "int16" | "uint32" | "int32" | "float32" | "float64";
  /** Unit for the value */
  unit: string;
  /** Scale factor (raw * scale = engineering units) */
  scale?: number;
  /** Offset (raw * scale + offset = engineering units) */
  offset?: number;
  /** Sample rate in Hz */
  sampleRateHz?: number;
  /** Evidence grade — include in evidence bundles */
  evidenceGrade?: boolean;
}

export class ModbusSensorAdapter implements SensorAdapter, UniversalSensorAdapter {
  readonly id: string;
  readonly deviceClass = "sensor" as const;
  readonly source: EvidenceSource;
  readonly type = "power_monitor" as const;

  private config: ModbusConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private readingListeners: Array<(reading: SensorReading) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private recording = false;
  private recordedValues: Map<string, number[]> = new Map();

  constructor(id: string, config: ModbusConfig) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "plc",
      kernelId: config.kernelId,
      firmwareVersion: `Modbus-Adapter-1.0.0`,
      // Honesty marker: events from a mock-mode adapter are simulation.
      ...(config.mockMode ? { simulated: true } : {}),
    };
  }

  // ── UniversalSensorAdapter ─────────────────────────────────────────

  getChannelDescriptors(): SensorChannelDescriptor[] {
    return this.config.registerMap.map((reg) => ({
      channel: reg.channel,
      label: reg.label,
      dataType: "scalar" as const,
      unit: reg.unit,
      sampleRateHz: reg.sampleRateHz ?? 1,
      retentionPolicy: "downsample_1s" as const,
      evidenceGrade: reg.evidenceGrade ?? false,
    }));
  }

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) return "idle";
    // No real Modbus client is wired — this adapter has never opened a socket
    // to the host. Reporting "idle" claimed a never-contacted device was
    // reachable and healthy. "offline" is the honest value.
    return "offline";
  }

  // ── SensorAdapter ──────────────────────────────────────────────────

  async startRecording(jobId: string): Promise<void> {
    if (!this.config.mockMode) {
      // FAIL LOUD: no real Modbus client is wired (modbus-serial pending).
      // Recording in real mode would fabricate sensor readings (random values
      // stamped quality 1.0) straight into evidence bundles. Refuse instead.
      throw new Error(
        `[modbus-adapter] real-mode read not implemented — refusing to record fabricated sensor data ` +
          `for ${this.config.host}:${this.config.port ?? 502}. Set mockMode: true for simulated readings.`,
      );
    }

    this.recording = true;
    this.recordedValues.clear();

    for (const reg of this.config.registerMap) {
      this.recordedValues.set(reg.channel, []);
    }

    // Start polling registers. The catch is defensive: a rejected poll must
    // never surface as an unhandled promise rejection inside the timer.
    const interval = this.config.pollIntervalMs ?? 1000;
    this.pollTimer = setInterval(() => {
      void this.pollRegisters(jobId).catch((err) => {
        console.error("[modbus-adapter] register poll failed:", err);
      });
    }, interval);
  }

  async stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    this.recording = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (!this.config.mockMode) {
      // FAIL LOUD (symmetry with startRecording): in real mode nothing was
      // ever recorded, so returning a sensor_data_summary event — even an
      // empty one — fabricates the shape of evidence that does not exist.
      throw new Error(
        `[modbus-adapter] real-mode read not implemented — no recording ever started for ` +
          `${this.config.host}:${this.config.port ?? 502}, refusing to emit a fabricated ` +
          `sensor_data_summary. Set mockMode: true for simulated readings.`,
      );
    }

    // Compute summary statistics
    const summary: Record<string, { min: number; max: number; mean: number; samples: number }> = {};
    for (const [channel, values] of this.recordedValues) {
      if (values.length > 0) {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        summary[channel] = { min, max, mean, samples: values.length };
      }
    }

    return {
      type: "sensor_data_summary",
      timestamp: new Date().toISOString(),
      source: this.source,
      // mock: true — this summary is simulation data (mock mode is the only
      // path that reaches here).
      payload: { summary, mock: true },
    };
  }

  async getCurrentReading(): Promise<Record<string, unknown>> {
    const readings: Record<string, unknown> = {};
    for (const reg of this.config.registerMap) {
      readings[reg.channel] = this.config.mockMode
        ? this.generateMockValue(reg)
        : await this.readRegister(reg);
    }
    return readings;
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.listeners = [];
    this.readingListeners = [];
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async pollRegisters(jobId: string): Promise<void> {
    for (const reg of this.config.registerMap) {
      const value = this.config.mockMode
        ? this.generateMockValue(reg)
        : await this.readRegister(reg);

      if (this.recording) {
        this.recordedValues.get(reg.channel)?.push(value);
      }

      // Emit as SensorReading for universal pipeline
      const reading: SensorReading = {
        id: `rdg_${Date.now()}_${reg.channel}`,
        timestamp: new Date().toISOString(),
        kernelId: this.config.kernelId,
        deviceId: this.id,
        channel: reg.channel,
        dataType: "scalar",
        unit: reg.unit,
        value,
        quality: 1.0,
        jobId,
      };

      for (const listener of this.readingListeners) {
        listener(reading);
      }
    }
  }

  private async readRegister(reg: ModbusRegisterDef): Promise<number> {
    // In production: use modbus-serial or similar
    // const client = new ModbusTCPClient(this.config.host, this.config.port);
    // const result = await client.readHoldingRegisters(reg.address, registerCount);
    // return decodeValue(result.data, reg.dataType) * (reg.scale ?? 1) + (reg.offset ?? 0);

    // FAIL LOUD: no real client is wired. The previous behavior returned
    // generateMockValue() here — fabricated readings presented as real ones.
    throw new Error(
      `[modbus-adapter] real-mode read not implemented for register ${reg.address} (${reg.channel}) ` +
        `at ${this.config.host}:${this.config.port ?? 502}. Set mockMode: true for simulated readings.`,
    );
  }

  private generateMockValue(reg: ModbusRegisterDef): number {
    const scale = reg.scale ?? 1;
    const offset = reg.offset ?? 0;

    // Generate realistic values based on unit
    switch (reg.unit) {
      case "W": case "kW": return (Math.random() * 500 + 100) * scale + offset;
      case "V": return (Math.random() * 5 + 118) * scale + offset;
      case "A": return (Math.random() * 10 + 2) * scale + offset;
      case "degC": return (Math.random() * 5 + 22) * scale + offset;
      case "bar": case "psi": return (Math.random() * 2 + 5) * scale + offset;
      case "L/min": case "mL/min": return (Math.random() * 5 + 10) * scale + offset;
      case "Hz": case "rpm": return (Math.random() * 100 + 2900) * scale + offset;
      default: return Math.random() * 100 * scale + offset;
    }
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

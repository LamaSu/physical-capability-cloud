/**
 * Generic sensor adapter template.
 *
 * Wraps any sensor that exposes an HTTP endpoint for readings.
 * Polls the sensor and emits evidence events for the evidence pipeline.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

export interface GenericSensorConfig {
  /** URL for reading the sensor value (e.g., "http://192.168.1.101:502/reading") */
  readingUrl: string;
  /** Kernel ID */
  kernelId: string;
  /** Channel name for this sensor (e.g., "spindle_power", "bed_temp") */
  channel: string;
  /** Physical unit (e.g., "W", "degC", "bar", "Hz") */
  unit: string;
  /** Sensor type */
  sensorType: "power_monitor" | "vibration_sensor" | "acoustic_sensor" | "temperature_sensor";
  /** JSON path to the value in the response (dot-separated, e.g., "data.watts") */
  valueField: string;
  /** Poll interval in ms (default 1000) */
  sampleIntervalMs?: number;
  /** Auth config */
  auth?: {
    type: "header" | "bearer";
    key: string;
    value: string;
  };
  /** Mock mode */
  mockMode?: boolean;
  /** Mock value range for mock mode */
  mockRange?: { min: number; max: number };
}

export class GenericSensorAdapter {
  readonly id: string;
  readonly type: string;
  readonly source: EvidenceSource;

  private config: GenericSensorConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private recording = false;
  private samples: Array<{ timestamp: string; value: number }> = [];

  constructor(id: string, config: GenericSensorConfig) {
    this.id = id;
    this.type = config.sensorType;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "power_monitor",
      kernelId: config.kernelId,
      firmwareVersion: `GenericSensor-${config.channel}-1.0.0`,
    };
  }

  async startRecording(jobId: string): Promise<void> {
    this.recording = true;
    this.samples = [];

    const interval = this.config.sampleIntervalMs ?? 1000;
    this.pollTimer = setInterval(async () => {
      try {
        const value = this.config.mockMode
          ? this.generateMockValue()
          : await this.readValue();

        const sample = { timestamp: new Date().toISOString(), value };
        this.samples.push(sample);

        this.emit({
          type: "power_profile_sample",
          timestamp: sample.timestamp,
          source: this.source,
          payload: {
            channel: this.config.channel,
            value: sample.value,
            unit: this.config.unit,
            jobId,
          },
        });
      } catch {
        // Silently handle read failures during recording
      }
    }, interval);
  }

  async stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    this.recording = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const values = this.samples.map(s => s.value);
    const stats = values.length > 0 ? {
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      stdDev: Math.sqrt(
        values.reduce((sum, v) => sum + (v - values.reduce((a, b) => a + b, 0) / values.length) ** 2, 0)
        / values.length
      ),
    } : { min: 0, max: 0, mean: 0, stdDev: 0 };

    return {
      type: "sensor_data_summary",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        channel: this.config.channel,
        unit: this.config.unit,
        sampleCount: values.length,
        durationMs: this.samples.length * (this.config.sampleIntervalMs ?? 1000),
        statistics: stats,
        samples: this.samples,
      },
    };
  }

  async getCurrentReading(): Promise<Record<string, unknown>> {
    const value = this.config.mockMode
      ? this.generateMockValue()
      : await this.readValue();

    return {
      channel: this.config.channel,
      value,
      unit: this.config.unit,
      timestamp: new Date().toISOString(),
    };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.listeners = [];
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async readValue(): Promise<number> {
    const headers: Record<string, string> = {};
    if (this.config.auth) {
      if (this.config.auth.type === "bearer") {
        headers["Authorization"] = `Bearer ${this.config.auth.value}`;
      } else {
        headers[this.config.auth.key] = this.config.auth.value;
      }
    }

    const res = await fetch(this.config.readingUrl, { headers });
    if (!res.ok) throw new Error(`Sensor read failed: ${res.status}`);

    const data = await res.json();
    return Number(this.extractField(data, this.config.valueField));
  }

  private extractField(data: unknown, fieldPath: string): unknown {
    const parts = fieldPath.split(".");
    let current: unknown = data;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private generateMockValue(): number {
    const range = this.config.mockRange ?? { min: 0, max: 100 };
    return range.min + Math.random() * (range.max - range.min);
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

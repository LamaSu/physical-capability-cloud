/**
 * Generic sensor adapter template.
 *
 * Wraps any sensor that exposes an HTTP endpoint for readings.
 * Polls the sensor and emits evidence events for the evidence pipeline.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import { OutstandingWork } from "./outstanding-work.js";

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
  /**
   * The recording running now: its job and its samples. A read keeps the recording it was
   * started for, and a read of a recording that was replaced is dropped (astra pack 186).
   */
  private current: { jobId: string; samples: Array<{ timestamp: string; value: number }> } | null = null;
  /** The recording's sampling timer and each read in flight: what can still emit. */
  private readonly work = new OutstandingWork();
  private endRecording: (() => void) | null = null;

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
    // A recording already running is replaced: its timer used to be overwritten and left sampling.
    this.stopSampling();
    this.recording = true;
    const recording = { jobId, samples: [] as Array<{ timestamp: string; value: number }> };
    this.current = recording;

    const interval = this.config.sampleIntervalMs ?? 1000;
    this.endRecording = this.work.begin();
    this.pollTimer = setInterval(() => {
      void this.work.track(this.sample(recording));
    }, interval);
  }

  private async sample(recording: { jobId: string; samples: Array<{ timestamp: string; value: number }> }): Promise<void> {
    const { jobId } = recording;
    try {
      const value = this.config.mockMode
        ? this.generateMockValue()
        : await this.readValue();
      // The recording was replaced while this read was in flight: neither job gets it.
      if (this.current !== recording) return;

      const sample = { timestamp: new Date().toISOString(), value };
      recording.samples.push(sample);

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
  }

  async stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    this.recording = false;
    this.stopSampling();

    const samples = this.current?.samples ?? [];
    const values = samples.map(s => s.value);
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
        durationMs: samples.length * (this.config.sampleIntervalMs ?? 1000),
        statistics: stats,
        samples,
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

  /**
   * Required by the PCC kernel: resolves once every evidence event of the work this adapter
   * was given has been emitted, and never while that work can still emit. Here: once
   * stopRecording has stopped the sampling timer and no read is in flight (a read the timer
   * started before stopRecording can still emit after it returns). The kernel calls it after
   * stopRecording.
   */
  quiesceEvidence(): Promise<void> {
    return this.work.idle();
  }

  async dispose(): Promise<void> {
    this.stopSampling();
    this.listeners = [];
  }

  private stopSampling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.endRecording?.();
    this.endRecording = null;
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

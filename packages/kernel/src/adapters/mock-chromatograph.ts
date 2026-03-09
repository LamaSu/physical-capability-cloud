/**
 * Mock HPLC Chromatograph — demonstrates batch instrument pattern.
 *
 * Declares UV absorbance, column pressure, and column temperature channels.
 * Simulates an autosampler batch run with per-slot injection/acquisition.
 */

import type {
  EvidenceEvent,
  EvidenceSource,
  SensorChannelDescriptor,
  SensorReading,
  SampleSlot,
} from "@pcc/spec";
import type { UniversalSensorAdapter } from "./universal-sensor-adapter.js";

export class MockChromatograph implements UniversalSensorAdapter {
  readonly id: string;
  readonly deviceClass = "instrument" as const;
  readonly source: EvidenceSource;
  private status: "idle" | "busy" | "error" | "offline" | "maintenance" = "idle";
  private evidenceCallbacks: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private readingCallbacks: Array<(reading: Omit<SensorReading, "id">) => void> = [];

  constructor(id: string, kernelId: string) {
    this.id = id;
    this.source = {
      deviceId: id,
      deviceType: "chromatograph",
      kernelId,
      firmwareVersion: "mock-hplc-1.0",
    };
  }

  getChannelDescriptors(): SensorChannelDescriptor[] {
    return [
      {
        channel: `${this.id}_uv_absorbance`,
        label: "UV Absorbance (254nm)",
        dataType: "scalar",
        unit: "mAU",
        sampleRateHz: 10,
        range: { min: -50, max: 2000 },
        resolution: 0.01,
        retentionPolicy: "full",
        evidenceGrade: true,
      },
      {
        channel: `${this.id}_column_pressure`,
        label: "Column Pressure",
        dataType: "scalar",
        unit: "bar",
        sampleRateHz: 1,
        range: { min: 0, max: 400 },
        resolution: 0.1,
        retentionPolicy: "downsample_1s",
        evidenceGrade: true,
      },
      {
        channel: `${this.id}_column_temp`,
        label: "Column Temperature",
        dataType: "scalar",
        unit: "degC",
        sampleRateHz: 0.5,
        range: { min: 15, max: 80 },
        resolution: 0.1,
        retentionPolicy: "downsample_10s",
        evidenceGrade: false,
      },
    ];
  }

  async getStatus() {
    return this.status;
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.evidenceCallbacks.push(callback);
  }

  /** Subscribe to sensor readings during acquisition */
  onReading(callback: (reading: Omit<SensorReading, "id">) => void): void {
    this.readingCallbacks.push(callback);
  }

  /** Simulate a batch sequence run */
  async runSequence(
    slots: SampleSlot[],
    onSlotStart?: (slotId: string) => void,
    onSlotEnd?: (slotId: string) => void,
  ): Promise<void> {
    this.status = "busy";

    this.emitEvidence("sequence_started", {
      slotCount: slots.length,
      method: "mock_gradient_30min",
    });

    for (const slot of slots) {
      if (onSlotStart) onSlotStart(slot.id);

      // Simulate injection
      this.emitEvidence("batch_sample_result", {
        position: slot.position,
        phase: "injection",
        slotId: slot.id,
      });

      // Simulate acquisition — emit a few readings
      const baseAbsorbance = Math.random() * 100 + 50;
      const basePressure = 150 + Math.random() * 50;
      const baseTemp = 25 + Math.random() * 5;
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        const timestamp = new Date(now + i * 100).toISOString();

        // UV absorbance with simulated peak
        const peakFactor = Math.exp(-((i - 2.5) ** 2) / 2);
        this.emitReading({
          timestamp,
          kernelId: this.source.kernelId,
          deviceId: this.id,
          channel: `${this.id}_uv_absorbance`,
          dataType: "scalar",
          unit: "mAU",
          value: baseAbsorbance + peakFactor * 500,
          quality: 0.95,
          jobId: slot.jobId,
          batchId: slot.id,
        });

        // Column pressure
        this.emitReading({
          timestamp,
          kernelId: this.source.kernelId,
          deviceId: this.id,
          channel: `${this.id}_column_pressure`,
          dataType: "scalar",
          unit: "bar",
          value: basePressure + Math.random() * 5,
          quality: 0.99,
          jobId: slot.jobId,
          batchId: slot.id,
        });

        // Column temperature
        if (i % 2 === 0) {
          this.emitReading({
            timestamp,
            kernelId: this.source.kernelId,
            deviceId: this.id,
            channel: `${this.id}_column_temp`,
            dataType: "scalar",
            unit: "degC",
            value: baseTemp + Math.random() * 0.5,
            quality: 0.98,
            jobId: slot.jobId,
            batchId: slot.id,
          });
        }
      }

      if (onSlotEnd) onSlotEnd(slot.id);
    }

    this.status = "idle";
  }

  async dispose(): Promise<void> {
    this.evidenceCallbacks = [];
    this.readingCallbacks = [];
    this.status = "offline";
  }

  private emitEvidence(type: string, payload: Record<string, unknown>): void {
    const event: Omit<EvidenceEvent, "id" | "hash"> = {
      type: type as EvidenceEvent["type"],
      timestamp: new Date().toISOString(),
      source: this.source,
      payload,
    };
    for (const cb of this.evidenceCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }

  private emitReading(reading: Omit<SensorReading, "id">): void {
    for (const cb of this.readingCallbacks) {
      try { cb(reading); } catch { /* ignore */ }
    }
  }
}

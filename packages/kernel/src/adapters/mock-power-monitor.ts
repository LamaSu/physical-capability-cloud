/**
 * Mock power monitor adapter.
 *
 * Simulates a CT clamp sensor monitoring machine power consumption.
 * Produces power profile evidence events during job execution.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { SensorAdapter } from "./types.js";

export class MockPowerMonitorAdapter implements SensorAdapter {
  readonly id: string;
  readonly type = "power_monitor" as const;
  readonly source: EvidenceSource;

  private recording = false;
  private jobId: string | null = null;
  private samples: Array<{ timestamp: string; watts: number }> = [];
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  /** Simulated base wattage when idle */
  private idleWatts: number;
  /** Simulated wattage when active */
  private activeWatts: number;

  constructor(id: string, kernelId: string, opts?: { idleWatts?: number; activeWatts?: number }) {
    this.id = id;
    this.idleWatts = opts?.idleWatts ?? 5;
    this.activeWatts = opts?.activeWatts ?? 250;
    this.source = {
      deviceId: id,
      deviceType: "power_monitor",
      kernelId,
      firmwareVersion: "MockCT-1.0.0",
      // Honesty marker: simulator by construction (see also payload.mock).
      simulated: true,
    };
  }

  async startRecording(jobId: string): Promise<void> {
    this.recording = true;
    this.jobId = jobId;
    this.samples = [];

    // Sample every 2 seconds
    this.sampleTimer = setInterval(() => {
      const watts = this.activeWatts + (Math.random() - 0.5) * 20;
      const sample = { timestamp: new Date().toISOString(), watts };
      this.samples.push(sample);

      this.emit({
        type: "power_profile_sample",
        timestamp: sample.timestamp,
        source: this.source,
        payload: { jobId, watts: sample.watts, unit: "W" },
      });
    }, 2000);
  }

  async stopRecording(): Promise<Omit<EvidenceEvent, "id" | "hash">> {
    this.recording = false;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;

    const totalSamples = this.samples.length;
    const avgWatts = totalSamples > 0
      ? this.samples.reduce((s, x) => s + x.watts, 0) / totalSamples
      : 0;
    const peakWatts = totalSamples > 0
      ? Math.max(...this.samples.map((s) => s.watts))
      : 0;
    const durationSeconds = totalSamples * 2;
    const totalWh = (avgWatts * durationSeconds) / 3600;

    const summaryEvent: Omit<EvidenceEvent, "id" | "hash"> = {
      type: "power_profile_summary",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        jobId: this.jobId,
        totalSamples,
        durationSeconds,
        avgWatts: Math.round(avgWatts * 100) / 100,
        peakWatts: Math.round(peakWatts * 100) / 100,
        totalWh: Math.round(totalWh * 100) / 100,
        profile: this.samples.map((s) => s.watts),
        mock: true,
      },
    };

    this.emit(summaryEvent);
    this.samples = [];
    this.jobId = null;

    return summaryEvent;
  }

  async getCurrentReading(): Promise<Record<string, unknown>> {
    const watts = this.recording
      ? this.activeWatts + (Math.random() - 0.5) * 20
      : this.idleWatts + Math.random() * 2;
    return { watts, unit: "W", recording: this.recording };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    this.listeners = [];
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    // Single tag point: every event from this simulator carries payload.mock.
    const tagged = { ...event, payload: { ...event.payload, mock: true } };
    for (const listener of this.listeners) {
      listener(tagged);
    }
  }
}

/**
 * SSE Data Producers — wire real-time data sources into the StreamHub.
 *
 * Each producer generates mock data on a timer and publishes through StreamHub
 * in the correct StreamEvent format. Producers are independently startable/stoppable.
 */

import type { StreamTopic } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { streamHub, type StreamEvent } from "./stream-hub.js";
import {
  generateSensorReading,
  generateSensorAnomaly,
  generateBatchEvent,
  generateProtocolEvent,
  generateProcessLog,
  resetBatchGenerator,
  resetProtocolGenerator,
  resetLogGenerator,
  MOCK_CHANNEL_DESCRIPTORS,
} from "./mock-data-generator.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeStreamEvent(
  type: string,
  topic: StreamTopic,
  payload: unknown,
): StreamEvent {
  return {
    id: ids.stream(),
    type,
    timestamp: new Date().toISOString(),
    topic,
    payload,
  };
}

// ── Base Producer ────────────────────────────────────────────────

export interface Producer {
  readonly name: string;
  start(): void;
  stop(): void;
  readonly isRunning: boolean;
}

// ── Sensor Producer ──────────────────────────────────────────────

/**
 * Publishes sensor_reading events to device and kernel topics.
 * Cycles through registered channels on each tick.
 * Occasionally emits sensor_anomaly events.
 */
export class SensorProducer implements Producer {
  readonly name = "sensor";
  private timer: ReturnType<typeof setInterval> | null = null;
  private channelIndex = 0;
  private tickCount = 0;

  constructor(
    private intervalMs = 1000,
    private channels = MOCK_CHANNEL_DESCRIPTORS.map((d) => d.channel),
  ) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    this.tickCount++;
    const channel = this.channels[this.channelIndex % this.channels.length];
    this.channelIndex++;

    const reading = generateSensorReading(channel);

    const deviceTopic: StreamTopic = { type: "device", id: reading.deviceId };
    const kernelTopic: StreamTopic = { type: "kernel", id: reading.kernelId };
    const topics = [deviceTopic, kernelTopic];

    if (reading.jobId) {
      topics.push({ type: "job", id: reading.jobId });
    }

    const event = makeStreamEvent("sensor_reading", kernelTopic, reading);
    streamHub.publish(topics, event);

    // Occasionally emit anomalies (~1 in 30 ticks)
    if (this.tickCount % 30 === 0) {
      const anomaly = generateSensorAnomaly(channel);
      const anomalyEvent = makeStreamEvent("sensor_anomaly", kernelTopic, anomaly);
      streamHub.publish([kernelTopic, deviceTopic], anomalyEvent);
    }
  }
}

// ── Batch Producer ───────────────────────────────────────────────

/**
 * Publishes batch lifecycle events to batch topics.
 * Progresses through a realistic batch lifecycle: assemble -> seal -> run -> complete.
 */
export class BatchProducer implements Producer {
  readonly name = "batch";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private intervalMs = 3000) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    resetBatchGenerator();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const batchEvent = generateBatchEvent();

    const batchTopic: StreamTopic = { type: "batch", id: batchEvent.batchId };
    const kernelTopic: StreamTopic = { type: "kernel", id: "kernel-nyc" };

    const event = makeStreamEvent(batchEvent.type, batchTopic, batchEvent);
    streamHub.publish([batchTopic, kernelTopic], event);
  }
}

// ── Protocol Producer ────────────────────────────────────────────

/**
 * Publishes protocol run events to job topics.
 * Simulates a multi-step protocol execution with start/step/complete events.
 */
export class ProtocolProducer implements Producer {
  readonly name = "protocol";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private intervalMs = 4000) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    resetProtocolGenerator();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const protocolEvent = generateProtocolEvent();

    const kernelTopic: StreamTopic = { type: "kernel", id: "kernel-nyc" };
    const jobTopic: StreamTopic = { type: "job", id: protocolEvent.runId };

    const event = makeStreamEvent(protocolEvent.type, kernelTopic, protocolEvent);
    streamHub.publish([jobTopic, kernelTopic], event);
  }
}

// ── Log Producer ─────────────────────────────────────────────────

/**
 * Publishes process_log events to job and kernel topics.
 * Generates structured log entries with phase tracking and progress.
 */
export class LogProducer implements Producer {
  readonly name = "log";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private intervalMs = 2000) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    resetLogGenerator();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const logEntry = generateProcessLog();

    const kernelTopic: StreamTopic = { type: "kernel", id: logEntry.kernelId };
    const jobTopic: StreamTopic = { type: "job", id: logEntry.jobId };
    const topics = [kernelTopic, jobTopic];

    if (logEntry.deviceId) {
      topics.push({ type: "device", id: logEntry.deviceId });
    }

    const event = makeStreamEvent("process_log", kernelTopic, logEntry);
    streamHub.publish(topics, event);
  }
}

// ── Producer Manager ─────────────────────────────────────────────

/**
 * Manages all producers with collective start/stop and individual control.
 */
export class ProducerManager {
  private producers: Producer[] = [];

  constructor() {
    this.producers = [
      new SensorProducer(1000),   // 1s — sensor readings
      new BatchProducer(3000),    // 3s — batch events
      new ProtocolProducer(4000), // 4s — protocol events
      new LogProducer(2000),      // 2s — process logs
    ];
  }

  /** Start all producers */
  startAll(): void {
    for (const p of this.producers) {
      p.start();
    }
    console.log(
      `[producers] Started ${this.producers.length} mock producers: ${this.producers.map((p) => p.name).join(", ")}`,
    );
  }

  /** Stop all producers */
  stopAll(): void {
    for (const p of this.producers) {
      p.stop();
    }
    console.log("[producers] All mock producers stopped");
  }

  /** Start a specific producer by name */
  start(name: string): boolean {
    const p = this.producers.find((pr) => pr.name === name);
    if (p) {
      p.start();
      return true;
    }
    return false;
  }

  /** Stop a specific producer by name */
  stop(name: string): boolean {
    const p = this.producers.find((pr) => pr.name === name);
    if (p) {
      p.stop();
      return true;
    }
    return false;
  }

  /** Get status of all producers */
  getStatus(): Array<{ name: string; running: boolean }> {
    return this.producers.map((p) => ({
      name: p.name,
      running: p.isRunning,
    }));
  }
}

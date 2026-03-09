/**
 * SensorPipeline — edge data processing engine for universal sensor ingestion.
 *
 * Provides ring-buffered storage, LTTB downsampling, anomaly detection,
 * and aggregation for any sensor channel.
 */

import type {
  SensorReading,
  SensorChannelDescriptor,
  SensorAggregate,
  SensorAnomaly,
  PhysicalUnit,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

/** Fixed-size circular buffer — O(1) insert, no allocation after init */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Return items in chronological order */
  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return result;
  }

  /** Latest N items, most recent last */
  latest(n: number): T[] {
    const all = this.toArray();
    return all.slice(Math.max(0, all.length - n));
  }

  get size(): number {
    return this.count;
  }
}

/**
 * LTTB (Largest Triangle Three Buckets) — visual downsampling algorithm.
 * Preserves visual fidelity by keeping the most visually significant points.
 */
export function lttbDownsample(data: { t: number; v: number }[], targetPoints: number): { t: number; v: number }[] {
  if (data.length <= targetPoints) return data;
  if (targetPoints < 3) return [data[0], data[data.length - 1]];

  const result: { t: number; v: number }[] = [data[0]]; // Always keep first
  const bucketSize = (data.length - 2) / (targetPoints - 2);

  let prevIndex = 0;

  for (let i = 0; i < targetPoints - 2; i++) {
    const bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, data.length - 1);

    // Average of next bucket (for triangle area calculation)
    const nextBucketStart = Math.floor((i + 2) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, data.length - 1);
    let avgT = 0, avgV = 0, avgCount = 0;
    for (let j = nextBucketStart; j < nextBucketEnd && j < data.length; j++) {
      avgT += data[j].t;
      avgV += data[j].v;
      avgCount++;
    }
    if (avgCount === 0) {
      avgT = data[data.length - 1].t;
      avgV = data[data.length - 1].v;
    } else {
      avgT /= avgCount;
      avgV /= avgCount;
    }

    // Find point in current bucket with largest triangle area
    let maxArea = -1;
    let maxIndex = bucketStart;
    const prev = data[prevIndex];

    for (let j = bucketStart; j < bucketEnd && j < data.length; j++) {
      const area = Math.abs(
        (prev.t - avgT) * (data[j].v - prev.v) -
        (prev.t - data[j].t) * (avgV - prev.v)
      );
      if (area > maxArea) {
        maxArea = area;
        maxIndex = j;
      }
    }

    result.push(data[maxIndex]);
    prevIndex = maxIndex;
  }

  result.push(data[data.length - 1]); // Always keep last
  return result;
}

export interface PipelineConfig {
  /** Default ring buffer capacity per channel */
  bufferCapacity: number;
  /** Anomaly detection: max consecutive identical readings before "flatline" */
  flatlineThreshold: number;
  /** Anomaly detection: max rate of change per second before "rate_of_change" */
  maxRateOfChange: number;
}

const DEFAULT_CONFIG: PipelineConfig = {
  bufferCapacity: 1000,
  flatlineThreshold: 30,
  maxRateOfChange: 1000,
};

export class SensorPipeline {
  private buffers = new Map<string, RingBuffer<SensorReading>>();
  private descriptors = new Map<string, SensorChannelDescriptor>();
  private listeners = new Set<(reading: SensorReading) => void>();
  private anomalyListeners = new Set<(anomaly: SensorAnomaly) => void>();
  private config: PipelineConfig;

  constructor(config?: Partial<PipelineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Register a channel's metadata */
  registerChannel(descriptor: SensorChannelDescriptor): void {
    this.descriptors.set(descriptor.channel, descriptor);
    if (!this.buffers.has(descriptor.channel)) {
      this.buffers.set(descriptor.channel, new RingBuffer(this.config.bufferCapacity));
    }
  }

  /** Ingest a raw reading — validate, buffer, detect anomalies, emit */
  ingest(reading: Omit<SensorReading, "id">): SensorReading {
    const id = ids.reading();
    const full: SensorReading = { ...reading, id };

    // Ensure buffer exists
    let buffer = this.buffers.get(reading.channel);
    if (!buffer) {
      buffer = new RingBuffer(this.config.bufferCapacity);
      this.buffers.set(reading.channel, buffer);
    }

    // Anomaly detection for scalar values
    if (typeof reading.value === "number") {
      this.detectAnomalies(full, buffer);
    }

    buffer.push(full);

    // Notify listeners
    for (const cb of this.listeners) {
      try { cb(full); } catch { /* ignore */ }
    }

    return full;
  }

  private detectAnomalies(reading: SensorReading, buffer: RingBuffer<SensorReading>): void {
    const value = reading.value as number;
    const descriptor = this.descriptors.get(reading.channel);

    // Threshold check
    if (descriptor?.range) {
      if (value < descriptor.range.min || value > descriptor.range.max) {
        this.emitAnomaly({
          timestamp: reading.timestamp,
          kernelId: reading.kernelId,
          deviceId: reading.deviceId,
          channel: reading.channel,
          type: "threshold_exceeded",
          severity: "warning",
          value,
          threshold: value < descriptor.range.min ? descriptor.range.min : descriptor.range.max,
          message: `${reading.channel} value ${value} outside range [${descriptor.range.min}, ${descriptor.range.max}]`,
          jobId: reading.jobId,
        });
      }
    }

    // Rate of change check
    const recent = buffer.latest(2);
    if (recent.length > 0 && typeof recent[recent.length - 1].value === "number") {
      const prev = recent[recent.length - 1];
      const dt = (new Date(reading.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;
      if (dt > 0) {
        const rate = Math.abs(value - (prev.value as number)) / dt;
        if (rate > this.config.maxRateOfChange) {
          this.emitAnomaly({
            timestamp: reading.timestamp,
            kernelId: reading.kernelId,
            deviceId: reading.deviceId,
            channel: reading.channel,
            type: "rate_of_change",
            severity: "warning",
            value: rate,
            threshold: this.config.maxRateOfChange,
            message: `${reading.channel} rate of change ${rate.toFixed(1)}/s exceeds threshold`,
            jobId: reading.jobId,
          });
        }
      }
    }

    // Flatline check
    const tail = buffer.latest(this.config.flatlineThreshold);
    if (tail.length >= this.config.flatlineThreshold) {
      const allSame = tail.every((r) => r.value === value);
      if (allSame) {
        this.emitAnomaly({
          timestamp: reading.timestamp,
          kernelId: reading.kernelId,
          deviceId: reading.deviceId,
          channel: reading.channel,
          type: "flatline",
          severity: "info",
          value,
          threshold: this.config.flatlineThreshold,
          message: `${reading.channel} has been constant at ${value} for ${this.config.flatlineThreshold} readings`,
          jobId: reading.jobId,
        });
      }
    }
  }

  private emitAnomaly(partial: Omit<SensorAnomaly, "id">): void {
    const anomaly: SensorAnomaly = { ...partial, id: ids.anomaly() };
    for (const cb of this.anomalyListeners) {
      try { cb(anomaly); } catch { /* ignore */ }
    }
  }

  /** Get latest N readings for a channel */
  getRecent(channel: string, count = 100): SensorReading[] {
    return this.buffers.get(channel)?.latest(count) ?? [];
  }

  /** Compute aggregate for a channel over a time window */
  aggregate(channel: string, windowMs: number): SensorAggregate | null {
    const buffer = this.buffers.get(channel);
    if (!buffer || buffer.size === 0) return null;

    const now = Date.now();
    const cutoff = now - windowMs;
    const readings = buffer.toArray().filter(
      (r) => new Date(r.timestamp).getTime() >= cutoff && typeof r.value === "number"
    );

    if (readings.length === 0) return null;

    const values = readings.map((r) => r.value as number);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;

    const first = readings[0];
    return {
      channel,
      kernelId: first.kernelId,
      deviceId: first.deviceId,
      windowStart: readings[0].timestamp,
      windowEnd: readings[readings.length - 1].timestamp,
      count: readings.length,
      min,
      max,
      mean,
      stddev: Math.sqrt(variance),
      unit: first.unit,
      jobId: first.jobId,
      batchId: first.batchId,
    };
  }

  /** Downsample channel data using LTTB algorithm */
  downsample(channel: string, targetPoints: number): SensorReading[] {
    const buffer = this.buffers.get(channel);
    if (!buffer || buffer.size === 0) return [];

    const readings = buffer.toArray().filter((r) => typeof r.value === "number");
    const data = readings.map((r) => ({
      t: new Date(r.timestamp).getTime(),
      v: r.value as number,
    }));

    const downsampled = lttbDownsample(data, targetPoints);
    const tSet = new Set(downsampled.map((d) => d.t));
    return readings.filter((r) => tSet.has(new Date(r.timestamp).getTime()));
  }

  /** Get all registered channel descriptors */
  getDescriptors(): SensorChannelDescriptor[] {
    return [...this.descriptors.values()];
  }

  /** Subscribe to all readings */
  onReading(cb: (reading: SensorReading) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Subscribe to anomalies */
  onAnomaly(cb: (anomaly: SensorAnomaly) => void): () => void {
    this.anomalyListeners.add(cb);
    return () => { this.anomalyListeners.delete(cb); };
  }
}

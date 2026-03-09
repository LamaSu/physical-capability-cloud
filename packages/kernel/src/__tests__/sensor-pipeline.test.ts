import { describe, it, expect } from "vitest";
import { RingBuffer, SensorPipeline, lttbDownsample } from "../sensor-pipeline.js";
import type { SensorReading, SensorChannelDescriptor } from "@pcc/spec";

// ── RingBuffer ──────────────────────────────────────────────────────

describe("RingBuffer", () => {
  it("starts empty", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
  });

  it("pushes items and returns in order", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.size).toBe(3);
  });

  it("overwrites oldest on overflow", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.size).toBe(3);
  });

  it("wraps around multiple times", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 1; i <= 10; i++) buf.push(i);
    expect(buf.toArray()).toEqual([8, 9, 10]);
  });

  it("latest returns last N items", () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 1; i <= 5; i++) buf.push(i);
    expect(buf.latest(2)).toEqual([4, 5]);
    expect(buf.latest(10)).toEqual([1, 2, 3, 4, 5]);
  });

  it("latest on empty buffer returns empty", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.latest(3)).toEqual([]);
  });
});

// ── LTTB Downsampling ───────────────────────────────────────────────

describe("lttbDownsample", () => {
  it("returns input unchanged when data.length <= targetPoints", () => {
    const data = [{ t: 0, v: 1 }, { t: 1, v: 2 }, { t: 2, v: 3 }];
    expect(lttbDownsample(data, 5)).toEqual(data);
    expect(lttbDownsample(data, 3)).toEqual(data);
  });

  it("returns first and last for targetPoints < 3", () => {
    const data = [{ t: 0, v: 1 }, { t: 1, v: 2 }, { t: 2, v: 3 }, { t: 3, v: 4 }];
    const result = lttbDownsample(data, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ t: 0, v: 1 });
    expect(result[1]).toEqual({ t: 3, v: 4 });
  });

  it("reduces data to target size", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      t: i,
      v: Math.sin(i / 10) * 100,
    }));
    const result = lttbDownsample(data, 20);
    expect(result.length).toBe(20);
    // First and last are always preserved
    expect(result[0]).toEqual(data[0]);
    expect(result[result.length - 1]).toEqual(data[data.length - 1]);
  });

  it("preserves peaks better than uniform sampling", () => {
    // Create data with a sharp peak at index 50
    const data = Array.from({ length: 100 }, (_, i) => ({
      t: i,
      v: i === 50 ? 1000 : 0,
    }));
    const result = lttbDownsample(data, 10);
    // LTTB should keep the peak because it has the largest triangle area
    const maxVal = Math.max(...result.map((d) => d.v));
    expect(maxVal).toBe(1000);
  });
});

// ── SensorPipeline ──────────────────────────────────────────────────

function makeReading(overrides: Partial<SensorReading> & { channel: string }): Omit<SensorReading, "id"> {
  return {
    timestamp: new Date().toISOString(),
    kernelId: "kernel-test",
    deviceId: "dev-test",
    dataType: "scalar",
    unit: "degC",
    value: 25,
    ...overrides,
  };
}

const tempDescriptor: SensorChannelDescriptor = {
  channel: "nozzle_temp",
  label: "Nozzle Temperature",
  dataType: "scalar",
  unit: "degC",
  sampleRateHz: 1,
  range: { min: 150, max: 280 },
  resolution: 0.1,
  retentionPolicy: "full",
  evidenceGrade: true,
};

describe("SensorPipeline", () => {
  it("registers channels and returns descriptors", () => {
    const pipeline = new SensorPipeline();
    pipeline.registerChannel(tempDescriptor);
    expect(pipeline.getDescriptors()).toHaveLength(1);
    expect(pipeline.getDescriptors()[0].channel).toBe("nozzle_temp");
  });

  it("ingests readings and assigns IDs", () => {
    const pipeline = new SensorPipeline();
    const reading = pipeline.ingest(makeReading({ channel: "nozzle_temp", value: 200 }));
    expect(reading.id).toMatch(/^rdg_/);
    expect(reading.value).toBe(200);
  });

  it("buffers readings and retrieves recent", () => {
    const pipeline = new SensorPipeline();
    for (let i = 0; i < 10; i++) {
      pipeline.ingest(makeReading({ channel: "temp", value: i }));
    }
    const recent = pipeline.getRecent("temp", 5);
    expect(recent).toHaveLength(5);
    expect(recent[0].value).toBe(5);
    expect(recent[4].value).toBe(9);
  });

  it("notifies reading listeners", () => {
    const pipeline = new SensorPipeline();
    const received: SensorReading[] = [];
    pipeline.onReading((r) => received.push(r));
    pipeline.ingest(makeReading({ channel: "temp", value: 42 }));
    expect(received).toHaveLength(1);
    expect(received[0].value).toBe(42);
  });

  it("unsubscribes reading listeners", () => {
    const pipeline = new SensorPipeline();
    const received: SensorReading[] = [];
    const unsub = pipeline.onReading((r) => received.push(r));
    pipeline.ingest(makeReading({ channel: "temp", value: 1 }));
    unsub();
    pipeline.ingest(makeReading({ channel: "temp", value: 2 }));
    expect(received).toHaveLength(1);
  });

  it("detects threshold anomaly", () => {
    const pipeline = new SensorPipeline();
    pipeline.registerChannel(tempDescriptor);
    const anomalies: unknown[] = [];
    pipeline.onAnomaly((a) => anomalies.push(a));

    // Value within range — no anomaly
    pipeline.ingest(makeReading({ channel: "nozzle_temp", value: 200 }));
    expect(anomalies).toHaveLength(0);

    // Value exceeds max — anomaly
    pipeline.ingest(makeReading({ channel: "nozzle_temp", value: 300 }));
    expect(anomalies).toHaveLength(1);
    expect((anomalies[0] as any).type).toBe("threshold_exceeded");
  });

  it("detects flatline anomaly", () => {
    const pipeline = new SensorPipeline({ bufferCapacity: 100, flatlineThreshold: 5, maxRateOfChange: 1000 });
    const anomalies: unknown[] = [];
    pipeline.onAnomaly((a) => anomalies.push(a));

    for (let i = 0; i < 6; i++) {
      pipeline.ingest(makeReading({ channel: "temp", value: 42 }));
    }
    const flatlines = (anomalies as any[]).filter((a) => a.type === "flatline");
    expect(flatlines.length).toBeGreaterThanOrEqual(1);
  });

  it("computes aggregates", () => {
    const pipeline = new SensorPipeline();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      pipeline.ingest(makeReading({
        channel: "temp",
        value: 10 + i,
        timestamp: new Date(now - (10 - i) * 100).toISOString(),
      }));
    }
    const agg = pipeline.aggregate("temp", 5000);
    expect(agg).not.toBeNull();
    expect(agg!.count).toBe(10);
    expect(agg!.min).toBe(10);
    expect(agg!.max).toBe(19);
    expect(agg!.mean).toBeCloseTo(14.5);
  });

  it("returns null aggregate for unknown channel", () => {
    const pipeline = new SensorPipeline();
    expect(pipeline.aggregate("nonexistent", 1000)).toBeNull();
  });

  it("downsamples channel data", () => {
    const pipeline = new SensorPipeline();
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      pipeline.ingest(makeReading({
        channel: "temp",
        value: Math.sin(i / 10) * 50 + 100,
        timestamp: new Date(now + i * 1000).toISOString(),
      }));
    }
    const downsampled = pipeline.downsample("temp", 20);
    expect(downsampled.length).toBeLessThanOrEqual(20);
    expect(downsampled.length).toBeGreaterThan(0);
  });
});

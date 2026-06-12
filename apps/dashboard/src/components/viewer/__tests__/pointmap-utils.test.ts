/**
 * Tests for the pure helpers in `pointmap-utils.ts`.
 *
 * These are the math + buffer-conversion functions that feed the GPU. Bugs
 * here corrupt the rendered cloud silently (Three.js warns then no-ops), so
 * the tests are exhaustive about edge cases: empty traces, malformed
 * matrices, missing confidence values, single-frame traces, NaN inputs.
 */

import { describe, it, expect } from "vitest";
import type { PointMap3DTrace, PointMap3DFrame } from "@pcc/spec";
import {
  extractCameraPath,
  pointsToBuffer,
  pointsToColorBuffer,
  traceDurationSec,
  timeToFrameIndex,
  clampFrameIndex,
  pathBounds,
  isFinitePoint,
} from "../pointmap-utils.js";

function makeFrame(
  index: number,
  timestampSec: number,
  matrix: number[],
  points: { x: number; y: number; z: number; conf?: number }[] = [],
): PointMap3DFrame {
  return {
    frameIndex: index,
    timestampSec,
    pose: { matrix },
    points,
  };
}

function makeTrace(frames: PointMap3DFrame[]): PointMap3DTrace {
  return {
    deviceId: "test-device",
    startedAt: "2026-05-30T00:00:00Z",
    endedAt: "2026-05-30T00:00:10Z",
    videoHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    mode: "streaming",
    fps: 10,
    frameCount: frames.length,
    frames,
    model: "test-model",
    adapterVersion: "test-1.0.0",
  };
}

// ── extractCameraPath ──────────────────────────────────────────────────────

describe("extractCameraPath", () => {
  it("returns an empty Float32Array for empty traces", () => {
    const trace = makeTrace([]);
    const out = extractCameraPath(trace);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(0);
  });

  it("returns an empty Float32Array for single-frame traces (needs 2+ for a line)", () => {
    const trace = makeTrace([makeFrame(0, 0, [1, 0, 0, 5, 0, 1, 0, 7, 0, 0, 1, 9])]);
    const out = extractCameraPath(trace);
    expect(out.length).toBe(0);
  });

  it("extracts the translation column from each frame's 3x4 c2w matrix", () => {
    const trace = makeTrace([
      makeFrame(0, 0,   [1, 0, 0, 1.5,  0, 1, 0, 2.5,  0, 0, 1, 3.5]),
      makeFrame(1, 0.1, [1, 0, 0, 4.5,  0, 1, 0, 5.5,  0, 0, 1, 6.5]),
      makeFrame(2, 0.2, [1, 0, 0, 7.5,  0, 1, 0, 8.5,  0, 0, 1, 9.5]),
    ]);
    const out = extractCameraPath(trace);
    expect(out.length).toBe(9);
    expect(Array.from(out)).toEqual([1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]);
  });

  it("zero-fills malformed (too-short) matrices instead of throwing", () => {
    // Use values exactly representable in float32 so equality is stable.
    const trace = makeTrace([
      makeFrame(0, 0, [1, 0, 0, 9.5, 0, 1, 0, 8.25, 0, 0, 1, 7.125]),
      makeFrame(1, 0.1, [1, 2, 3]),
    ]);
    const out = extractCameraPath(trace);
    expect(out.length).toBe(6);
    expect(out[0]).toBe(9.5);
    expect(out[1]).toBe(8.25);
    expect(out[2]).toBe(7.125);
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(0);
    expect(out[5]).toBe(0);
  });
});

// ── pointsToBuffer ────────────────────────────────────────────────────────

describe("pointsToBuffer", () => {
  it("returns empty Float32Array for empty point arrays", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), []);
    const out = pointsToBuffer(frame);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(0);
  });

  it("flattens points to xyz triples in order", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), [
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
      { x: 7, y: 8, z: 9 },
    ]);
    const out = pointsToBuffer(frame);
    expect(out.length).toBe(9);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("preserves negative coordinates", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), [
      { x: -1, y: -2, z: -3 },
    ]);
    const out = pointsToBuffer(frame);
    expect(Array.from(out)).toEqual([-1, -2, -3]);
  });
});

// ── pointsToColorBuffer ───────────────────────────────────────────────────

describe("pointsToColorBuffer", () => {
  it("returns empty Float32Array for empty point arrays", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), []);
    expect(pointsToColorBuffer(frame).length).toBe(0);
  });

  it("maps conf=1 to pure green-ish (R=0, G=1, B=0.15)", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), [
      { x: 0, y: 0, z: 0, conf: 1 },
    ]);
    const out = pointsToColorBuffer(frame);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0.15);
  });

  it("maps conf=0 to pure red-ish (R=1, G=0, B=0.15)", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), [
      { x: 0, y: 0, z: 0, conf: 0 },
    ]);
    const out = pointsToColorBuffer(frame);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(0.15);
  });

  it("uses mid-gray for missing conf", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), [
      { x: 0, y: 0, z: 0 },
    ]);
    const out = pointsToColorBuffer(frame);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(0.5);
  });

  it("clamps conf outside [0,1] before rendering", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), [
      { x: 0, y: 0, z: 0, conf: 1.5 },
      { x: 0, y: 0, z: 0, conf: -0.5 },
    ]);
    const out = pointsToColorBuffer(frame);
    // 1.5 → clamped to 1 → R=0, G=1
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
    // -0.5 → clamped to 0 → R=1, G=0
    expect(out[3]).toBeCloseTo(1);
    expect(out[4]).toBeCloseTo(0);
  });

  it("uses mid-gray for NaN conf instead of corrupting the buffer", () => {
    const frame = makeFrame(0, 0, new Array(12).fill(0), [
      { x: 0, y: 0, z: 0, conf: Number.NaN },
    ]);
    const out = pointsToColorBuffer(frame);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[1]).toBeCloseTo(0.5);
  });
});

// ── traceDurationSec ──────────────────────────────────────────────────────

describe("traceDurationSec", () => {
  it("returns 0 for empty traces", () => {
    expect(traceDurationSec(makeTrace([]))).toBe(0);
  });

  it("returns the last frame's timestamp", () => {
    const trace = makeTrace([
      makeFrame(0, 0, new Array(12).fill(0)),
      makeFrame(1, 1.5, new Array(12).fill(0)),
      makeFrame(2, 3, new Array(12).fill(0)),
    ]);
    expect(traceDurationSec(trace)).toBe(3);
  });

  it("never returns a negative duration", () => {
    // Defensive — if a malformed trace somehow has a negative timestamp,
    // the function returns 0, not a negative number that would crash
    // a slider's max prop.
    const trace = makeTrace([
      makeFrame(0, 0, new Array(12).fill(0)),
      makeFrame(1, -2, new Array(12).fill(0)),
    ]);
    expect(traceDurationSec(trace)).toBe(0);
  });
});

// ── timeToFrameIndex ──────────────────────────────────────────────────────

describe("timeToFrameIndex", () => {
  const trace = makeTrace([
    makeFrame(0, 0, new Array(12).fill(0)),
    makeFrame(1, 1, new Array(12).fill(0)),
    makeFrame(2, 2, new Array(12).fill(0)),
    makeFrame(3, 3, new Array(12).fill(0)),
    makeFrame(4, 4, new Array(12).fill(0)),
  ]);

  it("returns 0 for empty traces", () => {
    expect(timeToFrameIndex(makeTrace([]), 5)).toBe(0);
  });

  it("returns 0 for negative time", () => {
    expect(timeToFrameIndex(trace, -1)).toBe(0);
  });

  it("returns last index for time past the end", () => {
    expect(timeToFrameIndex(trace, 100)).toBe(4);
  });

  it("returns exact index for matching timestamps", () => {
    expect(timeToFrameIndex(trace, 0)).toBe(0);
    expect(timeToFrameIndex(trace, 1)).toBe(1);
    expect(timeToFrameIndex(trace, 2)).toBe(2);
    expect(timeToFrameIndex(trace, 3)).toBe(3);
    expect(timeToFrameIndex(trace, 4)).toBe(4);
  });

  it("picks the closer of two bracketing frames", () => {
    expect(timeToFrameIndex(trace, 1.3)).toBe(1); // closer to 1 than to 2
    expect(timeToFrameIndex(trace, 1.7)).toBe(2); // closer to 2 than to 1
  });

  it("breaks ties at the midpoint deterministically (picks lower)", () => {
    expect(timeToFrameIndex(trace, 1.5)).toBe(1);
  });
});

// ── clampFrameIndex ───────────────────────────────────────────────────────

describe("clampFrameIndex", () => {
  const trace = makeTrace([
    makeFrame(0, 0, new Array(12).fill(0)),
    makeFrame(1, 1, new Array(12).fill(0)),
    makeFrame(2, 2, new Array(12).fill(0)),
  ]);

  it("clamps negative indices to 0", () => {
    expect(clampFrameIndex(trace, -5)).toBe(0);
  });

  it("clamps indices >= length to length-1", () => {
    expect(clampFrameIndex(trace, 10)).toBe(2);
  });

  it("returns in-range indices unchanged", () => {
    expect(clampFrameIndex(trace, 1)).toBe(1);
  });

  it("floors fractional indices", () => {
    expect(clampFrameIndex(trace, 1.7)).toBe(1);
  });

  it("returns 0 for NaN", () => {
    expect(clampFrameIndex(trace, Number.NaN)).toBe(0);
  });

  it("returns 0 for empty traces", () => {
    expect(clampFrameIndex(makeTrace([]), 5)).toBe(0);
  });
});

// ── pathBounds ────────────────────────────────────────────────────────────

describe("pathBounds", () => {
  it("returns origin-centered unit box for empty traces", () => {
    const b = pathBounds(makeTrace([]));
    expect(b.min).toEqual([-0.5, -0.5, -0.5]);
    expect(b.max).toEqual([0.5, 0.5, 0.5]);
    expect(b.center).toEqual([0, 0, 0]);
    expect(b.size).toEqual([1, 1, 1]);
  });

  it("computes correct bounds for a 3-frame straight path", () => {
    const trace = makeTrace([
      makeFrame(0, 0, [1, 0, 0, 0,    0, 1, 0, 0,    0, 0, 1, 0]),
      makeFrame(1, 1, [1, 0, 0, 2,    0, 1, 0, 4,    0, 0, 1, 6]),
      makeFrame(2, 2, [1, 0, 0, 4,    0, 1, 0, 8,    0, 0, 1, 12]),
    ]);
    const b = pathBounds(trace);
    expect(b.min).toEqual([0, 0, 0]);
    expect(b.max).toEqual([4, 8, 12]);
    expect(b.center).toEqual([2, 4, 6]);
    expect(b.size).toEqual([4, 8, 12]);
  });

  it("clamps near-zero sizes to a minimum so renderers don't crash", () => {
    const trace = makeTrace([
      makeFrame(0, 0, [1, 0, 0, 0.5, 0, 1, 0, 1.5, 0, 0, 1, 2.5]),
      makeFrame(1, 1, [1, 0, 0, 0.5, 0, 1, 0, 1.5, 0, 0, 1, 2.5]),
    ]);
    const b = pathBounds(trace);
    // All same position → size would be 0 — but clamp keeps it ≥ 0.001.
    expect(b.size[0]).toBeGreaterThanOrEqual(0.001);
    expect(b.size[1]).toBeGreaterThanOrEqual(0.001);
    expect(b.size[2]).toBeGreaterThanOrEqual(0.001);
  });
});

// ── isFinitePoint ─────────────────────────────────────────────────────────

describe("isFinitePoint", () => {
  it("returns true for fully finite points", () => {
    expect(isFinitePoint({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isFinitePoint({ x: -0.5, y: 0, z: 1e9 })).toBe(true);
  });

  it("returns false for NaN coordinates", () => {
    expect(isFinitePoint({ x: Number.NaN, y: 0, z: 0 })).toBe(false);
    expect(isFinitePoint({ x: 0, y: Number.NaN, z: 0 })).toBe(false);
    expect(isFinitePoint({ x: 0, y: 0, z: Number.NaN })).toBe(false);
  });

  it("returns false for Infinity", () => {
    expect(isFinitePoint({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 })).toBe(false);
    expect(isFinitePoint({ x: 0, y: Number.NEGATIVE_INFINITY, z: 0 })).toBe(false);
  });
});

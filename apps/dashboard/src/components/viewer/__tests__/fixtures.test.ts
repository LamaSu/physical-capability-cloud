/**
 * Tests for the demo trace fixture.
 *
 * The fixture feeds the dev-time viewer in EvidenceExplorerPage and
 * JobDetailPage. It MUST be deterministic (same seed → same output) so
 * snapshots and visual regression don't drift, and it MUST conform to the
 * Zod schema in `@pcc/spec` so the gateway-side `PointMap3DTraceSchemaExport`
 * would accept it if round-tripped.
 */

import { describe, expect, it } from "vitest";
import { makeDemoPointMap3DTrace } from "../fixtures.js";
import { PointMap3DTraceSchemaExport } from "@pcc/spec";

describe("makeDemoPointMap3DTrace", () => {
  it("returns a deterministic trace for a given seed", () => {
    const a = makeDemoPointMap3DTrace(42);
    const b = makeDemoPointMap3DTrace(42);

    // Same number of frames, same points-per-frame, same first/last poses
    // and points. (Don't deep-compare startedAt/endedAt — those use Date.now().)
    expect(a.frames.length).toBe(b.frames.length);
    expect(a.frameCount).toBe(b.frameCount);
    expect(a.fps).toBe(b.fps);
    expect(a.frames[0].pose.matrix).toEqual(b.frames[0].pose.matrix);
    expect(a.frames[0].points.length).toBe(b.frames[0].points.length);
    expect(a.frames[0].points[0]).toEqual(b.frames[0].points[0]);
    expect(a.frames.at(-1)!.pose.matrix).toEqual(b.frames.at(-1)!.pose.matrix);
  });

  it("returns different traces for different seeds (points differ)", () => {
    const a = makeDemoPointMap3DTrace(1);
    const b = makeDemoPointMap3DTrace(2);
    expect(a.frames[0].points[0]).not.toEqual(b.frames[0].points[0]);
  });

  it("has at least 2 frames so the camera path renders as a line", () => {
    const t = makeDemoPointMap3DTrace(42);
    expect(t.frames.length).toBeGreaterThanOrEqual(2);
  });

  it("has monotonic non-negative timestamps", () => {
    const t = makeDemoPointMap3DTrace(42);
    for (let i = 1; i < t.frames.length; i++) {
      expect(t.frames[i].timestampSec).toBeGreaterThan(t.frames[i - 1].timestampSec);
    }
    expect(t.frames[0].timestampSec).toBe(0);
  });

  it("every frame's pose matrix is exactly 12 numbers", () => {
    const t = makeDemoPointMap3DTrace(42);
    for (const f of t.frames) {
      expect(f.pose.matrix).toHaveLength(12);
      for (const v of f.pose.matrix) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("every point has finite x/y/z and conf in [0,1]", () => {
    const t = makeDemoPointMap3DTrace(42);
    for (const f of t.frames) {
      for (const p of f.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        expect(Number.isFinite(p.z)).toBe(true);
        if (typeof p.conf === "number") {
          expect(p.conf).toBeGreaterThanOrEqual(0);
          expect(p.conf).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("validates against the spec's Zod schema (PointMap3DTraceSchemaExport)", () => {
    const t = makeDemoPointMap3DTrace(42);
    const result = PointMap3DTraceSchemaExport.safeParse(t);
    if (!result.success) {
      // Surface validation errors for the test failure message.
      throw new Error(
        `Demo trace failed spec validation: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("frameCount matches frames.length", () => {
    const t = makeDemoPointMap3DTrace(42);
    expect(t.frameCount).toBe(t.frames.length);
  });

  it("is flagged as stubbed (so the viewer header shows a 'stub' chip)", () => {
    const t = makeDemoPointMap3DTrace(42);
    expect(t.stubbed).toBe(true);
  });
});

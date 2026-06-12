/**
 * Pure helpers for the PointMap3DViewer.
 *
 * Three transforms the viewer needs from the on-the-wire `PointMap3DTrace`
 * to GPU-ready buffers / scene values:
 *
 *   1. `extractCameraPath(trace)` — pulls the camera translation (last
 *      column of the 3x4 c2w extrinsic) out of every frame, producing the
 *      `[x, y, z]` polyline that becomes the camera-trajectory <Line>.
 *
 *   2. `pointsToBuffer(frame)` — flattens a frame's sparse Point3D[] into a
 *      `Float32Array(n*3)` that Three.js BufferGeometry can consume as a
 *      `position` attribute. Optional `Float32Array(n)` for confidence-tinted
 *      colours.
 *
 *   3. `timeToFrameIndex(trace, timeSec)` — given an elapsed playback
 *      time in *trace seconds*, return the closest frame index. Used by the
 *      RAF loop in `usePointMap3DPlayback` to advance the slider.
 *
 * Plus a small `traceDurationSec` helper for the seek-slider range.
 *
 * All functions are pure (no React, no Three.js imports), so they are safe
 * to test directly with vitest and reuse from any renderer.
 */

import type { PointMap3DTrace, PointMap3DFrame, Point3D } from "@pcc/spec";

/**
 * Pull the translation column of every frame's 3x4 c2w extrinsic, in trace
 * order, and return the resulting polyline as a flat `[x, y, z, x, y, z, ...]`
 * Float32Array suitable for a Three.js Line geometry.
 *
 * The matrix layout is row-major `[r00,r01,r02,t0, r10,r11,r12,t1,
 * r20,r21,r22,t2]` — so the translation column is at indices [3, 7, 11].
 *
 * Returns an empty array for traces with 0 or 1 frames (a line needs ≥2
 * points; the renderer renders an `<Line>` only when `length >= 6`).
 */
export function extractCameraPath(trace: PointMap3DTrace): Float32Array {
  if (!trace.frames || trace.frames.length < 2) {
    return new Float32Array(0);
  }
  const out = new Float32Array(trace.frames.length * 3);
  for (let i = 0; i < trace.frames.length; i++) {
    const m = trace.frames[i].pose.matrix;
    // Guard against malformed matrices (the schema requires length 12 but
    // the on-the-wire trace may come from an off-spec client).
    if (!m || m.length < 12) {
      out[i * 3 + 0] = 0;
      out[i * 3 + 1] = 0;
      out[i * 3 + 2] = 0;
      continue;
    }
    out[i * 3 + 0] = m[3];
    out[i * 3 + 1] = m[7];
    out[i * 3 + 2] = m[11];
  }
  return out;
}

/**
 * Flatten a frame's sparse Point3D[] into a Float32Array(n*3) suitable for
 * `BufferAttribute("position", buf, 3)`. Returns an empty array (length 0)
 * for empty/missing frames.
 */
export function pointsToBuffer(frame: PointMap3DFrame): Float32Array {
  if (!frame.points || frame.points.length === 0) {
    return new Float32Array(0);
  }
  const out = new Float32Array(frame.points.length * 3);
  for (let i = 0; i < frame.points.length; i++) {
    const p = frame.points[i];
    out[i * 3 + 0] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  }
  return out;
}

/**
 * For every point in `frame.points`, emit an RGB triplet derived from its
 * `conf` field. High confidence → green, low → red, missing → mid-gray.
 *
 * Result: `Float32Array(n*3)` of values in [0, 1], to be bound as the
 * `color` BufferAttribute on a `<PointsMaterial vertexColors />`.
 */
export function pointsToColorBuffer(frame: PointMap3DFrame): Float32Array {
  if (!frame.points || frame.points.length === 0) {
    return new Float32Array(0);
  }
  const out = new Float32Array(frame.points.length * 3);
  for (let i = 0; i < frame.points.length; i++) {
    const c = frame.points[i].conf;
    if (typeof c !== "number" || !Number.isFinite(c)) {
      out[i * 3 + 0] = 0.5;
      out[i * 3 + 1] = 0.5;
      out[i * 3 + 2] = 0.5;
      continue;
    }
    const cl = Math.max(0, Math.min(1, c));
    // Red→Green gradient through amber.
    out[i * 3 + 0] = 1 - cl;        // R: high at low conf
    out[i * 3 + 1] = cl;            // G: high at high conf
    out[i * 3 + 2] = 0.15;          // B: small constant for visibility on dark bg
  }
  return out;
}

/**
 * Total trace duration in seconds (last frame timestamp). Returns 0 when
 * the trace is empty so a slider always has a finite range.
 */
export function traceDurationSec(trace: PointMap3DTrace): number {
  if (!trace.frames || trace.frames.length === 0) return 0;
  const last = trace.frames[trace.frames.length - 1];
  return Math.max(0, last.timestampSec);
}

/**
 * Find the frame index whose `timestampSec` is closest to `timeSec`.
 *
 * Uses binary search on the (assumed monotonic) timestamps. Returns 0 for
 * negative inputs, last index for inputs past the end, or the nearest of
 * the two bracketing frames for in-range inputs.
 *
 * O(log N) — important when scrubbing every animation frame.
 */
export function timeToFrameIndex(
  trace: PointMap3DTrace,
  timeSec: number,
): number {
  const frames = trace.frames;
  if (!frames || frames.length === 0) return 0;
  if (timeSec <= frames[0].timestampSec) return 0;
  if (timeSec >= frames[frames.length - 1].timestampSec) return frames.length - 1;

  let lo = 0;
  let hi = frames.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].timestampSec <= timeSec) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Pick whichever of {lo, hi} is closer to timeSec.
  const dLo = Math.abs(frames[lo].timestampSec - timeSec);
  const dHi = Math.abs(frames[hi].timestampSec - timeSec);
  return dHi < dLo ? hi : lo;
}

/**
 * Clamp a frame index into `[0, trace.frames.length - 1]`. Used by seek
 * controls that take raw integer input (slider min/max may briefly drift
 * during re-renders).
 */
export function clampFrameIndex(trace: PointMap3DTrace, idx: number): number {
  const last = Math.max(0, (trace.frames?.length ?? 0) - 1);
  if (!Number.isFinite(idx)) return 0;
  return Math.max(0, Math.min(last, Math.floor(idx)));
}

/**
 * Project the entire camera path into a bounding box. Useful so the
 * default OrbitControls target can be the path centroid and the camera
 * sits at an appropriate distance.
 *
 * Returns `{ min, max, center, size }` where each is `[x, y, z]`. For
 * empty traces returns origin-centered unit box (so the renderer doesn't
 * choke on NaN-derived camera math).
 */
export function pathBounds(trace: PointMap3DTrace): {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  size: [number, number, number];
} {
  const frames = trace.frames ?? [];
  if (frames.length === 0) {
    return {
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
      center: [0, 0, 0],
      size: [1, 1, 1],
    };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const f of frames) {
    const m = f.pose.matrix;
    if (!m || m.length < 12) continue;
    const x = m[3], y = m[7], z = m[11];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  // Guard against all-zero / all-NaN traces.
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return {
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
      center: [0, 0, 0],
      size: [1, 1, 1],
    };
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const sx = Math.max(0.001, maxX - minX);
  const sy = Math.max(0.001, maxY - minY);
  const sz = Math.max(0.001, maxZ - minZ);
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [cx, cy, cz],
    size: [sx, sy, sz],
  };
}

/**
 * One-liner: every `Point3D` field is finite. Defensive: a trace coming
 * from a stubbed adapter may carry NaNs that would silently corrupt the
 * GPU buffer (Three.js will refuse to draw and log a console warning).
 */
export function isFinitePoint(p: Point3D): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

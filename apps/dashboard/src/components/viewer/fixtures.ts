/**
 * Demo fixtures for the PointMap3DViewer.
 *
 * Used by the EvidenceExplorerPage when the selected bundle has no real
 * `pointMaps3D` attached (i.e. the mock encrypted-evidence flow) so the
 * viewer can still be exercised end-to-end in development.
 *
 * The data is deterministic, finite, and small enough to keep the bundle
 * size impact negligible (~10 frames × 60 points × 3 floats).
 */

import type { PointMap3DTrace, PointMap3DFrame } from "@pcc/spec";

const FRAME_COUNT = 24;
const POINTS_PER_FRAME = 96;
const FPS = 12;

/**
 * Deterministic pseudo-random number generator (mulberry32) so the demo
 * trace is stable across reloads and CI runs.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFrame(index: number, rng: () => number): PointMap3DFrame {
  // Camera path: circular orbit around origin at radius 1.5, height 0.4 → 0.8.
  const theta = (index / FRAME_COUNT) * Math.PI * 2;
  const radius = 1.5;
  const cx = radius * Math.cos(theta);
  const cy = 0.4 + 0.4 * Math.sin(theta * 2);
  const cz = radius * Math.sin(theta);

  // Identity-ish rotation matrix (the demo doesn't need accurate orientation
  // for rendering; only the translation column drives camera-path display).
  const matrix = [
    1, 0, 0, cx,
    0, 1, 0, cy,
    0, 0, 1, cz,
  ];

  // Scene cloud: a fuzzy sphere of 96 points around the origin with a
  // gradient of confidence values. Same point cloud across frames produces
  // a "static scene, moving camera" feel which is appropriate for the demo.
  const points = Array.from({ length: POINTS_PER_FRAME }, (_, i) => {
    const phi = rng() * Math.PI * 2;
    const ct = rng() * 2 - 1;
    const st = Math.sqrt(1 - ct * ct);
    const r = 0.4 + rng() * 0.3;
    return {
      x: r * st * Math.cos(phi),
      y: r * ct,
      z: r * st * Math.sin(phi),
      conf: 0.4 + (i / POINTS_PER_FRAME) * 0.55,
    };
  });

  return {
    frameIndex: index,
    timestampSec: index / FPS,
    pose: { matrix },
    points,
    meanConfidence: 0.7,
  };
}

/**
 * Build the demo trace. Wrapped in a function (vs. a module-top constant)
 * so consumers can request a fresh deterministic trace per render and so
 * the trace isn't held in memory if no consumer ever calls it.
 */
export function makeDemoPointMap3DTrace(seed: number = 42): PointMap3DTrace {
  const rng = mulberry32(seed);
  const frames = Array.from({ length: FRAME_COUNT }, (_, i) => makeFrame(i, rng));
  const isoNow = new Date().toISOString();
  return {
    deviceId: "demo-device-fixture",
    startedAt: isoNow,
    endedAt: isoNow,
    videoHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    mode: "streaming",
    fps: FPS,
    frameCount: FRAME_COUNT,
    frames,
    model: "lingbot-map-stub",
    adapterVersion: "fixture-1.0.0",
    stubbed: true,
  };
}

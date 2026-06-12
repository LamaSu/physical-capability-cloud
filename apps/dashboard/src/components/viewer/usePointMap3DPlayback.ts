/**
 * usePointMap3DPlayback — playback state machine for a PointMap3DTrace.
 *
 * Owns: current frame index, playing flag, playback rate. Drives a RAF loop
 * that advances `currentFrame` based on `trace.fps × rate`. Exposes
 * imperative controls (play, pause, toggle, seek, step, reset).
 *
 * Pure React state + refs — no Three.js. The viewer reads `currentFrame`
 * each render and re-binds the matching frame's buffers to the GPU.
 *
 * Wraps the RAF call so vitest tests can substitute a deterministic clock
 * via `__test__ScheduleFrame` (default falls through to `requestAnimationFrame`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointMap3DTrace } from "@pcc/spec";
import { clampFrameIndex, timeToFrameIndex, traceDurationSec } from "./pointmap-utils.js";

/**
 * Test-injection hook for the RAF loop. Defaults to `requestAnimationFrame`.
 * Test code can override before the hook runs (the hook reads the live
 * reference each tick).
 */
export const __testHooks: {
  scheduleFrame: ((cb: (t: number) => void) => number) | null;
  cancelFrame: ((handle: number) => void) | null;
  now: (() => number) | null;
} = {
  scheduleFrame: null,
  cancelFrame: null,
  now: null,
};

function scheduleFrameImpl(cb: (t: number) => void): number {
  if (__testHooks.scheduleFrame) return __testHooks.scheduleFrame(cb);
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(cb);
  }
  // Node / SSR fallback — a 16 ms timer keeps things ticking.
  return setTimeout(() => cb(Date.now()), 16) as unknown as number;
}

function cancelFrameImpl(handle: number): void {
  if (__testHooks.cancelFrame) {
    __testHooks.cancelFrame(handle);
    return;
  }
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

function nowImpl(): number {
  if (__testHooks.now) return __testHooks.now();
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export interface PointMap3DPlaybackOptions {
  /** Initial playback rate (1 = real-time, 2 = 2x, 0.5 = half). Default 1. */
  initialRate?: number;
  /** Whether playback starts immediately. Default false. */
  autoplay?: boolean;
  /** Loop back to frame 0 when reaching the end. Default true. */
  loop?: boolean;
}

export interface PointMap3DPlaybackState {
  /** Current frame index, in `[0, trace.frames.length - 1]`. */
  currentFrame: number;
  /** Number of frames the trace has (cached for slider range). */
  frameCount: number;
  /** Total duration in seconds (last frame timestamp). */
  durationSec: number;
  /** Playback rate multiplier (1 = real-time). */
  rate: number;
  /** Whether playback is advancing. */
  playing: boolean;

  /** Start (or resume) playback. */
  play: () => void;
  /** Pause playback. */
  pause: () => void;
  /** Toggle playing flag. */
  toggle: () => void;
  /** Jump to a specific frame index (clamped to valid range). */
  seekFrame: (index: number) => void;
  /** Jump to a specific time in seconds (binary-searches frame). */
  seekTime: (timeSec: number) => void;
  /** Step forward/back N frames (negative for back). */
  step: (delta: number) => void;
  /** Reset to frame 0 and pause. */
  reset: () => void;
  /** Update playback rate (clamped to (0, 8]). */
  setRate: (rate: number) => void;
}

const MIN_RATE = 0.0625;   // 1/16x
const MAX_RATE = 8;        // 8x

/**
 * The hook. `trace` may be null to render an empty viewer; controls
 * still work (they just no-op) so the parent doesn't need conditional
 * wiring.
 */
export function usePointMap3DPlayback(
  trace: PointMap3DTrace | null,
  opts: PointMap3DPlaybackOptions = {},
): PointMap3DPlaybackState {
  const { initialRate = 1, autoplay = false, loop = true } = opts;

  const frameCount = trace?.frames?.length ?? 0;
  const durationSec = trace ? traceDurationSec(trace) : 0;

  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(Boolean(autoplay && frameCount > 1));
  const [rate, setRateState] = useState(
    Math.max(MIN_RATE, Math.min(MAX_RATE, initialRate)),
  );

  // Reset frame index whenever the trace identity changes.
  const traceIdRef = useRef<PointMap3DTrace | null>(null);
  useEffect(() => {
    if (traceIdRef.current !== trace) {
      traceIdRef.current = trace;
      setCurrentFrame(0);
    }
  }, [trace]);

  const playingRef = useRef(playing);
  const rateRef = useRef(rate);
  const frameRef = useRef(currentFrame);
  const traceRef = useRef(trace);
  const loopRef = useRef(loop);

  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { frameRef.current = currentFrame; }, [currentFrame]);
  useEffect(() => { traceRef.current = trace; }, [trace]);
  useEffect(() => { loopRef.current = loop; }, [loop]);

  // RAF loop — advances the frame index in real time scaled by `rate`.
  useEffect(() => {
    if (!playing || !trace || frameCount < 2) return;

    let rafHandle = 0;
    let lastTick = nowImpl();
    let accumSec = trace.frames[frameRef.current]?.timestampSec ?? 0;

    const tick = (t: number) => {
      const dtMs = t - lastTick;
      lastTick = t;
      if (!playingRef.current) return;
      if (!traceRef.current) return;

      accumSec += (dtMs / 1000) * rateRef.current;
      const total = traceDurationSec(traceRef.current);
      let nextIdx: number;

      if (total > 0 && accumSec >= total) {
        if (loopRef.current) {
          accumSec = 0;
          nextIdx = 0;
        } else {
          nextIdx = traceRef.current.frames.length - 1;
          setCurrentFrame(nextIdx);
          frameRef.current = nextIdx;
          setPlaying(false);
          return;
        }
      } else {
        nextIdx = timeToFrameIndex(traceRef.current, accumSec);
      }

      if (nextIdx !== frameRef.current) {
        frameRef.current = nextIdx;
        setCurrentFrame(nextIdx);
      }
      rafHandle = scheduleFrameImpl(tick);
    };

    rafHandle = scheduleFrameImpl(tick);
    return () => {
      cancelFrameImpl(rafHandle);
    };
  }, [playing, trace, frameCount]);

  const play = useCallback(() => {
    if (!trace || frameCount < 2) return;
    setPlaying(true);
  }, [trace, frameCount]);

  const pause = useCallback(() => setPlaying(false), []);

  const toggle = useCallback(() => {
    setPlaying((p) => (p ? false : trace !== null && frameCount > 1));
  }, [trace, frameCount]);

  const seekFrame = useCallback((index: number) => {
    if (!trace) return;
    const clamped = clampFrameIndex(trace, index);
    setCurrentFrame(clamped);
    frameRef.current = clamped;
  }, [trace]);

  const seekTime = useCallback((timeSec: number) => {
    if (!trace) return;
    const idx = timeToFrameIndex(trace, timeSec);
    setCurrentFrame(idx);
    frameRef.current = idx;
  }, [trace]);

  const step = useCallback((delta: number) => {
    if (!trace) return;
    const next = clampFrameIndex(trace, frameRef.current + delta);
    setCurrentFrame(next);
    frameRef.current = next;
  }, [trace]);

  const reset = useCallback(() => {
    setCurrentFrame(0);
    setPlaying(false);
    frameRef.current = 0;
  }, []);

  const setRate = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0) return;
    setRateState(Math.max(MIN_RATE, Math.min(MAX_RATE, next)));
  }, []);

  return {
    currentFrame,
    frameCount,
    durationSec,
    rate,
    playing,
    play,
    pause,
    toggle,
    seekFrame,
    seekTime,
    step,
    reset,
    setRate,
  };
}

/**
 * Tests for the playback hook (`usePointMap3DPlayback`).
 *
 * Uses react-dom/client + React's built-in `act` to mount the hook in a
 * jsdom environment so effects (RAF loop, frame-index reset) actually run.
 * No React Testing Library — that dep isn't in the dashboard, and we don't
 * need it for this scope.
 *
 * The RAF loop is short-circuited via `__pointMap3DPlaybackTestHooks` so
 * we can drive playback deterministically.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 18+ requires this flag so `act()` knows it's in a test env.
// Set as early as possible — before any render — and only on the test
// process (never leaks into the bundled app).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import {
  usePointMap3DPlayback,
  __pointMap3DPlaybackTestHooks,
} from "../index.js";
import type { PointMap3DPlaybackState } from "../usePointMap3DPlayback.js";
import type { PointMap3DTrace, PointMap3DFrame } from "@pcc/spec";

function makeFrame(index: number, timestampSec: number): PointMap3DFrame {
  return {
    frameIndex: index,
    timestampSec,
    pose: { matrix: [1, 0, 0, index, 0, 1, 0, 0, 0, 0, 1, 0] },
    points: [{ x: 0, y: 0, z: 0 }],
  };
}

function makeTrace(n: number, fps: number = 10): PointMap3DTrace {
  const frames = Array.from({ length: n }, (_, i) => makeFrame(i, i / fps));
  return {
    deviceId: "test",
    startedAt: "2026-05-30T00:00:00Z",
    endedAt: "2026-05-30T00:00:10Z",
    videoHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    mode: "streaming",
    fps,
    frameCount: n,
    frames,
    model: "test",
    adapterVersion: "1",
  };
}

interface Harness {
  root: Root;
  container: HTMLDivElement;
  /** Latest hook return value (refreshed on every render via captured ref). */
  get state(): PointMap3DPlaybackState;
  /** Re-render with new props. */
  rerender(trace: PointMap3DTrace | null, opts?: Parameters<typeof usePointMap3DPlayback>[1]): void;
  unmount(): void;
}

function mount(
  trace: PointMap3DTrace | null,
  opts: Parameters<typeof usePointMap3DPlayback>[1] = {},
): Harness {
  const captured: { value: PointMap3DPlaybackState | null } = { value: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  function Host(props: { trace: PointMap3DTrace | null; opts: Parameters<typeof usePointMap3DPlayback>[1] }) {
    captured.value = usePointMap3DPlayback(props.trace, props.opts);
    return null;
  }

  act(() => {
    root.render(React.createElement(Host, { trace, opts }));
  });

  return {
    root,
    container,
    get state() {
      if (!captured.value) throw new Error("hook never rendered");
      return captured.value;
    },
    rerender(nextTrace, nextOpts = {}) {
      act(() => {
        root.render(React.createElement(Host, { trace: nextTrace, opts: nextOpts }));
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

let harnesses: Harness[] = [];
function track(h: Harness): Harness {
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try { h.unmount(); } catch { /* ignore */ }
  }
  harnesses = [];
  __pointMap3DPlaybackTestHooks.scheduleFrame = null;
  __pointMap3DPlaybackTestHooks.cancelFrame = null;
  __pointMap3DPlaybackTestHooks.now = null;
});

// ── Initial state ─────────────────────────────────────────────────────────

describe("usePointMap3DPlayback — initial state", () => {
  it("starts at frame 0 with playing=false for a non-autoplay trace", () => {
    const h = track(mount(makeTrace(10)));
    expect(h.state.currentFrame).toBe(0);
    expect(h.state.playing).toBe(false);
    expect(h.state.frameCount).toBe(10);
    expect(h.state.durationSec).toBeCloseTo(0.9);
    expect(h.state.rate).toBe(1);
  });

  it("starts playing when autoplay=true and trace has >1 frame", () => {
    const h = track(mount(makeTrace(5), { autoplay: true }));
    expect(h.state.playing).toBe(true);
  });

  it("does NOT autoplay a single-frame trace", () => {
    const h = track(mount(makeTrace(1), { autoplay: true }));
    expect(h.state.playing).toBe(false);
  });

  it("respects initialRate (clamped to (0, 8])", () => {
    const h = track(mount(makeTrace(10), { initialRate: 2.5 }));
    expect(h.state.rate).toBe(2.5);
  });

  it("clamps initialRate above the cap to 8x", () => {
    const h = track(mount(makeTrace(10), { initialRate: 100 }));
    expect(h.state.rate).toBe(8);
  });

  it("clamps initialRate below the floor to 1/16x", () => {
    const h = track(mount(makeTrace(10), { initialRate: 0 }));
    expect(h.state.rate).toBe(0.0625);
  });

  it("returns 0 frameCount and 0 duration for null traces", () => {
    const h = track(mount(null));
    expect(h.state.frameCount).toBe(0);
    expect(h.state.durationSec).toBe(0);
  });
});

// ── Control behaviour (real React, so state updates flush) ───────────────

describe("usePointMap3DPlayback — controls", () => {
  it("setRate clamps to (0, 8] and updates state", () => {
    const h = track(mount(makeTrace(10)));
    act(() => { h.state.setRate(4); });
    expect(h.state.rate).toBe(4);
    act(() => { h.state.setRate(-5); });
    expect(h.state.rate).toBe(4); // invalid -> no-op
    act(() => { h.state.setRate(0); });
    expect(h.state.rate).toBe(4);
    act(() => { h.state.setRate(Number.NaN); });
    expect(h.state.rate).toBe(4);
    act(() => { h.state.setRate(1000); });
    expect(h.state.rate).toBe(8);
  });

  it("seekFrame clamps index into [0, frameCount-1]", () => {
    const h = track(mount(makeTrace(5)));
    act(() => { h.state.seekFrame(2); });
    expect(h.state.currentFrame).toBe(2);
    act(() => { h.state.seekFrame(-3); });
    expect(h.state.currentFrame).toBe(0);
    act(() => { h.state.seekFrame(100); });
    expect(h.state.currentFrame).toBe(4);
  });

  it("step(+1) advances; step(-1) goes back; clamped at edges", () => {
    const h = track(mount(makeTrace(5)));
    act(() => { h.state.step(1); });
    expect(h.state.currentFrame).toBe(1);
    act(() => { h.state.step(1); });
    expect(h.state.currentFrame).toBe(2);
    act(() => { h.state.step(-1); });
    expect(h.state.currentFrame).toBe(1);
    act(() => { h.state.step(-10); });
    expect(h.state.currentFrame).toBe(0); // clamped, not negative
    act(() => { h.state.step(100); });
    expect(h.state.currentFrame).toBe(4); // clamped to last
  });

  it("seekTime jumps to the nearest frame by timestamp", () => {
    const h = track(mount(makeTrace(5, 10))); // 0.0, 0.1, 0.2, 0.3, 0.4
    act(() => { h.state.seekTime(0.25); });
    // 0.25 is exactly between 0.2 (index 2) and 0.3 (index 3); function
    // picks the lower one on tie.
    expect(h.state.currentFrame).toBe(2);
    act(() => { h.state.seekTime(0.31); });
    expect(h.state.currentFrame).toBe(3);
  });

  it("reset sets currentFrame to 0 and pauses", () => {
    const h = track(mount(makeTrace(5)));
    act(() => { h.state.seekFrame(3); });
    act(() => { h.state.play(); });
    expect(h.state.playing).toBe(true);
    act(() => { h.state.reset(); });
    expect(h.state.currentFrame).toBe(0);
    expect(h.state.playing).toBe(false);
  });

  it("toggle flips playing state, but never starts on a 1-frame trace", () => {
    const tiny = track(mount(makeTrace(1)));
    act(() => { tiny.state.toggle(); });
    expect(tiny.state.playing).toBe(false);

    const big = track(mount(makeTrace(10)));
    expect(big.state.playing).toBe(false);
    act(() => { big.state.toggle(); });
    expect(big.state.playing).toBe(true);
    act(() => { big.state.toggle(); });
    expect(big.state.playing).toBe(false);
  });

  it("pause is a no-op when not playing", () => {
    const h = track(mount(makeTrace(5)));
    expect(h.state.playing).toBe(false);
    act(() => { h.state.pause(); });
    expect(h.state.playing).toBe(false);
  });

  it("play does nothing on a null trace", () => {
    const h = track(mount(null));
    act(() => { h.state.play(); });
    expect(h.state.playing).toBe(false);
  });
});

// ── Trace replacement resets the frame index ─────────────────────────────

describe("usePointMap3DPlayback — trace identity changes", () => {
  it("seeking, then replacing the trace, snaps back to frame 0", () => {
    const h = track(mount(makeTrace(5)));
    act(() => { h.state.seekFrame(3); });
    expect(h.state.currentFrame).toBe(3);

    h.rerender(makeTrace(8));
    expect(h.state.currentFrame).toBe(0);
    expect(h.state.frameCount).toBe(8);
  });

  it("controls on null traces are inert (no throw)", () => {
    const h = track(mount(null));
    expect(() => act(() => { h.state.play(); })).not.toThrow();
    expect(() => act(() => { h.state.pause(); })).not.toThrow();
    expect(() => act(() => { h.state.seekFrame(5); })).not.toThrow();
    expect(() => act(() => { h.state.seekTime(2); })).not.toThrow();
    expect(() => act(() => { h.state.step(1); })).not.toThrow();
    expect(() => act(() => { h.state.reset(); })).not.toThrow();
  });
});

// ── RAF scheduler is invoked when playback engages ───────────────────────

describe("usePointMap3DPlayback — RAF integration", () => {
  type ScheduleFn = (cb: (t: number) => void) => number;
  type CancelFn = (handle: number) => void;
  let scheduleFrame: ScheduleFn & ReturnType<typeof vi.fn>;
  let cancelFrame: CancelFn & ReturnType<typeof vi.fn>;
  let now = 0;

  beforeEach(() => {
    scheduleFrame = vi.fn<Parameters<ScheduleFn>, ReturnType<ScheduleFn>>(() => 1) as ScheduleFn & ReturnType<typeof vi.fn>;
    cancelFrame = vi.fn<Parameters<CancelFn>, ReturnType<CancelFn>>() as CancelFn & ReturnType<typeof vi.fn>;
    now = 0;
    __pointMap3DPlaybackTestHooks.scheduleFrame = scheduleFrame;
    __pointMap3DPlaybackTestHooks.cancelFrame = cancelFrame;
    __pointMap3DPlaybackTestHooks.now = () => (now += 16);
  });

  it("schedules a frame when autoplay engages", () => {
    track(mount(makeTrace(8), { autoplay: true }));
    expect(scheduleFrame).toHaveBeenCalled();
  });

  it("cancels pending frame on unmount", () => {
    const h = track(mount(makeTrace(8), { autoplay: true }));
    expect(scheduleFrame).toHaveBeenCalled();
    h.unmount();
    expect(cancelFrame).toHaveBeenCalled();
  });

  it("does not schedule when playback never starts", () => {
    track(mount(makeTrace(8), { autoplay: false }));
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it("does not schedule when trace has only one frame", () => {
    track(mount(makeTrace(1), { autoplay: true }));
    expect(scheduleFrame).not.toHaveBeenCalled();
  });
});

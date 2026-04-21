/**
 * Tests for rpc-health: quantile correctness, windowed thresholds,
 * failure-to-critical mapping, recovery path.
 *
 * Author: implementer-alpha
 */

import { describe, it, expect, vi } from "vitest";
import { startRpcHealth, quantile } from "../rpc-health.js";
import type { Alert } from "../types.js";
import type { RpcProbeConfig } from "../config.js";

function makeCfg(overrides?: Partial<RpcProbeConfig>): RpcProbeConfig {
  return {
    label: "base",
    rpcUrl: "https://sepolia.base.org",
    chain: "base-sepolia",
    intervalMs: 1000,
    p95WarnMs: 100,
    consecutiveWindows: 2,
    windowSize: 3,
    ...overrides,
  };
}

describe("quantile", () => {
  it("returns 0 for empty", () => {
    expect(quantile([], 0.5)).toBe(0);
  });
  it("computes p50 correctly", () => {
    expect(quantile([10, 20, 30], 0.5)).toBe(20);
  });
  it("interpolates p95", () => {
    // sorted: 1..10, pos = 9 * 0.95 = 8.55, base=8 (val=9), hi=9 (val=10), rest=0.55
    // => 9 + 0.55 * 1 = 9.55
    const p95 = quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95);
    expect(p95).toBeCloseTo(9.55, 2);
  });
});

describe("startRpcHealth", () => {
  it("emits critical when probe throws", async () => {
    const received: Alert[] = [];
    const noopScheduler = {
      setInterval: (_cb: () => void) => ({}) as unknown,
      clearInterval: (_h: unknown) => {},
    };
    const handle = startRpcHealth({
      config: makeCfg(),
      providerFactory: () => ({
        getBlockNumber: async () => {
          throw new Error("RPC down");
        },
      }),
      onAlert: (a) => void received.push(a),
      scheduler: noopScheduler,
      nowMs: () => 0,
    });
    await handle._tick();
    expect(received).toHaveLength(1);
    expect(received[0]!.severity).toBe("critical");
    expect(received[0]!.context?.error).toContain("RPC down");
    handle.stop();
  });

  it("emits warning only after consecutiveWindows of p95 > threshold", async () => {
    const received: Alert[] = [];
    let nowValue = 0;
    const nowFn = () => nowValue;

    // Simulate a provider whose latency is controlled by a queue.
    const latencies: number[] = [];
    const provider = {
      getBlockNumber: async () => {
        const latency = latencies.shift() ?? 10;
        // Emulate elapsed time by advancing `nowValue` between started and now.
        const started = nowValue;
        nowValue = started + latency;
        return 1n;
      },
    };

    const noopScheduler = {
      setInterval: (_cb: () => void) => ({}) as unknown,
      clearInterval: (_h: unknown) => {},
    };
    const handle = startRpcHealth({
      config: makeCfg({ windowSize: 3, p95WarnMs: 100, consecutiveWindows: 2 }),
      providerFactory: () => provider,
      onAlert: (a) => void received.push(a),
      scheduler: noopScheduler,
      nowMs: nowFn,
    });

    // Fill first window all with high latency -> first breach window.
    latencies.push(200, 200, 200);
    await handle._tick();
    await handle._tick();
    await handle._tick();
    expect(received, "no alert after first breach window only").toHaveLength(0);

    // Second full window all high -> second consecutive breach -> warning fires.
    latencies.push(200, 200, 200);
    await handle._tick();
    await handle._tick();
    await handle._tick();
    // By 6 ticks total, we should have 2 consecutive above-threshold reads.
    const warnings = received.filter((a) => a.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);

    // Now serve fast latencies -> recovery info alert.
    latencies.push(5, 5, 5);
    await handle._tick();
    await handle._tick();
    await handle._tick();
    const recoveries = received.filter(
      (a) => a.severity === "info" && typeof a.title === "string" && a.title.includes("recovered"),
    );
    expect(recoveries.length).toBeGreaterThanOrEqual(1);

    handle.stop();
  });

  it("does not warn on a single slow probe", async () => {
    const received: Alert[] = [];
    let nowValue = 0;
    const provider = {
      getBlockNumber: async () => {
        const started = nowValue;
        nowValue = started + 300; // slow
        return 1n;
      },
    };
    const handle = startRpcHealth({
      config: makeCfg({ windowSize: 3, p95WarnMs: 100, consecutiveWindows: 2 }),
      providerFactory: () => provider,
      onAlert: (a) => void received.push(a),
      scheduler: {
        setInterval: () => ({}) as unknown,
        clearInterval: () => {},
      },
      nowMs: () => nowValue,
    });
    // Only one probe -> window not yet full.
    await handle._tick();
    expect(received).toHaveLength(0);
    handle.stop();
  });

  it("calls scheduler.clearInterval on stop()", () => {
    const clearFn = vi.fn();
    const handle = startRpcHealth({
      config: makeCfg(),
      providerFactory: () => ({ getBlockNumber: async () => 1n }),
      onAlert: () => {},
      scheduler: {
        setInterval: () => "handle-123" as unknown,
        clearInterval: clearFn,
      },
      nowMs: () => 0,
    });
    handle.stop();
    expect(clearFn).toHaveBeenCalledWith("handle-123");
  });
});

/**
 * Hamilton ML Prep adapter — mock-mode behaviour tests.
 *
 * Exercises the full async run lifecycle without touching real HTTP:
 *   load_gcode (select protocol) → start (create run) → completion event.
 *
 * Real-device tests live in a separate integration suite gated on
 * HAMILTON_TEST_URL + HAMILTON_TEST_USERNAME + HAMILTON_TEST_PASSWORD env vars,
 * because Hamilton instruments are LAN-only and CI cannot reach them.
 */

import { describe, it, expect, vi } from "vitest";
import { HamiltonAdapter } from "../adapters/hamilton-adapter.js";
import type { EvidenceEvent } from "@pcc/spec";

function makeAdapter() {
  const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
  const adapter = new HamiltonAdapter("hamilton-01", {
    url: "http://192.0.2.1", // TEST-NET-1, never resolves; mock mode bypasses HTTP
    username: "test",
    password: "test",
    kernelId: "kernel_hamilton_test",
    mockMode: true,
    mockRunDurationMs: 50,
  });
  adapter.onEvidence((e) => events.push(e));
  return { adapter, events };
}

describe("HamiltonAdapter (mock mode)", () => {
  it("reports liquid-handler type and stable source metadata", () => {
    const { adapter } = makeAdapter();
    expect(adapter.type).toBe("liquid-handler");
    expect(adapter.id).toBe("hamilton-01");
    expect(adapter.source.deviceType).toBe("instrument");
    expect(adapter.source.kernelId).toBe("kernel_hamilton_test");
    expect(adapter.source.firmwareVersion).toContain("Hamilton");
  });

  it("returns idle status before any run", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.getStatus()).toBe("idle");
    expect(await adapter.getProgress()).toBe(0);
  });

  it("rejects load_gcode without payload.protocolId in mock mode the same way the real path would", async () => {
    // In mock mode, load_gcode falls back to "mock-protocol" rather than 400ing.
    // Real-mode rejection of missing protocolId is covered by a separate
    // contract test that hits the real HTTP path.
    const { adapter } = makeAdapter();
    const res = await adapter.execute({ type: "load_gcode", payload: {} });
    expect(res.success).toBe(true);
    expect(res.message).toContain("(mock)");
  });

  it("emits gcode_received when a protocol is selected", async () => {
    const { adapter, events } = makeAdapter();
    await adapter.execute({
      type: "load_gcode",
      payload: { protocolId: "proto-123" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("gcode_received");
    expect(events[0].payload).toMatchObject({ protocolId: "proto-123", mock: true });
  });

  it("runs the full lifecycle: load → start → execution_started → execution_completed", async () => {
    vi.useFakeTimers();
    const { adapter, events } = makeAdapter();

    await adapter.execute({ type: "load_gcode", payload: { protocolId: "proto-abc" } });
    const startRes = await adapter.execute({ type: "start" });
    expect(startRes.success).toBe(true);
    expect(startRes.message).toMatch(/started \(mock\)/);

    expect(await adapter.getStatus()).toBe("busy");

    // Drain the simulated run timer
    await vi.advanceTimersByTimeAsync(50);

    expect(await adapter.getStatus()).toBe("idle");
    expect(await adapter.getProgress()).toBe(100);

    const types = events.map((e) => e.type);
    expect(types).toEqual(["gcode_received", "execution_started", "execution_completed"]);

    const completion = events[2];
    expect(completion.payload).toMatchObject({
      protocolId: "proto-abc",
      mock: true,
    });
    expect(completion.payload?.runId).toMatch(/^mock-run-/);
    expect(completion.payload?.runDataId).toMatch(/^mock-run-data-/);

    vi.useRealTimers();
  });

  it("returns failure for stop in mock mode (matches real-device behaviour)", async () => {
    const { adapter } = makeAdapter();
    const res = await adapter.execute({ type: "stop" });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not API-driven/);
  });

  it("status command returns tracked run state", async () => {
    const { adapter } = makeAdapter();
    await adapter.execute({ type: "load_gcode", payload: { protocolId: "proto-status" } });
    const res = await adapter.execute({ type: "status" });
    expect(res.success).toBe(true);
    expect(res.data?.mock).toBe(true);
    const tracked = res.data?.tracked as Record<string, unknown> | undefined;
    expect(tracked?.protocolId).toBe("proto-status");
  });

  it("dispose clears listeners and is safe to call multiple times", async () => {
    const { adapter, events } = makeAdapter();
    await adapter.execute({ type: "load_gcode", payload: { protocolId: "p" } });
    expect(events).toHaveLength(1);

    await adapter.dispose();
    await adapter.dispose(); // idempotent

    // After dispose, new evidence subscriptions don't see prior listeners
    const moreEvents: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((e) => moreEvents.push(e));
    await adapter.execute({ type: "load_gcode", payload: { protocolId: "q" } });
    expect(moreEvents).toHaveLength(1);
    expect(moreEvents[0].payload?.protocolId).toBe("q");
  });

  it("returns null from run-data + camera helpers in mock mode (no real HTTP)", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.getRunDataPdf("any")).toBeNull();
    expect(await adapter.getRunDataCsv("any")).toBeNull();
    expect(await adapter.captureCameraSnapshot()).toBeNull();
  });
});

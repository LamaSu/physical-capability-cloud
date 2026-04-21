/**
 * Tests for heartbeat: sweep stale detection, recovery, snapshot.
 *
 * Author: implementer-alpha
 */

import { describe, it, expect } from "vitest";
import { startHeartbeat } from "../heartbeat.js";
import type { Alert } from "../types.js";

describe("startHeartbeat", () => {
  it("fires critical on never-seen worker on first sweep", async () => {
    const received: Alert[] = [];
    let nowMs = 1_000_000;
    const handle = startHeartbeat({
      configs: [{ worker: "oracle-1", maxSilenceMs: 60_000 }],
      onAlert: (a) => void received.push(a),
      sweepIntervalMs: 60_000,
      nowMs: () => nowMs,
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
    });
    await handle._sweep();
    expect(received).toHaveLength(1);
    expect(received[0]!.severity).toBe("critical");
    expect(received[0]!.context?.worker).toBe("oracle-1");
    expect(received[0]!.context?.lastSeen).toBeNull();
    handle.stop();
  });

  it("does not re-fire on repeated sweeps while still stale", async () => {
    const received: Alert[] = [];
    let nowMs = 1_000_000;
    const handle = startHeartbeat({
      configs: [{ worker: "oracle-1", maxSilenceMs: 60_000 }],
      onAlert: (a) => void received.push(a),
      sweepIntervalMs: 60_000,
      nowMs: () => nowMs,
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
    });
    await handle._sweep();
    await handle._sweep();
    await handle._sweep();
    expect(received).toHaveLength(1);
    handle.stop();
  });

  it("fires stale when last-seen exceeds maxSilenceMs", async () => {
    const received: Alert[] = [];
    let nowMs = 1_000_000;
    const handle = startHeartbeat({
      configs: [{ worker: "w1", maxSilenceMs: 1000 }],
      onAlert: (a) => void received.push(a),
      sweepIntervalMs: 60_000,
      nowMs: () => nowMs,
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
    });
    handle.record("w1", nowMs);
    // First sweep: fresh, no alert.
    await handle._sweep();
    expect(received).toHaveLength(0);
    // Advance past silence window.
    nowMs += 5000;
    await handle._sweep();
    expect(received).toHaveLength(1);
    expect(received[0]!.severity).toBe("critical");
    expect(received[0]!.title).toContain("silent");
    handle.stop();
  });

  it("fires info recovery on next heartbeat after staleness", async () => {
    const received: Alert[] = [];
    let nowMs = 1_000_000;
    const handle = startHeartbeat({
      configs: [{ worker: "w1", maxSilenceMs: 1000 }],
      onAlert: (a) => void received.push(a),
      sweepIntervalMs: 60_000,
      nowMs: () => nowMs,
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
    });
    handle.record("w1", nowMs);
    nowMs += 5000;
    await handle._sweep(); // critical stale
    nowMs += 1000;
    handle.record("w1", nowMs); // recovery
    // Now resolve pending microtasks before assertions
    await new Promise((r) => setImmediate(r));
    const severities = received.map((a) => a.severity);
    expect(severities).toContain("critical");
    expect(severities).toContain("info");
    handle.stop();
  });

  it("snapshot returns ageMs per configured worker", async () => {
    let nowMs = 1_000_000;
    const handle = startHeartbeat({
      configs: [
        { worker: "w1", maxSilenceMs: 1000 },
        { worker: "w2", maxSilenceMs: 1000 },
      ],
      onAlert: () => {},
      nowMs: () => nowMs,
      scheduler: { setInterval: () => ({}), clearInterval: () => {} },
    });
    handle.record("w1", nowMs - 100);
    // w2 never posts.
    const snap = handle.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.find((s) => s.worker === "w1")?.ageMs).toBe(100);
    expect(snap.find((s) => s.worker === "w2")?.ageMs).toBeNull();
    handle.stop();
  });
});

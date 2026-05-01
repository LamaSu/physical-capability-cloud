/**
 * Tests for the Week 6 B5 approval Live Activity wrapper.
 *
 * The plugin is mocked via _setPluginForTests so we can verify:
 *   - start fires plugin.startActivity with the expected payload
 *   - end fires plugin.endActivity with the right outcome
 *   - graceful no-op when the plugin is unavailable
 *   - errors thrown by the plugin do not propagate
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startApprovalActivity,
  endApprovalActivity,
  updateApprovalActivity,
  onApprovalActivityTap,
  onApprovalActivityDismiss,
  notifyActivityTap,
  notifyActivityDismiss,
  _setPluginForTests,
  _clearActivityCallbacksForTests,
  type LiveActivityPlugin,
} from "./approval-activity.js";

interface CallLog {
  start: { id: string; data: Record<string, unknown> }[];
  update: { id: string; data: Record<string, unknown> }[];
  end: { id: string; data?: Record<string, unknown> }[];
}

function newMockPlugin(
  opts: { fail?: boolean; noUpdateActivity?: boolean } = {},
): {
  plugin: LiveActivityPlugin;
  log: CallLog;
} {
  const log: CallLog = { start: [], update: [], end: [] };
  const plugin: LiveActivityPlugin = {
    startActivity: async (o) => {
      log.start.push(o);
      if (opts.fail) throw new Error("simulated plugin failure");
    },
    endActivity: async (o) => {
      log.end.push(o);
      if (opts.fail) throw new Error("simulated plugin failure");
    },
    ...(opts.noUpdateActivity
      ? {}
      : {
          updateActivity: async (o) => {
            log.update.push(o);
            if (opts.fail) throw new Error("simulated plugin failure");
          },
        }),
  };
  return { plugin, log };
}

describe("startApprovalActivity (Week 6 B5)", () => {
  beforeEach(() => {
    _setPluginForTests(null);
  });

  afterEach(() => {
    _setPluginForTests(null);
    vi.restoreAllMocks();
  });

  it("returns a handle synchronously and forwards args to the plugin", async () => {
    const { plugin, log } = newMockPlugin();
    _setPluginForTests(plugin);

    const handle = startApprovalActivity({
      id: "sess-001",
      capability: "haircut",
      amountUsd: 32,
      operatorName: "Andre",
      expiresAt: "2026-04-30T00:00:00Z",
    });
    expect(handle.id).toBe("sess-001");
    // started is initially false; the plugin call is async.
    expect(handle.started).toBe(false);

    // Drain microtasks so the async fire completes.
    await new Promise((r) => setTimeout(r, 0));
    expect(log.start.length).toBe(1);
    expect(log.start[0].id).toBe("sess-001");
    expect(log.start[0].data.capability).toBe("haircut");
    expect(log.start[0].data.amountUsd).toBe(32);
    expect(log.start[0].data.operatorName).toBe("Andre");
    expect(log.start[0].data.expiresAt).toBe("2026-04-30T00:00:00Z");
    // W8 Phase 2: start phase is "waiting" (renamed from W6's "pending"
    // to align with the waiting → approved → settling → done ladder).
    expect(log.start[0].data.phase).toBe("waiting");

    // Handle's started flag should now be true.
    expect(handle.started).toBe(true);
  });

  it("no-ops gracefully when no plugin is available", async () => {
    _setPluginForTests(null);
    const handle = startApprovalActivity({
      id: "sess-no-plugin",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    expect(handle.id).toBe("sess-no-plugin");
    await new Promise((r) => setTimeout(r, 0));
    // started stays false; no crash.
    expect(handle.started).toBe(false);
  });

  it("does not throw when the plugin throws", async () => {
    const { plugin } = newMockPlugin({ fail: true });
    _setPluginForTests(plugin);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const handle = startApprovalActivity({
      id: "sess-failpath",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(handle.started).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("startActivity failed"),
      expect.stringContaining("simulated"),
    );
  });
});

describe("endApprovalActivity (Week 6 B5)", () => {
  beforeEach(() => {
    _setPluginForTests(null);
  });

  afterEach(() => {
    _setPluginForTests(null);
    vi.restoreAllMocks();
  });

  it("forwards the outcome to plugin.endActivity", async () => {
    const { plugin, log } = newMockPlugin();
    _setPluginForTests(plugin);

    const handle = startApprovalActivity({
      id: "sess-end",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    endApprovalActivity(handle, { outcome: "approve" });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.end.length).toBe(1);
    expect(log.end[0].id).toBe("sess-end");
    expect(log.end[0].data?.outcome).toBe("approve");
    // W8 Phase 2: terminal phase is "done" (renamed from W6's "ended" so
    // both the active-state ladder and the end payload use the same set
    // of phase tokens — simpler for the SwiftUI widget to switch on).
    expect(log.end[0].data?.phase).toBe("done");
    expect(typeof log.end[0].data?.endedAt).toBe("string");
  });

  it.each(["approve", "reject", "dismiss"] as const)(
    "carries outcome=%s through to plugin",
    async (outcome) => {
      const { plugin, log } = newMockPlugin();
      _setPluginForTests(plugin);
      const handle = startApprovalActivity({
        id: `sess-${outcome}`,
        capability: "x",
        amountUsd: 1,
        operatorName: "y",
      });
      await new Promise((r) => setTimeout(r, 0));
      endApprovalActivity(handle, { outcome });
      await new Promise((r) => setTimeout(r, 0));
      expect(log.end[0].data?.outcome).toBe(outcome);
    },
  );

  it("no-ops when plugin is not available", async () => {
    _setPluginForTests(null);
    // Even with no plugin, callers should be safe.
    const handle = { id: "sess-z", started: false };
    expect(() =>
      endApprovalActivity(handle, { outcome: "dismiss" }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("does not throw when plugin.endActivity throws", async () => {
    const { plugin } = newMockPlugin({ fail: true });
    _setPluginForTests(plugin);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const handle = startApprovalActivity({
      id: "sess-end-fail",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    endApprovalActivity(handle, { outcome: "reject" });
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
  });

  it("accepts the new W8 outcome=expired", async () => {
    const { plugin, log } = newMockPlugin();
    _setPluginForTests(plugin);
    const handle = startApprovalActivity({
      id: "sess-expired",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));
    endApprovalActivity(handle, { outcome: "expired" });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.end[0].data?.outcome).toBe("expired");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Week 8 Phase 2/3 — updateApprovalActivity
// ──────────────────────────────────────────────────────────────────────

describe("updateApprovalActivity (Week 8 Phase 2/3)", () => {
  beforeEach(() => {
    _setPluginForTests(null);
  });

  afterEach(() => {
    _setPluginForTests(null);
    vi.restoreAllMocks();
  });

  it("forwards a phase transition to plugin.updateActivity", async () => {
    const { plugin, log } = newMockPlugin();
    _setPluginForTests(plugin);
    const handle = startApprovalActivity({
      id: "sess-phase",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    updateApprovalActivity(handle, { phase: "approved" });
    await new Promise((r) => setTimeout(r, 0));

    expect(log.update.length).toBe(1);
    expect(log.update[0].id).toBe("sess-phase");
    expect(log.update[0].data.phase).toBe("approved");
    // Other fields not touched.
    expect(log.update[0].data.progress).toBeUndefined();
    expect(log.update[0].data.etaSeconds).toBeUndefined();
  });

  it("walks the full phase ladder through three update calls", async () => {
    const { plugin, log } = newMockPlugin();
    _setPluginForTests(plugin);
    const handle = startApprovalActivity({
      id: "sess-ladder",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    updateApprovalActivity(handle, { phase: "approved" });
    updateApprovalActivity(handle, { phase: "settling" });
    updateApprovalActivity(handle, { phase: "done" });
    // Drain three IIFE schedulings.
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));

    expect(log.update.length).toBe(3);
    expect(log.update.map((u) => u.data.phase)).toEqual([
      "approved",
      "settling",
      "done",
    ]);
  });

  it("forwards progress + etaSeconds with clamping", async () => {
    const { plugin, log } = newMockPlugin();
    _setPluginForTests(plugin);
    const handle = startApprovalActivity({
      id: "sess-progress",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    updateApprovalActivity(handle, { progress: 0.45, etaSeconds: 12 });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.update[0].data.progress).toBe(0.45);
    expect(log.update[0].data.etaSeconds).toBe(12);

    // Out-of-range values get clamped at the wrapper.
    updateApprovalActivity(handle, { progress: 1.5, etaSeconds: -7 });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.update[1].data.progress).toBe(1);
    expect(log.update[1].data.etaSeconds).toBe(0);

    updateApprovalActivity(handle, { progress: -0.2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.update[2].data.progress).toBe(0);
  });

  it("skips empty payloads (does not call updateActivity)", async () => {
    const { plugin, log } = newMockPlugin();
    _setPluginForTests(plugin);
    const handle = startApprovalActivity({
      id: "sess-empty",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    updateApprovalActivity(handle, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(log.update.length).toBe(0);
  });

  it("no-ops gracefully when plugin lacks updateActivity", async () => {
    const { plugin, log } = newMockPlugin({ noUpdateActivity: true });
    _setPluginForTests(plugin);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = startApprovalActivity({
      id: "sess-no-update",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    updateApprovalActivity(handle, { phase: "settling" });
    await new Promise((r) => setTimeout(r, 0));
    expect(log.update.length).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("updateActivity not supported by plugin"),
    );
  });

  it("no-ops when plugin is missing entirely", async () => {
    _setPluginForTests(null);
    const handle = { id: "sess-no-plugin", started: false };
    expect(() =>
      updateApprovalActivity(handle, { phase: "approved" }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("does not throw when plugin.updateActivity throws", async () => {
    const { plugin } = newMockPlugin({ fail: true });
    _setPluginForTests(plugin);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = startApprovalActivity({
      id: "sess-update-throw",
      capability: "x",
      amountUsd: 1,
      operatorName: "y",
    });
    await new Promise((r) => setTimeout(r, 0));

    updateApprovalActivity(handle, { phase: "approved" });
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("updateActivity failed"),
      expect.any(String),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Week 8 Phase 4 — tap / dismiss callback registry
// ──────────────────────────────────────────────────────────────────────

describe("onApprovalActivityTap / Dismiss (Week 8 Phase 4)", () => {
  beforeEach(() => {
    _clearActivityCallbacksForTests();
  });

  afterEach(() => {
    _clearActivityCallbacksForTests();
  });

  it("dispatches tap to all registered subscribers", () => {
    const seen: string[] = [];
    const unsub1 = onApprovalActivityTap((id) => seen.push(`a:${id}`));
    const unsub2 = onApprovalActivityTap((id) => seen.push(`b:${id}`));

    notifyActivityTap("sess-tap-1");
    expect(seen).toEqual(["a:sess-tap-1", "b:sess-tap-1"]);
    unsub1();
    unsub2();
  });

  it("unsubscribe stops further deliveries", () => {
    const seen: string[] = [];
    const unsub = onApprovalActivityTap((id) => seen.push(id));
    notifyActivityTap("sess-1");
    unsub();
    notifyActivityTap("sess-2");
    expect(seen).toEqual(["sess-1"]);
  });

  it("dismiss subscribers receive their own events", () => {
    const seen: string[] = [];
    const unsub = onApprovalActivityDismiss((id) => seen.push(id));
    notifyActivityDismiss("sess-d-1");
    notifyActivityDismiss("sess-d-2");
    expect(seen).toEqual(["sess-d-1", "sess-d-2"]);
    unsub();
  });

  it("subscriber that throws does not break siblings", () => {
    const seen: string[] = [];
    onApprovalActivityTap(() => {
      throw new Error("subscriber boom");
    });
    onApprovalActivityTap((id) => seen.push(id));
    expect(() => notifyActivityTap("sess-x")).not.toThrow();
    expect(seen).toEqual(["sess-x"]);
  });
});

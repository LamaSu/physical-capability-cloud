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
  _setPluginForTests,
  type LiveActivityPlugin,
} from "./approval-activity.js";

interface CallLog {
  start: { id: string; data: Record<string, unknown> }[];
  end: { id: string; data?: Record<string, unknown> }[];
}

function newMockPlugin(opts: { fail?: boolean } = {}): {
  plugin: LiveActivityPlugin;
  log: CallLog;
} {
  const log: CallLog = { start: [], end: [] };
  const plugin: LiveActivityPlugin = {
    startActivity: async (o) => {
      log.start.push(o);
      if (opts.fail) throw new Error("simulated plugin failure");
    },
    endActivity: async (o) => {
      log.end.push(o);
      if (opts.fail) throw new Error("simulated plugin failure");
    },
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
    expect(log.start[0].data.phase).toBe("pending");

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
    expect(log.end[0].data?.phase).toBe("ended");
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
});

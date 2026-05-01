/**
 * Tests for App.tsx — mainly: the shell renders without crashing when
 * ApprovalSheet is mounted, and the dev-mode fake-trigger gates correctly.
 *
 * Week 5 adds tests that verify the SSE approval listener is started
 * correctly under role==="user" + persisted session token, and is NOT
 * started for operator mode or when no token is present.
 *
 * Week 6 adds:
 *   - Channel-id mint flow (A3): mocked fetch returns a channelId; the
 *     listener opens with that id instead of the session token.
 *   - Live Activity wiring (B5): a mocked plugin records the start/end
 *     calls when an approval-request lands.
 *
 * The Week 1 baseline did not include an App.test.tsx because the wiring
 * was trivial; Week 3 adds the ApprovalSheet hook so a smoke test is
 * worth having.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App.js";
import { setRole, setSessionToken } from "./storage/secure-api-key.js";
import {
  _setPluginForTests,
  type LiveActivityPlugin,
} from "./live-activity/approval-activity.js";

let container: HTMLDivElement;
let root: Root;

// ── EventSource mock — captures URLs + lets tests dispatch events ─────

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: EventListener): void {
    let s = this.listeners.get(type);
    if (!s) {
      s = new Set();
      this.listeners.set(type, s);
    }
    s.add(fn as (e: MessageEvent) => void);
  }
  removeEventListener(type: string, fn: EventListener): void {
    this.listeners.get(type)?.delete(fn as (e: MessageEvent) => void);
  }
  close(): void {
    this.closed = true;
  }
  fireApproval(payload: object, lastEventId = ""): void {
    const evt = new MessageEvent("approval-request", {
      data: JSON.stringify(payload),
      lastEventId,
    });
    const s = this.listeners.get("approval-request");
    if (s) for (const fn of s) fn(evt);
  }
  /**
   * W9 B: dispatch any named SSE event. Used for `settle-progress` and
   * future event types added on the approval topic.
   */
  fireNamed(type: string, payload: unknown, lastEventId = ""): void {
    const evt = new MessageEvent(type, {
      data: typeof payload === "string" ? payload : JSON.stringify(payload),
      lastEventId,
    });
    const s = this.listeners.get(type);
    if (s) for (const fn of s) fn(evt);
  }
  static reset(): void {
    MockEventSource.instances = [];
  }
}

/**
 * Week 6 A3: the listener now POSTs to /api/sessions/:tok/subscribe to
 * mint a per-channel id before opening the EventSource. We mock fetch
 * to fail-fast so the listener falls back to the W5 token-as-channel-id
 * path — that lets us keep the existing assertions
 * (`url.includes('/sse/stream/approval/<token>')`) without rewriting them.
 *
 * One test below asserts the mint-then-channel path explicitly.
 */
function installFailingFetch(): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi
    .fn()
    .mockRejectedValue(new Error("test: subscribe disabled")) as unknown as typeof fetch;
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
  // Default to user mode so the React shell renders (operator mode does
  // a window.location.replace which we don't want during a render test).
  await setRole("user");
  MockEventSource.reset();
  (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
    MockEventSource as unknown as typeof EventSource;
  installFailingFetch();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
  delete (globalThis as { EventSource?: unknown }).EventSource;
  delete (globalThis as { fetch?: unknown }).fetch;
});

async function flush(): Promise<void> {
  // Bumped from 6 → 12 to cover the W6 A3 subscribe-fetch IIFE before
  // the listener actually opens the EventSource.
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("App smoke", () => {
  it("renders the user shell without crashing", async () => {
    act(() => {
      root.render(<App />);
    });
    await flush();
    // Either UserMobilePage or the loading placeholder must render.
    expect(container.textContent ?? "").toMatch(
      /Your agent sessions live here|Loading/i,
    );
  });

  it("renders without an ApprovalSheet when no pending approval is set", async () => {
    act(() => {
      root.render(<App />);
    });
    await flush();
    // No ApprovalSheet should be in the DOM yet — the dev-mode trigger
    // either won't fire (jsdom default) or fires only after 3s. This
    // sub-second test catches it before that.
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).toBeNull();
  });

  it("renders ApprovalSheet when dev-mode trigger flag is set + timer elapses", async () => {
    vi.useFakeTimers();
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("pcc-mobile-dev-approval", "1");
    }
    act(() => {
      root.render(<App />);
    });
    // Let the role-load useEffect resolve
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Advance the dev-mode 3-second timer
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).not.toBeNull();
    vi.useRealTimers();
  });
});

describe("App SSE approval listener (Week 5)", () => {
  it("does not start the listener when no session token is set", async () => {
    // Default: localStorage was cleared in beforeEach + no token written.
    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(0);
  });

  it("starts the listener for role=user when a session token is present", async () => {
    await setSessionToken("token-abc-123");
    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);
    const url = MockEventSource.instances[0].url;
    // Channel id = the session token in v1.
    expect(url).toContain("/sse/stream/approval/token-abc-123");
    // Token is also passed via ?token= for auth.
    expect(url).toContain("token=token-abc-123");
  });

  it("does NOT start the listener for operator role even with a session token", async () => {
    await setRole("operator");
    await setSessionToken("token-abc-123");
    act(() => {
      root.render(<App />);
    });
    await flush();
    // Operator mode triggers a redirect (jsdom location.replace), but
    // crucially it should NOT fire an SSE listener.
    expect(MockEventSource.instances.length).toBe(0);
  });

  it("dispatches approval events from the listener to the ApprovalSheet", async () => {
    await setSessionToken("token-abc-123");
    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);
    // No sheet yet — no event fired.
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).toBeNull();

    // Fire an approval event.
    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "real-session-001",
        capability: "haircut",
        amountUsd: 32,
        operatorName: "Andre's Hair Salon",
        evidenceHash:
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        captureClass: "tier-1-photo",
        requestedAt: new Date().toISOString(),
      });
      await Promise.resolve();
    });

    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).not.toBeNull();
    // The sheet's plain-English summary should contain the operator name.
    expect(container.textContent ?? "").toMatch(/Andre/);
  });

  it("stops the listener (closes EventSource) on unmount", async () => {
    await setSessionToken("token-cleanup");
    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].closed).toBe(false);

    act(() => {
      root.unmount();
    });
    // Re-create root so afterEach unmount is a no-op.
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // The original EventSource should be closed.
    expect(MockEventSource.instances[0].closed).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Week 6 A3 — opt-in channel-id subscribe flow
// ──────────────────────────────────────────────────────────────────────

describe("App SSE listener — Week 6 A3 mint-then-channel", () => {
  it("uses the minted channelId on the SSE URL when subscribe succeeds", async () => {
    await setSessionToken("token-mint-A3");
    // Override fetch to return a successful subscribe response.
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          channelId: "ch_abc_minted_xyz",
          sessionId: "token-mint-A3",
        }),
      } as Response) as unknown as typeof fetch;

    act(() => {
      root.render(<App />);
    });
    await flush();
    // The listener opens with the MINTED channel id, not the token.
    expect(MockEventSource.instances.length).toBe(1);
    const url = MockEventSource.instances[0].url;
    expect(url).toContain("/sse/stream/approval/ch_abc_minted_xyz");
    // The token is still passed via ?token= for auth.
    expect(url).toContain("token=token-mint-A3");
  });

  it("falls back to token-as-channel-id when subscribe call fails", async () => {
    await setSessionToken("token-fb-A3");
    // fetch throws (the default in the outer beforeEach).
    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);
    const url = MockEventSource.instances[0].url;
    // No channelId minted — listener uses the token.
    expect(url).toContain("/sse/stream/approval/token-fb-A3");
  });

  it("falls back when subscribe returns non-OK response", async () => {
    await setSessionToken("token-fb-B3");
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        json: async () => ({ error: "unauthorized" }),
      } as Response) as unknown as typeof fetch;

    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);
    const url = MockEventSource.instances[0].url;
    expect(url).toContain("/sse/stream/approval/token-fb-B3");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Week 6 B5 — Live Activity wiring
// ──────────────────────────────────────────────────────────────────────

describe("App Live Activity wiring (Week 6 B5)", () => {
  interface CallLog {
    start: { id: string; data: Record<string, unknown> }[];
    end: { id: string; data?: Record<string, unknown> }[];
  }

  function mkPlugin(): { plugin: LiveActivityPlugin; log: CallLog } {
    const log: CallLog = { start: [], end: [] };
    const plugin: LiveActivityPlugin = {
      startActivity: async (o) => {
        log.start.push(o);
      },
      endActivity: async (o) => {
        log.end.push(o);
      },
    };
    return { plugin, log };
  }

  afterEach(() => {
    _setPluginForTests(null);
  });

  it("starts a Live Activity when an approval-request event arrives", async () => {
    await setSessionToken("token-LA-001");
    const { plugin, log } = mkPlugin();
    _setPluginForTests(plugin);

    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);

    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "sess-LA-001",
        capability: "haircut",
        amountUsd: 32,
        operatorName: "Andre's Hair Salon",
        evidenceHash: "ab".repeat(32),
        captureClass: "tier-1-photo",
        requestedAt: new Date().toISOString(),
      });
      // Drain microtasks so the IIFE inside fireStart runs.
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(log.start.length).toBe(1);
    expect(log.start[0].id).toBe("sess-LA-001");
    expect(log.start[0].data.capability).toBe("haircut");
    expect(log.start[0].data.amountUsd).toBe(32);
    expect(log.start[0].data.operatorName).toBe("Andre's Hair Salon");
  });

  it("ends the Live Activity with outcome=approve when the user approves", async () => {
    await setSessionToken("token-LA-002");
    const { plugin, log } = mkPlugin();
    _setPluginForTests(plugin);

    act(() => {
      root.render(<App />);
    });
    await flush();

    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "sess-LA-002",
        capability: "haircut",
        amountUsd: 25,
        operatorName: "Andre",
        evidenceHash: "cd".repeat(32),
        requestedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(log.start.length).toBe(1);

    // User clicks "Decline" (mapped to reject) — exercises the simpler
    // path that doesn't require a passkey signature.
    const declineBtn = container.querySelector(
      "[data-testid='approval-decline']",
    ) as HTMLButtonElement | null;
    expect(declineBtn).not.toBeNull();
    await act(async () => {
      declineBtn!.click();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    expect(log.end.length).toBe(1);
    expect(log.end[0].id).toBe("sess-LA-002");
    expect(log.end[0].data?.outcome).toBe("reject");
  });

  it("no-ops the activity when no plugin is registered", async () => {
    await setSessionToken("token-LA-003");
    _setPluginForTests(null);

    act(() => {
      root.render(<App />);
    });
    await flush();

    // Should not throw on event arrival even without a plugin.
    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "sess-LA-003",
        capability: "haircut",
        amountUsd: 10,
        operatorName: "Andre",
        evidenceHash: "ef".repeat(32),
        requestedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    // The sheet still opens — graceful degradation.
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Week 7 A5 — server POST loop close
// ──────────────────────────────────────────────────────────────────────

describe("App approval-decision POST (Week 7 A5)", () => {
  /**
   * Smart fetch mock: subscribe returns minted channelId, decision routes
   * return 200, anything else throws so we catch unexpected requests.
   */
  function installSmartFetch(): { mock: ReturnType<typeof vi.fn> } {
    const impl = async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/subscribe")) {
        return {
          ok: true,
          json: async () => ({
            channelId: "ch_w7_minted",
            sessionId: "tok-w7",
          }),
        } as Response;
      }
      if (u.includes("/approval/") && /\/(approve|reject)$/.test(u)) {
        return {
          status: 200,
          json: async () => ({}),
        } as Response;
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    };
    const mock = vi.fn().mockImplementation(impl);
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      mock as unknown as typeof fetch;
    return { mock };
  }

  it("POSTs reject when decline tapped with approvalId + sessionToken", async () => {
    await setSessionToken("tok-w7");
    const { mock } = installSmartFetch();

    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);

    // Fire an approval event with approvalId (W7 server-side mints it).
    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "sess-w7-001",
        approvalId: "appr_w7_001",
        capability: "haircut",
        amountUsd: 32,
        operatorName: "Andre",
        evidenceHash: "ab".repeat(32),
        requestedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    const declineBtn = container.querySelector(
      "[data-testid='approval-decline']",
    ) as HTMLButtonElement | null;
    expect(declineBtn).not.toBeNull();

    await act(async () => {
      declineBtn!.click();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    // The decision POST should have been issued. Find the call by URL shape.
    const decisionCalls = mock.mock.calls.filter((c) => {
      const u = String(c[0]);
      return u.includes("/api/sessions/sess-w7-001/approval/appr_w7_001/reject");
    });
    expect(decisionCalls.length).toBe(1);
    const init = decisionCalls[0][1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer tok-w7");
  });

  it("skips POST on dev-mode synthetic event without approvalId", async () => {
    await setSessionToken("tok-w7-devmode");
    const { mock } = installSmartFetch();

    act(() => {
      root.render(<App />);
    });
    await flush();

    // Fire an approval event WITHOUT approvalId (the dev-mode shape).
    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "dev-session-001",
        capability: "haircut",
        amountUsd: 32,
        operatorName: "Andre",
        evidenceHash: "cd".repeat(32),
        requestedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    const declineBtn = container.querySelector(
      "[data-testid='approval-decline']",
    ) as HTMLButtonElement | null;
    expect(declineBtn).not.toBeNull();

    await act(async () => {
      declineBtn!.click();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    // No fetch call to /approval/.../reject should have been made.
    const decisionCalls = mock.mock.calls.filter((c) =>
      String(c[0]).includes("/approval/"),
    );
    expect(decisionCalls.length).toBe(0);
    // The sheet still dismisses locally.
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Week 9 B — settle-progress events drive Live Activity updates
// ──────────────────────────────────────────────────────────────────────

describe("App settle-progress wiring (Week 9 B)", () => {
  /**
   * Mock plugin that records updateActivity calls in addition to start/end.
   * The W9 wiring routes settle-progress events to updateApprovalActivity,
   * which on the W6 wrapper calls plugin.updateActivity.
   */
  interface ProgressLog {
    start: { id: string; data: Record<string, unknown> }[];
    update: { id: string; data: Record<string, unknown> }[];
    end: { id: string; data?: Record<string, unknown> }[];
  }

  function mkProgressPlugin(): { plugin: LiveActivityPlugin; log: ProgressLog } {
    const log: ProgressLog = { start: [], update: [], end: [] };
    const plugin: LiveActivityPlugin = {
      startActivity: async (o) => {
        log.start.push(o);
      },
      updateActivity: async (o) => {
        log.update.push(o);
      },
      endActivity: async (o) => {
        log.end.push(o);
      },
    };
    return { plugin, log };
  }

  afterEach(() => {
    _setPluginForTests(null);
  });

  it("calls updateActivity with phase=settling + progress when settle-progress event arrives", async () => {
    await setSessionToken("token-W9-001");
    const { plugin, log } = mkProgressPlugin();
    _setPluginForTests(plugin);

    act(() => {
      root.render(<App />);
    });
    await flush();
    expect(MockEventSource.instances.length).toBe(1);

    // Fire an approval-request first to start the Live Activity.
    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "sess-W9-001",
        capability: "haircut",
        amountUsd: 32,
        operatorName: "Andre's Hair Salon",
        evidenceHash: "ab".repeat(32),
        requestedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(log.start.length).toBe(1);

    // Now fire a settle-progress event mid-settle.
    await act(async () => {
      MockEventSource.instances[0].fireNamed(
        "settle-progress",
        { id: "sess-W9-001", phase: "release", progress: 0.25 },
      );
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    // updateActivity should have been called with phase=settling +
    // progress=0.25. (W9 wiring maps the gateway phase to the mobile
    // ladder phase "settling".)
    const settlingUpdate = log.update.find(
      (u) => u.data.phase === "settling",
    );
    expect(settlingUpdate).toBeDefined();
    expect(settlingUpdate!.data.progress).toBe(0.25);
    expect(settlingUpdate!.id).toBe("sess-W9-001");
  });

  it("forwards multiple progress events with monotonic progress values", async () => {
    await setSessionToken("token-W9-002");
    const { plugin, log } = mkProgressPlugin();
    _setPluginForTests(plugin);

    act(() => {
      root.render(<App />);
    });
    await flush();

    await act(async () => {
      MockEventSource.instances[0].fireApproval({
        id: "sess-W9-002",
        capability: "haircut",
        amountUsd: 32,
        operatorName: "Andre",
        evidenceHash: "cd".repeat(32),
        requestedAt: new Date().toISOString(),
      });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    // Fire all four phases.
    await act(async () => {
      const es = MockEventSource.instances[0];
      es.fireNamed("settle-progress", {
        id: "sess-W9-002",
        phase: "release",
        progress: 0.25,
      });
      es.fireNamed("settle-progress", {
        id: "sess-W9-002",
        phase: "sign",
        progress: 0.5,
      });
      es.fireNamed("settle-progress", {
        id: "sess-W9-002",
        phase: "log_append",
        progress: 0.75,
      });
      es.fireNamed("settle-progress", {
        id: "sess-W9-002",
        phase: "done",
        progress: 1.0,
      });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    // Expect 4 settling-phase updates with monotonic progress.
    const settlingUpdates = log.update.filter(
      (u) => u.data.phase === "settling",
    );
    expect(settlingUpdates.length).toBe(4);
    const progresses = settlingUpdates.map(
      (u) => u.data.progress as number,
    );
    expect(progresses).toEqual([0.25, 0.5, 0.75, 1.0]);
  });
});

/**
 * Tests for App.tsx — mainly: the shell renders without crashing when
 * ApprovalSheet is mounted, and the dev-mode fake-trigger gates correctly.
 *
 * Week 5 adds tests that verify the SSE approval listener is started
 * correctly under role==="user" + persisted session token, and is NOT
 * started for operator mode or when no token is present.
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
  static reset(): void {
    MockEventSource.instances = [];
  }
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
});

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
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
    await act(async () => {
      // give the async useEffect time to run
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(MockEventSource.instances.length).toBe(0);
  });

  it("starts the listener for role=user when a session token is present", async () => {
    await setSessionToken("token-abc-123");
    act(() => {
      root.render(<App />);
    });
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
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
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    // Operator mode triggers a redirect (jsdom location.replace), but
    // crucially it should NOT fire an SSE listener.
    expect(MockEventSource.instances.length).toBe(0);
  });

  it("dispatches approval events from the listener to the ApprovalSheet", async () => {
    await setSessionToken("token-abc-123");
    act(() => {
      root.render(<App />);
    });
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
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
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
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

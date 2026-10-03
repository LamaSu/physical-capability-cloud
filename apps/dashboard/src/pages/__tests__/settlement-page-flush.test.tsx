/**
 * Component interaction tests for SettlementPage — cross-family review r2 of PR #425
 * (rm-px3-425-r2-5d2615cd.astra.verdict.md, findings 3/4/5, plus the M5 flush-control
 * regressions tracked in the same pack's question 6). The page code is already fixed;
 * these tests PIN that behavior:
 *
 *   A. a double/triple confirm sends exactly one POST (the controller's synchronous
 *      in-flight guard, M5);
 *   B. a reload that fails after a successful flush never surfaces as an unhandled
 *      rejection, and the flush control recovers (M5, question 6);
 *   C. source-conformance backstop: the page routes every flush through exactly one
 *      `createFlushController` instance, calling only `flushController.confirmFlush()`
 *      (finding 5);
 *   D. an epoch with no batches never has its intents counted as "ops carried" (M3,
 *      finding 3);
 *   E. an epoch whose completedAt < startedAt (the gateway's clock moved back) is
 *      still listed, with "duration unknown" instead of being rejected as malformed
 *      (M4, finding 4).
 *
 * Renders the REAL SettlementPage (and everything it imports from
 * lib/settlement-queue-view.ts — never mocked) against a mocked `global.fetch`. The
 * dashboard has no React Testing Library, so this uses the createRoot + React 19 `act`
 * pattern from
 * apps/dashboard/src/components/viewer/__tests__/usePointMap3DPlayback.test.ts (see also
 * the ai memory note pcc-dashboard-component-tests.md). No providers/router are
 * needed: the page's two stores (`useUIStore`, auth-store's `getAuthHeaders`) are
 * plain Zustand hooks/module functions backed by module-level singleton state, not
 * context-based, and the page never calls react-router or react-query hooks.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 19 requires this flag before any render so `act()` knows it's in a test env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SettlementPage } from "../SettlementPage.js";

// ---------------------------------------------------------------------------
// Source conformance fixture (Test C) — read once at module scope, like the
// existing settlement-page-truth.test.ts does.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(here, "..", "SettlementPage.tsx"), "utf-8");

// ---------------------------------------------------------------------------
// Fixtures (shared across tests; epochs vary per test as noted at each call site)
// ---------------------------------------------------------------------------

const STATUS_BODY = {
  batchEnabled: true,
  pending: 3,
  totalValue: "3000000",
  oldestAge: 1000,
  autoFlush: false,
  smartAccountAddress: null,
};

const FLUSH_BODY = {
  epoch: 1,
  totalIntents: 3,
  batches: 1,
  batchDetails: [{ userOpHash: "0x" + "ab".repeat(32), operationCount: 3, trigger: "manual" }],
  byAgent: { "agent-1": 3 },
  byOperation: { release: 3 },
  duration: 5,
};

// ---------------------------------------------------------------------------
// fetch mock — routes GET /api/settlement/{status,epochs} and POST .../flush.
// Each route's behavior is a swappable handler so a test can fail, defer, or
// vary a single route without re-wiring the others.
// ---------------------------------------------------------------------------

interface MockResponse {
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(status: number, body: unknown): MockResponse {
  return { status, json: async () => body };
}

type Handler = () => Promise<MockResponse>;

interface FetchRig {
  calls: { url: string; method: string }[];
  status: Handler;
  epochs: Handler;
  flush: Handler;
}

function installFetchMock(): FetchRig {
  const calls: { url: string; method: string }[] = [];
  const rig: FetchRig = {
    calls,
    status: async () => jsonResponse(200, STATUS_BODY),
    epochs: async () => jsonResponse(200, { epochs: [] }),
    flush: async () => jsonResponse(200, FLUSH_BODY),
  };
  const fetchMock = async (input: unknown, init?: { method?: string }): Promise<MockResponse> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/settlement/status") return rig.status();
    if (url === "/api/settlement/epochs") return rig.epochs();
    if (url === "/api/settlement/flush") return rig.flush();
    throw new Error(`settlement-page-flush.test.tsx: unexpected fetch ${method} ${url}`);
  };
  vi.stubGlobal("fetch", fetchMock);
  return rig;
}

// ---------------------------------------------------------------------------
// Render harness
// ---------------------------------------------------------------------------

interface Harness {
  container: HTMLDivElement;
  root: Root;
}

function mountContainer(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

/**
 * Drains the microtask queue plus one macrotask tick — enough for the mocked
 * fetch -> json() -> state-setter chains used here (none of which are
 * deferred except where a test explicitly holds a promise open).
 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((done) => setTimeout(done, 0));
}

function mainFlushButton(container: HTMLElement): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((el) =>
    el.textContent?.startsWith("Flush"),
  );
  if (!btn) throw new Error("main flush button (text starting with 'Flush') not found");
  return btn;
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes(text));
  if (!btn) throw new Error(`no <button> containing "${text}" found`);
  return btn;
}

/**
 * The DataCell with this exact label's own `sub` text — scoped to that one
 * <span> so it can't be confused with the adjacent value span's text (e.g. a
 * value of "1" immediately followed by a sub starting with "0 ops..." would
 * read as "10 ops..." in the panel's full concatenated textContent).
 */
function dataCellSub(container: HTMLElement, label: string): string {
  const labelEl = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === label);
  if (!labelEl) throw new Error(`DataCell labeled "${label}" not found`);
  const siblings = Array.from(labelEl.parentElement?.children ?? []) as HTMLElement[];
  return siblings[2]?.textContent ?? "";
}

let harnesses: Harness[] = [];
let rig: FetchRig;

beforeEach(() => {
  rig = installFetchMock();
});

afterEach(() => {
  for (const h of harnesses) {
    try {
      act(() => {
        h.root.unmount();
      });
    } catch {
      /* ignore */
    }
    h.container.remove();
  }
  harnesses = [];
  vi.unstubAllGlobals();
});

function track(h: Harness): Harness {
  harnesses.push(h);
  return h;
}

async function renderPage(): Promise<Harness> {
  const h = track(mountContainer());
  await act(async () => {
    h.root.render(<SettlementPage />);
    await settle();
  });
  return h;
}

// ---------------------------------------------------------------------------
// A & B. Manual flush interaction
// ---------------------------------------------------------------------------

describe("SettlementPage — manual flush", () => {
  it("A: sends exactly one POST when confirmed repeatedly while the flush is in flight", async () => {
    let resolveFlush!: (r: MockResponse) => void;
    rig.flush = () => new Promise<MockResponse>((finish) => { resolveFlush = finish; });

    const h = await renderPage();

    // Open the confirmation the way a user does: click the main flush button.
    act(() => {
      mainFlushButton(h.container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const confirmBtn = findButton(h.container, "Confirm flush");

    // Click the confirm control three times back-to-back, in the same tick —
    // the controller's synchronous in-flight guard (not React state, which is
    // batched/async) must suppress the second and third before any of them
    // reach fetch(). All three happen while the POST is still unresolved.
    act(() => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const flushPostsWhilePending = rig.calls.filter(
      (c) => c.url === "/api/settlement/flush" && c.method === "POST",
    );
    expect(flushPostsWhilePending).toHaveLength(1);

    await act(async () => {
      resolveFlush(jsonResponse(200, FLUSH_BODY));
      await settle();
    });

    const flushPosts = rig.calls.filter((c) => c.url === "/api/settlement/flush" && c.method === "POST");
    expect(flushPosts).toHaveLength(1);
    expect(h.container.textContent).toContain("The gateway reports epoch 1 flushed");
  });

  it("B: a reload that fails after a successful flush never produces an unhandled rejection, and the control recovers", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      // First load (on mount) succeeds; the reload triggered by the flush
      // (second call to each endpoint) throws — simulating the gateway going
      // unreachable right after accepting the flush.
      let statusCalls = 0;
      let epochsCalls = 0;
      rig.status = async () => {
        statusCalls += 1;
        if (statusCalls === 1) return jsonResponse(200, STATUS_BODY);
        throw new Error("settlement-page-flush.test.tsx: simulated status re-fetch failure");
      };
      rig.epochs = async () => {
        epochsCalls += 1;
        if (epochsCalls === 1) return jsonResponse(200, { epochs: [] });
        throw new Error("settlement-page-flush.test.tsx: simulated epochs re-fetch failure");
      };

      const h = await renderPage();

      act(() => {
        mainFlushButton(h.container).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await act(async () => {
        findButton(h.container, "Confirm flush").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
      });

      expect(unhandled).toHaveLength(0);
      // flushing reset to false despite the reload failing — the control is
      // not wedged in "Flushing..." forever, and the confirmation panel closed.
      expect(mainFlushButton(h.container).textContent).toBe("Flush");
      expect(h.container.textContent).not.toContain("Confirm flush");
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// C. Source conformance backstop (review r2 of #425, finding 5)
// ---------------------------------------------------------------------------

describe("SettlementPage — source conformance (review r2 of #425, finding 5)", () => {
  it("constructs the flush controller exactly once (never re-created per render)", () => {
    // Lookahead for "(" or "<" so the import-list mention of the bare
    // identifier (no call/generic following it) doesn't also count.
    const invocationSites = pageSource.match(/createFlushController(?=[<(])/g) ?? [];
    expect(invocationSites).toHaveLength(1);
  });

  it("routes the flush handler through flushController.confirmFlush()", () => {
    expect(pageSource.match(/flushController\.confirmFlush\(\)/g) ?? []).toHaveLength(1);
  });

  it("has no POST to /api/settlement/flush outside the controller's own post()", () => {
    expect(pageSource.match(/\/api\/settlement\/flush/g) ?? []).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D & E. Epoch read-shape regressions
// ---------------------------------------------------------------------------

describe("SettlementPage — epoch read shape regressions", () => {
  it("D (M3): an epoch with no batches never has its intents counted as ops carried", async () => {
    rig.epochs = async () =>
      jsonResponse(200, {
        epochs: [
          {
            epochId: 1,
            batches: [],
            totalIntents: 10,
            byAgent: { a: 10 },
            byOperation: { release: 10 },
            startedAt: 1000,
            completedAt: 1500,
          },
        ],
      });

    const h = await renderPage();

    const sub = dataCellSub(h.container, "Epochs Flushed");
    expect(sub).toContain("0 ops carried by UserOperations");
    expect(sub).not.toContain("10 ops");

    expect(h.container.textContent).toContain("10 intents; no UserOperation carried them");
  });

  it("E (M4): an epoch whose clock moved back is still listed, with duration unknown", async () => {
    rig.epochs = async () =>
      jsonResponse(200, {
        epochs: [
          {
            epochId: 2,
            batches: [{ userOpHash: "0x" + "cd".repeat(32), operationCount: 2, trigger: "manual" }],
            totalIntents: 2,
            byAgent: { a: 2 },
            byOperation: { release: 2 },
            startedAt: 1500,
            completedAt: 1000,
          },
        ],
      });

    const h = await renderPage();

    expect(h.container.textContent).toContain("#2");
    expect(h.container.textContent).toContain("duration unknown: the gateway's clock moved back");
    // The read must not have been rejected as malformed (M4's whole point).
    expect(h.container.textContent).not.toContain("expected shape");
  });
});

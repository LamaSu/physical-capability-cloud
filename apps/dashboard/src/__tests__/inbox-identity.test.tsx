/** @vitest-environment jsdom */
// Regression from the Claude identity probe: real auth, authorizedFetch and app singleton.
// Only the gateway response is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const READ = { state: "read", durability: "durable", count: 0, reason: null };
function dto(capabilityType: string, approvalId: string) {
  return {
    schemaId: "pcc.operator-work/v1", asOf: "2026-10-10T12:00:00Z", kernels: [{ kernelId: "k", name: null }],
    items: [{
      id: `approval:${approvalId}`, source: "approval", phase: "awaiting_me", phaseSource: "server", sourceStatus: "pending",
      capabilityType, title: null, executorKind: "kernel", pay: {}, payout: null, deadline: null,
      acceptBy: "2026-10-11T12:00:00Z", postedAt: "2026-10-10T11:00:00Z", location: {}, evidence: {}, assuranceTier: null,
      actions: [
        { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: `/api/operator/approvals/${approvalId}/approve` } },
        { op: "reject", allowed: true, reasonIfNot: null, route: { method: "POST", path: `/api/operator/approvals/${approvalId}/reject` } },
      ], mine: true, kernelId: "k", refs: { approvalId }, changedAt: null,
    }],
    total: 1, offset: 0, truncated: false, nextOffset: null, snapshot: "s",
    sources: { approval: READ, kernel_job: READ, job_offer: READ, skill_job: READ },
  };
}
type Res = { status: number; ok: boolean; json(): Promise<unknown> };
const res = (status: number, body: unknown): Res => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const KEY_A = "pcc_test_AAAAAAAAAAAAAAAAAAAA";
const KEY_B = "pcc_test_BBBBBBBBBBBBBBBBBBBB";
const KEY_C = "pcc_test_CCCCCCCCCCCCCCCCCCCC";

let next: () => Promise<Res>;
const calls: Array<{ url: string; auth: string | null }> = [];
const signals: Array<AbortSignal | undefined> = [];
const mounted: Array<{ root: Root; host: HTMLElement }> = [];
beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  signals.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    signals.push(init.signal ?? undefined);
    return next();
  }));
});
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove(); }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function load() {
  const auth = await import("../stores/auth-store.js");
  const inbox = await import("../stores/inbox-store.js");
  const toasts = await import("../stores/notification-store.js");
  const panel = await import("../components/inbox/InboxPanel.js");
  return { ...auth, ...inbox, ...toasts, ...panel };
}
async function mountPanel(InboxPanel: React.ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<MemoryRouter><InboxPanel /></MemoryRouter>); });
  return host;
}

describe("the app inbox across identity changes", () => {
  it("immediately aborts A's GET and clears its deadline on a switch, without writing into B", async () => {
    const m = await load();
    vi.useFakeTimers();
    m.adoptApiKey(KEY_A);
    await vi.advanceTimersByTimeAsync(0); // flush jsdom's auth storage event, not the GET deadline
    const pendingA = deferred<Res>();
    next = () => pendingA.promise; // ignores abort, so cancellation must still release the refresh
    const readingA = m.useInboxStore.getState().refresh();
    expect(vi.getTimerCount()).toBe(1);
    m.adoptApiKey(KEY_B);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(m.useInboxStore.getState()).toMatchObject({ items: [], loaded: false, errors: {} });
    const settled = vi.fn();
    void readingA.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    next = async () => res(200, dto("capB", "approval-b"));
    await m.useInboxStore.getState().refresh();
    expect(calls.map((v) => v.auth)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    pendingA.resolve(res(200, dto("capA-private", "approval-a")));
    await pendingA.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(m.useInboxStore.getState().items.map((v) => v.detail)).toEqual(["capB"]);
    expect(m.useInboxStore.getState().errors).toEqual({});
    expect(m.useNotificationStore.getState().notifications).toEqual([]);
  });

  it.each([KEY_A, KEY_C])("discards A's late decision after two switches to %s without a re-read", async (finalKey) => {
    const m = await load();
    m.adoptApiKey(KEY_A);
    next = async () => res(200, dto("old-A", "shared"));
    await m.useInboxStore.getState().refresh();
    const pendingDecision = deferred<Res>();
    next = () => pendingDecision.promise;
    const deciding = m.useInboxStore.getState().decideItem("ow:approval:shared", "approve");
    m.adoptApiKey(KEY_B);
    m.adoptApiKey(finalKey);
    next = async () => res(200, dto("fresh-view", "shared"));
    await m.useInboxStore.getState().refresh();
    const count = calls.length;
    pendingDecision.resolve(res(204, {}));
    await deciding;
    expect(m.useInboxStore.getState().outcomes).toEqual({});
    expect(m.useInboxStore.getState().pending).toEqual({});
    expect(m.useInboxStore.getState().items.map((v) => v.detail)).toEqual(["fresh-view"]);
    expect(calls).toHaveLength(count);
    expect(m.useNotificationStore.getState().notifications).toEqual([]);
  });

  it("uses the first successful read after a 503 as a silent toast baseline", async () => {
    const m = await load();
    m.adoptApiKey(KEY_A);
    next = async () => res(503, { error: "read_model_unavailable" });
    await m.useInboxStore.getState().refresh();
    expect(m.useInboxStore.getState().errors).toEqual({ "operator-work": "unavailable" });
    next = async () => res(200, dto("cap-a", "a"));
    await m.useInboxStore.getState().refresh();
    expect(m.useNotificationStore.getState().notifications).toEqual([]);
    next = async () => res(200, { ...dto("cap-a", "a"), items: [...dto("cap-a", "a").items, ...dto("cap-b", "b").items] });
    await m.useInboxStore.getState().refresh();
    expect(m.useNotificationStore.getState().notifications.map((v) => v.title)).toEqual(["1 new item in your inbox"]);
  });

  it.each(["stale-first", "stale-last"] as const)("discards A's stale read across A to B to A (%s)", async (order) => {
    const m = await load();
    m.adoptApiKey(KEY_A);
    const staleA = deferred<Res>();
    next = () => staleA.promise;
    const readingStaleA = m.useInboxStore.getState().refresh();
    m.adoptApiKey(KEY_B);
    const pendingB = deferred<Res>();
    next = () => pendingB.promise;
    const readingB = m.useInboxStore.getState().refresh();
    m.adoptApiKey(KEY_A);
    const freshA = deferred<Res>();
    next = () => freshA.promise;
    const readingFreshA = m.useInboxStore.getState().refresh();
    const host = await mountPanel(m.InboxPanel); // coalesces onto the fresh A read
    expect(calls.map((v) => v.auth)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`, `Bearer ${KEY_A}`]);
    const settleStale = async () => {
      await act(async () => { staleA.resolve(res(200, dto("capA-stale", "approval-old"))); await readingStaleA; });
      expect(host.textContent).not.toContain("capA-stale");
    };
    if (order === "stale-first") {
      await settleStale();
      expect(m.useInboxStore.getState()).toMatchObject({ items: [], loaded: false, errors: {} });
    }
    await act(async () => { freshA.resolve(res(200, dto("capA-fresh", "approval-new"))); await readingFreshA; });
    if (order === "stale-last") await settleStale();
    await act(async () => { pendingB.resolve(res(200, dto("capB-private", "approval-b"))); await readingB; });
    expect(m.useInboxStore.getState().items.map((v) => v.detail)).toEqual(["capA-fresh"]);
    expect(host.textContent).toContain("capA-fresh");
    expect(host.textContent).not.toContain("capB-private");
    expect(m.useNotificationStore.getState().notifications).toEqual([]);
  });

  it("discards A's stale read across A to B to C while C's fresh read is pending", async () => {
    const m = await load();
    m.adoptApiKey(KEY_A);
    const pendingA = deferred<Res>();
    next = () => pendingA.promise;
    const readingA = m.useInboxStore.getState().refresh();
    m.adoptApiKey(KEY_B);
    m.adoptApiKey(KEY_C);
    const pendingC = deferred<Res>();
    next = () => pendingC.promise;
    const readingC = m.useInboxStore.getState().refresh();
    const host = await mountPanel(m.InboxPanel);
    expect(calls.map((v) => v.auth)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_C}`]);
    await act(async () => { pendingA.resolve(res(200, dto("capA-private", "approval-a"))); await readingA; });
    expect(m.useInboxStore.getState()).toMatchObject({ items: [], loaded: false, errors: {} });
    expect(host.textContent).not.toContain("capA-private");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    await act(async () => { pendingC.resolve(res(200, dto("capC", "approval-c"))); await readingC; });
    expect(m.useInboxStore.getState().items.map((v) => v.detail)).toEqual(["capC"]);
    expect(host.textContent).toContain("capC");
    expect(m.useNotificationStore.getState().notifications).toEqual([]);
  });

  it("discards A's late read after a direct switch to B while B's read is pending", async () => {
    const m = await load();
    m.adoptApiKey(KEY_A);
    const pendingA = deferred<Res>();
    next = () => pendingA.promise;
    const readingA = m.useInboxStore.getState().refresh();
    m.adoptApiKey(KEY_B);
    const pendingB = deferred<Res>();
    next = () => pendingB.promise;
    const host = await mountPanel(m.InboxPanel);
    expect(calls.map((v) => v.auth)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    await act(async () => { pendingA.resolve(res(200, dto("capA-private", "approval-a"))); await readingA; });
    expect(m.useInboxStore.getState().items).toEqual([]);
    expect(host.textContent).not.toContain("capA-private");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    await act(async () => { pendingB.resolve(res(200, dto("capB", "approval-b"))); await pendingB.promise; });
    expect(host.textContent).toContain("capB");
    expect(m.useNotificationStore.getState().notifications).toEqual([]);
  });
  it("clears A's cached cards and toasts on sign-out before B's first read", async () => {
    const m = await load();
    next = async () => res(200, dto("capA-private", "approval-a"));
    m.adoptApiKey(KEY_A);
    await m.useInboxStore.getState().refresh();
    expect(m.useInboxStore.getState().items.map((v) => v.detail)).toEqual(["capA-private"]);
    expect(calls[0]).toEqual({ url: "/api/operator/work?limit=200", auth: `Bearer ${KEY_A}` }); // the key rides the header, never the URL

    next = async () => res(200, dto("capA-second", "approval-a2"));
    await m.useInboxStore.getState().refresh();
    expect(m.useNotificationStore.getState().notifications).toHaveLength(1);
    const epoch = m.useAuthStore.getState().keyEpoch;
    const seen: number[] = [];
    const unsubscribe = m.onIdentityChange(() => seen.push(m.useAuthStore.getState().keyEpoch));
    m.adoptApiKey(null); // A signs out
    expect(seen).toEqual([epoch + 1]); // the app reports the identity change
    expect(m.useInboxStore.getState().items).toEqual([]);
    expect(m.useNotificationStore.getState().notifications).toEqual([]);
    unsubscribe();

    m.adoptApiKey(KEY_B); // B signs in on the same tab
    const pendingB = deferred<Res>();
    next = () => pendingB.promise;
    const host = await mountPanel(m.InboxPanel);
    expect(host.textContent).not.toContain("capA-private");
    expect(host.textContent).not.toContain("capA-second");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    const before = m.useNotificationStore.getState().notifications.length;
    await act(async () => { pendingB.resolve(res(200, dto("capB", "approval-b"))); await pendingB.promise; });
    expect(host.textContent).not.toContain("capA-private");
    expect(m.useNotificationStore.getState().notifications.slice(before).map((n) => n.title)).toEqual([]);
    expect(JSON.stringify(m.useInboxStore.getState())).not.toContain("pcc_test_");
    expect(JSON.stringify(m.useNotificationStore.getState().notifications)).not.toContain("pcc_test_");
  });

  it("discards a late read sent as A after sign-out before the anonymous read settles", async () => {
    const m = await load();
    m.adoptApiKey(KEY_A);
    const pendingA = deferred<Res>();
    next = () => pendingA.promise;
    const reading = m.useInboxStore.getState().refresh();
    m.adoptApiKey(null); // sign out while A's read is in flight
    pendingA.resolve(res(200, dto("capA-private", "approval-a")));
    await reading;
    expect(m.useInboxStore.getState().items).toEqual([]);
    expect(m.useInboxStore.getState().loaded).toBe(false);

    const refused = deferred<Res>();
    next = () => refused.promise;
    const host = await mountPanel(m.InboxPanel);
    expect(host.textContent).not.toContain("capA-private");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(calls.at(-1)?.auth).toBeNull();
    await act(async () => { refused.resolve(res(401, { error: "unauthenticated" })); await refused.promise; });
    expect(host.textContent).toContain("Sign in to see your inbox.");
    expect(host.textContent).not.toContain("capA-private");
  });
});

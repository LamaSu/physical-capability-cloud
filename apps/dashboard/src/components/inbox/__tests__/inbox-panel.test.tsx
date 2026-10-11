/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { InboxPanel } from "../InboxPanel.js";
import { createInboxStore } from "../../../stores/inbox-store.js";
import type { AckOutcome, InboxItem, InboxSource } from "../../../lib/inbox/inbox-model.js";
import { createOperatorWorkSource } from "../../../lib/inbox/operator-work-source.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = () => Date.parse("2026-10-10T12:00:00Z");
function item(id = "one", patch: Partial<InboxItem> = {}): InboxItem {
  return { id, sourceId: "fake", kind: "mail_this", urgency: "act_now", createdAt: null, decideBy: null,
    title: id, detail: null, link: null, read: null, actions: [],
    task: { id: "task:" + id, dueAt: null, ackKinds: ["mailed"], ack: null }, ...patch };
}
const ok = (items: InboxItem[]): Awaited<ReturnType<InboxSource["load"]>> => ({ ok: true, items, notices: [] });
const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.useRealTimers();
});
async function mount(sources: InboxSource[], pollMs = 15_000, store = createInboxStore(sources)) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<MemoryRouter><InboxPanel store={store} now={now} pollMs={pollMs} /></MemoryRouter>); });
  return { store, host, root };
}
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((v) => v.textContent === label);
const section = (host: HTMLElement, title: string) => [...host.querySelectorAll("section")].find((v) => v.querySelector("h2")?.textContent === title);

describe("operator inbox panel", () => {
  it.each(["reread", "waiting-poll"] as const)("cancels decision reconciliation (%s) on unmount without opening another GET", async (phase) => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const body = { schemaId: "pcc.operator-work/v1", items: [{ id: "approval:a", phase: "awaiting_me", actions: [
      { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/approve" } },
    ] }] };
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { status: 204, json: async () => ({}) };
      signals.push(init!.signal as AbortSignal);
      if (signals.length === 1) return { status: 200, json: async () => body };
      return new Promise<{ status: number; json(): Promise<unknown> }>(() => {}); // ignores abort
    });
    const { root, host, store } = await mount([createOperatorWorkSource({ fetch })]);
    if (phase === "waiting-poll") await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    let deciding!: Promise<void>;
    await act(async () => { deciding = store.getState().decideItem("ow:approval:a", "approve"); });
    expect(signals).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(2);
    act(() => root.unmount());
    mounted.splice(mounted.findIndex((v) => v.root === root), 1);
    host.remove();
    expect(signals[1].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    await deciding;
    expect(store.getState().errors).toEqual({});
    expect(store.getState().pending).toEqual({});
  });

  it.each(["initial", "poll"] as const)("aborts a stalled %s GET on unmount and reads afresh on remount", async (phase) => {
    vi.useFakeTimers();
    let resolve!: (v: { status: number; json(): Promise<unknown> }) => void;
    const pending = new Promise<{ status: number; json(): Promise<unknown> }>((r) => { resolve = r; });
    const signals: AbortSignal[] = [];
    const body = (id: string) => ({ schemaId: "pcc.operator-work/v1", items: [
      { id, phase: "awaiting_me", capabilityType: id, actions: [] },
    ] });
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      if (signals.length === (phase === "initial" ? 1 : 2)) return pending; // deliberately ignores abort
      return { status: 200, json: async () => body("fresh") };
    });
    const { root, host, store } = await mount([createOperatorWorkSource({ fetch })]);
    if (phase === "poll") await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const staleSignal = signals.at(-1)!;
    const reading = store.getState().refresh();
    const before = store.getState();
    expect(vi.getTimerCount()).toBe(2); // poll and GET deadline
    act(() => root.unmount());
    mounted.splice(mounted.findIndex((v) => v.root === root), 1);
    host.remove();
    expect(staleSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const settled = vi.fn();
    void reading.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(store.getState()).toBe(before); // cancellation writes no fields, even unavailable
    const count = fetch.mock.calls.length;
    const remount = await mount([], 15_000, store);
    expect(fetch).toHaveBeenCalledTimes(count + 1);
    expect(remount.host.textContent).toContain("fresh");
    await act(async () => {
      resolve({ status: 200, json: async () => body("stale") });
      await pending;
      await reading;
    });
    expect(remount.host.textContent).not.toContain("stale");
    expect(store.getState().errors).toEqual({});
    expect(store.getState().items.map((v) => v.detail)).toEqual(["fresh"]);
    expect(vi.getTimerCount()).toBe(1); // only the remount's poll
  });

  it("suppresses all-clear when malformed awaiting_me decisions could not be shown", async () => {
    const source = createOperatorWorkSource({ fetch: async () => ({ status: 200, json: async () => ({
      schemaId: "pcc.operator-work/v1", items: [{ phase: "awaiting_me", id: 9, actions: [] }],
    }) }) });
    const { host } = await mount([source]);
    expect(host.textContent).toContain("1 items could not be shown here.");
    expect(host.textContent).not.toContain("Nothing needs you right now.");
  });
  it.each(["job offers", "skill jobs", "kernel jobs"])("does not gate all-clear on deliberately unlisted %s", async (source) => {
    const { host } = await mount([{ id: "fake", load: async () => ({ ok: true, items: [], notices: [{ code: "source_not_attributable", source }] }) }]);
    const label = source[0].toUpperCase() + source.slice(1);
    expect(host.textContent).toContain(`${label} are not listed in this inbox yet.`);
    expect(host.textContent).not.toContain("could not be read");
    expect(host.textContent).toContain("Nothing needs you right now.");
  });
  it("only gates the operator-work all-clear on approval source state", async () => {
    const read = { state: "read", durability: "durable", count: 0, reason: null };
    const source = createOperatorWorkSource({ fetch: async () => ({ status: 200, json: async () => ({
      schemaId: "pcc.operator-work/v1", items: [], sources: { approval: read,
        skill_job: { ...read, state: "not_attributable" }, job_offer: { ...read, state: "unavailable" }, kernel_job: { ...read, state: "unavailable" } },
    }) }) });
    const { host } = await mount([source]);
    expect(host.textContent).toContain("Skill jobs are not listed in this inbox yet.");
    expect(host.textContent).toContain("Job offers could not be read, so they are not shown.");
    expect(host.textContent).toContain("Nothing needs you right now.");
  });
  it("keeps an acknowledged task under Act now while the post-ack read is deferred", async () => {
    let resolve!: (v: Awaited<ReturnType<InboxSource["load"]>>) => void;
    const reread = new Promise<Awaited<ReturnType<InboxSource["load"]>>>((r) => { resolve = r; });
    const current = item();
    const load = vi.fn<[], ReturnType<InboxSource["load"]>>().mockResolvedValueOnce(ok([current])).mockImplementation(() => reread);
    const { host, store } = await mount([{ id: "fake", load, ack: async () => "acked" }]);
    let acking!: Promise<void>;
    await act(async () => { acking = store.getState().ackTask("one", "mailed"); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.getState().outcomes.one).toBe("acked");
    expect(store.getState().items[0].task!.ack).toBeNull();
    expect(section(host, "Act now")?.textContent).toContain("one");
    expect(section(host, "Done")).toBeUndefined();
    expect(button(host, "Mailed")?.disabled).toBe(true);
    await act(async () => {
      resolve(ok([{ ...current, task: { ...current.task!, ack: { kind: "mailed", at: "2026-10-10T11:55:00Z" } } }]));
      await acking;
    });
    expect(section(host, "Act now")).toBeUndefined();
    expect(section(host, "Done")?.textContent).toContain("one");
  });
  it.each([500, 502, 503, 504, "network"] as const)("shows unknown decision %s as unavailable without claiming nothing changed", async (status) => {
    const source = createOperatorWorkSource({ fetch: async () => {
      if (status === "network") throw new Error("connection lost after sending");
      return { status, json: async () => ({}) };
    } });
    const current = item("decision", { urgency: "decide_soon", task: null, actions: [
      { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/approve" } },
    ] });
    const { host } = await mount([{ id: "fake", load: async () => ok([current]), act: source.act }]);
    await act(async () => { button(host, "Approve")!.click(); });
    expect(host.textContent).toContain("Check again before retrying");
    expect(host.textContent).not.toContain("Nothing changed.");
    expect(host.textContent).toContain("decision");
  });
  it("releases a timed-out coalesced GET and re-enables decision buttons after a known read", async () => {
    vi.useFakeTimers();
    const read = { state: "read", durability: "durable", count: 0, reason: null };
    const body = { schemaId: "pcc.operator-work/v1", items: [{ id: "approval:a", source: "approval", phase: "awaiting_me", actions: [
      { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/approve" } },
    ] }], sources: { approval: read } };
    let reads = 0;
    let stalledSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { status: 204, json: async () => ({}) };
      reads++;
      if (reads === 2) {
        stalledSignal = init?.signal ?? undefined;
        return new Promise<{ status: number; json(): Promise<unknown> }>(() => {});
      }
      return { status: 200, json: async () => body };
    });
    const { host, store } = await mount([createOperatorWorkSource({ fetch })], 60_000);
    let deciding!: Promise<void>;
    await act(async () => { deciding = store.getState().decideItem("ow:approval:a", "approve"); });
    expect(button(host, "Approve")?.disabled).toBe(true);
    const coalesced = store.getState().refresh();
    expect(reads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(button(host, "Approve")?.disabled).toBe(true);
    let finished = false;
    void deciding.then(() => { finished = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    // Assert settlement before awaiting; a missing timeout must fail instead of hanging the test.
    expect(finished).toBe(true);
    await Promise.all([deciding, coalesced]);
    expect(stalledSignal?.aborted).toBe(true);
    expect(store.getState().errors).toEqual({ "operator-work": "unavailable" });
    expect(store.getState().pending).toEqual({});
    expect(host.textContent).toContain("Your inbox could not be read just now, so nothing is shown. Try again shortly.");
    await act(async () => { await store.getState().refresh(); });
    expect(reads).toBe(3);
    expect(button(host, "Approve")?.disabled).toBe(false);
  });
  it("renders hostile title/detail as literal text without img or script elements", async () => {
    const title = "<img src=x onerror=alert(1)>";
    const detail = "<script>alert(1)</script>";
    const { host } = await mount([{ id: "fake", load: async () => ok([item("one", { title, detail })]) }]);
    expect(host.querySelector("img, script")).toBeNull();
    expect(host.textContent).toContain(title);
    expect(host.textContent).toContain(detail);
  });
  it("renders no anchor for javascript: and opens only validated internal links", async () => {
    const { host } = await mount([{ id: "fake", load: async () => ok([item("bad", { link: "javascript:alert(1)" }), item("good", { link: "/operator" })]) }]);
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/operator");
    expect(host.querySelector("a")?.textContent).toBe("Open");
  });
  it("puts act-now items above decisions, then FYI and done", async () => {
    const { host } = await mount([{ id: "fake", load: async () => ok([
      item("decision", { urgency: "decide_soon", task: null }), item("urgent"),
      item("fyi", { urgency: "fyi", task: null }), item("done", { task: { ...item().task!, ack: { kind: "mailed", at: "2026-10-10T11:55:00Z" } } }),
    ]) }]);
    const text = host.textContent!;
    expect(text.indexOf("Act now")).toBeLessThan(text.indexOf("Needs your decision"));
    expect(text.indexOf("Needs your decision")).toBeLessThan(text.indexOf("For your information"));
    expect(text.indexOf("For your information")).toBeLessThan(text.indexOf("Done"));
    expect(section(host, "Act now")?.textContent).toContain("urgent");
  });
  it("double-clicks Mailed only once and stays pinned until the server reports the ack", async () => {
    let resolve!: (v: AckOutcome) => void;
    const promise = new Promise<AckOutcome>((r) => { resolve = r; });
    const ack = vi.fn<Parameters<NonNullable<InboxSource["ack"]>>, Promise<AckOutcome>>(() => promise);
    let current = item();
    const { host, store } = await mount([{ id: "fake", load: async () => ok([current]), ack }]);
    act(() => {
      button(host, "Mailed")!.click();
      button(host, "Mailed")!.click();
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][1]).toBe("mailed");
    expect(button(host, "Mailed")?.disabled).toBe(true);
    await act(async () => { resolve("acked"); await promise; });
    expect(section(host, "Act now")?.textContent).toContain("one");
    expect(store.getState().items[0].task!.ack).toBeNull();
    current = { ...current, task: { ...current.task!, ack: { kind: "mailed", at: "2026-10-10T11:55:00Z" } } };
    await act(async () => { await store.getState().refresh(); });
    expect(section(host, "Act now")?.textContent ?? "").not.toContain("one");
    expect(section(host, "Done")?.textContent).toContain("one");
    expect(section(host, "Done")?.textContent).toContain("Marked Mailed 5m ago");
    expect(button(host, "Mailed")).toBeUndefined();
  });
  it("shows a refused approve reason and no approval button", async () => {
    const { host } = await mount([{ id: "fake", load: async () => ok([item("one", { actions: [{ op: "approve", allowed: false, reasonIfNot: "This action is not available here", route: { method: "POST", path: "/api/admin/x" } }] })]) }]);
    expect(host.textContent).toContain("This action is not available here");
    expect(button(host, "Approve")).toBeUndefined();
  });
  it("renders known ack labels only and explains missing ack support or task", async () => {
    const { host } = await mount([{ id: "fake", load: async () => ok([item(), item("no-task", { task: null })]) }]);
    expect(host.textContent?.match(/This can't be acknowledged here\./g)).toHaveLength(2);
    expect(button(host, "Mailed")).toBeUndefined();
    const known = item("kinds", { task: { ...item().task!, ackKinds: ["mailed", "not_mailed", "resolved", "acknowledged", "unknown" as "mailed"] } });
    const next = await mount([{ id: "fake", load: async () => ok([known]), ack: async () => "acked" }]);
    expect([...next.host.querySelectorAll("button")].map((v) => v.textContent)).toEqual(["Mailed", "Not mailed", "Fixed", "Seen"]);
  });
  it.each([
    ["sign_in", "Sign in to see your inbox."],
    ["sign_in_wallet", "Sign in with your wallet to see your inbox."],
    ["unavailable", "Your inbox could not be read just now, so nothing is shown. Try again shortly."],
    ["failed", "Your inbox could not be read."],
  ] as const)("shows %s honestly and suppresses the empty state", async (error, text) => {
    const { host } = await mount([{ id: "fake", load: async () => ({ ok: false, error }) }]);
    expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("Nothing needs you right now.");
  });
  it.each(["source_unavailable", "source_not_attributable"] as const)("%s notice suppresses all-clear and uses fixed label copy", async (code) => {
    const { host } = await mount([{ id: "fake", load: async () => ({ ok: true, items: [], notices: [{ code, source: "approvals" }] }) }]);
    expect(host.textContent).toContain(code === "source_unavailable" ? "Approvals could not be read, so they are not shown." : "Approvals are not listed in this inbox yet.");
    expect(host.textContent).not.toContain("Nothing needs you right now.");
  });
  it("shows notices in fixed copy and treats an unknown source label as data never copy", async () => {
    const { host } = await mount([{ id: "fake", load: async () => ({ ok: true, items: [], notices: [
      { code: "source_unavailable", source: "job offers" }, { code: "source_not_attributable", source: "skill jobs" },
      { code: "source_unavailable", source: "kernel jobs" }, { code: "source_unavailable", source: "<script>" },
      { code: "no_kernels" }, { code: "more_items" }, { code: "unshown_items", count: 3 },
    ] }) }]);
    for (const text of ["Job offers could not be read, so they are not shown.", "Skill jobs are not listed in this inbox yet.", "Kernel jobs could not be read, so they are not shown.", "No kernels are registered to this wallet.", "More decisions are waiting than this page shows.", "3 items could not be shown here."]) expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("<script>");
  });
  it("shows loading until a load settles and all-clear only on a complete empty success", async () => {
    let resolve!: (v: Awaited<ReturnType<InboxSource["load"]>>) => void;
    const promise = new Promise<Awaited<ReturnType<InboxSource["load"]>>>((r) => { resolve = r; });
    const { host } = await mount([{ id: "fake", load: () => promise }]);
    expect(host.textContent).toContain("Loading your inbox...");
    expect(host.textContent).not.toContain("Nothing needs you right now.");
    await act(async () => { resolve(ok([])); await promise; });
    expect(host.textContent).toContain("Nothing needs you right now.");
  });
  it("clicks decisions and read through the store, with fixed refusal outcome copy", async () => {
    const decide = vi.fn(async () => "stopped" as const);
    const markRead = vi.fn(async () => true);
    const current = item("one", { urgency: "decide_soon", task: null, read: false, decideBy: "2026-10-10T12:05:00Z", createdAt: "2026-10-10T11:55:00Z", actions: [
      { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/approve" } },
      { op: "reject", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/reject" } },
    ] });
    const { host } = await mount([{ id: "fake", load: async () => ok([current]), act: decide, markRead }]);
    expect(host.textContent).toContain("Decide by in 5m");
    expect(host.textContent).toContain("5m ago");
    expect(button(host, "Reject")).toBeDefined();
    await act(async () => { button(host, "Approve")!.click(); });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("The kernel's emergency stop is on; nothing was decided.");
    await act(async () => { button(host, "Mark read")!.click(); });
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(button(host, "Mark read")).toBeUndefined();
  });
  it("polls after pollMs and cancels the timer on unmount", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ok([]));
    const { root } = await mount([{ id: "fake", load }], 1000);
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(load).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    mounted.splice(0).forEach(({ host }) => host.remove());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

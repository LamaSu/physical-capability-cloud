import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorWorkDTO, OperatorWorkItem } from "@pcc/spec";
import type { ActOutcome, InboxAction, InboxItem } from "../inbox-model.js";
import { createOperatorWorkSource } from "../operator-work-source.js";

function work(patch: Partial<OperatorWorkItem> = {}): OperatorWorkItem {
  return {
    id: "approval:a", source: "approval", phase: "awaiting_me", phaseSource: "server", sourceStatus: "pending",
    capabilityType: "fdm", title: "server title not used", executorKind: "kernel",
    pay: { amount: null, amountBaseUnits: null, currency: null, decimals: null, model: "unknown", unit: null, funding: "unknown", fundingRef: null, basis: null },
    payout: null, deadline: null, acceptBy: "2026-10-11T12:00:00Z", postedAt: "2026-10-10T12:00:00Z",
    location: { kind: "operator_site", approximate: false, lat: null, lng: null, kernelId: "k" },
    evidence: { assuranceTier: null, requirements: null, source: "none" }, assuranceTier: null,
    actions: [
      { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/approve" } },
      { op: "reject", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/reject" } },
    ], mine: true, kernelId: "k", refs: { approvalId: "a" }, changedAt: null, ...patch,
  };
}
function dto(patch: Partial<OperatorWorkDTO> = {}): OperatorWorkDTO {
  const read = { state: "read", durability: "durable", count: 0, reason: null } as const;
  return {
    schemaId: "pcc.operator-work/v1", asOf: "2026-10-10T12:00:00Z", kernels: [{ kernelId: "k", name: "kernel" }],
    items: [work()], total: 1, offset: 0, truncated: false, nextOffset: null, snapshot: "snapshot",
    sources: { approval: read, kernel_job: read, skill_job: read, job_offer: read }, ...patch,
  };
}
const response = (status: number, body: unknown = {}) => ({ status, json: async () => body });
const actItem: InboxItem = {
  id: "ow:approval:a", sourceId: "operator-work", kind: "job_awaiting_accept", urgency: "decide_soon",
  createdAt: null, decideBy: null, title: "A job waits for your decision", detail: null, link: null,
  task: null, read: null, actions: [],
};
const approve: InboxAction = { op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/approve" } };
afterEach(() => { vi.useRealTimers(); });

describe("operator work inbox read", () => {
  it.each(["ignores", "rejects"] as const)("aborts the GET and clears its deadline when the caller aborts (fetch %s abort)", async (mode) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const source = createOperatorWorkSource({ fetch: async (_path, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<ReturnType<typeof response>>((_resolve, reject) => {
        if (mode === "rejects") signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    } });
    const controller = new AbortController();
    const settled = vi.fn();
    const reading = source.load(controller.signal).then((result) => { settled(result); return result; });
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await reading).toEqual({ ok: false, error: "unavailable" });
  });

  it("does not fetch or leave a deadline when the caller's signal is already aborted", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response(200, dto()));
    const controller = new AbortController();
    controller.abort();
    await createOperatorWorkSource({ fetch }).load(controller.signal);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("omits all funded pay and payout data from mapped inbox items (D6)", async () => {
    const funded = work({ pay: { ...work().pay, amount: "123.45", currency: "USDC", funding: "escrowed", amountBaseUnits: "123450000" },
      payout: "paid" });
    const result = await createOperatorWorkSource({ fetch: async () => response(200, dto({ items: [funded] })) }).load();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("read failed");
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result.items)).not.toMatch(/123\.45|123450000|USDC|escrowed|paid|amount|currency|funding|payout/i);
  });
  it("aborts a stalled GET at 20 seconds and settles unavailable even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let resolve!: (v: ReturnType<typeof response>) => void;
    const pending = new Promise<ReturnType<typeof response>>((r) => { resolve = r; });
    const source = createOperatorWorkSource({ fetch: async (_path, init) => { signal = init?.signal ?? undefined; return pending; } });
    const settled = vi.fn();
    const reading = source.load().then((result) => { settled(result); return result; });
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await reading).toEqual({ ok: false, error: "unavailable" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    resolve(response(200, dto()));
    await pending;
    expect(settled).toHaveBeenCalledTimes(1);
  });
  it("clears the GET deadline when a read succeeds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const source = createOperatorWorkSource({ fetch: async (_path, init) => { signal = init?.signal ?? undefined; return response(200, dto()); } });
    expect((await source.load()).ok).toBe(true);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal?.aborted).toBe(false);
  });
  it("maps approvals and kernel jobs, only from awaiting_me; links only a kernel job", async () => {
    const approval = work({ refs: { approvalId: "a", jobId: "must-not-link" } });
    const kernel = work({ id: "kernel_job:j", source: "kernel_job", refs: { jobId: "a b/xyz" }, capabilityType: "x".repeat(90) });
    const fetch = vi.fn(async () => response(200, dto({ items: [approval, kernel, work({ phase: "accepted" }), work({ phase: "offered" })] })));
    const source = createOperatorWorkSource({ fetch });
    const result = await source.load();
    expect(fetch).toHaveBeenCalledWith("/api/operator/work?limit=200", { signal: expect.any(AbortSignal) });
    expect(source.id).toBe("operator-work");
    expect(source.ack).toBeUndefined();
    expect(source.markRead).toBeUndefined();
    expect(result).toEqual({ ok: true, notices: [], items: [
      { ...actItem, createdAt: approval.postedAt, decideBy: approval.acceptBy, detail: "fdm", actions: approval.actions },
      { ...actItem, id: "ow:kernel_job:j", createdAt: kernel.postedAt, decideBy: kernel.acceptBy, detail: "x".repeat(77) + "...", link: "/jobs/a%20b%2Fxyz", actions: kernel.actions },
    ] });
  });
  it("ignores every other phase", async () => {
    const phases: OperatorWorkItem["phase"][] = ["offered", "accepted", "in_progress", "reported_done", "verified", "failed", "cancelled", "expired", "disputed", "unknown"];
    const source = createOperatorWorkSource({ fetch: async () => response(200, dto({ items: phases.map((phase) => work({ phase })) })) });
    expect(await source.load()).toEqual({ ok: true, items: [], notices: [] });
  });
  it.each(["", undefined, 3])("does not link a missing/empty/non-string job id %j", async (jobId) => {
    const body = dto({ items: [work({ source: "kernel_job", refs: { jobId: jobId as string } })] });
    const result = await createOperatorWorkSource({ fetch: async () => response(200, body) }).load();
    expect(result.ok && result.items[0].link).toBeNull();
  });
  it.each([{ schemaId: "wrong", items: [] }, { schemaId: "pcc.operator-work/v1", items: {} }, null])("refuses a malformed envelope %j", async (body) => {
    expect(await createOperatorWorkSource({ fetch: async () => response(200, body) }).load()).toEqual({ ok: false, error: "failed" });
  });
  it.each([
    [401, {}, "sign_in"], [403, { error: "identity_unverified" }, "sign_in_wallet"],
    [403, { error: "another" }, "failed"], [503, {}, "unavailable"], [500, {}, "failed"],
  ])("maps read %s to %s", async (status, body, error) => {
    expect(await createOperatorWorkSource({ fetch: async () => response(status as number, body) }).load()).toEqual({ ok: false, error });
  });
  it("maps thrown fetch and json to unavailable", async () => {
    for (const fetch of [async () => { throw new Error("network"); }, async () => ({ status: 200, json: async () => { throw new Error("json"); } })]) {
      expect(await createOperatorWorkSource({ fetch }).load()).toEqual({ ok: false, error: "unavailable" });
    }
  });
  it("uses fixed labels for unread/unattributable sources and reports bounds and kernels", async () => {
    const body = dto({ kernels: [], truncated: true, sources: {
      approval: { state: "unavailable", durability: "durable", count: 0, reason: "hostile reason" },
      kernel_job: { state: "unavailable", durability: "durable", count: 0, reason: "hostile reason" },
      skill_job: { state: "not_attributable", durability: "durable", count: 0, reason: "hostile reason" },
      job_offer: { state: "not_attributable", durability: "memory", count: 0, reason: "hostile reason" },
    } });
    const result = await createOperatorWorkSource({ fetch: async () => response(200, body) }).load();
    expect(result.ok && result.notices).toEqual(expect.arrayContaining([
      { code: "source_unavailable", source: "approvals" }, { code: "source_unavailable", source: "kernel jobs" },
      { code: "source_not_attributable", source: "skill jobs" }, { code: "source_not_attributable", source: "job offers" },
      { code: "no_kernels" }, { code: "more_items" },
    ]));
    expect(result.ok && result.notices).toHaveLength(6);
  });
  it("only warns about more decisions when the last page item awaits me", async () => {
    for (const items of [[], [work(), work({ phase: "in_progress" })]]) {
      const result = await createOperatorWorkSource({ fetch: async () => response(200, dto({ truncated: true, items })) }).load();
      expect(result.ok && result.notices).not.toContainEqual({ code: "more_items" });
    }
  });
  it("counts malformed awaiting items and keeps valid ones", async () => {
    const body = { ...dto(), items: [work(), { ...work(), id: 9 }, { ...work(), actions: null }, null] };
    const result = await createOperatorWorkSource({ fetch: async () => response(200, body) }).load();
    expect(result.ok && result.items).toHaveLength(1);
    expect(result.ok && result.notices).toContainEqual({ code: "unshown_items", count: 2 });
  });
  it("keeps only decision ops, clamps reasons and disallows unsafe or mismatched routes", async () => {
    const body = dto({ items: [work({ actions: [
      { ...approve, route: { method: "POST", path: "/api/admin/x" } },
      { ...approve, op: "reject", route: approve.route },
      { ...approve, allowed: false, reasonIfNot: " x".repeat(120) },
      { ...approve, op: "claim" },
    ] })] });
    const result = await createOperatorWorkSource({ fetch: async () => response(200, body) }).load();
    expect(result.ok && result.items[0].actions).toEqual([
      { ...approve, allowed: false, reasonIfNot: "This action is not available here", route: { method: "POST", path: "/api/admin/x" } },
      { ...approve, op: "reject", allowed: false, reasonIfNot: "This action is not available here" },
      { ...approve, allowed: false, reasonIfNot: ("x" + " x".repeat(120)).slice(0, 197) + "..." },
    ]);
  });
});

describe("operator work explicit decisions", () => {
  it.each<[number, unknown, ActOutcome]>([
    [200, {}, "done"], [201, {}, "done"], [204, {}, "done"], [299, {}, "done"],
    [409, { error: "already_decided" }, "already_decided"], [409, { error: "scope_expired" }, "expired"],
    [409, { error: "kernel_emergency_stopped" }, "stopped"], [409, { error: "other" }, "already_decided"],
    [401, {}, "sign_in"], [403, { error: "identity_unverified" }, "sign_in_wallet"], [403, {}, "not_allowed"],
    [404, {}, "gone"], [503, { error: "policy_unavailable" }, "unavailable"], [500, {}, "unavailable"],
    [502, {}, "unavailable"], [504, {}, "unavailable"], [400, {}, "failed"], [422, {}, "failed"],
  ])("maps act status %s (%j) to %s", async (status, body, outcome) => {
    const fetch = vi.fn(async () => response(status, body));
    const source = createOperatorWorkSource({ fetch });
    expect(await source.act!(actItem, approve)).toBe(outcome);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(approve.route.path, { method: "POST" });
  });
  it("maps thrown requests and refusal JSON to unavailable", async () => {
    for (const fetch of [async () => { throw new Error("unknown outcome"); }, async () => ({ status: 409, json: async () => { throw new Error("json"); } })]) {
      expect(await createOperatorWorkSource({ fetch }).act!(actItem, approve)).toBe("unavailable");
    }
  });
  it.each([
    { ...approve, allowed: false }, { ...approve, route: { method: "POST", path: "/api/admin/x" } },
    { ...approve, op: "reject" },
  ])("does not fetch a refused action %j", async (action) => {
    const fetch = vi.fn(async () => response(200));
    expect(await createOperatorWorkSource({ fetch }).act!(actItem, action as InboxAction)).toBe("not_allowed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("POSTs scope acceptance exactly as supplied, with no body or success JSON read", async () => {
    const json = vi.fn(async () => { throw new Error("204 has no body"); });
    const fetch = vi.fn(async () => ({ status: 204, json }));
    const action: InboxAction = { ...approve, route: { method: "POST", path: "/api/operator/scopes/s:1/accept" } };
    expect(await createOperatorWorkSource({ fetch }).act!(actItem, action)).toBe("done");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(action.route.path, { method: "POST" });
    expect(json).not.toHaveBeenCalled();
  });
});

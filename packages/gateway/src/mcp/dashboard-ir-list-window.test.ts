/**
 * N110 — the list WINDOW disclosure (follow-up to #348, steward row N110, PR #5334).
 *
 * The property: a list never implies completeness it cannot vouch for. Before this, a list
 * rendered "none", or a subset, while hiding the window it shows: manifest-chosen filters, an
 * offset, the server's page size, the client's own row cap. `listWindow` (dashboard-ir-
 * renderer.ts) is the pure, DOM-free derivation of what the view can HONESTLY disclose about
 * that window; `bindListRows` paints it (the empty marker's own text, and a trailing `.pcc-window`
 * note). This file: (1) a unit table over `listWindow` itself; (2) end-to-end over the REBUILT
 * kit bytes (the `scene` harness, copied from dashboard-ir-provenance.test.ts — not exported
 * there); (3) the server defaults pinned against the real producers, so the disclosure can never
 * silently guess a page size that drifted; (4) an equal-time poll whose only change is the
 * disclosed total, proving the window note is part of the committed fingerprint; (5) the no-total
 * fallback on a scoped test-only profile, since jobs now declare their total like capabilities;
 * (6) the null case: an explicit null query value is refused by the adapter and by validateIr, and
 * listWindow reads it as unknown, never as the default.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";
import { LIST_PROFILES, dashboardManifestToIr, validateIr } from "./dashboard-ir.js";
import type { IrNode } from "./dashboard-ir.js";
import { listWindow } from "./dashboard-ir-renderer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = readFileSync(resolve(HERE, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"), "utf8");

// A minimal list IrNode, matching the `{ type: "list", id, props, bind }` shape the adapter
// produces (dashboard-ir.ts mapWindow's "list" case) — constructed directly, as the rest of the
// suite does, since `listWindow` only reads `node.bind` and `node.props.limit`.
function listNode(bind: { path?: string; query?: Record<string, unknown> } | undefined, limit?: number): IrNode {
  const props: Record<string, unknown> = {};
  if (limit !== undefined) props.limit = limit;
  return { type: "list", id: "n1", props, ...(bind ? { bind } : {}) } as unknown as IrNode;
}

describe("N110 listWindow: unit table (pure, no DOM)", () => {
  it("no query: none, no note", () => {
    expect(listWindow(listNode(undefined), undefined, 0)).toEqual({ empty: "none", note: null });
  });

  it("a filter renders key=value and forces 'no rows in this window'", () => {
    const r = listWindow(listNode({ path: "/api/kernels", query: { status: "failed" } }), undefined, 1);
    expect(r.empty).toBe("no rows in this window");
    expect(r.note).toBe("filtered by this view: status=failed");
  });

  it("a filter value outside the grammar (contains a space) is never shown raw", () => {
    const r = listWindow(listNode({ path: "/api/kernels", query: { status: "paid in full" } }), undefined, 1);
    expect(r.note).toBe("filtered by this view: status=(value not shown)");
  });

  it("a filter value over 64 chars is not shown", () => {
    const r = listWindow(listNode({ path: "/api/kernels", query: { status: "x".repeat(65) } }), undefined, 1);
    expect(r.note).toBe("filtered by this view: status=(value not shown)");
  });

  it("offset 100: from row 101, and empty is 'no rows in this window'", () => {
    // jobs {total: 101}: the window ends at the reported total, so no total note.
    const r = listWindow(listNode({ path: "/api/jobs", query: { offset: 100 } }), { total: 101 }, 1);
    expect(r.note).toBe("from row 101");
    expect(r.empty).toBe("no rows in this window");
  });

  it("offset 100 with jobs {total: 500}: from row 101 · 1 of 500 returned", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { offset: 100 } }), { total: 500 }, 1);
    expect(r.note).toBe("from row 101 · 1 of 500 returned");
  });

  it("offset 'abc' (off-grammar): offset not shown (an unknown offset is never 0), so no total can be reconciled", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { offset: "abc" } }), { total: 5 }, 1);
    expect(r.note).toBe("offset not shown · total not shown");
    expect(r.empty).toBe("no rows in this window");
  });

  it("offset '0' (canonical string form) with jobs {total: 0}: none", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { offset: "0" } }), { total: 0 }, 0);
    expect(r).toEqual({ empty: "none", note: null });
  });

  it("capabilities {total:120} with 50 returned: 50 of 120 returned", () => {
    const r = listWindow(listNode({ path: "/api/capabilities" }), { total: 120 }, 50);
    expect(r.note).toBe("50 of 120 returned");
  });

  it("capabilities total absent: total not shown", () => {
    const r = listWindow(listNode({ path: "/api/capabilities" }), {}, 19);
    expect(r.note).toBe("total not shown");
  });

  it("capabilities {total:\"120\"} (mistyped, and would be less than returned if parsed): total not shown", () => {
    const r = listWindow(listNode({ path: "/api/capabilities" }), { total: "120" }, 200);
    expect(r.note).toBe("total not shown");
  });

  // Jobs declare their total (`paged.total: "total"`, the follow-up to N110 once N111 landed), so
  // jobs read exactly like capabilities: the route's own total, never the page size.
  it("jobs {total:120} with 50 returned and no query: 50 of 120 returned", () => {
    const r = listWindow(listNode({ path: "/api/jobs" }), { total: 120 }, 50);
    expect(r.note).toBe("50 of 120 returned");
  });

  it("jobs {total:50} with 50 returned: no note (the total vouches that the window holds every job)", () => {
    // Before jobs declared a total, a full default page could only say "50 returned; more may exist".
    const r = listWindow(listNode({ path: "/api/jobs" }), { total: 50 }, 50);
    expect(r.note).toBeNull();
  });

  it("jobs total absent (an off-contract envelope, or a 4-argument caller): total not shown", () => {
    expect(listWindow(listNode({ path: "/api/jobs" }), {}, 49).note).toBe("total not shown");
    expect(listWindow(listNode({ path: "/api/jobs" }), undefined, 49).note).toBe("total not shown");
  });

  it("jobs {total:\"120\"} (mistyped): total not shown", () => {
    expect(listWindow(listNode({ path: "/api/jobs" }), { total: "120" }, 50).note).toBe("total not shown");
  });

  it("jobs {total:3} with 5 returned (claims fewer jobs than shown): total not shown", () => {
    expect(listWindow(listNode({ path: "/api/jobs" }), { total: 3 }, 5).note).toBe("total not shown");
  });

  it("jobs {limit:10} {total:25} with 10 returned: 10 of 25 returned", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { limit: 10 } }), { total: 25 }, 10);
    expect(r.note).toBe("10 of 25 returned");
  });

  it("jobs {limit:10} {total:0} with 0 returned: none (`limit` is not a filter)", () => {
    expect(listWindow(listNode({ path: "/api/jobs", query: { limit: 10 } }), { total: 0 }, 0)).toEqual({ empty: "none", note: null });
  });

  it("jobs {limit:\"x\"} (off-grammar) {total:3} with 1 returned: 1 of 3 returned, and never 'none'", () => {
    // The total does not depend on the limit, so it is still disclosed; an unknown limit can never vouch for "none".
    const r = listWindow(listNode({ path: "/api/jobs", query: { limit: "x" } }), { total: 3 }, 1);
    expect(r.note).toBe("1 of 3 returned");
    expect(r.empty).toBe("no rows in this window");
  });

  it("kernels (no paged profile at all) with 300 returned: never a page note", () => {
    const r = listWindow(listNode({ path: "/api/kernels" }), undefined, 300);
    // 300 > LIST_ROW_CAP (200): the CLIENT cap still discloses, but no server-page text appears.
    expect(r.note).toBe("showing first 200 of 300 returned");
    expect(r.note).not.toContain("more may exist");
    expect(r.note).not.toContain("total");
  });

  it("client cap: props.limit 10 with 30 returned, no bind at all: showing first 10 of 30 returned", () => {
    const r = listWindow(listNode(undefined, 10), undefined, 30);
    expect(r.note).toBe("showing first 10 of 30 returned");
  });
});

// ── End-to-end over the REBUILT kit bytes (scene harness, copied from dashboard-ir-
// provenance.test.ts — not exported there, per the brief's "copy ... or import it if exported"). ──
const PROTOCOL = "2026-01-26";
type Reply = { status: number; json?: unknown; raw?: string; ct?: string };
function scene(replies: Reply[], nowMs: number, opts: { origin?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p class="pcc-invalid">waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
  const w: any = dom.window;
  let now = nowMs;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let tid = 0;
  w.setTimeout = (fn: () => void, ms: number) => { const id = ++tid; timers.push({ id, at: now + (ms || 0), fn }); return id; };
  w.clearTimeout = (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  w.Date.now = () => now;
  w.TextDecoder = NodeTextDecoder;
  w.parent.postMessage = () => {};
  if (opts.origin !== false) w.__PCC_IR_ORIGIN__ = "https://capability.network";
  let hidden = false;
  Object.defineProperty(w.document, "hidden", { configurable: true, get: () => hidden });
  let call = 0;
  w.fetch = () => {
    const r = replies[Math.min(call++, replies.length - 1)]!;
    const bytes = new NodeTextEncoder().encode(r.raw !== undefined ? r.raw : JSON.stringify(r.json ?? {}));
    let sent = false;
    return Promise.resolve({
      status: r.status, redirected: false,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? (r.ct ?? "application/json") : null) },
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => {} }), cancel: async () => {} },
    });
  };
  w.eval(KIT);
  w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL } } }));
  const deliver = (m: unknown) => w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: w.JSON.parse(w.JSON.stringify(m)) } } } }));
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  /** Advance to the next POLL tick (skip the per-request timeout timers). */
  const nextPoll = async () => {
    const polls = timers.filter((t) => t.at - now >= 5000 && t.at - now <= 600_000).sort((a, b) => a.at - b.at);
    const t = polls[0]; if (!t) throw new Error("no poll timer scheduled");
    timers.splice(timers.indexOf(t), 1); now = t.at; t.fn(); await settle();
  };
  const q = (sel: string) => w.document.querySelector(sel) as any;
  return { w, deliver, settle, nextPoll, q, close: () => w.close() };
}
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// Read `dashboardManifestToIr`'s manifest binding shape (mapBind, dashboard-ir.ts: `binding.query`
// becomes `bind.query`) — a window passes a query the same way a metric/capability binding does.
const capsManifest = (query?: Record<string, unknown>) => ({
  csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec W", windows: [
    { kind: "list", binding: { path: "/api/capabilities", ...(query ? { query } : {}) }, item: { title: "name", meta: ["type"], statusFrom: "available" } },
  ] }],
});
const jobsManifest = (query?: Record<string, unknown>) => ({
  csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec J", windows: [
    { kind: "list", binding: { path: "/api/jobs", ...(query ? { query } : {}) }, item: { title: "id", meta: ["status"], statusFrom: "status" } },
  ] }],
});
// A seeded-store-shaped job row (kernel-nyc's job-001).
const JOB_ROW = { id: "job-001", capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc", status: "completed" };

describe("N110 end-to-end on the rebuilt pcc-ir-kit.js", () => {
  it("a filtered, timed, empty capabilities list: 'no rows in this window' + a window note, never 'none'", async () => {
    const s = scene([{ status: 200, json: { items: [], total: 0, asOf: iso(T0) } }], T0);
    s.deliver(capsManifest({ type: "pizza" })); await s.settle();
    const empty = s.q(".pcc-list .pcc-empty");
    expect(empty).not.toBeNull();
    expect(empty.textContent).toBe("no rows in this window");
    expect(empty.textContent).not.toBe("none");
    expect(s.q(".pcc-list .pcc-window").textContent).toBe("filtered by this view: type=pizza");
    s.close();
  });

  it("an unfiltered, timed, empty capabilities list still renders 'none' and no .pcc-window", async () => {
    const s = scene([{ status: 200, json: { items: [], total: 0, asOf: iso(T0) } }], T0);
    s.deliver(capsManifest()); await s.settle();
    expect(s.q(".pcc-list .pcc-empty").textContent).toBe("none");
    expect(s.q(".pcc-list .pcc-window")).toBeNull();
    s.close();
  });

  it("a jobs list discloses the jobs route's own total: 1 of 3 returned", async () => {
    const s = scene([{ status: 200, json: { jobs: [JOB_ROW], items: [JOB_ROW], total: 3, offset: 0, limit: 1, hasMore: true, asOf: iso(T0) } }], T0);
    s.deliver(jobsManifest({ limit: 1 })); await s.settle();
    expect(s.q(".pcc-list").querySelectorAll(".pcc-row").length).toBe(1);
    expect(s.q(".pcc-list .pcc-window").textContent).toBe("1 of 3 returned");
    s.close();
  });

  it("an unfiltered, empty jobs list renders 'none' only on a reported total of 0", async () => {
    const s = scene([{ status: 200, json: { jobs: [], items: [], total: 0, asOf: iso(T0) } }], T0);
    s.deliver(jobsManifest()); await s.settle();
    expect(s.q(".pcc-list .pcc-empty").textContent).toBe("none");
    expect(s.q(".pcc-list .pcc-window")).toBeNull();
    s.close();
    // The same empty page with no total cannot vouch for the whole collection.
    const t = scene([{ status: 200, json: { jobs: [], asOf: iso(T0) } }], T0);
    t.deliver(jobsManifest()); await t.settle();
    expect(t.q(".pcc-list .pcc-empty").textContent).toBe("no rows in this window");
    expect(t.q(".pcc-list .pcc-window").textContent).toBe("total not shown");
    t.close();
  });
});

describe("N110 server defaults are pinned against the real producers (never guessed)", () => {
  // Why: if the facade's own default page size ever drifts, the window's "first N; more may
  // exist" / "showing N of total" disclosure must drift WITH it, or it would silently lie about
  // how many rows the server actually hands back by default.
  it("LIST_PROFILES['/api/jobs'].paged.defaultLimit matches BOTH the jobs route's query-schema default and the facade's fallback", () => {
    // N111 (on master) gave GET /api/jobs a querystring schema whose `limit` default the route applies
    // first; job.facade.ts keeps its own coercion fallback. The view's page size must equal both.
    const route = readFileSync(resolve(HERE, "../routes/jobs.ts"), "utf8");
    const r = /limit:\s*\{\s*type:\s*"integer"[^}]*default:\s*(\d+)/.exec(route);
    expect(r, "routes/jobs.ts: could not find the limit schema's `default:`").not.toBeNull();
    expect(LIST_PROFILES["/api/jobs"]!.paged!.defaultLimit).toBe(Number(r![1]));
    const facade = readFileSync(resolve(HERE, "../facades/job.facade.ts"), "utf8");
    const f = /toSafeOffsetOrLimit\(\s*pagination\?\.limit\s*,\s*(\d+)\s*\)/.exec(facade);
    expect(f, "job.facade.ts: could not find `toSafeOffsetOrLimit(pagination?.limit, <default>)`").not.toBeNull();
    expect(LIST_PROFILES["/api/jobs"]!.paged!.defaultLimit).toBe(Number(f![1]));
  });

  it("LIST_PROFILES['/api/capabilities'].paged.defaultLimit matches routes/capabilities.ts's query-schema default", () => {
    const text = readFileSync(resolve(HERE, "../routes/capabilities.ts"), "utf8");
    const m = /limit:\s*\{\s*type:\s*"integer"[^}]*default:\s*(\d+)/.exec(text);
    expect(m, "routes/capabilities.ts: could not find the limit schema's `default:`").not.toBeNull();
    expect(LIST_PROFILES["/api/capabilities"]!.paged!.defaultLimit).toBe(Number(m![1]));
  });
});

describe("N110 equal-time: the window note is part of the committed fingerprint", () => {
  it("two polls with the same asOf whose total differs (120 then 121, same items) must not replace the shown list", async () => {
    const at = iso(T0 - 5_000);
    const items = [{ name: "A", type: "t", available: true }, { name: "B", type: "u", available: false }];
    const s = scene([
      { status: 200, json: { items, total: 120, asOf: at } },
      { status: 200, json: { items, total: 121, asOf: at } }, // same asOf, same rows, DIFFERENT total
    ], T0);
    s.deliver(capsManifest()); await s.settle();
    expect(s.q(".pcc-list").querySelectorAll(".pcc-row").length).toBe(2);
    expect(s.q(".pcc-list .pcc-window").textContent).toBe("2 of 120 returned");
    await s.nextPoll();
    // must NOT become 121: an equal-timestamp update is undecidable by time alone when its
    // payload (here, only the window note) differs from what is shown, so it is rejected.
    expect(s.q(".pcc-list .pcc-window").textContent).toBe("2 of 120 returned");
    expect(s.q(".pcc-list").querySelectorAll(".pcc-row").length).toBe(2);
    expect(s.q(".pcc-list").className).not.toContain("pcc-unavail");
    s.close();
  });
});

describe("astra n110 r1 (@975d583e): reproduced (verify before fix)", () => {
  // MEDIUM: "none" must be decided by the SAME paging evidence the note uses. It may be claimed only
  // when the window vouches for the whole collection.
  it("capabilities {total: 1} with 0 returned is not 'none' (it contradicted '0 of 1 returned')", () => {
    expect(listWindow(listNode({ path: "/api/capabilities" }), { total: 1 }, 0)).toEqual({ empty: "no rows in this window", note: "0 of 1 returned" });
  });
  it("capabilities with no reported total and 0 returned is not 'none' (the route cannot vouch)", () => {
    expect(listWindow(listNode({ path: "/api/capabilities" }), {}, 0)).toEqual({ empty: "no rows in this window", note: "total not shown" });
  });
  // jobs now declare a total, so these two carry a reported total of 0: the limit rule alone must refuse "none".
  it("jobs {limit: 0} {total: 0} with 0 returned is not 'none' (an off-grammar limit can empty a non-empty page)", () => {
    expect(listWindow(listNode({ path: "/api/jobs", query: { limit: 0 } }), { total: 0 }, 0).empty).toBe("no rows in this window");
  });
  it("jobs {limit: 'x'} {total: 0} with 0 returned is not 'none'", () => {
    expect(listWindow(listNode({ path: "/api/jobs", query: { limit: "x" } }), { total: 0 }, 0).empty).toBe("no rows in this window");
  });
  it("jobs with no reported total and 0 returned is not 'none' (the route cannot vouch)", () => {
    expect(listWindow(listNode({ path: "/api/jobs" }), {}, 0)).toEqual({ empty: "no rows in this window", note: "total not shown" });
  });
  // Positive controls: an honest "none" survives the fix.
  it("capabilities {total: 0} with 0 returned is 'none', with no note", () => {
    expect(listWindow(listNode({ path: "/api/capabilities" }), { total: 0 }, 0)).toEqual({ empty: "none", note: null });
  });
  it("jobs {total: 0} with no query and 0 returned is 'none'", () => {
    expect(listWindow(listNode({ path: "/api/jobs" }), { total: 0 }, 0)).toEqual({ empty: "none", note: null });
  });
  it("jobs {limit: 10} {total: 0} with 0 returned is 'none'", () => {
    expect(listWindow(listNode({ path: "/api/jobs", query: { limit: 10 } }), { total: 0 }, 0)).toEqual({ empty: "none", note: null });
  });
  it("kernels (unpaginated) with 0 returned is 'none'", () => {
    expect(listWindow(listNode({ path: "/api/kernels" }), {}, 0)).toEqual({ empty: "none", note: null });
  });
});

// ── The no-total fallback, on a scoped test-only profile ─────────────────────────────────
// Every paged LIST_PROFILES route declares its total now, so listWindow's reviewed fallback for a
// paged route WITHOUT one ("N returned; more may exist", and "none" only for an empty FIRST page of
// a positive limit) has no real route left. It stays for a future paged route that reports no
// total. These tests install a test-only profile for ONE call and always remove it.
const NO_TOTAL = "/api/test-paged-no-total";
function onPagedNoTotal<T>(fn: () => T): T {
  const profiles = LIST_PROFILES as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(profiles, NO_TOTAL)) throw new Error(NO_TOTAL + " is a real profile");
  profiles[NO_TOTAL] = { rows: "rows", title: ["id"], meta: [], status: [], paged: { defaultLimit: 50 } };
  try { return fn(); } finally { delete profiles[NO_TOTAL]; }
}

describe("N110 fallback for a paged route with no total (scoped test-only profile)", () => {
  it("every real paged profile declares its total, so the fallback has no real route today", () => {
    for (const [path, prof] of Object.entries(LIST_PROFILES)) if (prof.paged) expect(typeof prof.paged.total, path).toBe("string");
  });
  it("50 returned and no query: 50 returned; more may exist (the profile's own default page)", () => {
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL }), {}, 50).note)).toBe("50 returned; more may exist");
  });
  it("49 returned (under the default): no note", () => {
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL }), {}, 49).note)).toBeNull();
  });
  it("{limit:10} with 10 returned: 10 returned; more may exist, and `limit` is not a filter", () => {
    const r = onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL, query: { limit: 10 } }), {}, 10));
    expect(r).toEqual({ empty: "none", note: "10 returned; more may exist" });
  });
  it("{limit:\"x\"} (off-grammar) with 1 returned: 1 returned; more may exist", () => {
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL, query: { limit: "x" } }), {}, 1).note)).toBe("1 returned; more may exist");
  });
  it("an empty FIRST page of a positive limit is 'none'; an off-grammar limit's empty page is not", () => {
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL }), {}, 0))).toEqual({ empty: "none", note: null });
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL, query: { limit: 10 } }), {}, 0))).toEqual({ empty: "none", note: null });
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL, query: { limit: 0 } }), {}, 0)).empty).toBe("no rows in this window");
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL, query: { limit: "x" } }), {}, 0)).empty).toBe("no rows in this window");
  });
  it("the test-only profile never outlives its call", () => {
    onPagedNoTotal(() => undefined);
    expect(Object.prototype.hasOwnProperty.call(LIST_PROFILES, NO_TOTAL)).toBe(false);
  });
});

// ── N110 null case (#5992: elsewhere, an explicit null silently took the default) ─────────────
// genui's answer to #5992: the closed IR is not affected. A manifest or IR query value must be a
// string, a number or a boolean, so an explicit null never reaches a bound read; and listWindow
// reads null as UNKNOWN, never as the default. These tests pin all three layers.
function findListNode(v: unknown): { bind: { query: Record<string, unknown> } } | null {
  if (Array.isArray(v)) {
    for (const x of v) { const f = findListNode(x); if (f) return f; }
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.type === "list" && o.bind !== undefined) return o as unknown as { bind: { query: Record<string, unknown> } };
  for (const x of Object.values(o)) { const f = findListNode(x); if (f) return f; }
  return null;
}

describe("N110 null case: an explicit null query value is refused, and is never read as the default", () => {
  it("the manifest adapter refuses a null offset, limit or filter value; the same window with a number is accepted", () => {
    expect(dashboardManifestToIr(jobsManifest({ limit: 10 }) as never).ok).toBe(true);
    for (const query of [{ offset: null }, { limit: null }, { status: null }]) {
      const r = dashboardManifestToIr(jobsManifest(query) as never);
      expect(r.ok, JSON.stringify(query)).toBe(false);
      if (!r.ok) expect(r.reason, JSON.stringify(query)).toContain("query value type");
    }
  });

  it("validateIr refuses a list node whose bind.query holds a null (the IR boundary itself, not only the adapter)", () => {
    const base = dashboardManifestToIr(jobsManifest({ limit: 10 }) as never);
    if (!base.ok) throw new Error(base.reason);
    const doc = JSON.parse(JSON.stringify(base.doc)) as unknown;
    expect(validateIr(doc)).toEqual({ ok: true });
    const list = findListNode(doc);
    expect(list, "the adapter's IR has a bound list node").not.toBeNull();
    list!.bind.query.limit = null;
    const r = validateIr(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("query value type");
  });

  it("listWindow (a direct caller): a null offset is unknown, never 0", () => {
    // Read as 0, it would say "1 of 5 returned".
    expect(listWindow(listNode({ path: "/api/jobs", query: { offset: null } }), { total: 5 }, 1)).toEqual({ empty: "no rows in this window", note: "offset not shown · total not shown" });
  });

  it("listWindow: a null limit is unknown, never the default page, so it never vouches for 'none'", () => {
    // Read as absent, each of the first two would be "none", and the third would print no note (1 < 50).
    expect(listWindow(listNode({ path: "/api/jobs", query: { limit: null } }), { total: 0 }, 0).empty).toBe("no rows in this window");
    expect(listWindow(listNode({ path: "/api/capabilities", query: { limit: null } }), { total: 0 }, 0).empty).toBe("no rows in this window");
    expect(onPagedNoTotal(() => listWindow(listNode({ path: NO_TOTAL, query: { limit: null } }), {}, 1).note)).toBe("1 returned; more may exist");
  });

  it("listWindow: a null filter value is never printed raw, and forces 'no rows in this window'", () => {
    expect(listWindow(listNode({ path: "/api/jobs", query: { status: null } }), { total: 0 }, 0)).toEqual({ empty: "no rows in this window", note: "filtered by this view: status=(value not shown)" });
  });
});

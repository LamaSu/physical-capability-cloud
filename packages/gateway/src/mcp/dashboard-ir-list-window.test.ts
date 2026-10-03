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
 * disclosed total, proving the window note is part of the committed fingerprint.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";
import { LIST_PROFILES } from "./dashboard-ir.js";
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
    const r = listWindow(listNode({ path: "/api/jobs", query: { offset: 100 } }), undefined, 1);
    expect(r.note).toBe("from row 101");
    expect(r.empty).toBe("no rows in this window");
  });

  it("offset 'abc' (off-grammar): offset not shown (an unknown offset is never 0)", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { offset: "abc" } }), undefined, 1);
    expect(r.note).toBe("offset not shown");
    expect(r.empty).toBe("no rows in this window");
  });

  it("offset '0' (canonical string form): none", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { offset: "0" } }), undefined, 1);
    expect(r.empty).toBe("none");
  });

  it("capabilities {total:120} with 50 returned: showing 50 of 120", () => {
    const r = listWindow(listNode({ path: "/api/capabilities" }), { total: 120 }, 50);
    expect(r.note).toBe("showing 50 of 120");
  });

  it("capabilities total absent: total not shown", () => {
    const r = listWindow(listNode({ path: "/api/capabilities" }), {}, 19);
    expect(r.note).toBe("total not shown");
  });

  it("capabilities {total:\"120\"} (mistyped, and would be less than returned if parsed): total not shown", () => {
    const r = listWindow(listNode({ path: "/api/capabilities" }), { total: "120" }, 200);
    expect(r.note).toBe("total not shown");
  });

  it("jobs with 50 returned and no query: first 50; more may exist (the facade's own default)", () => {
    const r = listWindow(listNode({ path: "/api/jobs" }), undefined, 50);
    expect(r.note).toBe("first 50; more may exist");
  });

  it("jobs with 49 returned (under the default): null", () => {
    const r = listWindow(listNode({ path: "/api/jobs" }), undefined, 49);
    expect(r.note).toBeNull();
  });

  it("jobs {limit:10} with 10 returned: first 10; more may exist", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { limit: 10 } }), undefined, 10);
    expect(r.note).toBe("first 10; more may exist");
    expect(r.empty).toBe("none"); // `limit` is not a filter
  });

  it("jobs {limit:\"x\"} (off-grammar) with 1 returned: first 1; more may exist", () => {
    const r = listWindow(listNode({ path: "/api/jobs", query: { limit: "x" } }), undefined, 1);
    expect(r.note).toBe("first 1; more may exist");
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
});

describe("N110 server defaults are pinned against the real producers (never guessed)", () => {
  // Why: if the facade's own default page size ever drifts, the window's "first N; more may
  // exist" / "showing N of total" disclosure must drift WITH it, or it would silently lie about
  // how many rows the server actually hands back by default.
  it("LIST_PROFILES['/api/jobs'].paged.defaultLimit matches job.facade.ts's own default", () => {
    const text = readFileSync(resolve(HERE, "../facades/job.facade.ts"), "utf8");
    const m = /pagination\?\.limit\s*\?\?\s*(\d+)/.exec(text);
    expect(m, "job.facade.ts: could not find `pagination?.limit ?? <default>`").not.toBeNull();
    expect(LIST_PROFILES["/api/jobs"]!.paged!.defaultLimit).toBe(Number(m![1]));
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
    expect(s.q(".pcc-list .pcc-window").textContent).toBe("showing 2 of 120");
    await s.nextPoll();
    // must NOT become 121: an equal-timestamp update is undecidable by time alone when its
    // payload (here, only the window note) differs from what is shown, so it is rejected.
    expect(s.q(".pcc-list .pcc-window").textContent).toBe("showing 2 of 120");
    expect(s.q(".pcc-list").querySelectorAll(".pcc-row").length).toBe(2);
    expect(s.q(".pcc-list").className).not.toContain("pcc-unavail");
    s.close();
  });
});

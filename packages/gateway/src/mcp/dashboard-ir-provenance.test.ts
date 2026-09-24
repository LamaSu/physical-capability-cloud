/**
 * PX-4 render-state provenance: the authority class of every rendered datum is DERIVED by
 * the trusted side (structure + the server-owned bind registry), never chosen by a manifest
 * or by generated content; bound data carries a visible "as of" freshness line, is marked
 * stale past its source's budget or when a refresh fails, and can never regress to an older
 * snapshot. Unit tests over the audited modules + end-to-end over the REBUILT kit bytes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";
import { dashboardManifestToIr, validateIr, sourceClassOf, provenanceOf, type IrNode } from "./dashboard-ir.js";
import { asOfFrom, isStale, acceptsNewer, ASOF_MAX_SKEW_MS } from "./dashboard-ir-binder.js";
import { renderIrDoc, applyFreshness, type RElement, type RDocument } from "./dashboard-ir-renderer.js";

const KIT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"), "utf8");
const allNodes = (n: IrNode, out: IrNode[] = []): IrNode[] => { out.push(n); (n.children || []).forEach((c) => allNodes(c, out)); return out; };

const everyKind = {
  csd: "pcc://artifacts/dashboard/v1", title: "Ops",
  sections: [{ heading: "Sec", windows: [
    { kind: "note", text: "context written by an agent" },
    { kind: "metric", label: "Progress", select: "progress", binding: { path: "/api/jobs/j1/status" } },
    { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
    { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["status"] } },
    { kind: "receipt", binding: { path: "/api/escrow/e1" } },
  ] }],
};

describe("PX-4 derivation: the class is assigned by the source, never by the manifest", () => {
  const r = dashboardManifestToIr(everyKind as never);
  if (!r.ok) throw new Error("fixture must project: " + r.reason);
  const nodes = [r.doc.title, ...allNodes(r.doc.root)];

  it("manifest prose is always 'proposed'; bound data is its registered class; constants are not data", () => {
    for (const n of nodes) {
      const c = sourceClassOf(n);
      if (n.type === "heading" || n.type === "text" || n.type === "badge" || n.type === "field-label") expect(c, n.type).toBe("proposed");
      else if (n.bind) expect(c === "authoritative" || c === "accepted", n.type).toBe(true);
      else expect(c, n.type).toBeNull(); // root/section/receipt pointer/approval notice/...
    }
  });

  it("no IR node is ever classed as preference or ephemeral (presentation cannot occupy a data slot)", () => {
    for (const n of nodes) expect(["preference", "ephemeral"]).not.toContain(sourceClassOf(n));
  });

  it("every bound node carries registry provenance: A/B class, a schema id, a positive freshness budget", () => {
    const bound = nodes.filter((n) => n.bind);
    expect(bound.length).toBeGreaterThanOrEqual(3);
    for (const n of bound) {
      const p = provenanceOf(n)!;
      expect(["authoritative", "accepted"]).toContain(p.sourceClass);
      expect(p.schemaId.length).toBeGreaterThan(0);
      expect(p.maxAgeMs).toBeGreaterThan(0);
    }
  });

  it("run cards resolve the RUN policy (shared resolution with validateIr), not the capability one", () => {
    const run: IrNode = { type: "card", id: "n1", props: { kind: "run", statusFrom: "status", latestFrom: "status" }, bind: { path: "/api/jobs/j1", schema: "run-summary-v1" } };
    expect(provenanceOf(run)!.schemaId).toBe("run-summary-v1");
    const cap: IrNode = { type: "card", id: "n2", props: { kind: "capability" }, bind: { path: "/api/capabilities/c1", schema: "capability-summary-v1" } };
    expect(provenanceOf(cap)!.schemaId).toBe("capability-summary-v1");
  });

  it("a FORGED IR cannot carry its own class: an extra node key or prop is rejected by validateIr", () => {
    const forgedKey = { ir: "pcc-dashboard-ir/v1", title: { type: "heading", id: "n1", props: { level: 1, text: "t" }, untrusted: true },
      root: { type: "root", id: "n2", children: [{ type: "section", id: "n3", children: [
        { type: "text", id: "n4", props: { text: "Payment received" }, untrusted: true, sourceClass: "authoritative" }] }] } };
    expect(validateIr(forgedKey).ok).toBe(false);
    const forgedProp = JSON.parse(JSON.stringify(forgedKey));
    delete forgedProp.root.children[0].children[0].sourceClass;
    forgedProp.root.children[0].children[0].props.sourceClass = "authoritative";
    expect(validateIr(forgedProp).ok).toBe(false);
  });

  it("a manifest that CLAIMS authority gets none: its prose still derives 'proposed'", () => {
    const claim = { csd: "pcc://artifacts/dashboard/v1", title: "Receipt", sections: [{ windows: [
      { kind: "note", text: "Payment received", sourceClass: "authoritative", trustClass: "authoritative", authority: "A" },
    ] }] };
    const rc = dashboardManifestToIr(claim as never);
    if (rc.ok) {
      const texts = allNodes(rc.doc.root).filter((n) => n.type === "text");
      expect(texts.length).toBe(1);
      expect(sourceClassOf(texts[0]!)).toBe("proposed");
      expect(Object.keys(texts[0]!)).not.toContain("sourceClass");
    } else {
      expect(rc.ok).toBe(false); // rejecting the claim outright is also a correct outcome
    }
  });
});

describe("PX-4 freshness primitives (binder)", () => {
  const NOW = Date.parse("2026-09-24T12:00:00.000Z");
  it("asOfFrom trusts an own-property ISO asOf, else falls back to receipt time", () => {
    expect(asOfFrom({ asOf: "2026-09-24T11:59:00Z" }, NOW)).toBe("2026-09-24T11:59:00.000Z");
    const fb = new Date(NOW).toISOString();
    expect(asOfFrom({}, NOW)).toBe(fb);
    expect(asOfFrom({ asOf: 12345 }, NOW)).toBe(fb);
    expect(asOfFrom({ asOf: "not a date" }, NOW)).toBe(fb);
    expect(asOfFrom([{ asOf: "2026-09-24T11:59:00Z" }], NOW)).toBe(fb);
    expect(asOfFrom(null, NOW)).toBe(fb);
    expect(asOfFrom(Object.create({ asOf: "2026-09-24T11:59:00Z" }), NOW)).toBe(fb); // inherited: ignored
  });
  it("a future-dated asOf beyond the skew is NOT trusted (it would freeze the view forever)", () => {
    const fb = new Date(NOW).toISOString();
    expect(asOfFrom({ asOf: new Date(NOW + ASOF_MAX_SKEW_MS + 1000).toISOString() }, NOW)).toBe(fb);
    expect(asOfFrom({ asOf: new Date(NOW + 30_000).toISOString() }, NOW)).toBe(new Date(NOW + 30_000).toISOString()); // small skew ok
  });
  it("isStale compares against the source budget", () => {
    expect(isStale(new Date(NOW - 60_000).toISOString(), 120_000, NOW)).toBe(false);
    expect(isStale(new Date(NOW - 180_000).toISOString(), 120_000, NOW)).toBe(true);
    expect(isStale("garbage", 120_000, NOW)).toBe(true);
  });
  it("acceptsNewer: first datum and newer/equal updates pass; an OLDER one never does", () => {
    expect(acceptsNewer(null, "2026-09-24T11:00:00.000Z")).toBe(true);
    expect(acceptsNewer("2026-09-24T11:00:00.000Z", "2026-09-24T11:00:00.000Z")).toBe(true);
    expect(acceptsNewer("2026-09-24T11:00:00.000Z", "2026-09-24T11:05:00.000Z")).toBe(true);
    expect(acceptsNewer("2026-09-24T11:05:00.000Z", "2026-09-24T11:00:00.000Z")).toBe(false);
  });
});

describe("PX-4 renderer markers (fake DOM)", () => {
  type FE = RElement & { attrs: Record<string, string> };
  const mk = (): FE => { const children: RElement[] = []; const attrs: Record<string, string> = {};
    return { textContent: "", className: "", children, attrs, setAttr(n: string, v: string) { attrs[n] = v; }, appendChild(c: RElement) { children.push(c); return c; } } as FE; };
  const doc: RDocument = { createElement: () => mk() };
  const walk = (e: RElement, out: FE[] = []): FE[] => { out.push(e as FE); e.children.forEach((c) => walk(c, out)); return out; };

  it("paint stamps data-source: prose 'proposed', bound 'authoritative'; nothing else", () => {
    const r = dashboardManifestToIr(everyKind as never); if (!r.ok) throw new Error(r.reason);
    const mount = mk(); renderIrDoc(doc, mount, r.doc);
    const els = walk(mount);
    const sources = els.map((e) => e.attrs["data-source"]).filter(Boolean);
    expect(sources).toContain("proposed");
    expect(sources).toContain("authoritative");
    for (const s of sources) expect(["proposed", "authoritative", "accepted"]).toContain(s);
    for (const e of els) if (e.attrs["data-source"]) expect(e.className).toContain("pcc-src-" + e.attrs["data-source"]);
  });

  it("applyFreshness writes a visible text line and toggles the stale class idempotently", () => {
    const host = mk(), meta = mk(); host.className = "pcc-stat pcc-src-authoritative";
    applyFreshness(host, meta, "2026-09-24T10:12:33.000Z", false);
    expect(meta.textContent).toBe("as of 10:12:33Z");
    expect(host.attrs["data-as-of"]).toBe("2026-09-24T10:12:33.000Z");
    expect(host.className).not.toContain("pcc-stale");
    applyFreshness(host, meta, "2026-09-24T10:12:33.000Z", true);
    applyFreshness(host, meta, "2026-09-24T10:12:33.000Z", true);
    expect(meta.textContent).toBe("as of 10:12:33Z · stale");
    expect(host.className.split(" ").filter((c) => c === "pcc-stale").length).toBe(1);
    applyFreshness(host, meta, "2026-09-24T10:15:00.000Z", false);
    expect(host.className).not.toContain("pcc-stale");
  });
});

// ── end-to-end over the REBUILT kit bytes (fresh jsdom per case) ──────────────────
const PROTOCOL = "2026-01-26";
const statManifest = { csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec A", windows: [
  { kind: "note", text: "agent context" },
  { kind: "metric", label: "Progress", select: "progress", binding: { path: "/api/jobs/j1/status" } },
] }] };
type Reply = { status: number; json?: unknown };
function scene(replies: Reply[], nowMs: number) {
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
  w.__PCC_IR_ORIGIN__ = "https://capability.network";
  let call = 0;
  w.fetch = () => {
    const r = replies[Math.min(call++, replies.length - 1)]!;
    const bytes = new NodeTextEncoder().encode(JSON.stringify(r.json ?? {}));
    let sent = false;
    return Promise.resolve({
      status: r.status, redirected: false,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => {} }), cancel: async () => {} },
    });
  };
  w.eval(KIT);
  w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL } } }));
  const deliver = (m: unknown) => w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: w.JSON.parse(w.JSON.stringify(m)) } } } }));
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  /** Advance to the next POLL tick (skip the per-request timeout timers). */
  const nextPoll = async () => {
    const polls = timers.filter((t) => t.at - now >= 5000 && t.at - now < 60_000).sort((a, b) => a.at - b.at);
    const t = polls[0]; if (!t) throw new Error("no poll timer scheduled");
    timers.splice(timers.indexOf(t), 1); now = t.at; t.fn(); await settle();
  };
  const stat = () => w.document.querySelector(".pcc-stat") as any;
  const fresh = () => (stat()?.nextElementSibling as any);
  return { w, deliver, settle, nextPoll, stat, fresh, setNow: (t: number) => { now = t; }, close: () => w.close() };
}
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("PX-4 end-to-end on the rebuilt pcc-ir-kit.js", () => {
  it("prose is marked proposed; bound data authoritative with a fresh 'as of' line", async () => {
    const s = scene([{ status: 200, json: { progress: 42, asOf: iso(T0 - 10_000) } }], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.w.document.querySelector(".pcc-text")!.getAttribute("data-source")).toBe("proposed");
    expect(s.w.document.querySelector(".pcc-heading")!.getAttribute("data-source")).toBe("proposed");
    expect(s.stat().getAttribute("data-source")).toBe("authoritative");
    expect(s.stat().textContent).toContain("42");
    expect(s.stat().getAttribute("data-as-of")).toBe(iso(T0 - 10_000));
    expect(s.fresh().textContent).toBe("as of 11:59:50Z");
    expect(s.stat().className).not.toContain("pcc-stale");
    s.close();
  });

  it("data older than its source budget renders visibly STALE on arrival", async () => {
    const s = scene([{ status: 200, json: { progress: 42, asOf: iso(T0 - 10 * 60_000) } }], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.stat().className).toContain("pcc-stale");
    expect(s.fresh().textContent).toContain("stale");
    s.close();
  });

  it("an OLDER snapshot (reconnect / out-of-order poll) never regresses the view", async () => {
    const s = scene([
      { status: 200, json: { progress: 80, asOf: iso(T0 - 5_000) } },
      { status: 200, json: { progress: 10, asOf: iso(T0 - 60_000) } }, // older state arriving late
    ], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.stat().textContent).toContain("80");
    await s.nextPoll();
    expect(s.stat().textContent).toContain("80");
    expect(s.stat().textContent).not.toContain("10");
    expect(s.stat().getAttribute("data-as-of")).toBe(iso(T0 - 5_000));
    s.close();
  });

  it("a FAILED refresh marks the shown datum stale (never implied current)", async () => {
    const s = scene([
      { status: 200, json: { progress: 55, asOf: iso(T0 - 1_000) } },
      { status: 500 },
    ], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.fresh().textContent).not.toContain("stale");
    await s.nextPoll();
    expect(s.stat().textContent).toContain("55");
    expect(s.fresh().textContent).toContain("stale");
    expect(s.stat().className).toContain("pcc-stale");
    s.close();
  });

  it("a future-dated asOf cannot freeze the view against later real updates", async () => {
    const s = scene([
      { status: 200, json: { progress: 1, asOf: iso(T0 + 24 * 3600_000) } }, // bogus far future
      { status: 200, json: { progress: 2, asOf: iso(T0 + 20_000) } },
    ], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.stat().getAttribute("data-as-of")).toBe(iso(T0)); // fell back to receipt time
    await s.nextPoll();
    expect(s.stat().textContent).toContain("2"); // the later real update was accepted
    s.close();
  });
});

// ── absence is not evidence: failure and off-schema payloads (found by a live trace) ──────
// Production `/api/kernels` answers `{ kernels: [...] }` and `/api/jobs` answers 401 to an
// anonymous read. Before this, both rendered as an EMPTY authoritative list (the first with a
// fresh "as of" line), which reads as "none". They must say "unavailable" instead.
const listManifest = { csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec L", windows: [
  { kind: "list", binding: { path: "/api/capabilities" }, item: { title: "name", statusFrom: "available" } },
] }] };
const listOf = (s: ReturnType<typeof scene>) => s.w.document.querySelector(".pcc-list") as any;
const lineOf = (s: ReturnType<typeof scene>) => listOf(s).nextElementSibling as any;
const rowsOf = (s: ReturnType<typeof scene>) => Array.from(listOf(s).querySelectorAll(".pcc-row")).map((r: any) => r.textContent);

describe("PX-4 absence is not evidence (rebuilt kit)", () => {
  it("a FIRST read that fails says 'unavailable · HTTP 401', never an empty authoritative list", async () => {
    const s = scene([{ status: 401 }], T0);
    s.deliver(listManifest); await s.settle();
    expect(listOf(s).className).toContain("pcc-unavail");
    expect(lineOf(s).textContent).toBe("unavailable · HTTP 401");
    expect(listOf(s).getAttribute("data-as-of")).toBeNull(); // nothing was observed
    expect(rowsOf(s)).toEqual([]);
    expect(listOf(s).querySelector(".pcc-empty")).toBeNull(); // and it does NOT claim "none"
    s.close();
  });

  it("a failed first read of a stat says unavailable, not a value", async () => {
    const s = scene([{ status: 503 }], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.stat().className).toContain("pcc-unavail");
    expect(s.fresh().textContent).toBe("unavailable · HTTP 503");
    expect(s.stat().getAttribute("data-as-of")).toBeNull();
    s.close();
  });

  it("a payload that is not a collection is unreadable, not an empty list", async () => {
    const s = scene([{ status: 200, json: { kernels: [{ name: "k1", status: "online" }] } }], T0);
    s.deliver(listManifest); await s.settle();
    expect(listOf(s).className).toContain("pcc-unavail");
    expect(lineOf(s).textContent).toBe("unavailable · unexpected response shape");
    expect(listOf(s).getAttribute("data-as-of")).toBeNull();
    expect(rowsOf(s)).toEqual([]);
    s.close();
  });

  it("rows present but none readable is unreadable, not 'none'", async () => {
    const s = scene([{ status: 200, json: { items: [{ nope: 1 }, { nope: 2 }] } }], T0);
    s.deliver(listManifest); await s.settle();
    expect(listOf(s).className).toContain("pcc-unavail");
    expect(listOf(s).querySelector(".pcc-empty")).toBeNull();
    s.close();
  });

  it("a genuinely empty collection is a valid state: 'none', as of its time", async () => {
    const s = scene([{ status: 200, json: { items: [], asOf: iso(T0 - 1_000) } }], T0);
    s.deliver(listManifest); await s.settle();
    expect(listOf(s).querySelector(".pcc-empty")!.textContent).toBe("none");
    expect(lineOf(s).textContent).toBe("as of 11:59:59Z");
    expect(listOf(s).className).not.toContain("pcc-unavail");
    s.close();
  });

  it("after good rows, an off-schema refresh KEEPS the rows and marks them stale", async () => {
    const s = scene([
      { status: 200, json: { items: [{ name: "Alpha", available: true }], asOf: iso(T0 - 1_000) } },
      { status: 200, json: { kernels: [] } },
    ], T0);
    s.deliver(listManifest); await s.settle();
    expect(rowsOf(s)).toEqual(["Alphatrue"]);
    await s.nextPoll();
    expect(rowsOf(s)).toEqual(["Alphatrue"]); // not wiped by the rejected payload
    expect(listOf(s).className).toContain("pcc-stale");
    expect(lineOf(s).textContent).toBe("as of 11:59:59Z · stale");
    s.close();
  });

  it("'unavailable' recovers to fresh data on the next good read", async () => {
    const s = scene([
      { status: 401 },
      { status: 200, json: { items: [{ name: "Beta", available: false }], asOf: iso(T0 + 5_000) } },
    ], T0);
    // A declared 10s poll, so the one-failure backoff (x2) lands inside the harness's poll window.
    const fast = JSON.parse(JSON.stringify(listManifest));
    fast.sections[0].windows[0].binding.pollMs = 10_000;
    s.deliver(fast); await s.settle();
    expect(listOf(s).className).toContain("pcc-unavail");
    await s.nextPoll();
    expect(rowsOf(s)).toEqual(["Betafalse"]);
    expect(listOf(s).className).not.toContain("pcc-unavail");
    expect(lineOf(s).textContent).toMatch(/^as of \d{2}:\d{2}:\d{2}Z$/);
    s.close();
  });
});

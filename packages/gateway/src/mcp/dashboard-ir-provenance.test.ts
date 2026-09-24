/**
 * PX-4 render-state provenance: the authority class of every rendered datum is DERIVED by
 * the trusted side (structure + the server-owned bind registry), never chosen by a manifest
 * or by generated content. Bound data is "fresh" only with a SOURCE read time and only within
 * its budget (a timer expires it); a failed, off-schema, partial or empty-without-time read
 * CLEARS the view and says "unavailable"; an older snapshot never regresses the view, across
 * binding restarts too. Unit tests over the audited modules + end-to-end over the REBUILT kit.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";
import { dashboardManifestToIr, validateIr, sourceClassOf, provenanceOf, type IrNode } from "./dashboard-ir.js";
import { sourceAsOf, isStale, acceptsNewer, ASOF_MAX_SKEW_MS } from "./dashboard-ir-binder.js";
import { renderIrDoc, applyFreshness, applyUnknownTime, applyUnavailable, type RElement, type RDocument } from "./dashboard-ir-renderer.js";

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
  it("sourceAsOf trusts only an own-property ISO asOf; receipt time is NOT a substitute", () => {
    expect(sourceAsOf({ asOf: "2026-09-24T11:59:00Z" }, NOW)).toBe("2026-09-24T11:59:00.000Z");
    for (const d of [{}, { asOf: 12345 }, { asOf: "not a date" }, [{ asOf: "2026-09-24T11:59:00Z" }], null, Object.create({ asOf: "2026-09-24T11:59:00Z" })]) {
      expect(sourceAsOf(d, NOW), JSON.stringify(d)).toBeNull();
    }
  });
  it("a future-dated asOf beyond the skew is not trusted (it would freeze the view forever)", () => {
    expect(sourceAsOf({ asOf: new Date(NOW + ASOF_MAX_SKEW_MS + 1000).toISOString() }, NOW)).toBeNull();
    expect(sourceAsOf({ asOf: new Date(NOW + 30_000).toISOString() }, NOW)).toBe(new Date(NOW + 30_000).toISOString()); // small skew ok
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
    return { textContent: "", className: "", children, attrs, setAttr(n: string, v: string) { attrs[n] = v; }, removeAttr(n: string) { delete attrs[n]; }, appendChild(c: RElement) { children.push(c); return c; } } as FE; };
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

  it("applyFreshness labels the SOURCE read time with its date and toggles stale idempotently", () => {
    const host = mk(), meta = mk(); host.className = "pcc-stat pcc-src-authoritative";
    applyFreshness(host, meta, "2026-09-24T10:12:33.000Z", false);
    expect(meta.textContent).toBe("source read 2026-09-24 10:12:33Z");
    expect(host.attrs["data-as-of"]).toBe("2026-09-24T10:12:33.000Z");
    expect(host.className).not.toContain("pcc-stale");
    applyFreshness(host, meta, "2026-09-24T10:12:33.000Z", true);
    applyFreshness(host, meta, "2026-09-24T10:12:33.000Z", true);
    expect(meta.textContent).toBe("source read 2026-09-24 10:12:33Z · stale");
    expect(host.className.split(" ").filter((c) => c === "pcc-stale").length).toBe(1);
  });

  it("unknown source time and unavailability drop data-as-of and say so", () => {
    const host = mk(), meta = mk();
    applyFreshness(host, meta, "2026-09-24T10:12:33.000Z", false);
    applyUnknownTime(host, meta, "2026-09-24T10:13:00.000Z");
    expect(host.attrs["data-as-of"]).toBeUndefined();
    expect(meta.textContent).toBe("source time not reported · received 2026-09-24 10:13:00Z");
    expect(host.className).toContain("pcc-time-unknown");
    applyUnavailable(host, meta, "HTTP 500");
    expect(host.className).toContain("pcc-unavail");
    expect(host.className).not.toContain("pcc-time-unknown");
    expect(meta.textContent).toBe("unavailable · HTTP 500");
  });
});

// ── end-to-end over the REBUILT kit bytes (fresh jsdom per case) ──────────────────
const PROTOCOL = "2026-01-26";
const statManifest = { csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec A", windows: [
  { kind: "note", text: "agent context" },
  { kind: "metric", label: "Progress", select: "progress", binding: { path: "/api/jobs/j1/status" } },
] }] };
const listManifest = { csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec L", windows: [
  { kind: "list", binding: { path: "/api/capabilities" }, item: { title: "name", meta: ["type"], statusFrom: "available" } },
] }] };
const cardManifest = { csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec C", windows: [
  { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
] }] };
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
  /** Advance the clock by `ms`, firing every timer that falls due, in time order. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1); now = Math.max(now, due.at); due.fn(); await settle();
    }
    now = end;
  };
  const setHidden = async (h: boolean) => { hidden = h; w.document.dispatchEvent(new w.Event("visibilitychange")); await settle(); };
  const q = (sel: string) => w.document.querySelector(sel) as any;
  const stat = () => q(".pcc-stat");
  const lineOf = (el: any) => el?.nextElementSibling as any;
  const fresh = () => lineOf(stat());
  return { w, deliver, settle, nextPoll, advance, setHidden, q, stat, lineOf, fresh, close: () => w.close() };
}
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const value = (s: ReturnType<typeof scene>) => (s.stat().querySelector(".pcc-value")!.textContent as string);

describe("PX-4 end-to-end on the rebuilt pcc-ir-kit.js", () => {
  it("prose is marked proposed; bound data authoritative with a dated source-read line", async () => {
    const s = scene([{ status: 200, json: { progress: 42, asOf: iso(T0 - 10_000) } }], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.w.document.querySelector(".pcc-text")!.getAttribute("data-source")).toBe("proposed");
    expect(s.w.document.querySelector(".pcc-heading")!.getAttribute("data-source")).toBe("proposed");
    expect(s.stat().getAttribute("data-source")).toBe("authoritative");
    expect(value(s)).toBe("42");
    expect(s.stat().getAttribute("data-as-of")).toBe(iso(T0 - 10_000));
    expect(s.fresh().textContent).toBe("source read 2026-09-24 11:59:50Z");
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
      { status: 200, json: { progress: 10, asOf: iso(T0 - 60_000) } },
    ], T0);
    s.deliver(statManifest); await s.settle();
    expect(value(s)).toBe("80");
    await s.nextPoll();
    expect(value(s)).toBe("80");
    expect(s.stat().getAttribute("data-as-of")).toBe(iso(T0 - 5_000));
    s.close();
  });

  it("a future-dated asOf is not a source time: shown as time-unknown, and cannot freeze later updates", async () => {
    const s = scene([
      { status: 200, json: { progress: 1, asOf: iso(T0 + 24 * 3600_000) } }, // bogus far future
      { status: 200, json: { progress: 2, asOf: iso(T0 + 20_000) } },
    ], T0);
    s.deliver(statManifest); await s.settle();
    expect(s.stat().getAttribute("data-as-of")).toBeNull();
    expect(s.fresh().textContent).toContain("source time not reported");
    await s.nextPoll();
    expect(value(s)).toBe("2"); // the later timed update was accepted
    s.close();
  });
});

describe("PX-4 review #2524, absence: every failed, off-schema, partial or empty read says unavailable", () => {
  it("a failed refresh CLEARS the shown value (never last-known) and says why", async () => {
    const s = scene([{ status: 200, json: { progress: 55, asOf: iso(T0 - 1_000) } }, { status: 500 }], T0);
    s.deliver(statManifest); await s.settle();
    expect(value(s)).toBe("55");
    await s.nextPoll();
    expect(value(s)).toBe("");
    expect(s.stat().className).toContain("pcc-unavail");
    expect(s.stat().getAttribute("data-as-of")).toBeNull();
    expect(s.fresh().textContent).toBe("unavailable · HTTP 500");
    s.close();
  });

  for (const [label, reply, why] of [
    ["a metric response missing its field", { status: 200, json: { asOf: iso(T0) } }, "missing field"],
    ["a metric field of the wrong type", { status: 200, json: { progress: "42%", asOf: iso(T0) } }, "mistyped field"],
    ["HTTP 200 with the wrong content type", { status: 200, raw: "<html>ok</html>", ct: "text/html" }, "unexpected content type"],
    ["unreadable JSON", { status: 200, raw: "{not json" }, "unreadable response"],
    ["an empty (null) body", { status: 200, raw: "null" }, "empty response"],
  ] as Array<[string, Reply, string]>) {
    it(`${label} is unavailable ("${why}"), never a default value`, async () => {
      const s = scene([reply], T0);
      s.deliver(statManifest); await s.settle();
      expect(s.stat().className).toContain("pcc-unavail");
      expect(value(s)).toBe("");
      expect(s.fresh().textContent).toBe("unavailable · " + why);
      s.close();
    });
  }

  it("a card missing a required field is unavailable, not a partial card", async () => {
    const s = scene([{ status: 200, json: { type: "pizza", asOf: iso(T0) } }], T0);
    s.deliver(cardManifest); await s.settle();
    const card = s.q(".pcc-schema-card");
    expect(card.className).toContain("pcc-unavail");
    expect(s.lineOf(card).textContent).toBe("unavailable · missing required fields");
    for (const v of Array.from(card.querySelectorAll(".pcc-value")) as any[]) expect(v.textContent).toBe("");
    s.close();
  });

  it("a partial collection is unavailable (no fresh rows for the readable part)", async () => {
    const s = scene([{ status: 200, json: { items: [{ name: "Alpha", type: "t", available: true }, { nope: 1 }], asOf: iso(T0) } }], T0);
    s.deliver(listManifest); await s.settle();
    const list = s.q(".pcc-list");
    expect(list.className).toContain("pcc-unavail");
    expect(list.querySelectorAll(".pcc-row").length).toBe(0);
    expect(s.lineOf(list).textContent).toBe("unavailable · partial collection");
    s.close();
  });

  it("empty-read policy: 'none' only when the source vouches for its read time", async () => {
    const withTime = scene([{ status: 200, json: { items: [], asOf: iso(T0 - 1_000) } }], T0);
    withTime.deliver(listManifest); await withTime.settle();
    expect(withTime.q(".pcc-list .pcc-empty").textContent).toBe("none");
    expect(withTime.lineOf(withTime.q(".pcc-list")).textContent).toBe("source read 2026-09-24 11:59:59Z");
    withTime.close();
    const noTime = scene([{ status: 200, json: { items: [] } }], T0);
    noTime.deliver(listManifest); await noTime.settle();
    expect(noTime.q(".pcc-list .pcc-empty")).toBeNull();
    expect(noTime.lineOf(noTime.q(".pcc-list")).textContent).toBe("unavailable · empty result without a source time");
    noTime.close();
  });

  it("a row missing a selected field shows 'not reported', never silently omits it", async () => {
    const s = scene([{ status: 200, json: { items: [{ name: "Alpha" }], asOf: iso(T0) } }], T0);
    s.deliver(listManifest); await s.settle();
    const row = s.q(".pcc-list .pcc-row");
    expect(row.textContent).toContain("Alpha");
    expect(Array.from(row.querySelectorAll(".pcc-absent")).map((e: any) => e.textContent)).toEqual(["not reported", "not reported"]);
    s.close();
  });

  it("operator free text that states money is withheld in list rows", async () => {
    const s = scene([{ status: 200, json: { items: [{ name: "PAID - verified 100 USDC", type: "t", available: true }], asOf: iso(T0) } }], T0);
    s.deliver(listManifest); await s.settle();
    const row = s.q(".pcc-list .pcc-row");
    expect(row.textContent).not.toContain("PAID");
    expect(row.textContent).toContain("withheld: stated money");
    s.close();
  });

  it("with no trusted origin, every bound element says unavailable (never sits empty)", async () => {
    const s = scene([{ status: 200, json: { progress: 1, asOf: iso(T0) } }], T0, { origin: false });
    s.deliver(statManifest); await s.settle();
    expect(s.stat().className).toContain("pcc-unavail");
    expect(s.fresh().textContent).toBe("unavailable · no live data source");
    s.close();
  });
});

describe("PX-4 review #2524, freshness: expires on its own; missing source time is unknown", () => {
  it("a fresh datum turns stale when its budget passes, without any new read", async () => {
    // metric budget 120 s; long poll so no read happens in between
    const m = JSON.parse(JSON.stringify(statManifest)); m.sections[0].windows[1].binding.pollMs = 3_600_000;
    const s = scene([{ status: 200, json: { progress: 5, asOf: iso(T0 - 10_000) } }], T0);
    s.deliver(m); await s.settle();
    expect(s.stat().className).not.toContain("pcc-stale");
    await s.advance(115_000);
    expect(s.stat().className).toContain("pcc-stale");
    expect(s.fresh().textContent).toBe("source read 2026-09-24 11:59:50Z · stale");
    s.close();
  });

  it("data without a source time is never presented as fresh", async () => {
    const s = scene([{ status: 200, json: { progress: 7 } }], T0);
    s.deliver(statManifest); await s.settle();
    expect(value(s)).toBe("7");
    expect(s.stat().getAttribute("data-as-of")).toBeNull();
    expect(s.stat().className).toContain("pcc-time-unknown");
    expect(s.fresh().textContent).toBe("source time not reported · received 2026-09-24 12:00:00Z");
    s.close();
  });

  it("the session cap ends updates: the view says unavailable instead of keeping old values", async () => {
    const m = JSON.parse(JSON.stringify(statManifest)); m.sections[0].windows[1].binding.pollMs = 3_600_000;
    const s = scene([{ status: 200, json: { progress: 9, asOf: iso(T0) } }], T0);
    s.deliver(m); await s.settle();
    await s.advance(31 * 60_000);
    expect(value(s)).toBe("");
    expect(s.fresh().textContent).toBe("unavailable · updates stopped");
    s.close();
  });
});

describe("PX-4 review #2524, regression: the watermark and the metadata line survive restarts", () => {
  it("after hide/show, an older snapshot still cannot overwrite a newer one, and one line remains", async () => {
    const s = scene([
      { status: 200, json: { progress: 80, asOf: iso(T0 - 1_000) } },
      { status: 200, json: { progress: 10, asOf: iso(T0 - 60_000) } }, // T1 < T2, served after the restart
    ], T0);
    s.deliver(statManifest); await s.settle();
    expect(value(s)).toBe("80");
    await s.setHidden(true);
    await s.setHidden(false); // restart: startBinds on the existing DOM
    await s.settle();
    expect(value(s)).toBe("80");
    expect(s.stat().getAttribute("data-as-of")).toBe(iso(T0 - 1_000));
    const lines = Array.from(s.w.document.querySelectorAll(".pcc-fresh"));
    expect(lines.length).toBe(1);
    s.close();
  });

  it("a resume re-checks freshness immediately", async () => {
    const m = JSON.parse(JSON.stringify(statManifest)); m.sections[0].windows[1].binding.pollMs = 3_600_000;
    const s = scene([{ status: 200, json: { progress: 3, asOf: iso(T0 - 10_000) } }, { status: 503 }], T0);
    s.deliver(m); await s.settle();
    await s.setHidden(true);
    await s.advance(200_000); // hidden: past the 120 s budget
    await s.setHidden(false);
    expect(s.stat().className).toMatch(/pcc-stale|pcc-unavail/);
    s.close();
  });
});

describe("PX-4 contrast (pcc-design #2540)", () => {
  it("marker lines are not dimmed by stacked opacity", async () => {
    const view = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "./mcp-app-view.ts"), "utf8");
    for (const cls of ["pcc-fresh", "pcc-stale", "pcc-unavail", "pcc-empty", "pcc-time-unknown"]) {
      const rules = view.match(new RegExp("\\." + cls + "[^{]*\\{[^}]*\\}", "g")) ?? [];
      for (const r of rules) expect(r, cls).not.toMatch(/opacity\s*:\s*0?\.\d/);
    }
  });
});

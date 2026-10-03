/**
 * PX-5 (#344) cross-family review, astra via coord-watch #2504. Each finding is pinned here:
 *  - manifest prose cannot present money (title, headings, notes, action and field labels);
 *  - lists show only a PCC-owned field profile per route; escrow is not listable;
 *  - the row cap holds when the manifest omits `limit`;
 *  - a malformed field type is refused, never thrown; the kit fails inert on any exception;
 *  - binding query keys are per-route allowlisted (no tokens in URLs);
 *  - every bindable route carries an effect review, pinned to BIND_POLICY.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import {
  dashboardManifestToIr, validateIr, WITHHELD_PROSE, isMoneyClaim, LIST_ROW_CAP,
  EFFECT_REVIEWED_READS, bindPolicyRouteSources, reviewedRouteSource,
  RECORD_STATUS_NOTE, isMoneyState, recordValueText,
  WITHHELD_FIELD, RECORD_CLAIM_NOTE, boundValueText, isProseClaim, statesAmount, mentionsWithheld,
  SAFE_STATUS_WORDS, LIST_PROFILES, LIST_FIELD_KINDS, listRowsOf, REPORTED_PREFIX,
  identifierText,
} from "./dashboard-ir.js";
import type { IrDoc, IrNode } from "./dashboard-ir.js";
import { bindListRows, bindScalar, bindSchemaCard, renderIrDoc, UNAVAILABLE } from "./dashboard-ir-renderer.js";
import { buildMcpAppIrDashboardHtml } from "./mcp-app-view.js";
import type { RDocument, RElement } from "./dashboard-ir-renderer.js";

const KIT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"), "utf8");
const CSD = "pcc://artifacts/dashboard/v1";
const man = (windows: unknown[], title = "Ops", heading = "Sec") => ({ csd: CSD, title, sections: [{ heading, windows }] });
function proseOf(n: IrNode | undefined, out: string[] = []): string[] {
  if (!n) return out;
  const p = (n.props ?? {}) as { text?: unknown; label?: unknown };
  if (n.untrusted && typeof p.text === "string") out.push(p.text);
  if (n.untrusted && typeof p.label === "string") out.push(p.label);
  for (const c of n.children ?? []) proseOf(c, out);
  return out;
}
const ok = (m: unknown) => { const r = dashboardManifestToIr(m as never); if (!r.ok) throw new Error(r.reason); return r.doc; };
/** PCC's structural withheld notices at or under `n` (astra r2 F4: a node, not a prose string). */
function withheldOf(n: IrNode | undefined): number {
  if (!n) return 0;
  return (n.props?.withheld === true ? 1 : 0) + (n.children ?? []).reduce((a, c) => a + withheldOf(c), 0);
}

// Module-scope fake DOM + text-flattener, moved up from the "astra r3 (#344 @e909337a) and #348 r2
// F1" describe (unchanged) so every describe — including astra r4's below — can reuse one copy.
type FakeEl = RElement & { attrs: Record<string, string> };
const fdoc: RDocument = { createElement(): RElement {
  const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
  return e;
} };
const textOf = (e: RElement): string => e.textContent + (e.children as RElement[]).map(textOf).join(" ");

describe("#344 money: manifest prose cannot present money", () => {
  it("amounts and payment/verification claims are withheld in every prose slot", () => {
    // Title and form-field title say "Balance confirmed", not bare "Balance": astra r3 moved
    // "balance" out of the strict claim list into the noun-only pair rule (M4 fix), so a bare
    // noun label no longer self-triggers — it takes a paired GENERIC word ("confirmed") within 3
    // words to withhold it, exactly like "payment received"/"payout approved".
    const doc = ok({
      csd: CSD, title: "Balance confirmed",
      sections: [{ heading: "Payment received - verified", windows: [
        { kind: "note", text: "1,000,000 USDC" },
        { kind: "note", text: "$12.50 on the way" },
        { kind: "note", text: "Pаid in full" },             // Cyrillic 'a'
        { kind: "note", text: "ｐａｉｄ" },       // fullwidth "paid"
        { kind: "note", text: "Settle\u200Bd yesterday" },        // zero-width space
        { kind: "actions", actions: [{ id: "a", label: "Refunded" }] },
        { kind: "form", schema: { type: "object", properties: { b: { type: "number", title: "Balance confirmed" } } } },
        { kind: "note", text: "Pick a kernel near you" },         // benign prose stays
      ] }],
    });
    const prose = [...proseOf(doc.title), ...proseOf(doc.root)];
    expect(withheldOf(doc.title) + withheldOf(doc.root)).toBe(9); // PCC's notice nodes carry no agent words
    expect(prose).toEqual(["Pick a kernel near you"]);
    for (const t of prose) expect(isMoneyClaim(t), t).toBe(false);
    expect(validateIr(doc)).toEqual({ ok: true });
  });

  it("a directly forged IR whose prose states money is rejected by the validator", () => {
    const doc = ok(man([{ kind: "note", text: "fine" }]));
    const forged = JSON.parse(JSON.stringify(doc)) as IrDoc;
    (forged.root.children![0]!.children![1]!.props as { text: string }).text = "Paid 5 USDC - verified";
    const r = validateIr(forged);
    expect(r.ok).toBe(false);
  });

  it("the withheld notice itself is not a money claim (it cannot self-trigger)", () => {
    expect(isMoneyClaim(WITHHELD_PROSE)).toBe(false);
  });
});

describe("#344 money: lists show only a PCC-owned field profile", () => {
  const list = (path: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    dashboardManifestToIr(man([{ kind: "list", binding: { path, ...extra }, item }]) as never);

  it("astra's example (pricing.baseCost as a row title) is refused", () => {
    const r = list("/api/capabilities", { title: "pricing.baseCost", meta: ["pricing.currency"], statusFrom: "available" });
    expect(r.ok).toBe(false);
  });

  it("money fields are refused as title, meta or status on every list route", () => {
    for (const [path, item] of [
      ["/api/capabilities", { title: "name", meta: ["pricing.baseCost"] }],
      ["/api/capabilities", { title: "name", statusFrom: "pricing.currency" }],
      ["/api/jobs", { title: "id", meta: ["price"] }],
      ["/api/jobs", { title: "escrowAddress" }],
      ["/api/kernels", { title: "name", meta: ["operatorAddress"] }],
      ["/api/jobs", { title: "proposal.text" }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(list(path, item).ok, `${path} ${JSON.stringify(item)}`).toBe(false);
    }
  });

  it("escrow is not a list route", () => {
    expect(list("/api/escrow", { title: "id" }).ok).toBe(false);
  });

  it("profile fields still work", () => {
    expect(list("/api/capabilities", { title: "name", meta: ["type"], statusFrom: "available" }).ok).toBe(true);
    expect(list("/api/jobs", { title: "id", meta: ["kernelId", "status"], statusFrom: "status" }).ok).toBe(true);
    expect(list("/api/kernels", { title: "name", statusFrom: "status" }).ok).toBe(true);
  });

  it("a forged IR list with an off-profile selector is rejected by the validator", () => {
    const doc = ok(man([{ kind: "list", binding: { path: "/api/capabilities" }, item: { title: "name" } }]));
    const forged = JSON.parse(JSON.stringify(doc)) as IrDoc;
    (forged.root.children![0]!.children![1]!.props as { rowTitle: string }).rowTitle = "pricing.baseCost";
    expect(validateIr(forged).ok).toBe(false);
  });
});

describe("#344 catalog: row cap, malformed input, query keys", () => {
  // a minimal fake DOM for the renderer
  type FakeEl = RElement & { attrs: Record<string, string> };
  const fdoc: RDocument = {
    createElement(): RElement {
      const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
      return e;
    },
  };

  it("omitting `limit` does not lift the row cap", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: [] } } as unknown as IrNode;
    const rows = Array.from({ length: 5 * LIST_ROW_CAP }, (_, i) => ({ name: "k" + i }));
    bindListRows(fdoc, listEl, node, rows);
    expect(listEl.children.length).toBe(LIST_ROW_CAP);
  });

  it("a manifest `limit` above the cap cannot lift it either", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: [], limit: 10 * LIST_ROW_CAP } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, Array.from({ length: 3 * LIST_ROW_CAP }, (_, i) => ({ name: "k" + i })));
    expect(listEl.children.length).toBe(LIST_ROW_CAP);
  });

  it("a field type whose toString is null is refused, not thrown", () => {
    const m = JSON.parse('{"csd":"pcc://artifacts/dashboard/v1","title":"T","sections":[{"windows":[{"kind":"form","schema":{"type":"object","properties":{"x":{"type":{"toString":null}}}}}]}]}');
    let r: ReturnType<typeof dashboardManifestToIr> | undefined;
    expect(() => { r = dashboardManifestToIr(m); }).not.toThrow();
    expect(r!.ok).toBe(false);
  });

  it("the shipped kit fails INERT on that manifest (no throw, nothing rendered)", async () => {
    const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p>waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
    const w = dom.window as unknown as Window & { eval: (s: string) => void; __PCC_IR_ORIGIN__?: string; MessageEvent: typeof MessageEvent };
    (w as unknown as { parent: { postMessage: () => void } }).parent.postMessage = () => {};
    w.eval(KIT);
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent as never, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } } }));
    const m = JSON.parse('{"csd":"pcc://artifacts/dashboard/v1","title":"T","sections":[{"windows":[{"kind":"form","schema":{"type":"object","properties":{"x":{"type":{"toString":null}}}}}]}]}');
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent as never, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: m } } } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.document.getElementById("pcc-ir-root")!.textContent).toContain("could not be verified");
    dom.window.close();
  });

  it("query keys are allowlisted per route; credential-like names are refused", () => {
    const listQ = (path: string, query: Record<string, unknown>) =>
      dashboardManifestToIr(man([{ kind: "list", binding: { path, query }, item: { title: path === "/api/jobs" ? "id" : "name" } }]) as never).ok;
    expect(listQ("/api/jobs", { status: "open", limit: 5 })).toBe(true);
    expect(listQ("/api/capabilities", { type: "pizza" })).toBe(true);
    expect(listQ("/api/jobs", { token: "x" })).toBe(false);
    expect(listQ("/api/jobs", { apiKey: "x" })).toBe(false);
    expect(listQ("/api/kernels", { limit: 5 })).toBe(false); // not in the kernels allowlist
    expect(dashboardManifestToIr(man([{ kind: "metric", label: "L", select: "progress", binding: { path: "/api/jobs/j1/status", query: { a: 1 } } }]) as never).ok).toBe(false);
  });
});

describe("#344 /mcp/apps: every bindable route carries an effect review", () => {
  it("the reviewed routes are exactly the routes BIND_POLICY can bind", () => {
    const reviewed = [...new Set(EFFECT_REVIEWED_READS.map((r) => reviewedRouteSource(r.route)))].sort();
    expect(reviewed).toEqual(bindPolicyRouteSources());
  });

  it("each review names its handler and its effect, operational effects included (astra r2 F3)", () => {
    for (const r of EFFECT_REVIEWED_READS) {
      expect(r.handler.length, r.route).toBeGreaterThan(10);
      expect(r.effect, r.route).toMatch(/^no business-state write; /);
      // a facade read is not effect-free: it emits telemetry; a capability read may add a funnel audit row
      if (r.handler.includes("Facade")) expect(r.effect, r.route).toContain("telemetry event");
      if (r.route.startsWith("/api/capabilities")) expect(r.effect, r.route).toContain("PCC_FUNNEL_ENABLED=true");
    }
  });
});

describe("#3013 (pcc-design): a record's status word is never a payment fact", () => {
  it("money-state words are recognised through case, joins, fullwidth, lookalikes and zero-width", () => {
    for (const v of ["settled", "Settled", "SETTLED_RELEASED", "payoutPending", "refund-pending", "released", "paid",
      "\uff53\uff45\uff54\uff54\uff4c\uff45\uff44", "s\u0435ttled", "sett\u200bled", "funded", "escrowed"]) {
      expect(isMoneyState(v), v).toBe(true);
    }
    for (const v of ["running", "queued", "completed", "verified", "approved", "online", "unsettled", "settlement pending", ""]) {
      expect(isMoneyState(v), v).toBe(false);
    }
  });

  it("recordValueText qualifies only a value read from a field named status", () => {
    expect(recordValueText("status", "settled")).toBe("settled" + RECORD_STATUS_NOTE);
    expect(recordValueText("job.status", "SETTLED_RELEASED")).toBe("SETTLED_RELEASED" + RECORD_STATUS_NOTE);
    expect(recordValueText("kernel.status", "online")).toBe("online");
    expect(recordValueText("name", "settled")).toBe("settled");     // not a status field
    expect(recordValueText("statusText", "paid")).toBe("paid");      // not a field NAMED status
    expect(recordValueText("status", "")).toBe("");
  });

  it("every renderer sink applies it: metric, run card, list badge and list meta", () => {
    expect(bindScalar({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "status" } } as unknown as IrNode, { status: "released" }))
      .toBe("released" + RECORD_STATUS_NOTE);
    // astra r5 F2: progress is now a typed "percent" stat field (0..100 number) — a STRING value
    // is off-kind and UNAVAILABLE outright, replacing the pre-typing expectation that only
    // content-filtering (WITHHELD_FIELD) gated an arbitrary string here.
    expect(bindScalar({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "progress" } } as unknown as IrNode, { progress: "paid" }))
      .toBe(UNAVAILABLE);
    const slots = [{ textContent: "" }, { textContent: "" }];
    bindSchemaCard("run-summary-v1", { job: { status: "settled", progress: 100 } }, slots);
    expect(slots.map((x) => x.textContent)).toEqual(["settled" + RECORD_STATUS_NOTE, "100"]);
    bindSchemaCard("run-summary-v1", { status: "running", progress: 5 }, slots);
    expect(slots[0]!.textContent).toBe("running");
    type FakeEl = RElement & { attrs: Record<string, string> };
    const fdoc: RDocument = { createElement(): RElement {
      const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
      return e;
    } };
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["kernelId", "status"], statusFrom: "status" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ id: "j3", kernelId: "k1", status: "released" }, { id: "j4", kernelId: "k1", status: "running" }]);
    const texts = (listEl.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent));
    expect(texts).toEqual([
      // row texts now carry PCC-owned field labels (astra r3 H2 structural framing); ids are attributed
      // (steward #5149: an identifier's grammar cannot exclude prose, so it reads "reported: ...")
      ["ID:", REPORTED_PREFIX + "j3", "Kernel:", REPORTED_PREFIX + "k1", "Status:", "released" + RECORD_STATUS_NOTE, "Status:", "released" + RECORD_STATUS_NOTE],
      ["ID:", REPORTED_PREFIX + "j4", "Kernel:", REPORTED_PREFIX + "k1", "Status:", "running", "Status:", "running"],
    ]);
  });

  it("the shipped kit shows the qualifier in all three sinks (committed bytes, URL-routed reads)", async () => {
    const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p>waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
    const w = dom.window as unknown as Record<string, any>;
    w.TextDecoder = NodeTextDecoder;
    w.parent.postMessage = () => {};
    w.__PCC_IR_ORIGIN__ = "https://capability.network";
    const byPath: Record<string, unknown> = {
      "/api/jobs/j1/status": { status: "settled", progress: 100 },
      "/api/jobs/j2": { job: { status: "SETTLED_RELEASED", progress: 100 } },
      // The REAL GET /api/jobs answers { jobs: [...] } (route inject: dashboard-ir-list-producers.test.ts);
      // this fixture said { items: [...] }, which passed only because the binder used to guess `.items`.
      "/api/jobs": { jobs: [{ id: "j3", kernelId: "k1", status: "released" }, { id: "j4", kernelId: "k1", status: "running" }] },
    };
    w.fetch = (url: string) => {
      const body = byPath[new URL(String(url)).pathname];
      const bytes = new NodeTextEncoder().encode(JSON.stringify(body ?? {}));
      let sent = false;
      return Promise.resolve({
        status: body === undefined ? 404 : 200, redirected: false,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => {} }), cancel: async () => {} },
      });
    };
    w.eval(KIT);
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } } }));
    const m = man([
      { kind: "metric", label: "Status", select: "status", binding: { path: "/api/jobs/j1/status" } },
      { kind: "run", binding: { path: "/api/jobs/j2", sse: "/sse/stream/job/j2" }, statusFrom: "status", latestFrom: "latest" },
      { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId", "status"], statusFrom: "status" } },
    ], "Jobs", "Runs");
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: w.JSON.parse(JSON.stringify(m)) } } } }));
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
    const text = w.document.getElementById("pcc-ir-root").textContent as string;
    expect(text).toContain("settled" + RECORD_STATUS_NOTE);
    expect(text).toContain("SETTLED_RELEASED" + RECORD_STATUS_NOTE);
    expect(text.split("released" + RECORD_STATUS_NOTE).length - 1).toBe(2); // j3's meta + badge
    expect(text.split(RECORD_STATUS_NOTE).length - 1).toBe(4);              // and nothing else is qualified
    expect(text).toContain("running");
    dom.window.close();
  });
});

describe("astra r2 (#344 @78989cc5): reproduced findings (verify before fix)", () => {
  type FakeEl = RElement & { attrs: Record<string, string> };
  const fdoc: RDocument = { createElement(): RElement {
    const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
    return e;
  } };
  const textOf = (e: RElement): string => e.textContent + (e.children as RElement[]).map(textOf).join(" ");

  it("F1 (HIGH): the claim detector catches the reviewer's bypasses", () => {
    for (const t of ["one million dollars", "1m USDC", "1\u{1F4B0}USDC", "pa\u202Eid", "pa\u0301id", "pa\u0131d", "pagado", "pay\u00e9", "verificado"]) {
      expect(isMoneyClaim(t), JSON.stringify(t)).toBe(true);
    }
  });

  it("F1 (HIGH): a claim split across adjacent action labels ('$' then '100') is withheld", () => {
    const doc = ok(man([{ kind: "actions", actions: [{ id: "a", label: "$" }, { id: "b", label: "100" }] }]));
    const prose = proseOf(doc.root);
    expect(prose).not.toContain("$");
    expect(prose).not.toContain("100");
  });

  it("F2 (HIGH): a bound list value that states money or verification is not shown verbatim", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: [] }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ name: "Paid $1M \u2014 verified" }]);
    expect(textOf(listEl)).not.toContain("$1M");
  });

  it("F2 (HIGH): a status value 'verified' is not shown bare outside a schema card", () => {
    const stat = { type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "status" } } as unknown as IrNode;
    expect(bindScalar(stat, { status: "verified" })).not.toBe("verified");
  });

  it("F4 (LOW): a manifest cannot supply the PCC withheld notice as its own prose", () => {
    const doc = ok(man([{ kind: "note", text: WITHHELD_PROSE }]));
    expect(proseOf(doc.root)).not.toContain(WITHHELD_PROSE);
  });
});

describe("astra r2 (#344): each fix holds for the whole class, not only the reported strings", () => {
  type FakeEl = RElement & { attrs: Record<string, string> };
  const fdoc: RDocument = { createElement(): RElement {
    const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
    return e;
  } };
  const textOf = (e: RElement): string => e.textContent + (e.children as RElement[]).map(textOf).join(" ");

  it("F1: folding defeats spelling tricks (look-alikes, small capitals, strokes, digits, spacing, joins, controls)", () => {
    for (const t of [
      "P\u0410ID", "\u0420\u0410\u0406D", // Cyrillic capitals
      "\u1d18\u1d00\u026a\u1d05", "pa\u0268d", "\u24df\u24d0\u24d8\u24d3", "\u{1D429}\u{1D41A}\u{1D422}\u{1D41D}",
      "p41d", "funds r3l3as3d", "s3tt1ed", "p a i d", "p.a.i.d", "v-e-r-i-f-i-e-d",
      "paymentReceived", "payout_done", "pa\u200did", "pa\u2066id\u2069", "pa\u00adid", "pa\u3164id", "pa\ufe0fid",
    ]) expect(isMoneyClaim(t), JSON.stringify(t)).toBe(true);
  });

  it("F1: amounts in words, magnitudes, symbols after the number, emoji and other currencies", () => {
    for (const t of ["five dollars", "a million bucks", "million-dollar deal", "twenty euros", "2.5k USDC", "3bn\u20ac", "100\u20b9",
      "\u00a5 3000", "USDC:100", "1mUSDC", "10 (USDC)", "\u{1F4B5}100", "100\u{1F4B8}", "\uff04\uff15",
      "1       USDC", "1\u00a0\u00a0\u2003USDC", "$\n\n  5"]) { // whitespace runs render as one space
      expect(isMoneyClaim(t), JSON.stringify(t)).toBe(true);
      expect(statesAmount(t), JSON.stringify(t)).toBe(true);
    }
  });

  it("F1: payment and verification words in other languages and scripts, in any case", () => {
    for (const t of ["reembolsado", "rembours\u00e9", "\u00fcberwiesen", "best\u00e4tigt", "pagato", "betaald", "zap\u0142acono", "\u00f6dendi", "dibayar",
      "\u043e\u043f\u043b\u0430\u0447\u0435\u043d\u043e", "\u041e\u041f\u041b\u0410\u0427\u0415\u041d\u041e", "\u5df2\u4ed8\u6b3e", "\u652f\u6255\u6e08\u307f",
      "\uacb0\uc81c \uc644\ub8cc", "\u0645\u062f\u0641\u0648\u0639"]) {
      expect(isMoneyClaim(t), JSON.stringify(t)).toBe(true);
    }
  });

  it("F1: ordinary dashboard prose is still shown", () => {
    for (const t of ["Pick a kernel near you", "Robot arm in Berlin", "Status of recent jobs", "Kernels by region", "Payload up to 5 kg",
      "Top 3 kernels", "Uptime 99.9%", "Created 2026-09-24T10:00:00Z", "v1.2.3", "Choose a capability", "Approve", "Deny",
      "Submit a job", "S\u00e3o Paulo", "Load balancer health", "Open settings", "Money facts appear only in PCC cards."]) {
      expect(isProseClaim(t), t).toBe(false);
    }
  });

  it("F1: a claim split across prose is withheld: adjacent labels, notes, single letters, and across sections", () => {
    const labels = ok(man([{ kind: "actions", actions: [{ id: "a", label: "1" }, { id: "b", label: "USDC" }] }, { kind: "note", text: "Pick a kernel" }]));
    expect(proseOf(labels.root)).toEqual([]); // the section's agent prose is withheld as a whole
    expect(withheldOf(labels.root)).toBe(4); // heading, two labels, note
    const letters = ok(man(["p", "a", "i", "d"].map((c, i) => ({ kind: "actions", actions: [{ id: `a${i}`, label: c }] }))));
    expect(proseOf(letters.root)).toEqual([]);
    const across = ok({ csd: CSD, title: "Ops", sections: [
      { heading: "Costs", windows: [{ kind: "note", text: "Total so far:" }, { kind: "note", text: "$" }] },
      { heading: "100", windows: [{ kind: "note", text: "Pick a kernel" }] },
    ] });
    expect([...proseOf(across.title), ...proseOf(across.root)]).toEqual([]); // formed only across sections: all agent prose withheld
    for (const d of [labels, letters, across]) expect(validateIr(d)).toEqual({ ok: true });
    // a dashboard with no claim anywhere keeps all of its prose
    const fine = ok({ csd: CSD, title: "Ops", sections: [{ heading: "Kernels", windows: [{ kind: "note", text: "Pick a kernel near you" }] }, { heading: "Jobs", windows: [{ kind: "note", text: "Recent runs" }] }] });
    expect([...proseOf(fine.title), ...proseOf(fine.root)]).toEqual(["Ops", "Kernels", "Pick a kernel near you", "Jobs", "Recent runs"]);
  });

  it("F1: the validator rejects a forged IR whose prose states a claim only across nodes", () => {
    const doc = ok(man([{ kind: "actions", actions: [{ id: "a", label: "one" }, { id: "b", label: "two" }] }]));
    const forged = JSON.parse(JSON.stringify(doc)) as IrDoc;
    const grid = forged.root.children![0]!.children![1]!;
    (grid.children![0]!.props as { text: string }).text = "$";
    (grid.children![1]!.props as { text: string }).text = "100";
    expect(validateIr(forged)).toEqual({ ok: false, reason: "agent prose states a claim across nodes" });
    const forged2 = JSON.parse(JSON.stringify(doc)) as IrDoc;
    (forged2.title.props as { text: string }).text = "$";
    (forged2.root.children![0]!.children![0]!.props as { text: string }).text = "100";
    expect(validateIr(forged2).ok).toBe(false);
  });

  it("F4: the withheld notice is a structural PCC node with no words, never untrusted", () => {
    const doc = ok(man([{ kind: "note", text: "Paid 5 USDC" }, { kind: "note", text: "PCC notice: agent text withheld" }], "Ops", "Kernels"));
    const [heading, n1, n2] = doc.root.children![0]!.children!;
    expect(heading).toMatchObject({ props: { level: 2, text: "Kernels" }, untrusted: true });
    for (const n of [n1!, n2!]) { expect(n.props).toEqual({ withheld: true }); expect(n.untrusted).toBeUndefined(); }
    expect(validateIr(doc)).toEqual({ ok: true });
    expect(JSON.stringify(doc)).not.toContain(WITHHELD_PROSE); // the notice text is never in the IR
  });

  it("F4: the validator refuses every forged form of the notice", () => {
    const doc = ok(man([{ kind: "note", text: "Paid 5 USDC" }, { kind: "note", text: "fine" }]));
    const forge = (f: (w: IrNode, fine: IrNode) => void): boolean => {
      const d = JSON.parse(JSON.stringify(doc)) as IrDoc; const [, w, fine] = d.root.children![0]!.children!; f(w!, fine!); return validateIr(d).ok;
    };
    expect(forge(() => {})).toBe(true);
    expect(forge((_w, fine) => { (fine.props as { text: string }).text = WITHHELD_PROSE; })).toBe(false); // agent prose that IS the notice
    expect(forge((w) => { w.untrusted = true; })).toBe(false); // the notice marked untrusted
    expect(forge((w) => { (w.props as Record<string, unknown>).text = "Paid"; })).toBe(false); // the notice carrying words
    expect(forge((w) => { (w.props as Record<string, unknown>).withheld = "yes"; })).toBe(false);
    expect(forge((_w, fine) => { delete fine.untrusted; })).toBe(false); // agent words passed off as PCC text
    // the node check alone refuses it: a dashboard whose only agent prose is its title has no join
    const lone = ok({ csd: CSD, title: "Ops", sections: [{ windows: [{ kind: "receipt" }] }] });
    const forgedTitle = JSON.parse(JSON.stringify(lone)) as IrDoc;
    (forgedTitle.title.props as { text: string }).text = WITHHELD_PROSE;
    expect(validateIr(lone)).toEqual({ ok: true });
    expect(validateIr(forgedTitle).ok).toBe(false);
  });

  it("F4: the renderer paints the notice from its own constant, and marks only agent words as agent-authored", () => {
    const doc = ok(man([{ kind: "note", text: "Paid 5 USDC" }, { kind: "note", text: "Pick a kernel" }]));
    const mount = fdoc.createElement("main");
    renderIrDoc(fdoc, mount, doc);
    const all: RElement[] = [];
    const walk = (e: RElement): void => { all.push(e); for (const c of e.children as RElement[]) walk(c); };
    walk(mount);
    const classes = (e: RElement): string[] => e.className.split(" ");
    const notice = all.find((e) => e.textContent === WITHHELD_PROSE)!;
    expect(classes(notice)).toEqual(expect.arrayContaining(["pcc-text", "pcc-withheld"]));
    for (const c of ["pcc-agent", "pcc-untrusted"]) expect(classes(notice)).not.toContain(c);
    expect(classes(notice).some((c) => c.startsWith("pcc-src-"))).toBe(false); // a PCC constant has no source class
    const agent = all.find((e) => e.textContent === "Pick a kernel")!;
    expect(classes(agent)).toEqual(expect.arrayContaining(["pcc-text", "pcc-agent", "pcc-untrusted"]));
    const html = buildMcpAppIrDashboardHtml("n0nce");
    expect(html).toContain(".pcc-agent{");
    expect(html).toContain('content:"agent-authored"');
    expect(html).toContain(".pcc-withheld{");
  });

  it("F2: every bound sink withholds a claim and qualifies a status word; the price fields are the card's own", () => {
    expect(boundValueText("name", "Paid $1M \u2014 verified")).toBe(WITHHELD_FIELD);
    expect(boundValueText("location.label", "Berlin - funds received")).toBe(WITHHELD_FIELD);
    expect(boundValueText("id", "cap-7")).toBe("cap-7");
    expect(boundValueText("status", "verified")).toBe("verified" + RECORD_CLAIM_NOTE);
    expect(boundValueText("kernel.status", "pagado")).toBe("pagado" + RECORD_CLAIM_NOTE);
    expect(boundValueText("status", "settled")).toBe("settled" + RECORD_STATUS_NOTE);
    expect(boundValueText("status", "paid 5 USDC")).toBe(WITHHELD_FIELD); // a status may not state an amount
    expect(boundValueText("status", "withheld by PCC")).toBe(WITHHELD_FIELD); // nor pose as the notice
    expect(boundValueText("status", "running")).toBe("running");
    const listEl = fdoc.createElement("div");
    // location.label removed from the list field profile entirely (astra r5 F5: dead
    // surface -- present in 0/8 real kernel rows and 0/19 real capability rows); exercise
    // the same text-attribution withholding on "name" itself, the one remaining text-kind
    // field.
    const node = { type: "list", id: "n1", props: { rowTitle: "name", statusFrom: "status" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [
      { name: "Arm 1", status: "approved" },
      { name: "Payment received", status: "approved" },
    ]);
    // row texts now carry PCC-owned field labels (astra r3 H2); "approved" is in the CLOSED
    // SAFE_STATUS_WORDS vocabulary (astra r3 H1 fail-closed status), so it is shown bare,
    // not qualified -- the record-status note is reserved for words NOT on that safe list.
    // "name" is now attributed text (astra r5 F1): a benign value is prefixed, not bare.
    const rowTexts = (listEl.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent));
    expect(rowTexts).toEqual([
      ["Name:", REPORTED_PREFIX + "Arm 1", "Status:", "approved"],
      ["Name:", WITHHELD_FIELD, "Status:", "approved"],
    ]);
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    bindSchemaCard("capability-summary-v1", { name: "Refunded in full", type: "arm", pricing: { baseCost: "12.50", currency: "USDC" }, assuranceTiers: [1, 2], available: true }, slots);
    expect(slots.map((x) => x.textContent)).toEqual([WITHHELD_FIELD, REPORTED_PREFIX + "arm", "12.50", "USDC", "1, 2", "Yes"]); // a capType is attributed (steward #5149)
    // astra r3 M3 / #348 r2b F1: "type" is a mistyped capType ("1,000 USDC" fails the closed
    // identifier grammar) and "assuranceTiers" is a mistyped tiers array ("Paid" is not an
    // integer) \u2014 the card now fails CLOSED on every slot instead of selectively masking just the
    // claim-bearing ones; the card's own price fields no longer get a content-based exemption,
    // they are validated like everything else.
    const ok2 = bindSchemaCard("capability-summary-v1", { name: "Arm", type: "1,000 USDC", pricing: { baseCost: "1,000 USDC", currency: "USDC" }, assuranceTiers: ["Paid", 2], available: false }, slots);
    expect(slots.map((x) => x.textContent)).toEqual([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    expect(ok2).toBe(false);
    // the row-2 claim ("Payment received", replacing the old location.label example above) never
    // leaks unredacted into the rendered list text either.
    expect(textOf(listEl)).not.toContain("Payment received");
  });

  it("F2: the shipped kit withholds a claim in a bound list title (committed bytes)", async () => {
    const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p>waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
    const w = dom.window as unknown as Record<string, any>;
    w.TextDecoder = NodeTextDecoder;
    w.parent.postMessage = () => {};
    w.__PCC_IR_ORIGIN__ = "https://capability.network";
    const body = { items: [{ id: "cap-1", name: "Paid $1M \u2014 verified", type: "arm" }, { id: "cap-2", name: "Gripper", type: "arm" }] };
    w.fetch = () => {
      const bytes = new NodeTextEncoder().encode(JSON.stringify(body));
      let sent = false;
      return Promise.resolve({
        status: 200, redirected: false,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => {} }), cancel: async () => {} },
      });
    };
    w.eval(KIT);
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } } }));
    const m = man([{ kind: "list", binding: { path: "/api/capabilities" }, item: { title: "name", meta: ["type"] } }], "Capabilities", "All");
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: w.JSON.parse(JSON.stringify(m)) } } } }));
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
    const text = w.document.getElementById("pcc-ir-root").textContent as string;
    expect(text).toContain("Gripper");
    expect(text).toContain(WITHHELD_FIELD);
    expect(text).not.toContain("$1M");
    dom.window.close();
  });
});

describe("astra r2 (#344): the checks stay linear at the manifest's size limits", () => {
  // 24 sections x 32 notes x 2000 characters: the largest prose a manifest can carry. Every check,
  // per node and across the joined dashboard, must stay linear-time: an unbounded repeat over the
  // joined text never finishes, and the reviewed head's per-note regex already took seconds here.
  const big = (text: (i: number) => string) => ({ csd: CSD, title: "Ops", sections: Array.from({ length: 24 }, () => ({ heading: "Sec", windows: Array.from({ length: 32 }, (_, i) => ({ kind: "note", text: text(i) })) })) });
  for (const [label, text] of [
    ["a run of digits", () => "1".repeat(2000)],
    ["spaces after a digit", () => "1" + " ".repeat(1999)],
    ["a number word then hyphens", () => "one" + "-".repeat(1997)],
    ["digits split by currency symbols across notes", (i: number) => (i % 2 ? "1".repeat(2000) : "$")],
  ] as Array<[string, (i: number) => string]>) {
    it(`${label}: adapted and validated within the test timeout`, () => {
      const r = dashboardManifestToIr(big(text) as never);
      expect(r.ok).toBe(true);
      if (r.ok) expect(validateIr(r.doc)).toEqual({ ok: true });
    });
  }
});
describe("astra r3 (#344 @e909337a) and #348 r2 F1: reproduced findings (verify before fix)", () => {
  // fdoc/textOf are module-scope now (see top of file) — reused here unchanged.
  it("H1 (lexical): obvious claim spellings, confusables and extra currencies bypass the detector", () => {
    expect(isProseClaim("Payment complete")).toBe(true);
    expect(boundValueText("status", "Verification passed")).not.toBe("Verification passed");
    expect(boundValueText("name", "PAlD")).toBe(WITHHELD_FIELD); // lowercase L, not capital I
    expect(isMoneyClaim("USDC five")).toBe(true);
    expect(isMoneyClaim("100 XLM")).toBe(true);
    expect(isMoneyClaim("\u03c0\u03bb\u03b7\u03c1\u03ce\u03b8\u03b7\u03ba\u03b5")).toBe(true); // Greek: "it was paid"
  });

  it("H2 (split across bound fields): a list row's bound title+meta jointly stating a claim is withheld", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["type"] }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ name: "$", type: "100" }, { name: "Payment", type: "complete" }]);
    const collapsed = textOf(listEl).replace(/\s+/g, " ");
    expect(collapsed).not.toContain("$ 100");
    expect(collapsed).not.toContain("Payment complete");
  });

  it("M3: a hostile price field cannot reproduce PCC's exact withheld notice", () => {
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    bindSchemaCard("capability-summary-v1", { name: "Arm", type: "arm", pricing: { baseCost: WITHHELD_PROSE, currency: "USDC" }, assuranceTiers: [1], available: true }, slots);
    expect(slots.some((s) => s.textContent === WITHHELD_PROSE)).toBe(false);
  });

  it("M4 (over-suppression): ordinary physical-workflow prose is not withheld", () => {
    for (const t of ["Sample received", "payload released", "biosafety approved", "balance calibrated", "Run confirmed for 9:00"]) {
      expect(isProseClaim(t), t).toBe(false);
    }
  });

  it("#348 F1 (types): a mistyped capability card fails closed on every slot", () => {
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    const okFlag = bindSchemaCard(
      "capability-summary-v1",
      { name: 7, type: true, pricing: { baseCost: "paid 5 USDC", currency: "verified" }, asOf: "2026-09-24T12:00:00.000Z" },
      slots,
    );
    const texts = slots.map((s) => s.textContent);
    for (const bad of ["7", "true", "paid 5 USDC", "verified"]) expect(texts).not.toContain(bad);
    for (const t of texts) expect(t).toBe(UNAVAILABLE);
    expect(okFlag).toBe(false);
  });

  // genui's review of e675595f (mutation survivors and one residual, verify before fix).
  it("review (survivor): the row backstop WITHHOLDS a split claim; PCC's interleaved labels alone are not the guard", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["type"] }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ name: "Payment", type: "complete" }]);
    const text = textOf(listEl);
    expect(text).not.toContain("Payment");
    expect(text).not.toMatch(/\bcomplete\b/);
    expect(text).toContain(WITHHELD_FIELD);
  });

  it("review (survivor): a card whose ONLY bad field is its currency fails closed on every slot", () => {
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    const okFlag = bindSchemaCard("capability-summary-v1", { name: "Arm", type: "arm", pricing: { baseCost: "5", currency: "verified" }, assuranceTiers: [1], available: true }, slots);
    for (const t of slots.map((s) => s.textContent)) expect(t).toBe(UNAVAILABLE);
    expect(okFlag).toBe(false);
  });

  it("review (residual H2): a claim split across a row's title and its STATUS is withheld", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", statusFrom: "status" }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ name: "Your payment", status: "completed" }]);
    expect(textOf(listEl)).not.toContain("Your payment");
  });

  it("review (regression guard): a money-word status never switches off the title+meta backstop", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["type"], statusFrom: "status" }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ name: "$", type: "100", status: "PAID" }]);
    const text = textOf(listEl);
    expect(text).not.toMatch(/Name: \$/);
    expect(text).not.toContain("Type: 100");
  });

  it("review (control): a status that is itself a money word is noted, and an innocent title is NOT withheld for it", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", statusFrom: "status" }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ name: "Arm calibration", status: "PAID" }]);
    const text = textOf(listEl);
    expect(text).toContain("Arm calibration");
    expect(text).toContain("PAID" + RECORD_STATUS_NOTE); // the status never stands bare: boundValueText notes it
  });
});

describe("astra r3 H1: SAFE_STATUS_WORDS is a closed vocabulary with no payment word in it", () => {
  it("no SAFE_STATUS_WORDS entry is itself a money claim or a money state", () => {
    for (const w of SAFE_STATUS_WORDS) {
      expect(isMoneyClaim(w), w).toBe(false);
      expect(isMoneyState(w), w).toBe(false);
    }
  });
});

describe("astra r4 (#344 @6773e870): findings 1-3 reproduced (verify before fix)", () => {
  it("F1 (HIGH): a statusFrom named 'available' is not rendered bare when its value is a hostile string", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "name", statusFrom: "available" }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ name: "Your payment", available: "completed" }]);
    const text = textOf(listEl);
    expect(text).not.toContain("Your payment");
    expect(text).not.toContain("Available: completed");
  });

  it("F2 (HIGH): one already-withheld field must not disable the backstop for the rest of the row", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["kernelId"], statusFrom: "status" }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ id: "verified", kernelId: "Your payment", status: "completed" }]);
    expect(textOf(listEl)).not.toContain("Your payment");
  });

  it("F2 (control): an innocent row of the same shape (a VALID kernelId) still renders", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["kernelId"], statusFrom: "status" }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ id: "verified", kernelId: "k-1", status: "completed" }]);
    expect(textOf(listEl)).toContain("k-1");
  });

  it("F3 (MEDIUM): a capability card whose only bad field is an off-grammar amount number fails closed on every slot", () => {
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    const okFlag = bindSchemaCard(
      "capability-summary-v1",
      { name: "Arm", type: "arm", pricing: { baseCost: 1e100, currency: "USDC" }, assuranceTiers: [1], available: true },
      slots,
    );
    for (const t of slots.map((s) => s.textContent)) expect(t).toBe(UNAVAILABLE);
    expect(okFlag).toBe(false);
  });
});

describe("astra r4 (#344 @6773e870): the fix — a closed type for every list field", () => {
  it("LIST_FIELD_KINDS is exhaustive over every field named anywhere in LIST_PROFILES (title, meta and status)", () => {
    const profileFields = new Set<string>();
    for (const prof of Object.values(LIST_PROFILES)) for (const f of [...prof.title, ...prof.meta, ...prof.status]) profileFields.add(f);
    expect(profileFields.size).toBeGreaterThan(0);
    for (const f of profileFields) expect(LIST_FIELD_KINDS[f], f).toBeDefined();
    // bidirectional: no stale LIST_FIELD_KINDS entry that no profile actually uses, either.
    expect(new Set(Object.keys(LIST_FIELD_KINDS))).toEqual(profileFields);
  });

  it("a bool-kind field (available: true) renders 'Yes', not a mistype", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "name", statusFrom: "available" }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ name: "Gripper", available: true }]);
    const texts = (listEl.children[0] as RElement).children as RElement[];
    // name is now attributed text (astra r5 F1): a benign value renders with the "reported: "
    // prefix, not bare.
    expect(texts.map((c) => c.textContent)).toEqual(["Name:", REPORTED_PREFIX + "Gripper", "Available:", "Yes"]);
  });

  it("a mistyped id ('Your payment', not a valid id shape) fails the WHOLE row: every value UNAVAILABLE, labels kept", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["kernelId"], statusFrom: "status" }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ id: "Your payment", kernelId: "k-1", status: "completed" }]);
    expect(listEl.children.length).toBe(1); // the row is NOT dropped (title was PRESENT, just mistyped)
    const texts = (listEl.children[0] as RElement).children as RElement[];
    expect(texts.map((c) => c.textContent)).toEqual(["ID:", UNAVAILABLE, "Kernel:", UNAVAILABLE, "Status:", UNAVAILABLE]);
  });

  it("'status' in META uses the closed vocabulary (boundStatusText applies by KIND, not just as statusFrom)", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["status"] }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ id: "j-1", status: "settled" }, { id: "j-2", status: "weirdWord" }]);
    const texts = (listEl.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent));
    expect(texts).toEqual([
      ["ID:", REPORTED_PREFIX + "j-1", "Status:", "settled" + RECORD_STATUS_NOTE], // ids are attributed (steward #5149)
      ["ID:", REPORTED_PREFIX + "j-2", "Status:", "weirdWord" + RECORD_CLAIM_NOTE],
    ]);
  });

  it("a row with a withheld title and two OTHER fields that jointly claim still withholds them (finding 2's general case)", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["capabilityId", "kernelId"] }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    // "id" is individually withheld (a claim word on its own); capabilityId+kernelId jointly pair
    // ("payment" + "complete") though neither is a claim alone. The OLD `alreadyWithheld` escape
    // would have let the pair through once the title was already withheld; it must not now.
    bindListRows(fdoc, listEl, node, [{ id: "verified", capabilityId: "Payment", kernelId: "complete" }]);
    const text = textOf(listEl);
    expect(text).not.toContain("Payment");
    expect(text).not.toMatch(/\bcomplete\b/);
    expect(text).toContain(WITHHELD_FIELD);
  });

  // genui's mutation check of c3e04dd9 (round 6, SURVIVED): if the backstop joined the text
  // kind's DISPLAYED value ("reported: " + raw) instead of its RAW value, this still passes every
  // test above — isMoneyClaim scans unanchored, so a "reported: " prefix never hides a pair that
  // was already adjacent (0..3 words apart) in the RAW content; prepending one word can only ever
  // ADD to the gap, never remove it. The one place that actually matters is the boundary itself:
  // PAIR_RE tolerates at most 3 intervening words, and "reported: " contributes exactly one more.
  // So a split claim sitting at EXACTLY the 3-word limit in the raw content (never redacted on its
  // own) is caught when the backstop joins raw, and WOULD slip through bare if it joined the
  // "reported: "-prefixed display text instead (4th word pushes the pair outside the window).
  it("mutation survivor — backstop joins the text kind's RAW value: a split claim at the pair detector's exact 3-word boundary is still withheld", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["capabilityId", "kernelId", "type", "name"] }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    // "funds" (claim noun) ... "released" (generic word) are exactly 3 words apart (aa, bb, cc);
    // neither "funds" nor "released" is a claim on its own, so only the cross-field backstop can
    // catch this — and only if it reads "released" by its RAW word, not "reported: released".
    bindListRows(fdoc, listEl, node, [{ id: "funds", capabilityId: "aa", kernelId: "bb", type: "cc", name: "released" }]);
    const text = textOf(listEl);
    expect(text).not.toContain("funds");
    expect(text).not.toMatch(/\breleased\b/);
    expect(text).toContain(WITHHELD_FIELD);
  });

  // Mutation survivors (Step 3): each kind's grammar needs its OWN present-but-off-grammar value
  // pinned, since the exhaustive kind-map test only checks that a kind EXISTS, not that its
  // grammar actually rejects a bad value. (id/bool already pinned above by the astra r4 tests.)
  it("mutation survivor — text kind: a present empty string is MISTYPED (not absent), fails the row closed", () => {
    // location.label removed from the list field profile entirely (astra r5 F5: dead surface —
    // present in 0/8 real kernel rows and 0/19 real capability rows); "name" is now the only
    // text-kind field, so the empty-string case is exercised on the title itself.
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["id"] }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ name: "", id: "cap-1" }]);
    expect(listEl.children.length).toBe(1);
    const texts = (listEl.children[0] as RElement).children as RElement[];
    expect(texts.map((c) => c.textContent)).toEqual(["Name:", UNAVAILABLE, "ID:", UNAVAILABLE]);
  });

  it("mutation survivor — status kind: a present empty string is MISTYPED, fails the row closed", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["status"] }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ id: "j-1", status: "" }]);
    const texts = (listEl.children[0] as RElement).children as RElement[];
    expect(texts.map((c) => c.textContent)).toEqual(["ID:", UNAVAILABLE, "Status:", UNAVAILABLE]);
  });

  it("mutation survivor — time kind: a valid timestamp is shown as-is; a non-timestamp string fails the row closed", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["createdAt"] }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ id: "j-1", createdAt: "2026-09-24T10:00:00Z" }, { id: "j-2", createdAt: "yesterday" }]);
    const rows = (listEl.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent));
    expect(rows).toEqual([
      ["ID:", REPORTED_PREFIX + "j-1", "Created:", "2026-09-24T10:00:00Z"], // ids are attributed (steward #5149)
      ["ID:", UNAVAILABLE, "Created:", UNAVAILABLE],
    ]);
  });

  it("mutation survivor — version kind: a valid version is shown as-is; a hostile string fails the row closed", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["version"] }, bind: { path: "/api/kernels" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ name: "K1", version: "1.2.3" }, { name: "K2", version: "not a version!" }]);
    const rows = (listEl.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent));
    // name is now attributed text (astra r5 F1): a benign value is prefixed, not bare.
    expect(rows).toEqual([
      ["Name:", REPORTED_PREFIX + "K1", "Version:", "1.2.3"],
      ["Name:", UNAVAILABLE, "Version:", UNAVAILABLE],
    ]);
  });

  it("mutation survivor — count kind: a string number is MISTYPED (brief's own example); so is an out-of-range or non-integer number; a valid integer is shown with String()", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["capabilityCount"] }, bind: { path: "/api/kernels" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [
      { name: "K1", capabilityCount: 5 },
      { name: "K2", capabilityCount: "5" }, // a string number (brief's own example)
      { name: "K3", capabilityCount: 2.5 }, // a number, but not an integer
      { name: "K4", capabilityCount: 1_000_001 }, // a number, but over the 0..1,000,000 bound
    ]);
    const rows = (listEl.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent));
    // name is now attributed text (astra r5 F1): a benign value is prefixed, not bare.
    expect(rows).toEqual([
      ["Name:", REPORTED_PREFIX + "K1", "Capabilities:", "5"],
      ["Name:", UNAVAILABLE, "Capabilities:", UNAVAILABLE],
      ["Name:", UNAVAILABLE, "Capabilities:", UNAVAILABLE],
      ["Name:", UNAVAILABLE, "Capabilities:", UNAVAILABLE],
    ]);
  });

  it("mutation survivor — capType kind: a hostile (space-bearing) type value fails the row closed", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["type"] }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ name: "Arm", type: "not a type!" }]);
    const texts = (listEl.children[0] as RElement).children as RElement[];
    expect(texts.map((c) => c.textContent)).toEqual(["Name:", UNAVAILABLE, "Type:", UNAVAILABLE]);
  });
});

describe("astra r5 (#344 @c3e04dd9): findings 1-5 reproduced (verify before fix)", () => {
  it("F1 (HIGH): a free-text list name stating a claim beyond the pair detector's 3-word window is not shown as the bare phrase", () => {
    // "payment" ... "received" are 4 words apart; the pair rule (dashboard-ir.ts PAIR_RE) only
    // looks 3 words either side, so isMoneyClaim(phrase) is false and the UNFIXED code shows it
    // verbatim. The fix is structural attribution (reportedFieldText), not a wider pair window —
    // the phrase stays lexically unflagged even after the fix; it is simply never shown bare.
    const phrase = "payment from the remote operator received";
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: [] }, bind: { path: "/api/capabilities" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ name: phrase, id: "cap-1", available: true }]);
    const texts = (listEl.children[0] as RElement).children as RElement[];
    expect(texts.map((c) => c.textContent)).not.toContain(phrase);
  });

  it("F1 (HIGH): the same phrase in a capability card's Name slot is not shown bare", () => {
    const phrase = "payment from the remote operator received";
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    bindSchemaCard("capability-summary-v1", { name: phrase, type: "arm", pricing: { baseCost: "5.00", currency: "USDC" }, assuranceTiers: [1], available: true }, slots);
    expect(slots[0]!.textContent).not.toBe(phrase);
  });

  it("F2 (MEDIUM): a stat bound to jobs/:id/status select=progress renders UNAVAILABLE for an off-kind boolean or string value", () => {
    const stat = { type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "progress" } } as unknown as IrNode;
    expect(bindScalar(stat, { progress: true })).toBe(UNAVAILABLE);
    expect(bindScalar(stat, { progress: "unknown-value" })).toBe(UNAVAILABLE);
  });

  // genui's mutation check of c3e04dd9 (round 6, SURVIVED): the "count" kind (reputation,
  // capabilityCount, totalJobsCompleted, activeJobCount) had no bindScalar test pinning its
  // integer/non-negative grammar — only a VALID count value was ever exercised (the renderer
  // conformance file's "kernel.reputation" === "850"/"42" checks). A non-integer or negative
  // number passed the mutated (type-only) check silently.
  it("mutation survivor — stat count kind: a non-integer or negative number is off-kind, UNAVAILABLE", () => {
    const stat = { type: "stat", id: "n1", bind: { path: "/api/kernels/k1", select: "kernel.reputation" } } as unknown as IrNode;
    expect(bindScalar(stat, { kernel: { reputation: 2.5 } })).toBe(UNAVAILABLE);
    expect(bindScalar(stat, { kernel: { reputation: -1 } })).toBe(UNAVAILABLE);
    expect(bindScalar(stat, { kernel: { reputation: 900 } })).toBe("900"); // control: a valid count still renders
  });

  it("F3 (MEDIUM): listRowsOf never accepts a bare array — only the route's own rows key", () => {
    expect(listRowsOf("/api/jobs", [{ id: "j1" }])).toEqual([]);
  });

  it("F4 (MEDIUM): an impossible calendar timestamp fails the whole jobs row closed", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["createdAt"] }, bind: { path: "/api/jobs" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ id: "j1", createdAt: "2026-99-99T99:99:99Z" }]);
    const texts = (listEl.children[0] as RElement).children as RElement[];
    expect(texts.map((c) => c.textContent)).toEqual(["ID:", UNAVAILABLE, "Created:", UNAVAILABLE]);
  });

  it("F4 (MEDIUM): a non-semver kernel version fails the whole row closed", () => {
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["version"] }, bind: { path: "/api/kernels" } } as unknown as IrNode;
    const listEl = fdoc.createElement("div");
    bindListRows(fdoc, listEl, node, [{ name: "K1", version: "banana" }]);
    const texts = (listEl.children[0] as RElement).children as RElement[];
    expect(texts.map((c) => c.textContent)).toEqual(["Name:", UNAVAILABLE, "Version:", UNAVAILABLE]);
  });

  // F5 (MEDIUM) is a coverage gap, not a behaviour: dashboard-ir-list-producers.test.ts asserts
  // "no field that IS present ever fails closed" over whichever fields happen to be present in
  // the seeded rows, but never asserted that every profile field (title/meta/status) is present
  // in at least one real row — a field that were NEVER present would pass silently (readListField
  // treats absence as "simply not shown", never a failure). reproduced: the producer test skips
  // absent fields (no assertion that each profile field is present). Fixed in that file's new
  // "every profile field is present, non-null, in at least one real row" test, not here.
});

describe("genui review of #344 r6 (@d9add4d3): an identifier cannot spell a claim the word window misses", () => {
  const claim = "payment-from-the-remote-operator-received";
  it("reproduced at d9add4d3: a hyphenated claim as a list kernelId is withheld, never bare", () => {
    const l = fdoc.createElement("div");
    bindListRows(fdoc, l, { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["kernelId"], statusFrom: "status" }, bind: { path: "/api/jobs" } } as unknown as IrNode, [{ id: "job-1", kernelId: claim, status: "running" }]);
    expect(textOf(l)).not.toContain(claim);
  });
  it("reproduced at d9add4d3: the same claim as a capability type is withheld in a list and in a card", () => {
    const l = fdoc.createElement("div");
    bindListRows(fdoc, l, { type: "list", id: "n2", props: { rowTitle: "name", rowMeta: ["type"], statusFrom: "available" }, bind: { path: "/api/capabilities" } } as unknown as IrNode, [{ name: "Arm", type: claim, available: true }]);
    expect(textOf(l)).not.toContain(claim);
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    bindSchemaCard("capability-summary-v1", { name: "Arm", type: claim, pricing: { baseCost: "1", currency: "USDC" }, assuranceTiers: [0], available: true }, slots);
    expect(slots.map((x) => x.textContent)).not.toContain(claim);
  });
  it("the pair check has NO word window for identifiers (6 words between still withholds)", () => {
    expect(identifierText("id", "payment-a-b-c-d-e-f-received")).toBe(WITHHELD_FIELD);
    expect(identifierText("type", "fundsOfTheRemoteOperatorWereFullyReleased")).toBe(WITHHELD_FIELD); // camelCase too
  });
  it("real identifiers are attributed, never withheld (no false positive on a single money noun or a hex segment)", () => {
    // steward #5149 (fix the property, not the detector): an identifier is attributed like free text;
    // the window-free pair check only withholds, as defense in depth.
    for (const id of ["job-3f2a9c1e-fee", "job-3f2a9c1e-ada", "cap-kernel-nyc-fdm", "kernel-nyc", "liquid-transfer", "analytical-balance", "cnc-3axis"]) {
      expect(identifierText("id", id), id).toBe(REPORTED_PREFIX + id);
    }
  });
});

describe("astra r6 (#344 @a3521bad): versions and percents are closed grammars (verify before fix at 7f6d8d43)", () => {
  // Reproduced at 7f6d8d43: "1.0.0-alpha..1", "1.0.0-01" and a 2,000-digit version rendered, and a
  // stat with {progress: 2.5} rendered "2.5". (Compact identifiers such as PAYMENTRECEIVED were already
  // attributed at 7f6d8d43, so that finding did not reproduce at the current head.)
  const versionRow = (version: string) => {
    const l = fdoc.createElement("div");
    bindListRows(fdoc, l, { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["version"], statusFrom: "status" }, bind: { path: "/api/kernels" } } as unknown as IrNode, [{ name: "K", version, status: "online" }]);
    return (l.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent))[0];
  };
  it("a version carrying words, an empty or leading-zero part, or unbounded digits fails the whole row", () => {
    for (const v of ["1.0.0-paymentreceived", "1.0.0-payment-received", "1.0.0-alpha..1", "1.0.0-01", "01.0.0", "1.0.0+build", "1" + "0".repeat(2000) + ".0.0", "1.0"]) {
      expect(versionRow(v), v).toEqual(["Name:", UNAVAILABLE, "Version:", UNAVAILABLE, "Status:", UNAVAILABLE]);
    }
  });
  it("a real numeric version renders as is", () => {
    expect(versionRow("1.4.0")).toEqual(["Name:", REPORTED_PREFIX + "K", "Version:", "1.4.0", "Status:", "online"]);
  });
  it("a percent is an integer 0..100 (a fraction is off-kind)", () => {
    const stat = (p: unknown) => bindScalar({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "progress" } } as unknown as IrNode, { progress: p });
    expect(stat(2.5)).toBe(UNAVAILABLE);
    expect(stat(80)).toBe("80");
    expect(stat(101)).toBe(UNAVAILABLE);
  });
});

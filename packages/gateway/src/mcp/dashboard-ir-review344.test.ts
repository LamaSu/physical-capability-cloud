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
} from "./dashboard-ir.js";
import type { IrDoc, IrNode } from "./dashboard-ir.js";
import { bindListRows, bindScalar, bindSchemaCard, renderIrDoc } from "./dashboard-ir-renderer.js";
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

describe("#344 money: manifest prose cannot present money", () => {
  it("amounts and payment/verification claims are withheld in every prose slot", () => {
    const doc = ok({
      csd: CSD, title: "Available balance",
      sections: [{ heading: "Payment received - verified", windows: [
        { kind: "note", text: "1,000,000 USDC" },
        { kind: "note", text: "$12.50 on the way" },
        { kind: "note", text: "Pаid in full" },             // Cyrillic 'a'
        { kind: "note", text: "ｐａｉｄ" },       // fullwidth "paid"
        { kind: "note", text: "Settle​d yesterday" },        // zero-width space
        { kind: "actions", actions: [{ id: "a", label: "Refunded" }] },
        { kind: "form", schema: { type: "object", properties: { b: { type: "number", title: "Balance" } } } },
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
    expect(bindScalar({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "progress" } } as unknown as IrNode, { progress: "paid" }))
      .toBe(WITHHELD_FIELD); // progress is not a status field: a claim there is withheld, not qualified (astra r2 F2)
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
      ["j3", "k1", "released" + RECORD_STATUS_NOTE, "released" + RECORD_STATUS_NOTE],
      ["j4", "k1", "running", "running"],
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
      "/api/jobs": { items: [{ id: "j3", kernelId: "k1", status: "released" }, { id: "j4", kernelId: "k1", status: "running" }] },
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
      "p41d", "r3l3as3d", "s3tt1ed", "p a i d", "p.a.i.d", "v-e-r-i-f-i-e-d",
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
    const notice = all.find((e) => e.textContent === WITHHELD_PROSE)!;
    expect(notice.className).toBe("pcc-text pcc-withheld");
    const agent = all.find((e) => e.textContent === "Pick a kernel")!;
    expect(agent.className).toBe("pcc-text pcc-agent pcc-untrusted");
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
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: ["location.label"], statusFrom: "status" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ name: "Arm 1", "location": { label: "\u2705 verified site" }, status: "approved" }]);
    expect((listEl.children[0]!.children as RElement[]).map((c) => c.textContent)).toEqual(["Arm 1", WITHHELD_FIELD, "approved" + RECORD_CLAIM_NOTE]);
    const slots = Array.from({ length: 6 }, () => ({ textContent: "" }));
    bindSchemaCard("capability-summary-v1", { name: "Refunded in full", type: "arm", pricing: { baseCost: "12.50", currency: "USDC" }, assuranceTiers: [1, 2], available: true }, slots);
    expect(slots.map((x) => x.textContent)).toEqual([WITHHELD_FIELD, "arm", "12.50", "USDC", "1, 2", "Yes"]);
    // the card's own price fields show money as stated, even an amount; no other field may
    bindSchemaCard("capability-summary-v1", { name: "Arm", type: "1,000 USDC", pricing: { baseCost: "1,000 USDC", currency: "USDC" }, assuranceTiers: ["Paid", 2], available: false }, slots);
    expect(slots.map((x) => x.textContent)).toEqual(["Arm", WITHHELD_FIELD, "1,000 USDC", "USDC", WITHHELD_FIELD, "No"]);
    expect(textOf(listEl)).not.toContain("verified site");
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

/**
 * @vitest-environment jsdom
 *
 * Money-status CONFORMANCE against the SHIPPED kit (apps/dashboard/public/ui-kit/v1/pcc-ui.js).
 *
 * Two proofs, both against the real bytes the browser runs (never a parallel copy):
 *  1. The kit's <status-map v2> region is extracted verbatim and evaluated. Its money
 *     table must equal the canonical @pcc/spec MONEY_STATUS_MAP key for key (same keys,
 *     same tone, same label), and its classifiers must agree with classifyMoneyStatus
 *     over an adversarial battery. This is what makes "one shared exact map" true for a
 *     vanilla asset that cannot import the spec.
 *  2. The WHOLE kit is booted in jsdom against a receipt manifest + snapshot, and the
 *     rendered settlement pill is asserted. A refund, an allocated-not-final state, an
 *     off-schema "success", or a missing status never renders settled/green.
 *
 * Spec: genui read-route contract sec-A + rules 1 and 12.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import {
  MONEY_STATUS_MAP, classifyMoneyStatus, classifySettlementRecord, VNEXT_UNIT_STATES, VNEXT_STATE_PRESENTATION,
} from "../money/money-status.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitPath = path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js");
const kitSrc = readFileSync(kitPath, "utf8");

type KitRegion = {
  MONEY_STATUS: Record<string, [string, string]>;
  GENERIC_STATES: Record<string, string>;
  statusClass: (s: unknown) => string;
  moneyStatusClass: (s: unknown) => string;
  settlementLabel: (s: unknown) => string | null;
  isMoneyData: (bindingPath: unknown, row: unknown) => boolean;
  dataStatusClass: (bindingPath: unknown, row: unknown, s: unknown) => string;
  VNEXT_UNIT_STATES: readonly string[];
  VNEXT_STATE_PRESENTATION: Record<string, [string, string]>;
  settlementRecordClass: (r: unknown) => [string, string | null, string];
};

function extractRegion(): KitRegion {
  const m = kitSrc.match(/\/\/ <status-map v2>[^\n]*\n([\s\S]*?)\/\/ <\/status-map v2>/);
  if (!m) throw new Error("<status-map v2> markers not found in pcc-ui.js");
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(
    m[1] +
      "\nthis.MONEY_STATUS = MONEY_STATUS; this.GENERIC_STATES = GENERIC_STATES;" +
      " this.statusClass = statusClass; this.moneyStatusClass = moneyStatusClass;" +
      " this.settlementLabel = settlementLabel; this.isMoneyData = isMoneyData; this.dataStatusClass = dataStatusClass;" +
      " this.VNEXT_UNIT_STATES = VNEXT_UNIT_STATES; this.VNEXT_STATE_PRESENTATION = VNEXT_STATE_PRESENTATION;" +
      " this.settlementRecordClass = settlementRecordClass;",
    ctx,
  );
  return ctx as unknown as KitRegion;
}

const toneToClass = (tone: string) => "st-" + tone;

// Adversarial inputs: substring traps, off-schema success words, ambiguity, junk, non-strings.
const ADVERSARIAL: unknown[] = [
  "refunded", "UNDERFUNDED", "UNRELEASED", "INCOMPLETE", "UNSUCCESSFUL", "NOT_APPROVED",
  "INACTIVE", "PARTIALLY_PAID", "PARTIALLY_RELEASED", "settled", "SETTLED", "paid",
  "done", "success", "ok", "ready", "resolved", "succeeded", "complete",
  "Settled Released", " settled-released ", "refund_allocated",
  "", "   ", null, undefined, 0, 42, true, {}, [], "__proto__", "constructor", "toString",
  "completed", "COMPLETED", "released!", "*released*", "released\u0000", "released\u200b", "RELEASED\u0130",
  ["released"], [["released"]], { toString: () => "released" },
];

describe("shipped kit money table == canonical @pcc/spec map", () => {
  const kit = extractRegion();

  it("has exactly the same keys", () => {
    expect(Object.keys(kit.MONEY_STATUS).sort()).toEqual(Object.keys(MONEY_STATUS_MAP).sort());
  });

  it("every key has the same tone and the same honest label", () => {
    for (const k of Object.keys(MONEY_STATUS_MAP)) {
      const spec = MONEY_STATUS_MAP[k]!;
      expect(kit.MONEY_STATUS[k]?.[0], k).toBe(toneToClass(spec.tone));
      expect(kit.MONEY_STATUS[k]?.[1], k).toBe(spec.label);
    }
  });

  it("the money classifier agrees with classifyMoneyStatus on every key and every adversarial input", () => {
    for (const s of [...Object.keys(MONEY_STATUS_MAP), ...ADVERSARIAL]) {
      expect(kit.moneyStatusClass(s), JSON.stringify(s)).toBe(toneToClass(classifyMoneyStatus(s).tone));
      expect(kit.settlementLabel(s), JSON.stringify(s)).toBe(classifyMoneyStatus(s).label);
    }
  });

  it("off-schema success words never green a MONEY surface (but still tone a generic one)", () => {
    for (const w of ["done", "success", "ok", "ready", "resolved", "succeeded", "complete"]) {
      expect(kit.moneyStatusClass(w), w).toBe("st-unknown");
      expect(kit.statusClass(w), w).toBe("st-settled"); // a generic run/action surface
    }
  });

  it("prototype keys never resolve (own-property lookup only)", () => {
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(kit.moneyStatusClass(k), k).toBe("st-unknown");
      expect(kit.statusClass(k), k).toBe("st-unknown");
    }
  });

  it("a data surface picks its table from the DATA: money unless a known non-money read with no money field", () => {
    // money bindings: the money table only, so off-schema success words and "completed" are never green
    for (const w of ["success", "done", "ok", "completed", "resolved"]) {
      expect(kit.dataStatusClass("/api/escrow", { status: w }, w), w).not.toBe("st-settled");
      expect(kit.dataStatusClass("/api/settlement/units", { status: w }, w), w).not.toBe("st-settled");
      expect(kit.dataStatusClass("/api/some/unlisted/read", { status: w }, w), w).not.toBe("st-settled"); // fail closed
    }
    // a non-money read without money fields keeps generic tones (a completed JOB is done)
    expect(kit.dataStatusClass("/api/jobs", { status: "completed" }, "completed")).toBe("st-settled");
    expect(kit.dataStatusClass("/api/jobs/j1", { status: "done" }, "done")).toBe("st-settled");
    // ...but a job row that carries money is money data
    expect(kit.dataStatusClass("/api/jobs", { status: "completed", amount: "5" }, "completed")).toBe("st-waiting");
    expect(kit.dataStatusClass("/api/jobs", { status: "success", escrowAddress: "0xabc" }, "success")).toBe("st-unknown");
    // lookalike or odd binding paths are money (fail closed)
    for (const b of ["/API/jobs", "/api/jobsX", "/api/jobs%2F..%2Fescrow", null, undefined, 42]) {
      expect(kit.isMoneyData(b, {}), String(b)).toBe(true);
    }
    // a refund word is never green even on a generic surface
    expect(kit.statusClass("refunded")).toBe("st-refunded");
  });

  it("each classifier is defined exactly once in the shipped kit (no later shadowing definition)", () => {
    for (const fn of ["normStatus", "statusClass", "moneyStatusClass", "settlementLabel", "isMoneyData", "dataStatusClass"]) {
      expect(kitSrc.split("function " + fn + "(").length - 1, fn).toBe(1);
    }
  });

  it("the greedy substring regex is gone from the shipped kit", () => {
    expect(kitSrc).not.toMatch(/settl\|releas\|complet\|done\|paid\|funded\|success\|approved\|active/);
    expect(kitSrc).not.toMatch(/<status-map v1>/);
  });
});

// ── Full-kit render: boot the real pcc-ui.js in jsdom and read the rendered pill ──

const ESC = "/api/escrow/esc-test-1";
const receiptManifest = JSON.stringify({
  csd: "pcc://artifacts/dashboard/v1",
  title: "Receipt",
  sections: [{ windows: [{ kind: "receipt", binding: { path: ESC } }] }],
});

function boot(escrow: Record<string, unknown>, manifest: string = receiptManifest, snapshot?: Record<string, unknown>) {
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
  const main = document.createElement("main");
  main.id = "pcc-root";
  document.body.appendChild(main);
  const mNode = document.createElement("script");
  mNode.type = "application/json";
  mNode.id = "pcc-manifest";
  mNode.textContent = manifest;
  document.body.appendChild(mNode);
  const sNode = document.createElement("script");
  sNode.type = "application/json";
  sNode.id = "pcc-snapshot";
  sNode.textContent = JSON.stringify(snapshot ?? { _ts: "2026-09-24T00:00:00Z", [ESC]: escrow });
  document.body.appendChild(sNode);
  // eslint-disable-next-line no-eval
  (0, eval)(kitSrc);
}
const flush = () => new Promise((r) => setTimeout(r, 0));

async function renderedPill(escrow: Record<string, unknown>) {
  boot({ id: "esc-test-1", totalAmount: "10.00", currency: "USDC", payer: "p", payee: "o", ...escrow });
  await flush();
  const pill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement | null;
  if (!pill) throw new Error("receipt pill not rendered");
  return { cls: pill.className, text: pill.textContent, rail: document.querySelector(".pcc-receipt-rail")!.textContent! };
}

describe("shipped kit renders money state honestly (full jsdom boot, receipt window)", () => {
  const NOT_SETTLED: Array<[Record<string, unknown>, string]> = [
    [{ status: "refunded" }, "st-refunded"],
    [{ status: "SETTLED_REFUNDED" }, "st-refunded"],
    [{ status: "REFUND_ALLOCATED" }, "st-waiting"],
    [{ status: "RELEASE_ALLOCATED" }, "st-waiting"],
    [{ status: "underfunded" }, "st-unknown"],
    [{ status: "success" }, "st-unknown"], // off-schema success word on a money surface
    [{ status: "done" }, "st-unknown"],
    [{ status: "settled" }, "st-unknown"], // ambiguous: can mean refunded
    [{ releasedCount: 3 }, "st-unknown"], // rule 12: never infer settlement from a count
    [{ status: "funded" }, "st-waiting"],
  ];

  it.each(NOT_SETTLED)("%j renders %s, never settled/green", async (escrow, expected) => {
    const r = await renderedPill(escrow);
    expect(r.cls).toContain(expected);
    expect(r.cls).not.toContain("st-settled");
  });

  it("a refund shows the honest direction label 'operator NOT paid'", async () => {
    const r = await renderedPill({ status: "refunded" });
    expect(r.rail).toContain("operator NOT paid");
  });

  it("a genuine final release (a consistent V-next receipt) renders settled with its direction label", async () => {
    const r = await renderedPill({ finalState: "SETTLED_RELEASED", isAllocated: true, phase: "settled" }); // wire shape
    expect(r.cls).toContain("st-settled");
    expect(r.text).toBe("SETTLED_RELEASED");
    expect(r.rail).toContain("payout distribution discharged");
  });

  it("a bare status word, even SETTLED_RELEASED, is not a settlement read (never green)", async () => {
    const r = await renderedPill({ status: "SETTLED_RELEASED" });
    expect(r.cls).not.toContain("st-settled");
  });

  it("the pill text is the raw server value (never rewritten to look final)", async () => {
    const r = await renderedPill({ status: "REFUND_ALLOCATED" });
    expect(r.text).toBe("REFUND_ALLOCATED");
  });
});

describe("reviewer-bravo F3/F4: 'completed' and generic success words never green money data (full boot)", () => {
  it("a receipt bound to a completed JOB is not a green payment", async () => {
    const r = await renderedPill({ status: "completed" });
    expect(r.cls).toContain("st-waiting");
    expect(r.cls).not.toContain("st-settled");
    expect(r.rail).toContain("settlement not confirmed");
  });

  it("a receipt with a decorated or non-string status is unknown, never green", async () => {
    for (const status of ["released!", ["released"], "released\u0000"]) {
      const r = await renderedPill({ status });
      expect(r.cls, JSON.stringify(status)).toContain("st-unknown");
    }
  });

  const listManifest = (p: string) => JSON.stringify({
    csd: "pcc://artifacts/dashboard/v1", title: "L",
    sections: [{ windows: [{ kind: "list", binding: { path: p }, item: { title: "id", statusFrom: "status" } }] }],
  });
  async function listPills(p: string, rows: unknown[]) {
    boot({}, listManifest(p), { _ts: "2026-09-24T00:00:00Z", [p]: rows });
    await flush();
    return Array.from(document.querySelectorAll(".pcc-list-row .pcc-pill")).map((e) => (e as HTMLElement).className);
  }

  it("an ESCROW list never greens 'success' / 'done' / 'completed'", async () => {
    const pills = await listPills("/api/escrow", [
      { id: "a", status: "success" }, { id: "b", status: "done" }, { id: "c", status: "completed" }, { id: "d", status: "released" },
    ]);
    expect(pills.length).toBe(4);
    expect(pills.some((c) => c.includes("st-settled"))).toBe(false); // a bare word is never green, "released" included
  });

  it("a JOB list keeps generic tones for non-money rows (completed job = done)", async () => {
    const pills = await listPills("/api/jobs", [{ id: "j1", status: "completed" }, { id: "j2", status: "completed", amount: "5" }]);
    expect(pills[0]).toContain("st-settled");
    expect(pills[1]).toContain("st-waiting"); // a paid job row is money data
  });
});

// ── source-schema classification: kit == spec, pinned to the Solidity enum ─────────────────────
const lifecycle = (n: number) => ({
  chainId: 84532, escrow: "0xE", unitId: "u1", unitState: n,
  phase: n >= 8 ? "settled" : n >= 6 ? "allocated" : "active",
  finalState: n >= 8 ? VNEXT_UNIT_STATES[n] : null, isTerminal: n >= 8, isAllocated: n >= 6,
});
const FIXTURES: unknown[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1, 8.5].map(lifecycle),
  { unitState: "SETTLED_RELEASED" }, { unitState: "settled_released" }, { unitState: "8" }, { unitState: null },
  { ...lifecycle(8), finalState: null }, { ...lifecycle(8), isAllocated: false }, { ...lifecycle(8), isTerminal: false },
  { ...lifecycle(6), finalState: "SETTLED_RELEASED" }, { ...lifecycle(3), isAllocated: true },
  { finalState: "SETTLED_RELEASED", isAllocated: true }, { finalState: "SETTLED_REFUNDED", isAllocated: true },
  { finalState: "SETTLED_RELEASED", isAllocated: false }, { finalState: "SETTLED_RELEASED" },
  { finalState: null, isAllocated: true }, { finalState: null, isAllocated: false }, { finalState: null },
  { finalState: 8, isAllocated: true }, { finalState: "RELEASED", isAllocated: true },
  { status: "refunded", contractAddress: "0x1" }, { status: "released", milestones: [] }, { status: "completed", totalAmount: "1" },
  { status: "RELEASED?", cwmId: "c" }, { id: "j1", status: "completed" }, { id: "t", state: "completed" },
  { status: "SETTLED_RELEASED" }, null, undefined, [], "SETTLED_RELEASED", 8, {},
];

describe("settlement read models are classified by SOURCE SCHEMA (kit == spec)", () => {
  const kit = extractRegion();

  it("the V-next ordinal table equals the Solidity enum UnitState, in the kit and in the spec", () => {
    const sol = readFileSync(path.resolve(here, "../../../contracts/src/libraries/VNextSettlementLib.sol"), "utf8");
    const body = /enum UnitState\s*\{([\s\S]*?)\}/.exec(sol)![1]!;
    const names = body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim().replace(/,$/, "")).filter((l) => /^[A-Z_]+$/.test(l));
    expect(names.length).toBe(10);
    expect([...VNEXT_UNIT_STATES]).toEqual(names);
    expect([...kit.VNEXT_UNIT_STATES]).toEqual(names);
  });

  it("the kit's V-next presentation equals the spec's (tone and label per state)", () => {
    expect(Object.keys(kit.VNEXT_STATE_PRESENTATION).sort()).toEqual(Object.keys(VNEXT_STATE_PRESENTATION).sort());
    for (const [k, e] of Object.entries(VNEXT_STATE_PRESENTATION)) {
      expect(kit.VNEXT_STATE_PRESENTATION[k]![0], k).toBe(toneToClass(e.tone));
      expect(kit.VNEXT_STATE_PRESENTATION[k]![1], k).toBe(e.label);
    }
  });

  it("the kit adapter agrees with classifySettlementRecord on every wire fixture", () => {
    for (const f of FIXTURES) {
      const spec = classifySettlementRecord(f);
      const [cls, label] = kit.settlementRecordClass(f);
      expect(cls, JSON.stringify(f)).toBe(toneToClass(spec.tone));
      expect(label, JSON.stringify(f)).toBe(spec.label);
    }
  });

  it("only a consistent state-8 read model is green, in the kit", () => {
    const green = FIXTURES.filter((f) => kit.settlementRecordClass(f)[0] === "st-settled").map((f) => JSON.stringify(f));
    expect(green).toEqual([JSON.stringify(lifecycle(8)), JSON.stringify({ finalState: "SETTLED_RELEASED", isAllocated: true })]);
  });

  it("the kit's tables are frozen (a runtime write cannot turn anything green)", () => {
    expect(Object.isFrozen(kit.MONEY_STATUS)).toBe(true);
    expect(Object.isFrozen(kit.MONEY_STATUS["REFUNDED"])).toBe(true);
    expect(Object.isFrozen(kit.VNEXT_STATE_PRESENTATION)).toBe(true);
    expect(Object.isFrozen(kit.VNEXT_STATE_PRESENTATION["SETTLED_REFUNDED"])).toBe(true);
    expect(Object.isFrozen(kit.VNEXT_UNIT_STATES)).toBe(true);
    expect(Object.isFrozen(kit.GENERIC_STATES)).toBe(true);
  });
});

describe("receipt and run windows (full boot): schema-aware, nothing invented", () => {
  const RC = "/api/settlement/units/u1/receipt";
  const receiptAt = (p: string) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "R", sections: [{ windows: [{ kind: "receipt", binding: { path: p } }] }] });
  async function receiptOf(p: string, rec: unknown) {
    boot({}, receiptAt(p), { _ts: "2026-09-24T00:00:00Z", [p]: rec });
    await flush();
    const pill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement;
    return { cls: pill.className, text: pill.textContent, body: document.querySelector(".pcc-receipt-rail")!.parentElement!.textContent! };
  }

  it("a receipt bound to a JOB endpoint is 'not a settlement record' (product-qa #2594)", async () => {
    const r = await receiptOf("/api/jobs/j1", { id: "j1", status: "completed", capabilityId: "c1" });
    expect(r.cls).toContain("st-unknown");
    expect(r.body).toContain("not a settlement record");
  });

  it("a V-next receipt with no payer, payee, currency or rail invents none of them", async () => {
    const r = await receiptOf(RC, { chainId: 84532, escrow: "0xE", unitId: "u1", finalState: "SETTLED_RELEASED", isAllocated: true, phase: "settled", economics: null });
    expect(r.cls).toContain("st-settled");
    expect(r.body).toContain("payer not reported");
    expect(r.body).toContain("payee not reported");
    expect(r.body).toContain("amount not reported");
    expect(r.body).not.toContain("USDC");
    expect(r.body).not.toContain("escrow-milestone");
  });

  it("an amount without a currency shows no invented currency", async () => {
    const r = await receiptOf(RC, { finalState: "SETTLED_RELEASED", isAllocated: true, totalAmount: "10.00", payer: "0xP", payee: "0xQ" });
    expect(r.body).toContain("10.00");
    expect(r.body).not.toContain("USDC");
  });

  it("a /lifecycle read with a numeric unitState renders by its ordinal; a disagreement is unknown", async () => {
    const LC = "/api/settlement/units/u1/lifecycle";
    const ok = await receiptOf(LC, lifecycle(8));
    expect(ok.cls).toContain("st-settled");
    expect(ok.text).toBe("SETTLED_RELEASED");
    const six = await receiptOf(LC, lifecycle(6));
    expect(six.cls).toContain("st-waiting");
    expect(six.body).toContain("payout outstanding");
    const bad = await receiptOf(LC, { ...lifecycle(8), isAllocated: false });
    expect(bad.cls).toContain("st-unknown");
  });

  const runAt = (p: string) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "Run", sections: [{ windows: [{ kind: "run", binding: { path: p }, statusFrom: "status", latestFrom: "message" }] }] });
  async function runPill(p: string, data: unknown) {
    boot({}, runAt(p), { _ts: "2026-09-24T00:00:00Z", [p]: data });
    await flush();
    const pill = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    return { cls: pill.className, text: pill.textContent };
  }

  it("a run over a settlement read model is classified by its schema", async () => {
    const g = await runPill("/api/settlement/units/u1/lifecycle", lifecycle(8));
    expect(g.cls).toContain("st-settled");
    const w = await runPill("/api/settlement/units/u1/lifecycle", lifecycle(7));
    expect(w.cls).toContain("st-waiting");
  });

  it("a run over escrow data with an off-schema success word is not green", async () => {
    const r = await runPill("/api/escrow/e1", { id: "e1", status: "success", totalAmount: "5" });
    expect(r.cls).not.toContain("st-settled");
  });

  it("a full run snapshot with NO status reads unknown (an earlier state is never kept)", async () => {
    const r = await runPill("/api/jobs/j1", { id: "j1", message: "tick" });
    expect(r.cls).toContain("st-unknown");
  });
});

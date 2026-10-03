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
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import {
  MONEY_STATUS_MAP, classifyMoneyStatus, classifySettlementRecord, VNEXT_UNIT_STATES, VNEXT_STATE_PRESENTATION, VNEXT_PHASE,
  classifySettlementRead, SETTLEMENT_READ_ROUTE, FINAL_MONEY_TOKENS, claimsFinalMoney, statusPillText,
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
  VNEXT_PHASE: Record<string, string>;
  settlementRecordClass: (r: unknown) => [string, string | null, string];
  settlementReadClass: (r: unknown, path: unknown, live: unknown) => [string, string | null, string];
  SETTLEMENT_READ_ROUTE: RegExp;
  FINAL_MONEY_TOKENS: Record<string, boolean>;
  claimsFinalMoney: (s: unknown) => boolean;
  statusPillText: (raw: unknown, verified: boolean) => string;
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
      " this.VNEXT_UNIT_STATES = VNEXT_UNIT_STATES; this.VNEXT_STATE_PRESENTATION = VNEXT_STATE_PRESENTATION; this.VNEXT_PHASE = VNEXT_PHASE;" +
      " this.settlementRecordClass = settlementRecordClass; this.settlementReadClass = settlementReadClass; this.SETTLEMENT_READ_ROUTE = SETTLEMENT_READ_ROUTE;" +
      " this.FINAL_MONEY_TOKENS = FINAL_MONEY_TOKENS; this.claimsFinalMoney = claimsFinalMoney; this.statusPillText = statusPillText;",
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

  it("off-schema success words never green a MONEY surface, and a generic surface reads them NEUTRAL (never green)", () => {
    for (const w of ["done", "success", "ok", "ready", "resolved", "succeeded", "complete"]) {
      expect(kit.moneyStatusClass(w), w).toBe("st-unknown");
      expect(kit.statusClass(w), w).toBe("st-ack"); // astra r2 F2: nothing but a live settlement read is green
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
    expect(kit.dataStatusClass("/api/jobs", { status: "completed" }, "completed")).toBe("st-ack"); // neutral, never green
    expect(kit.dataStatusClass("/api/jobs/j1", { status: "done" }, "done")).toBe("st-ack");
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

  it("a consistent V-next receipt in a baked SNAPSHOT is not shown as final (astra r2 F1: shape is not provenance)", async () => {
    const r = await renderedPill({ finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled" }); // the /receipt wire shape
    expect(r.cls).toContain("st-unknown");
    expect(r.rail).toContain("final state not shown - not a live read of a settlement route");
    // the LIVE, exact-route case (green, with its direction label) is pinned in the "astra r2" block below
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
    expect(pills[0]).toContain("st-ack"); // a completed job: neutral, never green
    expect(pills[1]).toContain("st-waiting"); // a paid job row is money data
  });
});

// ── source-schema classification: kit == spec, pinned to the Solidity enum ─────────────────────
// The routes' OWN field semantics (gateway unit-state-mapper): isAllocated is 6/7 ONLY, isTerminal 8/9.
const PHASE = [undefined, "active", "contest", "contest", "escalation", "escalation", "allocated", "allocated", "settled", "settled"];
const lifecycle = (n: number) => ({
  chainId: 84532, escrow: "0xE", unitId: "u1", unitState: n, phase: PHASE[n],
  finalState: n >= 8 ? VNEXT_UNIT_STATES[n] : null, isTerminal: n >= 8, isAllocated: n === 6 || n === 7,
});
const FIXTURES: unknown[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1, 8.5].map(lifecycle),
  { unitState: "SETTLED_RELEASED" }, { unitState: "settled_released" }, { unitState: "8" }, { unitState: null },
  { ...lifecycle(8), finalState: null }, { ...lifecycle(8), isAllocated: true }, { ...lifecycle(8), isTerminal: false },
  { ...lifecycle(8), phase: "allocated" }, { ...lifecycle(6), isAllocated: false }, { ...lifecycle(2), phase: "active" },
  { ...lifecycle(6), finalState: "SETTLED_RELEASED" }, { ...lifecycle(3), isAllocated: true },
  { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled" }, { finalState: "SETTLED_REFUNDED", isAllocated: false, phase: "settled" },
  { finalState: "SETTLED_RELEASED", isAllocated: true, phase: "settled" }, { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "allocated" },
  { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", isTerminal: false },
  { finalState: "SETTLED_RELEASED", isAllocated: true }, { finalState: "SETTLED_RELEASED", isAllocated: false }, { finalState: "SETTLED_RELEASED" },
  { finalState: null, isAllocated: true, phase: "allocated" }, { finalState: null, isAllocated: true, phase: "settled" },
  { finalState: null, isAllocated: false, phase: "contest" }, { finalState: null, isAllocated: false, phase: "allocated" },
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

  it("the kit's phase table equals the spec's", () => {
    expect(kit.VNEXT_PHASE).toEqual({ ...VNEXT_PHASE });
    expect(Object.isFrozen(kit.VNEXT_PHASE)).toBe(true);
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
    expect(green).toEqual([JSON.stringify(lifecycle(8)), JSON.stringify({ finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled" })]);
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
    const r = await receiptOf(RC, { chainId: 84532, escrow: "0xE", unitId: "u1", finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", economics: null });
    expect(r.cls).toContain("st-unknown"); // a snapshot is never shown as final
    expect(r.body).toContain("payer not reported");
    expect(r.body).toContain("payee not reported");
    expect(r.body).toContain("amount not reported");
    expect(r.body).not.toContain("USDC");
    expect(r.body).not.toContain("escrow-milestone");
  });

  // The route's EconomicsRecord (settlement-read.ts): amount is a raw BASE-unit integer; there is no tokenDecimals today.
  const ECON = { amount: "1000000", feeAmount: "23500", recipient: "0xRecipient", token: "0xUSDC", assuranceTier: 1 };
  const settledReceipt = (economics: unknown) => ({ chainId: 84532, escrow: "0xE", unitId: "u1", finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", network: { chainId: 84532 }, economics });

  it("a real V-next receipt's economics.amount (base units, no decimals) is never shown as a sum", async () => {
    const r = await receiptOf(RC, settledReceipt(ECON));
    expect(r.cls).toContain("st-unknown"); // a snapshot is never shown as final
    expect(r.body).toContain("1000000 base units (decimals not reported)");
    expect(r.body).not.toContain("1,000,000");
    expect(r.body).not.toContain("USDC");
  });

  it("with the record's own tokenDecimals the base units become the exact display amount", async () => {
    for (const [amount, d, shown] of [["1000000", 6, "1"], ["1234567", 6, "1.234567"], ["25", 6, "0.000025"], ["1500000000000", 6, "1,500,000"], ["7", 0, "7"]] as Array<[string, number, string]>) {
      const r = await receiptOf(RC, settledReceipt({ ...ECON, amount, tokenDecimals: d }));
      expect(r.body, amount + "/" + d).toContain(shown);
    }
  });

  it("a malformed base-unit amount is 'amount not reported', never a guess", async () => {
    for (const amount of ["1e6", "-5", "1,000", "0x10", "", { v: 1 }]) {
      const r = await receiptOf(RC, settledReceipt({ ...ECON, amount }));
      expect(r.body, JSON.stringify(amount)).toContain("amount not reported");
    }
  });

  it("an amount without a currency shows no invented currency", async () => {
    const r = await receiptOf(RC, { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", totalAmount: "10.00", payer: "0xP", payee: "0xQ" });
    expect(r.body).toContain("10.00");
    expect(r.body).not.toContain("USDC");
  });

  it("a /lifecycle read with a numeric unitState renders by its ordinal; a disagreement is unknown", async () => {
    const LC = "/api/settlement/units/u1/lifecycle";
    const ok = await receiptOf(LC, lifecycle(8));
    expect(ok.cls).toContain("st-unknown"); // named by its ordinal, but a snapshot is never shown as final
    expect(ok.text).toBe("reported status: SETTLED_RELEASED - settlement unconfirmed"); // nor named as one (astra r4 F6)
    const six = await receiptOf(LC, lifecycle(6));
    expect(six.cls).toContain("st-waiting");
    expect(six.body).toContain("payout outstanding");
    const bad = await receiptOf(LC, { ...lifecycle(8), isAllocated: true });
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
    expect(g.cls).toContain("st-unknown"); // a snapshot run is never shown as final
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

// ── astra round 2 on #313 @8f946499 (verify before fix): each finding reproduced by a failing test ──
describe("astra r2 (#313 @8f946499): settlement green needs a LIVE read of an exact settlement route", () => {
  const UNIT = "0x" + "ab".repeat(32);
  const RC_LIVE = `/api/settlement/units/${UNIT}/receipt`;
  const LC_LIVE = `/api/settlement/units/${UNIT}/lifecycle`;
  const SETTLED_RECEIPT = { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled" };
  const LC8 = { unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled" };
  const man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
  type Reply = { status: number; body?: unknown } | "reject";
  function bootLive(manifest: string, reply: (url: string, n: number) => Reply) {
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
    const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
    const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest"; mNode.textContent = manifest;
    document.body.appendChild(mNode); // no #pcc-snapshot node: LIVE mode
    let n = 0;
    (window as unknown as { fetch: unknown }).fetch = (url: unknown) => {
      const r = reply(String(url), n++);
      if (r === "reject") return Promise.reject(new Error("network down"));
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: () => Promise.resolve(r.body ?? {}) });
    };
    // eslint-disable-next-line no-eval
    (0, eval)(kitSrc);
  }
  const receiptPill = () => (document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement).className;
  const receiptWin = (path: string) => man([{ kind: "receipt", binding: { path } }]);

  it("F1 (HIGH): a settled-SHAPED body bound to a job route is never green", async () => {
    bootLive(receiptWin("/api/jobs/j1"), () => ({ status: 200, body: SETTLED_RECEIPT }));
    await flush();
    expect(receiptPill()).not.toContain("st-settled");
  });

  it("F1 (HIGH): a baked (unsigned) snapshot of a settled receipt is never green, even at the settlement route", async () => {
    boot({}, receiptWin(RC_LIVE), { _ts: "2026-09-24T00:00:00Z", [RC_LIVE]: SETTLED_RECEIPT });
    await flush();
    expect(receiptPill()).not.toContain("st-settled");
  });

  it("F1 positive control: a LIVE read of the exact settlement receipt route in the settled shape is green", async () => {
    bootLive(receiptWin(RC_LIVE), () => ({ status: 200, body: SETTLED_RECEIPT }));
    await flush();
    expect(receiptPill()).toContain("st-settled");
    expect(document.querySelector(".pcc-receipt-rail")!.textContent).toContain("payout distribution discharged");
  });

  it("F1: only the exact per-unit route counts (the route's own unit-id format; a query such as ?asOf is fine)", async () => {
    const cases: Array<[string, boolean]> = [
      [LC_LIVE, true], [RC_LIVE + "?asOf=0x" + "cd".repeat(32), true],
      ["/api/settlement/units/u1/receipt", false], ["/api/settlement/units/" + UNIT + "/receipt/x", false],
      ["/api/settlement/units/" + UNIT + "/provenance", false], ["/API/settlement/units/" + UNIT + "/receipt", false],
    ];
    for (const [p, green] of cases) {
      const body = p.indexOf("lifecycle") >= 0 ? LC8 : SETTLED_RECEIPT;
      bootLive(receiptWin(p), () => ({ status: 200, body }));
      await flush();
      expect(receiptPill().indexOf("st-settled") >= 0, p).toBe(green);
    }
  });

  it("F1: kit settlementReadClass == spec classifySettlementRead over records x sources", () => {
    const kit = extractRegion();
    expect(kit.SETTLEMENT_READ_ROUTE.source).toBe(SETTLEMENT_READ_ROUTE.source);
    const records: unknown[] = [SETTLED_RECEIPT, LC8, { ...LC8, unitState: 9, finalState: "SETTLED_REFUNDED" },
      { finalState: "SETTLED_REFUNDED", isAllocated: false, phase: "settled" }, { ...LC8, unitState: 6, finalState: null, isTerminal: false, isAllocated: true, phase: "allocated" },
      { status: "refunded", contractAddress: "0x1" }, { status: "completed", id: "j1" }, null, "SETTLED_RELEASED"];
    const sources: unknown[] = [{ path: RC_LIVE, live: true }, { path: LC_LIVE, live: true }, { path: RC_LIVE, live: false },
      { path: "/api/jobs/j1", live: true }, { path: RC_LIVE + "?asOf=x", live: true }, { path: RC_LIVE, live: "true" }, null, undefined, {}];
    for (const r of records) for (const src of sources) {
      const spec = classifySettlementRead(r, src as never);
      const [cls, label] = kit.settlementReadClass(r, (src as { path?: unknown } | null)?.path, (src as { live?: unknown } | null)?.live);
      const tag = JSON.stringify(r) + " @ " + JSON.stringify(src);
      expect(cls, tag).toBe("st-" + spec.tone);
      expect(label, tag).toBe(spec.label);
    }
  });

  it("F2 (HIGH): a generic success word is never green, whatever the routing heuristic decides", () => {
    const kit = extractRegion() as unknown as { dataStatusClass: (p: string, r: unknown, s: unknown) => string; statusClass: (s: unknown) => string };
    expect(kit.dataStatusClass("/api/jobs", { status: "success", economics: { amount: "5" } }, "success")).not.toBe("st-settled");
    for (const w of ["success", "done", "completed", "ok", "resolved", "ready"]) expect(kit.statusClass(w), w).not.toBe("st-settled");
  });

  it("F3 (MEDIUM): a failed poll after a settled read does not keep the pill green", async () => {
    bootLive(man([{ kind: "run", binding: { path: LC_LIVE, pollMs: 5 }, statusFrom: "status", latestFrom: "message" }]),
      (_u, n) => (n === 0 ? { status: 200, body: LC8 } : "reject"));
    await flush();
    const pill = () => (document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement).className;
    expect(pill()).toContain("st-settled"); // the first, live read of the exact lifecycle route
    await new Promise((r) => setTimeout(r, 60)); // later polls reject
    expect(pill()).not.toContain("st-settled");
    expect(pill()).toContain("st-unknown");
  });
});

describe("astra r3 (#313 @9250c578): F5, generic request success is never green (verify before fix)", () => {
  const man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
  type W = Window & { __PCC_HOST__?: boolean; __PCC_HOST_OPERATIONS__?: string[]; __PCC_HOST_BRIDGE__?: unknown; __PCC_UI_BOOTED__?: boolean };
  // `reply` answers only the requests a test expects (null = not this test's). Anything else never settles,
  // so a run window left polling by an earlier test stays frozen instead of being revived by these stubs.
  function bootWith(manifest: string, reply: (url: string, method: string) => { status: number; body?: unknown } | null, host?: { ops: string[]; result: unknown }) {
    const w = window as unknown as W;
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    w.__PCC_UI_BOOTED__ = false;
    delete w.__PCC_HOST__; delete w.__PCC_HOST_OPERATIONS__; delete w.__PCC_HOST_BRIDGE__;
    if (host) {
      w.__PCC_HOST__ = true;
      w.__PCC_HOST_OPERATIONS__ = host.ops;
      w.__PCC_HOST_BRIDGE__ = { callOperation: () => Promise.resolve(host.result) };
    }
    const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
    const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest"; mNode.textContent = manifest;
    document.body.appendChild(mNode); // no #pcc-snapshot node: LIVE mode
    (window as unknown as { fetch: unknown }).fetch = (url: unknown, init?: { method?: string }) => {
      const r = reply(String(url), (init && init.method) || "GET");
      if (r === null) return new Promise(() => {});
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: () => Promise.resolve(r.body ?? {}), text: () => Promise.resolve(JSON.stringify(r.body ?? {})) });
    };
    // eslint-disable-next-line no-eval
    (0, eval)(kitSrc);
  }
  const click = (label: string) => {
    // startsWith: a kit may append its own tag after the manifest label (#342, ruling 4).
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim().startsWith(label)) as HTMLButtonElement | undefined;
    if (!b) throw new Error("no button " + label);
    b.click();
  };
  afterEach(() => { const w = window as unknown as W; delete w.__PCC_HOST__; delete w.__PCC_HOST_OPERATIONS__; delete w.__PCC_HOST_BRIDGE__; });

  it("F5 (HIGH): an ordinary POST that returns 200 {} is acknowledged, never green", async () => {
    bootWith(man([{ kind: "actions", actions: [{ id: "fb", label: "Send note", kind: "post", path: "/api/feedback", body: { note: "hi" } }] }]),
      (url, method) => (method === "POST" && new URL(url).pathname === "/api/feedback" ? { status: 200, body: {} } : null));
    await flush();
    click("Send note");
    await flush();
    const st = document.querySelector(".pcc-action-status") as HTMLElement;
    expect(st.textContent).toContain("Done");
    expect(st.className).not.toContain("st-settled");
  });

  it("F5 (HIGH): a hosted typed operation that resolves without isError is acknowledged, never green", async () => {
    bootWith(man([{ kind: "actions", actions: [{ id: "q", label: "Get a quote", operation_id: "capability.request_quote", arguments: {} }] }]),
      () => null, { ops: ["capability.request_quote"], result: { content: [{ type: "text", text: "{}" }] } });
    await flush();
    click("Get a quote");
    await flush();
    const st = document.querySelector(".pcc-action-status") as HTMLElement;
    expect(st.textContent).toContain("Done");
    expect(st.className).not.toContain("st-settled");
  });

  // F5's third path (rebindApproval: a resolved approval's header pill) cannot be clicked at this head:
  // the approval window's Approve/Deny foot is removed again by winShell._setFoot (a master bug that
  // #342 fixes: _setFoot there removes only .pcc-foot-meta). The source pin below covers that line, and
  // #342's suite renders it end to end once it carries this head.
  it("F5: no code path assigns the green class directly; only the settlement-read classifier yields it", () => {
    expect(kitSrc).not.toMatch(/className\s*=\s*'[^']*st-settled/);
    expect(kitSrc).not.toMatch(/['"]pcc-(?:pill|action-status) st-settled['"]/);
  });
});

describe("astra r4 (#313 @887ea3c3): F6, a rejected money word is never shown as a bare status (verify before fix)", () => {
  const UNIT = "0x" + "ab".repeat(32);
  const RC_LIVE = `/api/settlement/units/${UNIT}/receipt`;
  const SETTLED_RECEIPT = { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled" };
  const man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
  // Answers only the requests a test expects (null = not this test's), and only its FIRST read of each:
  // a later poll never settles, so no window keeps polling after the test.
  function bootRead(manifest: string, reply: (url: string) => unknown) {
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
    const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
    const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest"; mNode.textContent = manifest;
    document.body.appendChild(mNode); // LIVE mode
    const seen = new Set<string>();
    (window as unknown as { fetch: unknown }).fetch = (url: unknown) => {
      const u = String(url);
      const body = seen.has(u) ? null : reply(u);
      seen.add(u);
      if (body === null) return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
    };
    // eslint-disable-next-line no-eval
    (0, eval)(kitSrc);
  }
  const pills = () => Array.from(document.querySelectorAll(".pcc-pill")).map((p) => (p.textContent || "").trim());
  const WORDS = ["paid", "released", "settled", "PAID", "Released", "SETTLED_RELEASED"];
  const bare = (texts: string[], w: string) => texts.filter((t) => t.toLowerCase() === w.toLowerCase());

  it("F6 (HIGH): a list row on a money read never shows a bare final money word", async () => {
    for (const w of WORDS) {
      bootRead(man([{ kind: "list", binding: { path: "/api/escrow" }, item: { title: "id", statusFrom: "status" } }]),
        (u) => (new URL(u).pathname === "/api/escrow" ? [{ id: "e1", status: w }] : null));
      await flush();
      expect(document.querySelector(".pcc-list-row"), w).not.toBeNull();
      expect(bare(pills(), w), w).toEqual([]);
    }
  });

  it("F6 (HIGH): a run window never shows a bare final money word", async () => {
    for (const w of WORDS) {
      bootRead(man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "message" }]),
        (u) => (new URL(u).pathname === "/api/escrow/e1" ? { status: w, message: "m" } : null));
      await flush();
      expect(bare(pills(), w), w).toEqual([]);
    }
  });

  it("F6 (HIGH): a receipt never shows a bare final money word for a legacy record", async () => {
    for (const w of WORDS) {
      bootRead(man([{ kind: "receipt", binding: { path: "/api/escrow/e1" } }]),
        (u) => (new URL(u).pathname === "/api/escrow/e1" ? { id: "e1", status: w, contractAddress: "0x" + "11".repeat(20), totalAmount: "5" } : null));
      await flush();
      expect(document.querySelector(".pcc-receipt-rail"), w).not.toBeNull();
      expect(bare(pills(), w), w).toEqual([]);
    }
  });

  it("F6 (HIGH): a gated-out final state (a baked snapshot) is never shown as a bare state name", async () => {
    boot({}, man([{ kind: "receipt", binding: { path: RC_LIVE } }]), { _ts: "2026-09-24T00:00:00Z", [RC_LIVE]: SETTLED_RECEIPT });
    await flush();
    const pill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement;
    expect(pill.className).not.toContain("st-settled");
    expect(pill.textContent).not.toBe("SETTLED_RELEASED");
  });

  it("F6: a NON-money read's status that claims money moved is not shown bare either", async () => {
    bootRead(man([{ kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", statusFrom: "status" } }]),
      (u) => (new URL(u).pathname === "/api/jobs" ? [{ id: "j1", status: "settled" }, { id: "j2", status: "running" }] : null));
    await flush();
    expect(bare(pills(), "settled")).toEqual([]);
    expect(pills()).toContain("running"); // an ordinary status word is unchanged
  });

  it("F6 positive control: a VERIFIED final state (live read of the exact route) keeps its plain name", async () => {
    bootRead(man([{ kind: "receipt", binding: { path: RC_LIVE } }]), (u) => (new URL(u).pathname === RC_LIVE ? SETTLED_RECEIPT : null));
    await flush();
    const pill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement;
    expect(pill.className).toContain("st-settled");
    expect(pill.textContent).toBe("SETTLED_RELEASED");
  });
});

describe("astra r4 (#313): the pill-text rule, kit == spec", () => {
  const kit = extractRegion();
  it("the same final-money tokens", () => {
    expect(Object.keys(kit.FINAL_MONEY_TOKENS).sort()).toEqual([...FINAL_MONEY_TOKENS].sort());
  });
  it("the same claim test and the same pill text over adversarial inputs, verified or not", () => {
    const inputs: unknown[] = [...ADVERSARIAL, "paid", "Paid in full", "paidOut", "payout_pending", "settlement_complete", "PAID!", "p\u0430id",
      "SETTLED_RELEASED", "SETTLED_REFUNDED", "RELEASE_ALLOCATED", "refund_allocated", "running", "pending", "3", "no settlement state", "funded"];
    for (const x of inputs) {
      expect(kit.claimsFinalMoney(x), JSON.stringify(x)).toBe(claimsFinalMoney(x));
      for (const v of [true, false]) expect(kit.statusPillText(x, v), JSON.stringify(x)).toBe(statusPillText(x, v));
    }
  });
  it("what the rule says", () => {
    expect(statusPillText("paid", false)).toBe("reported status: paid - settlement unconfirmed");
    expect(statusPillText("paid", true)).toBe("paid");
    expect(statusPillText(["released"], false)).toBe("reported status: released - settlement unconfirmed"); // String() of an array
    expect(statusPillText("running", false)).toBe("running");
    expect(statusPillText("RELEASE_ALLOCATED", false)).toBe("RELEASE_ALLOCATED"); // decided, not moved: no claim
    expect(claimsFinalMoney("p\u0430id")).toBe(true); // a look-alike is never a bare status
    expect(claimsFinalMoney("42")).toBe(false);
  });
});

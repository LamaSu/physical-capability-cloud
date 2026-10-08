/**
 * @vitest-environment jsdom
 *
 * Money-status CONFORMANCE against the SHIPPED kit (apps/dashboard/public/ui-kit/v1/pcc-ui.js).
 *
 * Two proofs, both against the real bytes the browser runs (never a parallel copy):
 *  1. The kit's private helpers are evaluated together without its DOM boot. Its money
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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import {
  MONEY_STATUS_MAP, classifyMoneyStatus, classifySettlementRecord, VNEXT_UNIT_STATES, VNEXT_STATE_PRESENTATION, VNEXT_PHASE,
  classifySettlementRead, SETTLEMENT_READ_ROUTE, chainPin, SETTLEMENT_NETWORKS, SAFE_STATUS_WORDS, SAFE_MONEY_STATUS_WORDS, statusPillText, reportedText,
  idText, hexText, timeText, traceText, nameText, fieldDefaultText, ESCROW_SERVICE_REPORTS, NOT_CONFIRMED_ON_CHAIN,
} from "../money/money-status.js";
import { foldForClaims, isMoneyClaim, isProseClaim, WITHHELD_PROSE, WITHHELD_FIELD } from "../money/plain-text-claims.js";
import { PLAIN_TEXT_CASES, PLAIN_TIME_ACCEPTED, PLAIN_TIME_REJECTED, FIELD_DEFAULT_CASES, PLAIN_CLAIM_CASES } from "./plain-text-fixtures.js";
import { assertKitTextBeforeBoot, assertKitTextViolations, flushKitText, checkKitClicks } from "./ui-kit-text-counter.js";

// R12 (operator 10/06): a final tone needs a valid pin for the read's own unit. The canonical settled
// fixtures carry one, so the liveness, exact-route and polling tests below keep testing what they test.
const PIN_FIELDS = Object.freeze({ chainId: 84532, escrow: "0x" + "12".repeat(20), unitId: "0x" + "ab".repeat(32),
  asOfBlock: "12345678", asOfBlockHash: "0x" + "cd".repeat(32), finality: "finalized" });

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
  dataStatusClass: (bindingPath: unknown, row: unknown, s: unknown, live?: unknown) => string;
  dataStatusText: (bindingPath: unknown, row: unknown, s: unknown, live?: unknown) => { readonly t: string };
  chainPin: (o: unknown, bindingPath: unknown) => unknown;
  VNEXT_UNIT_STATES: readonly string[];
  VNEXT_STATE_PRESENTATION: Record<string, [string, string]>;
  VNEXT_PHASE: Record<string, string>;
  settlementRecordClass: (r: unknown) => [string, string | null, string];
  settlementReadClass: (r: unknown, path: unknown, live: unknown) => [string, string | null, string];
  SETTLEMENT_READ_ROUTE: RegExp;
  SAFE_STATUS_WORDS: Record<string, boolean>;
  SAFE_MONEY_STATUS_WORDS: Record<string, boolean>;
  statusPillText: (raw: unknown, verified: boolean, money: boolean) => { readonly t: string };
  reportedText: (raw: unknown, verified: boolean, money: boolean) => { readonly t: string };
  idText: (raw: unknown) => { readonly t: string };
  hexText: (raw: unknown) => { readonly t: string };
  timeText: (raw: unknown) => { readonly t: string };
  traceText: (raw: unknown) => { readonly t: string };
  nameText: (raw: unknown) => { readonly t: string };
  fieldDefaultText: (kind: unknown, raw: unknown) => { readonly t: string };
  foldForClaims: (text: string) => string;
  isMoneyClaim: (text: string) => boolean;
  isProseClaim: (text: string) => boolean;
  WITHHELD_PROSE: { readonly t: string };
  WITHHELD_FIELD: { readonly t: string };
};

function extractRegion(): KitRegion {
  if (!kitSrc.includes("// <status-map v2>") || !kitSrc.includes("// </status-map v2>")) {
    throw new Error("<status-map v2> markers not found in pcc-ui.js");
  }
  const ctx: Record<string, unknown> = { window: {}, document: {} };
  // Evaluate the genuine private mints and helpers together, without mounting a DOM.
  // Only the final boot dispatch is replaced; every helper uses the shipped bytes.
  const helperSrc = kitSrc.replace(/  if \(document\.readyState === 'loading'\)[\s\S]*?\n\}\)\(\);\s*$/, "\n" +
      "window.kitRegion = { MONEY_STATUS, GENERIC_STATES, statusClass, moneyStatusClass, settlementLabel, isMoneyData, dataStatusClass, dataStatusText," +
      " VNEXT_UNIT_STATES, VNEXT_STATE_PRESENTATION, VNEXT_PHASE, settlementRecordClass, settlementReadClass, SETTLEMENT_READ_ROUTE, chainPin, SETTLEMENT_NETWORKS," +
      " SAFE_STATUS_WORDS, SAFE_MONEY_STATUS_WORDS, statusPillText, reportedText, idText, hexText, timeText, traceText, nameText, fieldDefaultText, foldForClaims, isMoneyClaim, isProseClaim, WITHHELD_PROSE, WITHHELD_FIELD };\n})();");
  if (helperSrc === kitSrc) throw new Error("plain kit's final boot dispatch not found");
  vm.runInNewContext(
    helperSrc,
    ctx,
  );
  return (ctx.window as { kitRegion: KitRegion }).kitRegion;
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

describe("plain typed-text helper grammars, kit == canonical spec", () => {
  const kit = extractRegion();
  const spec = { idText, hexText, traceText, nameText };

  for (const name of Object.keys(PLAIN_TEXT_CASES) as Array<keyof typeof PLAIN_TEXT_CASES>) {
    it(name + " agrees on shared accepted and rejected inputs", () => {
      for (const [raw, expected] of PLAIN_TEXT_CASES[name]) {
        expect(spec[name](raw), name + " spec " + String(raw)).toBe(expected);
        const branded = kit[name](raw);
        expect(branded.t, name + " kit " + String(raw)).toBe(expected);
        expect(Object.isFrozen(branded), name + " brand is frozen").toBe(true);
      }
    });
  }

  it("timeText admits only calendar-valid canonical UTC in the kit's supported era", () => {
    for (const raw of PLAIN_TIME_ACCEPTED) {
      const expected = new Date(raw).toLocaleString();
      expect(timeText(raw), raw).toBe(expected);
      expect(kit.timeText(raw).t, raw).toBe(expected);
    }
    for (const raw of PLAIN_TIME_REJECTED) {
      expect(timeText(raw), String(raw)).toBe("time not reported");
      expect(kit.timeText(raw).t, String(raw)).toBe("time not reported");
    }
  });

  it("fieldDefaultText validates the field kind and withholds claim-bearing strings", () => {
    for (const [kind, raw, expected] of FIELD_DEFAULT_CASES) {
      expect(fieldDefaultText(kind, raw), String(kind) + " spec " + String(raw)).toBe(expected);
      expect(kit.fieldDefaultText(kind, raw).t, String(kind) + " kit " + String(raw)).toBe(expected);
    }
  });

  it("the existing claim detector agrees, including reserved notices and folded spellings", () => {
    for (const [raw, expected] of PLAIN_CLAIM_CASES) {
      expect(isProseClaim(raw), raw).toBe(expected);
      expect(kit.isProseClaim(raw), raw).toBe(expected);
    }
    const inputs = new Set([
      ...PLAIN_CLAIM_CASES.map(([raw]) => raw),
      ...Object.values(PLAIN_TEXT_CASES).flatMap((cases) => cases.map(([raw]) => raw)),
      ...FIELD_DEFAULT_CASES.map(([, raw]) => raw), ...PLAIN_TIME_ACCEPTED, ...PLAIN_TIME_REJECTED,
    ].filter((raw): raw is string => typeof raw === "string"));
    for (const raw of inputs) {
      expect(kit.foldForClaims(raw), raw).toBe(foldForClaims(raw));
      expect(kit.isMoneyClaim(raw), raw).toBe(isMoneyClaim(raw));
      expect(kit.isProseClaim(raw), raw).toBe(isProseClaim(raw));
    }
    expect(kit.WITHHELD_PROSE.t).toBe(WITHHELD_PROSE);
    expect(kit.WITHHELD_FIELD.t).toBe(WITHHELD_FIELD);
  });
});

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
    expect(kit.dataStatusClass("/api/jobs", { status: "completed", amount: "5" }, "completed")).toBe("st-unknown"); // R12 r2 D: a flat word on money data is a report, no money tone
    expect(kit.dataStatusClass("/api/jobs", { status: "success", escrowAddress: "0xabc" }, "success")).toBe("st-unknown");
    // lookalike or odd binding paths are money (fail closed)
    for (const b of ["/API/jobs", "/api/jobsX", "/api/jobs%2F..%2Fescrow", null, undefined, 42]) {
      expect(kit.isMoneyData(b, {}), String(b)).toBe(true);
    }
    // a refund word is never green even on a generic surface, and (R12 r2 D) takes no money tone there either
    expect(kit.statusClass("refunded")).toBe("st-unknown");
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
  assertKitTextBeforeBoot();
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
  assertKitTextViolations();
}
const flush = flushKitText;
let clickCheck: ReturnType<typeof checkKitClicks>;
beforeEach(() => { clickCheck = checkKitClicks(); });
afterEach(async () => {
  // Pure helper cases run in an isolated VM; DOM boots and driven interactions use flush.
  try {
    if ((window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__) await flush();
  } finally { clickCheck.mockRestore(); }
});

async function renderedPill(escrow: Record<string, unknown>) {
  boot({ id: "esc-test-1", totalAmount: "10.00", currency: "USDC", payer: "p", payee: "o", ...escrow });
  await flush();
  const pill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement | null;
  if (!pill) throw new Error("receipt pill not rendered");
  return { cls: pill.className, text: pill.textContent, rail: document.querySelector(".pcc-receipt-rail")!.textContent! };
}

describe("shipped kit renders money state honestly (full jsdom boot, receipt window)", () => {
  const NOT_SETTLED: Array<[Record<string, unknown>, string]> = [
    // R12 r2 D: a legacy word, in ANY state, is the escrow service's report: attributed, and no money tone.
    [{ status: "refunded" }, "st-unknown"],
    [{ status: "SETTLED_REFUNDED" }, "st-unknown"],
    [{ status: "REFUND_ALLOCATED" }, "st-unknown"],
    [{ status: "RELEASE_ALLOCATED" }, "st-unknown"],
    [{ status: "underfunded" }, "st-unknown"],
    [{ status: "success" }, "st-unknown"], // off-schema success word on a money surface
    [{ status: "done" }, "st-unknown"],
    [{ status: "settled" }, "st-unknown"], // ambiguous: can mean refunded
    [{ releasedCount: 3 }, "st-unknown"], // rule 12: never infer settlement from a count
    [{ status: "funded" }, "st-unknown"],
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
    expect(r.rail).toContain("state not shown - not a live read of a settlement route");
    // the LIVE, exact-route case (green, with its direction label) is pinned in the "astra r2" block below
  });

  it("a bare status word, even SETTLED_RELEASED, is not a settlement read (never green)", async () => {
    const r = await renderedPill({ status: "SETTLED_RELEASED" });
    expect(r.cls).not.toContain("st-settled");
  });

  it("the pill text is the raw server value when the surface's safe vocabulary covers it", async () => {
    // EXPIRED is on SAFE_MONEY_STATUS_WORDS (astra r5): a word the safe list affirms is shown as-is.
    const r = await renderedPill({ status: "EXPIRED" });
    // R12 rule 4: a legacy escrow record's status is attributed to the service that reported it.
    expect(r.text).toBe("PCC escrow service reports: EXPIRED");
  });

  it("astra r5 (#313): a decided-but-not-final money word is qualified on the receipt pill, not rewritten to look final either", async () => {
    // REFUND_ALLOCATED is not on SAFE_MONEY_STATUS_WORDS: the receipt pill calls statusPillText on the
    // raw value directly (it does not consult the honest-label table that dataStatusText does), so a
    // closed safe vocabulary qualifies it. The honest label is still shown alongside, unaffected.
    const r = await renderedPill({ status: "REFUND_ALLOCATED" });
    expect(r.text).toBe("PCC escrow service reports: REFUND_ALLOCATED"); // R12 rule 4: attributed, never bare
    expect(r.rail).toContain("refund decided - payer not yet refunded");
  });
});

describe("reviewer-bravo F3/F4: 'completed' and generic success words never green money data (full boot)", () => {
  it("a receipt bound to a completed JOB is not a green payment", async () => {
    const r = await renderedPill({ status: "completed" });
    expect(r.cls).toContain("st-unknown"); // R12 r2 D: the escrow service's report, no money tone
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
    expect(pills[1]).toContain("st-unknown"); // a paid job row is money data: its flat word is a report, no money tone (R12 r2 D)
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

  it("R12: a V-next receipt in a SNAPSHOT never shows its amount (a money fact needs a live, pinned read)", async () => {
    const r = await receiptOf(RC, settledReceipt(ECON));
    expect(r.cls).toContain("st-unknown"); // a snapshot is never shown as final
    expect(r.body).toContain("amount pending - not confirmed at a finalized block");
    expect(r.body).not.toContain("1000000");
    expect(r.body).not.toContain("1,000,000");
    expect(r.body).not.toContain("USDC");
    expect(r.body).toContain("payee pending");
    expect(document.querySelector(".pcc-pin-ref")).toBeNull();
  });

  // (The base-unit formatting checks moved to the live, pinned R12 block below: in a snapshot the amount is pending.)

  it("an amount without a currency shows no invented currency (a V-next amount comes only from economics; a legacy amount is attributed)", async () => {
    const v = await receiptOf(RC, { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", totalAmount: "10.00", payer: "0xP", payee: "0xQ" });
    expect(v.body).toContain("amount not reported"); // R12: a V-next amount is economics.amount only
    expect(v.body).not.toContain("USDC");
    const l = await receiptOf("/api/escrow/e1", { status: "funded", contractAddress: "0x1", totalAmount: "10.00" });
    expect(l.body).toContain("reported amount: 10.00");
    expect(l.body).toContain("(currency not reported) (PCC escrow service)");
    expect(l.body).not.toContain("USDC");
  });

  it("a /lifecycle read with a numeric unitState renders by its ordinal; a disagreement is unknown", async () => {
    const LC = "/api/settlement/units/u1/lifecycle";
    const ok = await receiptOf(LC, lifecycle(8));
    expect(ok.cls).toContain("st-unknown"); // named by its ordinal, but a snapshot is never shown as final
    expect(ok.text).toBe("state not shown - not a live read of a settlement route"); // nor named as one (astra r4 F6)
    const six = await receiptOf(LC, lifecycle(6));
    expect(six.cls).toContain("st-unknown"); // R12 r2 D: a non-final state needs the live pinned read too
    expect(six.body).not.toContain("payout outstanding");
    expect(six.body).not.toContain("RELEASE_ALLOCATED");
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
    expect(w.cls).toContain("st-unknown"); // R12 r2 D: nor is a non-final one
    expect(w.text).toBe("state not shown - not a live read of a settlement route");
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
  const SETTLED_RECEIPT = { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", ...PIN_FIELDS };
  const LC8 = { unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled", ...PIN_FIELDS };
  const man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
  type Reply = { status: number; body?: unknown } | "reject";
  function bootLive(manifest: string, reply: (url: string, n: number) => Reply) {
    assertKitTextBeforeBoot();
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
    assertKitTextViolations();
  }
  const receiptPill = () => (document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement).className;
  const receiptWin = (path: string) => man([{ kind: "receipt", binding: { path } }]);

  // ── R12 (operator 10/06): money facts only from a live, pinned, finalized read of the unit's own route ──
  const PAYEE = "0x" + "34".repeat(20);
  const pinnedReceipt = (extra: Record<string, unknown> = {}) => ({ ...SETTLED_RECEIPT, economics: { amount: "1000000", feeAmount: "23500", recipient: PAYEE, token: "0x" + "56".repeat(20), assuranceTier: 1 }, ...extra });
  async function liveReceipt(body: unknown) {
    bootLive(receiptWin(RC_LIVE), () => ({ status: 200, body }));
    await flush();
    const rail = document.querySelector(".pcc-receipt-rail")!;
    return { cls: receiptPill(), body: rail.parentElement!.textContent!, ref: document.querySelector(".pcc-pin-ref")?.textContent ?? null };
  }

  it("R12: a live, pinned, finalized receipt shows its money facts and the visible reference", async () => {
    const r = await liveReceipt(pinnedReceipt({ assetReality: { value: "real", source: "registry" } }));
    expect(r.cls).toContain("st-settled");
    expect(r.body).toContain("1000000 base units (decimals not reported)"); // base units, never a sum, never an invented currency
    expect(r.body).not.toContain("1,000,000");
    expect(r.body).toContain(PAYEE);
    expect(r.ref).toBe("Base Sepolia · escrow 0x1212…1212 · unit 0xabab…abab · block 12,345,678 (0xcdcd…cdcd) · finalized");
    const details = document.querySelector(".pcc-pin-details")!;
    expect(details.querySelectorAll(".pcc-pin-row")).toHaveLength(6);
    expect(details.textContent).toContain("0x" + "cd".repeat(32));
    expect(document.querySelector(".pcc-asset-badge")).toBeNull(); // a registry-confirmed real asset is unmarked
  });

  it("R12: with the record's own tokenDecimals the base units become the exact display amount (pinned)", async () => {
    for (const [amount, d, shown] of [["1000000", 6, "1"], ["1234567", 6, "1.234567"], ["25", 6, "0.000025"], ["1500000000000", 6, "1,500,000"], ["7", 0, "7"]] as Array<[string, number, string]>) {
      const r = await liveReceipt(pinnedReceipt({ economics: { amount, tokenDecimals: d, recipient: PAYEE } }));
      expect(r.body, amount + "/" + d).toContain(shown);
    }
  });

  it("R12: a malformed base-unit amount is 'amount not reported', never a guess (pinned)", async () => {
    for (const amount of ["1e6", "-5", "1,000", "0x10", "", { v: 1 }]) {
      const r = await liveReceipt(pinnedReceipt({ economics: { amount, recipient: PAYEE } }));
      expect(r.body, JSON.stringify(amount)).toContain("amount not reported");
    }
  });

  it("R12: a test or unverified asset is marked, so a test-USDC settlement never looks real", async () => {
    for (const [ar, badge] of [[{ value: "test" }, "TEST ASSET"], [{ value: "unknown" }, "ASSET NOT VERIFIED"], [null, "ASSET NOT VERIFIED"], [undefined, "ASSET NOT VERIFIED"]] as Array<[unknown, string]>) {
      await liveReceipt(pinnedReceipt({ assetReality: ar }));
      expect(document.querySelector(".pcc-asset-badge")?.textContent, JSON.stringify(ar)).toBe(badge);
    }
  });

  it("R12: log-derived fields say so, and UNKNOWN is 'not reported' (contract rule 21)", async () => {
    const r = await liveReceipt(pinnedReceipt({ refundReason: { value: "TIMEOUT", source: "log" }, finalizedBlock: "12345679" }));
    expect(r.body).toContain("refund reason: TIMEOUT (from event logs)");
    expect(r.body).toContain("finalized at block 12,345,679 (from event logs)");
    const u = await liveReceipt(pinnedReceipt({ refundReason: "UNKNOWN", finalizedBlock: { value: "UNKNOWN", source: "log" } }));
    expect(u.body).toContain("refund reason: not reported (from event logs)");
    expect(u.body).toContain("finalized at block not reported (from event logs)");
  });

  // R12's reproduction: on the pre-R12 kit every one of these LIVE settled-shaped reads rendered green.
  const BAD_PINS: Array<[string, Record<string, unknown>]> = [
    ["no pin at all", { chainId: undefined, escrow: undefined, unitId: undefined, asOfBlock: undefined, asOfBlockHash: undefined, finality: undefined }],
    ["unknown chain", { chainId: 1 }], ["chainId as a string", { chainId: "84532" }], ["network disagrees", { network: { chainId: 8453 } }],
    ["network not an object", { network: "base-sepolia" }], ["escrow malformed", { escrow: "0xE" }],
    ["another unit", { unitId: "0x" + "ef".repeat(32) }], ["unitId malformed", { unitId: "u1" }],
    ["asOfBlock a number", { asOfBlock: 12345678 }], ["asOfBlock with a leading zero", { asOfBlock: "012" }], ["asOfBlock negative", { asOfBlock: "-1" }],
    ["asOfBlock past a safe integer", { asOfBlock: "9007199254740993" }], ["block hash malformed", { asOfBlockHash: "0x12" }],
    ["finality safe", { finality: "safe" }], ["finality latest", { finality: "latest" }], ["finality missing", { finality: undefined }],
  ];
  it.each(BAD_PINS)("R12: a live settled read with %s is pending, never green", async (_name, bad) => {
    const body: Record<string, unknown> = { ...pinnedReceipt(), ...bad };
    for (const k of Object.keys(bad)) if (bad[k] === undefined) delete body[k];
    const r = await liveReceipt(body);
    expect(r.cls).toContain("st-waiting");
    expect(r.cls).not.toContain("st-settled");
    expect(r.body).toContain("pending - not confirmed at a finalized block");
    expect(r.body).toContain("amount pending - not confirmed at a finalized block");
    expect(r.body).toContain("payee pending");
    expect(r.ref).toBeNull();
  });

  it("R12 (DOM property): no window shows a final tone without a pinned live read; the same windows go green once pinned", async () => {
    const UNPINNED_LC8 = { unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled" };
    const UNPINNED_RC = { finalState: "SETTLED_REFUNDED", isAllocated: false, phase: "settled" };
    const runWin = man([{ kind: "run", binding: { path: LC_LIVE }, statusFrom: "finalState", latestFrom: "phase" }]);
    const finals = () => document.querySelectorAll(".st-settled, .st-refunded").length;
    for (const [manifest, body] of [[runWin, UNPINNED_LC8], [receiptWin(RC_LIVE), UNPINNED_RC], [receiptWin("/api/escrow/e1"), { status: "REFUNDED", contractAddress: "0x1" }]] as Array<[string, unknown]>) {
      bootLive(manifest, () => ({ status: 200, body }));
      await flush();
      expect(finals(), manifest + " " + JSON.stringify(body)).toBe(0);
    }
    for (const [manifest, body] of [[runWin, { ...UNPINNED_LC8, ...PIN_FIELDS }], [receiptWin(RC_LIVE), { ...UNPINNED_RC, ...PIN_FIELDS }]] as Array<[string, unknown]>) {
      bootLive(manifest, () => ({ status: 200, body }));
      await flush();
      expect(finals(), "pinned " + manifest).toBe(1);
    }
  });

  it("R12: the route's unit matches the body's unit regardless of hex case", async () => {
    const r = await liveReceipt(pinnedReceipt({ unitId: ("0x" + "ab".repeat(32)).toUpperCase().replace("0X", "0x") }));
    expect(r.cls).toContain("st-settled");
  });

  it("R12: kit chainPin == spec chainPin over valid and broken pins (parity)", () => {
    const kit = extractRegion() as unknown as { chainPin: (o: unknown, p: unknown) => unknown; SETTLEMENT_NETWORKS: unknown };
    expect(JSON.stringify(kit.SETTLEMENT_NETWORKS)).toBe(JSON.stringify(SETTLEMENT_NETWORKS));
    const bodies: unknown[] = [pinnedReceipt(), ...BAD_PINS.map(([, bad]) => ({ ...pinnedReceipt(), ...bad })), null, [], "x", { ...pinnedReceipt(), network: null }];
    const paths: unknown[] = [RC_LIVE, LC_LIVE, RC_LIVE + "?asOf=x", "/api/settlement/units/" + "0x" + "ef".repeat(32) + "/receipt", "/api/jobs/j1", undefined];
    for (const b of bodies) for (const p of paths) {
      expect(JSON.stringify(kit.chainPin(b, p)), JSON.stringify(b) + " @ " + String(p)).toBe(JSON.stringify(chainPin(b, p)));
    }
  });

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
    assertKitTextBeforeBoot();
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
    assertKitTextViolations();
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
  const SETTLED_RECEIPT = { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", ...PIN_FIELDS };
  const man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
  // Answers only the requests a test expects (null = not this test's), and only its FIRST read of each:
  // a later poll never settles, so no window keeps polling after the test.
  function bootRead(manifest: string, reply: (url: string) => unknown) {
    assertKitTextBeforeBoot();
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
    assertKitTextViolations();
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

  it("F6 (HIGH): a run window rendered from a snapshot never shows a bare final money word either", async () => {
    for (const w of WORDS) {
      boot({}, man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "message" }]),
        { _ts: "2026-09-24T00:00:00Z", "/api/escrow/e1": { status: w, message: "m" } });
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

  it("F6: a run window names a gated-out final by the classifier's label, a verified one by its plain name", async () => {
    const LC_LIVE = `/api/settlement/units/${UNIT}/lifecycle`;
    const LC8 = { unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled", ...PIN_FIELDS };
    const run = (p: string) => man([{ kind: "run", binding: { path: p }, statusFrom: "status", latestFrom: "message" }]);
    boot({}, run(LC_LIVE), { _ts: "2026-09-24T00:00:00Z", [LC_LIVE]: LC8 }); // a baked snapshot: gated out
    await flush();
    const gated = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    expect(gated.className).toContain("st-unknown");
    expect(gated.textContent).toBe("state not shown - not a live read of a settlement route");
    bootRead(run(LC_LIVE), (u) => (new URL(u).pathname === LC_LIVE ? LC8 : null)); // a LIVE read of the exact route
    await flush();
    const verified = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    expect(verified.className).toContain("st-settled");
    expect(verified.textContent).toBe("SETTLED_RELEASED");
  });

  it("F6: money data shows the classifier's honest label, not the bare word", async () => {
    bootRead(man([{ kind: "list", binding: { path: "/api/escrow" }, item: { title: "id", statusFrom: "status" } }]),
      (u) => (new URL(u).pathname === "/api/escrow" ? [{ id: "e1", status: "funded" }, { id: "e2", status: "released" }] : null));
    await flush();
    // R12 r2 D: the honest label is still a report of the bound record, attributed, in ANY state
    expect(pills()).toEqual(["bound record reports: funds held - not released (not confirmed on chain)", "bound record reports: released - not confirmed by a settlement read (not confirmed on chain)"]);
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
  it("the same safe-status vocabularies", () => {
    expect(Object.keys(kit.SAFE_STATUS_WORDS).sort()).toEqual([...SAFE_STATUS_WORDS].sort());
    expect(Object.keys(kit.SAFE_MONEY_STATUS_WORDS).sort()).toEqual([...SAFE_MONEY_STATUS_WORDS].sort());
  });
  it("astra r5: SAFE_STATUS_WORDS (non-money) contains no payment-final or money-movement word", () => {
    const forbidden = ["PAID", "PAIDOUT", "PAYOUT", "SETTLED", "SETTLEMENT", "RELEASED", "REFUNDED", "DISBURSED", "CREDITED", "TRANSFERRED", "RECEIVED", "FUNDED"];
    for (const w of SAFE_STATUS_WORDS) for (const bad of forbidden) expect(w.includes(bad), w + " vs " + bad).toBe(false);
    for (const w of Object.keys(kit.SAFE_STATUS_WORDS)) for (const bad of forbidden) expect(w.includes(bad), w + " vs " + bad).toBe(false);
  });
  it("astra r5: SAFE_MONEY_STATUS_WORDS contains no success-ish word", () => {
    const successIsh = ["DONE", "OK", "APPROVED", "COMPLETE", "COMPLETED", "SUCCESS", "SUCCEEDED", "RESOLVED", "READY"];
    for (const w of SAFE_MONEY_STATUS_WORDS) expect(successIsh.includes(w), w).toBe(false);
    for (const w of Object.keys(kit.SAFE_MONEY_STATUS_WORDS)) expect(successIsh.includes(w), w).toBe(false);
  });
  it("the same pill text over adversarial inputs, every combination of verified x money", () => {
    const inputs: unknown[] = [...ADVERSARIAL, "paid", "Paid in full", "paidOut", "payout_pending", "settlement_complete", "PAID!", "p\u0430id",
      "SETTLED_RELEASED", "SETTLED_REFUNDED", "RELEASE_ALLOCATED", "refund_allocated", "running", "pending", "3", "no settlement state", "funded",
      "PAYEE_RECEIVED_FUNDS", "FUNDS_TRANSFERRED_TO_PAYEE", "payee received funds", "running!", "online", "executing", "approved", "done",
      "completed", "settled", "PAID", "SETTLED_RELEASED", "RELEASE_ALLOCATED"];
    for (const x of inputs) {
      for (const v of [true, false]) for (const money of [true, false]) {
        expect(kit.statusPillText(x, v, money).t, JSON.stringify(x) + " v=" + v + " money=" + money).toBe(statusPillText(x, v, money));
      }
    }
  });
  it("what the rule says", () => {
    expect(statusPillText("paid", false, true)).toBe("reported status: paid - settlement unconfirmed");
    expect(statusPillText("paid", true, true)).toBe("paid");
    expect(statusPillText(["released"], false, true)).toBe("reported status: released - settlement unconfirmed"); // String() of an array
    expect(statusPillText("running", false, true)).toBe("running"); // RUNNING is on SAFE_MONEY_STATUS_WORDS
    expect(statusPillText("running", false, false)).toBe("running"); // and on SAFE_STATUS_WORDS too
    // RELEASE_ALLOCATED is decided, not moved -- but it is not on the closed money-safe list either (that
    // list is in-progress/failure words only), so direct-called statusPillText fails closed on it too; the
    // honest "release decided - payout outstanding" label is what names it, via dataStatusText, not this.
    expect(statusPillText("RELEASE_ALLOCATED", false, true)).toBe("reported status: RELEASE_ALLOCATED - settlement unconfirmed");
    expect(statusPillText("p\u0430id", false, true)).not.toBe("p\u0430id"); // a look-alike is never a bare status
    expect(statusPillText("42", false, true)).not.toBe("42"); // not on any safe list: fails closed
    // astra r5 F7: explicit payee-received-funds claims are qualified even though no token enumerates them.
    expect(statusPillText("PAYEE_RECEIVED_FUNDS", false, true)).toBe("reported status: PAYEE_RECEIVED_FUNDS - settlement unconfirmed");
    expect(statusPillText("FUNDS_TRANSFERRED_TO_PAYEE", false, true)).toBe("reported status: FUNDS_TRANSFERRED_TO_PAYEE - settlement unconfirmed");
    // astra r5 F9: the same decorated text on a non-money surface reads an outcome-neutral qualifier.
    expect(statusPillText("running!", false, false)).toBe("reported status: running! - status unverified");
    expect(statusPillText("running!", false, true)).toBe("reported status: running! - settlement unconfirmed");
  });
  it("astra r6 F12: the same free-text message rule over adversarial inputs, every combination of verified x money", () => {
    const inputs: unknown[] = [...ADVERSARIAL, "Payout released to payee", "PAID", "Printing layer 3", "", "p\u0430id", 42, ["paid"]];
    for (const x of inputs) {
      for (const v of [true, false]) for (const money of [true, false]) {
        expect(kit.reportedText(x, v, money).t, JSON.stringify(x) + " v=" + v + " money=" + money).toBe(reportedText(x, v, money));
      }
    }
  });
  it("what the message rule says", () => {
    expect(reportedText("Payout released to payee", false, true)).toBe("reported: Payout released to payee - settlement unconfirmed");
    expect(reportedText("Payout released to payee", false, false)).toBe("reported: Payout released to payee");
    expect(reportedText("pending", false, true)).toBe("reported: pending - settlement unconfirmed"); // no vocabulary for messages
    expect(reportedText("Payout released to payee", true, true)).toBe("Payout released to payee"); // a verified payee payment
    expect(reportedText("", false, true)).toBe("");
  });
});

// -- astra round 5 on #313 @d82cde8b (verify before fix): F7, F8, F9 -----------------------------
// These call shapes are today's API (claimsFinalMoney / 2-arg statusPillText). Step 2 replaces the
// blacklist with a closed safe vocabulary and changes statusPillText to a 3-arg (raw, verified, money)
// call; the direct-function assertions below are adapted in place once that lands (same meaning: the
// value is never shown bare), and the render assertions (which don't depend on the signature) stay as-is.
describe("astra r5 (#313 @d82cde8b): F7-F9 (verify before fix)", () => {
  const man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
  // Answers only the requests a test expects (null = not this test's), and only its FIRST read of each:
  // a later poll never settles, so no window keeps polling after the test (same contract as astra r4's bootRead).
  function bootRead(manifest: string, reply: (url: string) => unknown) {
    assertKitTextBeforeBoot();
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
    assertKitTextViolations();
  }
  // A single SSE frame carrying `payload`, delivered through a real ReadableStream (Node 22's global
  // Streams API survives the jsdom test environment): proves the kit's SSE feed-line path, not just
  // its poll path. Closes the stream after one frame so the pump settles instead of hanging.
  function bootSSE(manifest: string, ssePath: string, payload: unknown) {
    assertKitTextBeforeBoot();
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
    const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
    const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest"; mNode.textContent = manifest;
    document.body.appendChild(mNode); // LIVE mode, no snapshot
    const frame = "data: " + JSON.stringify(payload) + "\n\n";
    (window as unknown as { fetch: unknown }).fetch = (url: unknown) => {
      const u = new URL(String(url));
      if (u.pathname !== ssePath) return new Promise(() => {}); // not this test's
      const enc = new TextEncoder();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(enc.encode(frame)); } else controller.close();
        },
      });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body });
    };
    // eslint-disable-next-line no-eval
    (0, eval)(kitSrc);
    assertKitTextViolations();
  }
  const pills = () => Array.from(document.querySelectorAll(".pcc-pill")).map((p) => (p.textContent || "").trim());

  it("F7 (HIGH): explicit payee-received-funds claims are never shown bare on a money surface (fixed: closed safe vocabulary, no blacklist)", () => {
    // Same meaning as the pre-fix reproduction (claimsFinalMoney("PAYEE_RECEIVED_FUNDS") === true and
    // statusPillText(..., false) qualified it): neither word is on SAFE_MONEY_STATUS_WORDS, so the new
    // 3-arg statusPillText(raw, verified, money) qualifies both the same way, without enumerating them.
    expect(statusPillText("PAYEE_RECEIVED_FUNDS", false, true)).toBe("reported status: PAYEE_RECEIVED_FUNDS - settlement unconfirmed");
    expect(statusPillText("PAYEE_RECEIVED_FUNDS", false, true)).not.toBe("PAYEE_RECEIVED_FUNDS");
    expect(statusPillText("FUNDS_TRANSFERRED_TO_PAYEE", false, true)).toBe("reported status: FUNDS_TRANSFERRED_TO_PAYEE - settlement unconfirmed");
    expect(statusPillText("FUNDS_TRANSFERRED_TO_PAYEE", false, true)).not.toBe("FUNDS_TRANSFERRED_TO_PAYEE");
  });

  it("F7 (HIGH) render: a live list on a money read never shows PAYEE_RECEIVED_FUNDS bare", async () => {
    bootRead(man([{ kind: "list", binding: { path: "/api/escrow" }, item: { title: "id", statusFrom: "status" } }]),
      (u) => (new URL(u).pathname === "/api/escrow" ? [{ id: "e1", status: "PAYEE_RECEIVED_FUNDS" }] : null));
    await flush();
    expect(document.querySelector(".pcc-list-row")).not.toBeNull();
    expect(pills()).not.toContain("PAYEE_RECEIVED_FUNDS");
  });

  it("F8 (a) HIGH: a run window's live-poll latest line never shows a bare final money word", async () => {
    bootRead(man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "status" }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1" ? { status: "paid" } : null));
    await flush();
    const latest = document.querySelector(".pcc-run-latest") as HTMLElement;
    expect(latest.textContent).not.toBe("paid");
  });

  it("F8 (b) HIGH: the same run window via a snapshot also must not show a bare final money word in the latest line", async () => {
    const manifest = man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "status" }]);
    boot({}, manifest, { _ts: "2026-09-24T00:00:00Z", "/api/escrow/e1": { status: "paid" } });
    await flush();
    const latest = document.querySelector(".pcc-run-latest") as HTMLElement;
    expect(latest.textContent).not.toBe("paid");
  });

  it("F8 (c) HIGH: a receipt timeline entry sourced from an event's status never shows a bare final money word", async () => {
    bootRead(man([{ kind: "receipt", binding: { path: "/api/escrow/e1" } }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1"
        ? { status: "funded", contractAddress: "0x" + "11".repeat(20), totalAmount: "5", events: [{ status: "paid" }] }
        : null));
    await flush();
    const rows = Array.from(document.querySelectorAll(".pcc-timeline-type")).map((e) => (e.textContent || "").trim());
    expect(rows).not.toContain("paid");
  });

  it("F8 (d) HIGH: an SSE run-window feed line sourced from ev.status never shows a bare final money word", async () => {
    const ssePath = "/sse/stream/escrow/e1";
    bootSSE(man([{ kind: "run", binding: { path: "/api/escrow/e1", sse: ssePath }, statusFrom: "status", latestFrom: "status" }]), ssePath, { status: "paid" });
    await flush();
    await flush();
    const lines = Array.from(document.querySelectorAll(".pcc-feed-line")).map((e) => (e.textContent || "").trim());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).not.toContain("paid");
  });

  it("F9 (MEDIUM): a non-money surface's decorated status reads an outcome-neutral qualifier, not a settlement one", async () => {
    bootRead(man([{ kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", statusFrom: "status" } }]),
      (u) => (new URL(u).pathname === "/api/jobs" ? [{ id: "j1", status: "running!" }] : null));
    await flush();
    const text = (document.querySelector(".pcc-pill") as HTMLElement).textContent;
    expect(text).toBe("reported status: running! - status unverified");
  });

  // genui's review of the F8 fix (@c2dd8346), verify before fix: F8 asked for one fail-closed rule over
  // every status-derived line, and three spellings of the same line still bypassed it on a money surface.
  const UNIT = "0x" + "ab".repeat(32);
  const RC_LIVE = `/api/settlement/units/${UNIT}/receipt`;
  const LC_LIVE = `/api/settlement/units/${UNIT}/lifecycle`;
  const LEGACY = { contractAddress: "0x" + "11".repeat(20), totalAmount: "5" };
  const feedLines = () => Array.from(document.querySelectorAll(".pcc-feed-line")).map((e) => (e.textContent || "").trim());
  const timelineRows = () => Array.from(document.querySelectorAll(".pcc-timeline-type")).map((e) => (e.textContent || "").trim());

  it("F8 residual (HIGH): a money run window's free-text latest line is qualified, never bare", async () => {
    bootRead(man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "message" }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1" ? { status: "funded", message: "Payout released to payee" } : null));
    await flush();
    const latest = document.querySelector(".pcc-run-latest") as HTMLElement;
    // astra r6 F12: a free-text message is attributed to its source (reportedText), not called a status.
    expect(latest.textContent).toBe("reported: Payout released to payee - settlement unconfirmed");
  });

  it("F8 residual (HIGH): an SSE feed line from ev.type is qualified on a money surface, never bare", async () => {
    const ssePath = "/sse/stream/escrow/e1";
    bootSSE(man([{ kind: "run", binding: { path: "/api/escrow/e1", sse: ssePath }, statusFrom: "status", latestFrom: "message" }]), ssePath, { type: "PAID" });
    await flush();
    await flush();
    expect(feedLines()).toEqual(["reported status: PAID - settlement unconfirmed"]);
  });

  it("F8 residual (HIGH): an SSE event with neither type nor status shows no bare JSON claim on a money surface", async () => {
    const ssePath = "/sse/stream/escrow/e1";
    bootSSE(man([{ kind: "run", binding: { path: "/api/escrow/e1", sse: ssePath }, statusFrom: "status", latestFrom: "message" }]), ssePath, { state: "paid" });
    await flush();
    await flush();
    expect(feedLines()).toEqual(['reported status: {"state":"paid"} - settlement unconfirmed']);
  });

  it("F8 residual (HIGH): a receipt timeline entry from ev.type or ev.name is qualified, never bare", async () => {
    bootRead(man([{ kind: "receipt", binding: { path: "/api/escrow/e1" } }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1"
        ? { status: "funded", ...LEGACY, events: [{ type: "PAYOUT_SENT" }, { name: "released" }, { type: "pending" }, {}] }
        : null));
    await flush();
    expect(timelineRows()).toEqual([
      "reported status: PAYOUT_SENT - settlement unconfirmed",
      "reported status: released - settlement unconfirmed",
      "pending", // a money-safe word stays plain
      "event", // PCC's own placeholder, not a server claim
    ]);
  });

  it("F8 residual positive control: a VERIFIED final keeps its plain latest line and timeline (no contradiction with the green pill)", async () => {
    bootRead(man([{ kind: "run", binding: { path: LC_LIVE }, statusFrom: "finalState", latestFrom: "phase" }]),
      (u) => (new URL(u).pathname === LC_LIVE ? { unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled", ...PIN_FIELDS } : null));
    await flush();
    expect((document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement).className).toContain("st-settled");
    expect((document.querySelector(".pcc-run-latest") as HTMLElement).textContent).toBe("settled");

    bootRead(man([{ kind: "receipt", binding: { path: RC_LIVE } }]),
      (u) => (new URL(u).pathname === RC_LIVE
        ? { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", events: [{ type: "SETTLED_RELEASED" }], ...PIN_FIELDS }
        : null));
    await flush();
    expect((document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement).className).toContain("st-settled");
    expect(timelineRows()).toEqual(["SETTLED_RELEASED"]);
  });

  it("F8 residual: a bare REFUNDED word (class st-refunded from the flat table) is not a verified final", async () => {
    // Only a V-next record can be verified; a legacy record's bare word shares the class, never the trust.
    bootRead(man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "status" }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1" ? { status: "REFUNDED" } : null));
    await flush();
    // R12: a bare money word is a report, never a final tone (it was the flat table's st-refunded before).
    expect((document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement).className).toContain("st-unknown"); // R12 r2 D: no money tone
    expect((document.querySelector(".pcc-run-latest") as HTMLElement).textContent).toBe("reported status: REFUNDED - settlement unconfirmed");

    bootRead(man([{ kind: "receipt", binding: { path: "/api/escrow/e1" } }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1" ? { status: "REFUNDED", ...LEGACY, events: [{ type: "REFUNDED" }] } : null));
    await flush();
    // R12: the legacy record's REFUNDED is the escrow service's report, so it takes no final tone.
    expect((document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement).className).toContain("st-unknown"); // R12 r2 D: no money tone
    expect(timelineRows()).toEqual(["reported status: REFUNDED - settlement unconfirmed"]);
  });

  // astra r6 (#313 @3b2e6e38): F10-F12, verify before fix. X1-X3 are the same class, found by a
  // sink inventory (every kit line that renders bound server text), not by astra.
  const LC9 = { unitState: 9, finalState: "SETTLED_REFUNDED", isTerminal: true, isAllocated: false, phase: "settled", ...PIN_FIELDS };
  const latestText = () => (document.querySelector(".pcc-run-latest") as HTMLElement).textContent;

  it("r6 F10 (HIGH): a VERIFIED refund vouches for no payment claim (run latest line)", async () => {
    bootRead(man([{ kind: "run", binding: { path: LC_LIVE }, statusFrom: "finalState", latestFrom: "message" }]),
      (u) => (new URL(u).pathname === LC_LIVE ? { ...LC9, message: "PAID" } : null));
    await flush();
    expect((document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement).className).toContain("st-refunded");
    expect(latestText()).not.toBe("PAID");
  });

  it("r6 F10 (HIGH): a VERIFIED refund vouches for no payment claim (receipt timeline)", async () => {
    bootRead(man([{ kind: "receipt", binding: { path: RC_LIVE } }]),
      (u) => (new URL(u).pathname === RC_LIVE
        ? { finalState: "SETTLED_REFUNDED", isAllocated: false, phase: "settled", events: [{ type: "PAID" }], ...PIN_FIELDS }
        : null));
    await flush();
    expect((document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement).className).toContain("st-refunded");
    expect(timelineRows()).not.toContain("PAID");
  });

  it("r6 F11 (HIGH): a snapshot timeline shows no bare claim, in the feed or the latest line", async () => {
    boot({}, man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "message" }]),
      { _ts: "2026-09-24T00:00:00Z", "/api/escrow/e1": { status: "FUNDED", timeline: [{ type: "PAID" }] } });
    await flush();
    expect(feedLines()).not.toContain("PAID");
    expect(latestText()).not.toBe("PAID");
  });

  it("r6 F11 (HIGH): a live poll's timeline shows no bare claim in the feed", async () => {
    bootRead(man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status", latestFrom: "message" }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1" ? { status: "FUNDED", timeline: [{ type: "PAYOUT_RELEASED" }, { note: "paid" }] } : null));
    await flush();
    expect(feedLines()).not.toContain("PAYOUT_RELEASED");
    expect(feedLines()).not.toContain('{"note":"paid"}');
  });

  it("r6 F11 positive control: a VERIFIED payee payment's live poll timeline stays plain (no contradiction with the green pill)", async () => {
    const LC8T = { unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled", timeline: [{ type: "SETTLED_RELEASED" }], ...PIN_FIELDS };
    bootRead(man([{ kind: "run", binding: { path: LC_LIVE }, statusFrom: "finalState", latestFrom: "phase" }]),
      (u) => (new URL(u).pathname === LC_LIVE ? LC8T : null));
    await flush();
    expect((document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement).className).toContain("st-settled");
    expect(feedLines()).toEqual(["SETTLED_RELEASED"]);
  });

  it("r6 F12 (HIGH): a non-money run's free-text message is source-qualified, not bare", async () => {
    bootRead(man([{ kind: "run", binding: { path: "/api/jobs/j1" }, statusFrom: "status", latestFrom: "message" }]),
      (u) => (new URL(u).pathname === "/api/jobs/j1" ? { status: "running", message: "Payout released to payee" } : null));
    await flush();
    expect(latestText()).not.toBe("Payout released to payee");
  });

  it("r6 F12 (HIGH): a non-money SSE event kind uses the closed vocabulary, not bare", async () => {
    const ssePath = "/sse/stream/jobs/j1";
    bootSSE(man([{ kind: "run", binding: { path: "/api/jobs/j1", sse: ssePath }, statusFrom: "status", latestFrom: "message" }]), ssePath, { type: "PAID" });
    await flush();
    await flush();
    expect(feedLines()).not.toContain("PAID");
  });

  it("r6 X1 (same class): a money list's status-like META field is not shown bare", async () => {
    bootRead(man([{ kind: "list", binding: { path: "/api/escrow" }, item: { title: "id", meta: ["status"] } }]),
      (u) => (new URL(u).pathname === "/api/escrow" ? [{ id: "e1", status: "PAID" }] : null));
    await flush();
    const meta = (document.querySelector(".pcc-list-meta") as HTMLElement).textContent;
    expect(meta).not.toBe("PAID");
  });

  it("r6 X2 (same class): a money list's status-bound TITLE is not shown bare", async () => {
    bootRead(man([{ kind: "list", binding: { path: "/api/escrow" }, item: { title: "state" } }]),
      (u) => (new URL(u).pathname === "/api/escrow" ? [{ id: "e1", state: "RELEASED" }] : null));
    await flush();
    const title = (document.querySelector(".pcc-list-title") as HTMLElement).textContent;
    expect(title).not.toBe("RELEASED");
  });

  it("r6 X3 (same class): a metric selecting a status field is not shown bare", async () => {
    bootRead(man([{ kind: "metric", label: "Escrow", binding: { path: "/api/escrow/e1" }, select: "status" }]),
      (u) => (new URL(u).pathname === "/api/escrow/e1" ? { status: "PAID" } : null));
    await flush();
    const val = (document.querySelector(".pcc-metric-amount") as HTMLElement).textContent;
    expect(val).not.toBe("PAID");
  });

  // astra r6 F12 replaced this control's old expectations (a non-money message and event kind were shown
  // as sent). Now: a message is attributed to its source, and an event kind takes the closed vocabulary.
  it("F8 residual non-money control (astra r6 F12): a job run's message is attributed and its event kinds take the vocabulary", async () => {
    bootRead(man([{ kind: "run", binding: { path: "/api/jobs/j1" }, statusFrom: "status", latestFrom: "message" }]),
      (u) => (new URL(u).pathname === "/api/jobs/j1" ? { status: "running", message: "Printing layer 3" } : null));
    await flush();
    expect((document.querySelector(".pcc-run-latest") as HTMLElement).textContent).toBe("reported: Printing layer 3");

    const ssePath = "/sse/stream/jobs/j1";
    bootSSE(man([{ kind: "run", binding: { path: "/api/jobs/j1", sse: ssePath }, statusFrom: "status", latestFrom: "message" }]), ssePath, { type: "log" });
    await flush();
    await flush();
    expect(feedLines()).toEqual(["reported status: log - status unverified"]);
    bootSSE(man([{ kind: "run", binding: { path: "/api/jobs/j1", sse: ssePath }, statusFrom: "status", latestFrom: "message" }]), ssePath, { type: "running" });
    await flush();
    await flush();
    expect(feedLines()).toEqual(["running"]); // a safe word stays plain
  });
});

// -- astra round 7 on #313 @9f3f75af (verify before fix): F13 provenance laundering, F10 over time --------
describe("astra r7 (#313 @9f3f75af): F13 provenance and F10 over time (verify before fix)", () => {
  const UNIT = "0x" + "ab".repeat(32);
  const RC_LIVE = `/api/settlement/units/${UNIT}/receipt`;
  const LC_LIVE = `/api/settlement/units/${UNIT}/lifecycle`;
  const SETTLED = { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", ...PIN_FIELDS };
  const LC8 = { unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled", ...PIN_FIELDS };
  const LC1 = { unitState: 1, finalState: null, isTerminal: false, isAllocated: false, phase: "active" };
  const man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
  type Reply = { status: number; body?: unknown } | "reject";
  // Replies by call index; after the script every request stays pending, so no window keeps polling.
  function bootScript(manifest: string, script: Reply[]) {
    assertKitTextBeforeBoot();
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
    const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
    const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest"; mNode.textContent = manifest;
    document.body.appendChild(mNode); // LIVE mode
    let n = 0;
    (window as unknown as { fetch: unknown }).fetch = () => {
      const r = script[n++];
      if (r === undefined) return new Promise(() => {});
      if (r === "reject") return Promise.reject(new Error("network down"));
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: () => Promise.resolve(r.body ?? {}), text: () => Promise.resolve(JSON.stringify(r.body ?? {})) });
    };
    // eslint-disable-next-line no-eval
    (0, eval)(kitSrc);
    assertKitTextViolations();
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pillClass = (sel: string) => (document.querySelector(sel) as HTMLElement).className;
  const latestText = () => (document.querySelector(".pcc-run-latest") as HTMLElement).textContent;
  const feedLines = () => Array.from(document.querySelectorAll(".pcc-feed-line")).map((e) => (e.textContent || "").trim());

  it("F13 (HIGH): a receipt's binding.select cannot launder a nested object into a verified settlement", async () => {
    bootScript(man([{ kind: "receipt", binding: { path: RC_LIVE, select: "claim" } }]),
      [{ status: 200, body: { finalState: null, isAllocated: false, phase: "active", claim: SETTLED } }]);
    await flush();
    expect(pillClass(".pcc-receipt-rail .pcc-pill")).not.toContain("st-settled");
  });

  it("F13 (HIGH): a list's rows never inherit the exact route's authority (with or without select)", async () => {
    bootScript(man([{ kind: "list", binding: { path: RC_LIVE, select: "rows" }, item: { title: "phase", statusFrom: "finalState" } }]),
      [{ status: 200, body: { finalState: null, isAllocated: false, phase: "active", rows: [SETTLED] } }]);
    await flush();
    expect(pillClass(".pcc-list-row .pcc-pill")).not.toContain("st-settled");
    bootScript(man([{ kind: "list", binding: { path: RC_LIVE }, item: { title: "phase", statusFrom: "finalState" } }]),
      [{ status: 200, body: { finalState: null, isAllocated: false, phase: "active", events: [SETTLED] } }]);
    await flush();
    expect(pillClass(".pcc-list-row .pcc-pill")).not.toContain("st-settled");
  });

  it("F13 positive control: the unprojected top-level read of the exact route is still verified", async () => {
    bootScript(man([{ kind: "receipt", binding: { path: RC_LIVE } }]), [{ status: 200, body: SETTLED }]);
    await flush();
    expect(pillClass(".pcc-receipt-rail .pcc-pill")).toContain("st-settled");
  });

  it("F10 over time (HIGH): a later UNVERIFIED read requalifies the latest line a verified read left plain", async () => {
    bootScript(man([{ kind: "run", binding: { path: LC_LIVE, pollMs: 5 }, statusFrom: "finalState", latestFrom: "message" }]),
      [{ status: 200, body: { ...LC8, message: "PAID" } }, { status: 200, body: LC1 }]);
    await flush();
    expect(latestText()).toBe("PAID"); // verified payee payment: plain
    await wait(60);
    expect(pillClass(".pcc-win-head .pcc-pill")).not.toContain("st-settled");
    expect(latestText()).not.toBe("PAID");
  });

  it("F10 over time (HIGH): a FAILED read requalifies the latest line too", async () => {
    bootScript(man([{ kind: "run", binding: { path: LC_LIVE, pollMs: 5 }, statusFrom: "finalState", latestFrom: "message" }]),
      [{ status: 200, body: { ...LC8, message: "PAID" } }, "reject"]);
    await flush();
    expect(latestText()).toBe("PAID");
    await wait(60);
    expect(latestText()).not.toBe("PAID");
  });

  it("F10 over time (HIGH): a FAILED read requalifies a verified poll timeline too", async () => {
    bootScript(man([{ kind: "run", binding: { path: LC_LIVE, pollMs: 5 }, statusFrom: "finalState", latestFrom: "message" }]),
      [{ status: 200, body: { ...LC8, timeline: [{ type: "PAID" }] } }, "reject"]);
    await flush();
    expect(feedLines()).toEqual(["PAID"]);
    await wait(60);
    expect(feedLines()).not.toContain("PAID");
  });

  it("F10 over time (HIGH): a later unverified read requalifies a verified poll timeline", async () => {
    bootScript(man([{ kind: "run", binding: { path: LC_LIVE, pollMs: 5 }, statusFrom: "finalState", latestFrom: "message" }]),
      [{ status: 200, body: { ...LC8, timeline: [{ type: "PAID" }] } }, { status: 200, body: LC1 }]);
    await flush();
    expect(feedLines()).toEqual(["PAID"]);
    await wait(60);
    expect(feedLines()).not.toContain("PAID");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// R12 round 2: ChatGPT runs 1-3 on #599 @aa0b8df6, the orchestrator's UNION A-E (implementer-alpha).
// Shared LIVE boot: replies by call index; once the script is used up every request stays pending, so
// no window keeps polling after its test.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
type R2Reply = { status: number; body?: unknown } | "reject";
const R2_UNIT = "0x" + "ab".repeat(32);
const R2_OTHER_UNIT = "0x" + "ef".repeat(32);
const R2_LC = `/api/settlement/units/${R2_UNIT}/lifecycle`;
const R2_RC = `/api/settlement/units/${R2_UNIT}/receipt`;
const r2Man = (windows: unknown[]) => JSON.stringify({ csd: "pcc://artifacts/dashboard/v1", title: "T", sections: [{ windows }] });
function r2BootLive(manifest: string, script: R2Reply[]) {
  assertKitTextBeforeBoot();
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
  const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
  const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest"; mNode.textContent = manifest;
  document.body.appendChild(mNode); // no #pcc-snapshot node: LIVE mode
  let n = 0;
  (window as unknown as { fetch: unknown }).fetch = () => {
    const r = script[n++];
    if (r === undefined) return new Promise(() => {});
    if (r === "reject") return Promise.reject(new Error("network down"));
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: () => Promise.resolve(r.body ?? {}), text: () => Promise.resolve(JSON.stringify(r.body ?? {})) });
  };
  // eslint-disable-next-line no-eval
  (0, eval)(kitSrc);
  assertKitTextViolations();
}
const r2Wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2Ok = (body: unknown): R2Reply => ({ status: 200, body });
const r2Without = (o: Record<string, unknown>, keys: readonly string[]) => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };
const r2Name = (n: number) => VNEXT_UNIT_STATES[n]!;
/** A /lifecycle body for state n (the routes' own field semantics), pinned for R2_UNIT. */
const r2Lifecycle = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  unitState: n, phase: PHASE[n], finalState: n >= 8 ? r2Name(n) : null, isTerminal: n >= 8, isAllocated: n === 6 || n === 7, ...PIN_FIELDS, ...extra,
});
/** A /receipt body for state n (no unitState, no isTerminal; network echoes the chain), pinned for R2_UNIT. */
const r2Receipt = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  finalState: n >= 8 ? r2Name(n) : null, phase: PHASE[n], isAllocated: n === 6 || n === 7, network: { chainId: 84532 }, ...PIN_FIELDS, ...extra,
});
const R2_PIN_KEYS = ["chainId", "escrow", "unitId", "asOfBlock", "asOfBlockHash", "finality", "network"] as const;
/** Every way a pin can fail: missing, malformed, another unit, another chain, not finalized. */
const R2_BROKEN_PINS: Array<[string, (b: Record<string, unknown>) => Record<string, unknown>]> = [
  ["missing", (b) => r2Without(b, R2_PIN_KEYS)],
  ["malformed escrow", (b) => ({ ...b, escrow: "0xE" })],
  ["malformed chainId (a string)", (b) => ({ ...b, chainId: "84532" })],
  ["malformed asOfBlock (a number)", (b) => ({ ...b, asOfBlock: 12345678 })],
  ["malformed asOfBlock (a leading zero)", (b) => ({ ...b, asOfBlock: "012345678" })],
  ["malformed block hash", (b) => ({ ...b, asOfBlockHash: "0x12" })],
  ["another unit", (b) => ({ ...b, unitId: R2_OTHER_UNIT })],
  ["another chain (not in the network table)", (b) => ({ ...b, chainId: 1, network: { chainId: 1 } })],
  ["another chain (network disagrees)", (b) => ({ ...b, network: { chainId: 8453 } })],
  ["not finalized (safe)", (b) => ({ ...b, finality: "safe" })],
  ["not finalized (latest)", (b) => ({ ...b, finality: "latest" })],
  ["not finalized (missing)", (b) => r2Without(b, ["finality"])],
];
/** Live reads of the unit's own exact routes (a query such as ?asOf is fine). */
const R2_LIVE_ROUTES: Array<{ path: string; live: true }> = [{ path: R2_LC, live: true }, { path: R2_RC, live: true }, { path: R2_LC + "?asOf=0x" + "cd".repeat(32), live: true }];
/** Not a live read of the exact route: a snapshot, a stringly "live", another route, the provenance route, no source. */
const R2_NOT_LIVE: unknown[] = [{ path: R2_LC, live: false }, { path: R2_RC, live: "true" }, { path: "/api/jobs/j1", live: true },
  { path: `/api/settlement/units/${R2_UNIT}/provenance`, live: true }, { path: `/api/settlement/units/${R2_OTHER_UNIT}/lifecycle`, live: false }, null, undefined, {}];
const R2_PENDING = { tone: "waiting", label: "pending - not confirmed at a finalized block" } as const;
const R2_NOT_SHOWN = { tone: "unknown", label: "state not shown - not a live read of a settlement route" } as const;
/** Every presentation a V-next state can take (the table, plus the /receipt-only decided and in-flight readings). */
const R2_STATE_LABELS = [...Object.values(VNEXT_STATE_PRESENTATION).map((e) => e.label), "outcome decided - not yet paid out", "in progress - no outcome decided"];

describe("R12 r2 D (run 2 F1 HIGH): EVERY chain-derived money state needs a live read with a valid pin, not only a final one", () => {
  const kit = extractRegion();
  const src = (s: unknown) => s as { path?: unknown; live?: unknown } | null | undefined;
  /** The spec classifier and BOTH kit classifiers (settlementReadClass, dataStatusClass) agree, and equal `want`. */
  function expectBoth(body: Record<string, unknown>, source: unknown, want: { tone: string; label: string | null }) {
    const s = src(source);
    const tag = JSON.stringify(body) + " @ " + JSON.stringify(source);
    const spec = classifySettlementRead(body, s);
    expect({ tone: spec.tone, label: spec.label }, tag).toEqual({ tone: want.tone, label: want.label });
    const [cls, label] = kit.settlementReadClass(body, s?.path, s?.live);
    expect([cls, label], tag).toEqual(["st-" + spec.tone, spec.label]);
    // A V-next row goes through the same gate on every data surface (list rows, run pills).
    expect(kit.dataStatusClass(s?.path, body, body.finalState, s?.live), tag).toBe("st-" + spec.tone);
    // ...and its text never names a state the gate did not admit.
    const text = kit.dataStatusText(s?.path, body, body.finalState, s?.live).t;
    if (want.tone === "unknown" || want === R2_PENDING) {
      expect(R2_STATE_LABELS, tag).not.toContain(text);
      expect([...VNEXT_UNIT_STATES], tag).not.toContain(text);
      if (kit.isMoneyData(s?.path, body)) expect(text, tag).toBe(want.label);
    }
  }

  it("unitState 1..9 x every broken pin x every source, from /lifecycle, /receipt and /receipt+unitState: the spec and the kit agree on the whole matrix", () => {
    let cases = 0;
    for (let n = 1; n <= 9; n++) {
      for (const shape of [r2Lifecycle(n), r2Receipt(n), r2Receipt(n, { unitState: n })]) {
        const own = classifySettlementRecord(shape);
        expect(own.known, JSON.stringify(shape)).toBe(true); // a consistent record: only the gate decides
        // a live read of the exact route WITH a valid pin: the state itself, final or not
        for (const s of R2_LIVE_ROUTES) { expectBoth(shape, s, { tone: own.tone, label: own.label }); cases++; }
        // a live read of the exact route with a missing, malformed, other-unit, other-chain or unfinalized pin: pending
        for (const [, broken] of R2_BROKEN_PINS) for (const s of R2_LIVE_ROUTES) { expectBoth(broken(shape), s, R2_PENDING); cases++; }
        // not a live read of the exact route (snapshot-only, another route, no source): unknown, pinned or not
        for (const body of [shape, ...R2_BROKEN_PINS.map(([, broken]) => broken(shape))]) for (const s of R2_NOT_LIVE) { expectBoth(body, s, R2_NOT_SHOWN); cases++; }
      }
    }
    expect(cases).toBe(9 * 3 * (3 + 12 * 3 + 13 * 8));
  });

  it("states 1..7 are gated exactly like 8 and 9: no non-final presentation without the pin (the reviewer's class, by state)", () => {
    for (let n = 1; n <= 7; n++) {
      const label = classifySettlementRecord(r2Lifecycle(n)).label!;
      for (const [name, broken] of R2_BROKEN_PINS) {
        const live = classifySettlementRead(broken(r2Lifecycle(n)), { path: R2_LC, live: true });
        expect(live.label, n + " " + name).not.toBe(label);
        expect(live.tone, n + " " + name).toBe("waiting");
      }
      const snap = classifySettlementRead(r2Lifecycle(n), { path: R2_LC, live: false }); // snapshot-only, even with a valid pin
      expect(snap.label, n + " snapshot").toBe(R2_NOT_SHOWN.label);
    }
  });

  it("run 2's exact body {unitState:1, finalState:null, isAllocated:false, phase:\"active\"} never shows 'active - funds committed, no outcome yet'", () => {
    const body = { unitState: 1, finalState: null, isAllocated: false, phase: "active" };
    expect(classifySettlementRecord(body).label).toBe("active - funds committed, no outcome yet"); // its FIELDS are consistent...
    for (const s of R2_LIVE_ROUTES) expectBoth(body, s, R2_PENDING); // ...but it carries no chain reference: pending
    for (const s of R2_NOT_LIVE) expectBoth(body, s, R2_NOT_SHOWN);
  });

  it("run 2's exact body, rendered (run, receipt and list windows, live; and a snapshot): pending or not shown, never the state", async () => {
    const body = { unitState: 1, finalState: null, isAllocated: false, phase: "active" };
    const docText = () => document.body.textContent || "";
    r2BootLive(r2Man([{ kind: "run", binding: { path: R2_LC }, statusFrom: "finalState" }]), [r2Ok(body)]);
    await flush();
    const runPill = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    expect(runPill.className).toContain("st-waiting");
    expect(runPill.textContent).toBe("pending - not confirmed at a finalized block");
    expect(docText()).not.toContain("funds committed");
    r2BootLive(r2Man([{ kind: "receipt", binding: { path: R2_LC } }]), [r2Ok(body)]);
    await flush();
    const rcPill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement;
    expect(rcPill.className).toContain("st-waiting");
    expect(rcPill.textContent).toBe("pending - not confirmed at a finalized block");
    expect(docText()).not.toContain("funds committed");
    expect(docText()).not.toContain("FUNDED_ACTIVE");
    r2BootLive(r2Man([{ kind: "list", binding: { path: "/api/settlement/units" }, item: { title: "phase", statusFrom: "unitState" } }]), [r2Ok([{ ...body, ...PIN_FIELDS }])]);
    await flush();
    const rowPill = document.querySelector(".pcc-list-row .pcc-pill") as HTMLElement;
    expect(rowPill.className).toContain("st-unknown"); // a row is never a live read of its own route, pinned or not
    expect(rowPill.textContent).toBe("state not shown - not a live read of a settlement route");
    boot({}, r2Man([{ kind: "run", binding: { path: R2_LC }, statusFrom: "finalState" }]), { _ts: "2026-09-24T00:00:00Z", [R2_LC]: { ...body, ...PIN_FIELDS } });
    await flush();
    expect((document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement).textContent).toBe("state not shown - not a live read of a settlement route");
    expect(docText()).not.toContain("funds committed");
  });

  it("DOM property: for every state 1..9, no window shows a state, its label or a money tone without THIS read's pin; once pinned, the same windows do", async () => {
    const docText = () => document.body.textContent || "";
    const pills = () => Array.from(document.querySelectorAll(".pcc-pill")).map((p) => [(p as HTMLElement).className, (p.textContent || "").trim()] as const);
    const MONEY_TONE = /st-(settled|refunded|running|failed)/;
    for (let n = 1; n <= 9; n++) {
      const label = classifySettlementRecord(r2Lifecycle(n)).label!;
      const tone = classifySettlementRecord(r2Lifecycle(n)).tone;
      for (const [name, broken] of [["no pin", (b: Record<string, unknown>) => r2Without(b, R2_PIN_KEYS)], ["not finalized", (b: Record<string, unknown>) => ({ ...b, finality: "safe" })]] as const) {
        for (const [manifest, body] of [
          [r2Man([{ kind: "run", binding: { path: R2_LC }, statusFrom: "finalState" }]), broken(r2Lifecycle(n))],
          [r2Man([{ kind: "receipt", binding: { path: R2_LC } }]), broken(r2Lifecycle(n))],
          [r2Man([{ kind: "receipt", binding: { path: R2_RC } }]), broken(r2Receipt(n))],
        ] as const) {
          r2BootLive(manifest, [r2Ok(body)]);
          await flush();
          const tag = n + " " + name + " " + manifest;
          expect(docText(), tag).not.toContain(label);
          for (const [cls, text] of pills()) {
            expect(cls, tag).not.toMatch(MONEY_TONE);
            if (cls.includes("st-waiting")) expect(text, tag).toBe("pending - not confirmed at a finalized block");
            expect([...VNEXT_UNIT_STATES], tag).not.toContain(text);
          }
          expect(document.querySelector(".pcc-pin-ref"), tag).toBeNull();
        }
      }
      // positive control: the same live read, pinned, shows the state's own tone and label
      r2BootLive(r2Man([{ kind: "receipt", binding: { path: R2_LC } }]), [r2Ok(r2Lifecycle(n))]);
      await flush();
      expect((document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement).className, "pinned " + n).toContain("st-" + tone);
      expect(docText(), "pinned " + n).toContain(label);
      expect(document.querySelector(".pcc-pin-ref"), "pinned " + n).not.toBeNull();
    }
  });

  it("a legacy escrow record's word, in ANY state, is the escrow service's report: attributed, no money tone (spec == kit, every flat word x source)", () => {
    const sources: unknown[] = [{ path: "/api/escrow/e1", live: true }, { path: "/api/escrow/e1", live: false }, { path: R2_RC, live: true }, null];
    for (const k of Object.keys(MONEY_STATUS_MAP)) {
      for (const rec of [{ status: k, contractAddress: "0x1" }, { status: k.toLowerCase(), totalAmount: "5" }, { status: k, milestones: [] }]) {
        for (const s of sources) {
          const tag = JSON.stringify(rec) + " @ " + JSON.stringify(s);
          const spec = classifySettlementRead(rec, src(s));
          expect(spec.tone, tag).toBe("unknown");
          expect(spec.label, tag).toBe(ESCROW_SERVICE_REPORTS + MONEY_STATUS_MAP[k]!.label + NOT_CONFIRMED_ON_CHAIN);
          expect(kit.settlementReadClass(rec, src(s)?.path, src(s)?.live), tag).toEqual(["st-unknown", spec.label, rec.status]);
        }
      }
    }
    // an unknown legacy word stays unknown, with no label to attribute (the receipt pill attributes the raw word)
    for (const w of ["underfunded", "success", "RELEASED?", ""]) {
      const rec = { status: w, contractAddress: "0x1" };
      expect(classifySettlementRead(rec, { path: "/api/escrow/e1", live: true })).toMatchObject({ tone: "unknown", label: null });
      expect(kit.settlementReadClass(rec, "/api/escrow/e1", true).slice(0, 2)).toEqual(["st-unknown", null]);
    }
  });

  it("a flat money word on ANY data surface takes no money tone and is attributed to its source (list rows, run pills, non-money reads)", () => {
    for (const k of Object.keys(MONEY_STATUS_MAP)) {
      const label = MONEY_STATUS_MAP[k]!.label;
      // money data: a legacy-shaped row is the escrow service's report, any other row the bound record's
      expect(kit.dataStatusClass("/api/escrow", { id: "e1", status: k }, k, true), k).toBe("st-unknown");
      expect(kit.dataStatusText("/api/escrow", { id: "e1", status: k }, k, true).t, k).toBe("bound record reports: " + label + NOT_CONFIRMED_ON_CHAIN);
      expect(kit.dataStatusText("/api/escrow", { id: "e1", status: k, contractAddress: "0x1" }, k, false).t, k).toBe(ESCROW_SERVICE_REPORTS + label + NOT_CONFIRMED_ON_CHAIN);
      expect(kit.dataStatusClass("/api/jobs", { status: k, amount: "5" }, k, true), k).toBe("st-unknown");
      // a NON-money read: the generic states only, so a money word is neutral, and its text is qualified
      if (!Object.prototype.hasOwnProperty.call(kit.GENERIC_STATES, k)) {
        expect(kit.statusClass(k), k).toBe("st-unknown");
        expect(kit.dataStatusClass("/api/jobs", { status: k }, k, true), k).toBe("st-unknown");
      }
    }
    // the generic job states keep their (non-money) tones on a non-money read
    expect(kit.dataStatusClass("/api/jobs", { status: "running" }, "running", true)).toBe("st-running");
    expect(kit.dataStatusClass("/api/jobs", { status: "failed" }, "failed", true)).toBe("st-failed");
    expect(kit.dataStatusClass("/api/jobs", { status: "done" }, "done", true)).toBe("st-ack");
  });

  it("legacy and flat words, rendered: receipt, list and run windows show them attributed in a neutral pill, in ANY state", async () => {
    for (const k of ["FUNDED", "LOCKED", "DISPUTED", "PENDING", "CREATED", "ACTIVE", "RELEASING", "MILESTONE_MET", "EXPIRED", "SLASHED"]) {
      const label = MONEY_STATUS_MAP[k]!.label;
      r2BootLive(r2Man([{ kind: "receipt", binding: { path: "/api/escrow/e1" } }]), [r2Ok({ id: "e1", status: k, contractAddress: "0x" + "11".repeat(20), totalAmount: "5" })]);
      await flush();
      const pill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement;
      expect(pill.className, k).toContain("st-unknown");
      expect(pill.textContent, k).toBe("PCC escrow service reports: " + k);
      expect(document.querySelector(".pcc-receipt-rail")!.textContent, k).toContain(ESCROW_SERVICE_REPORTS + label + NOT_CONFIRMED_ON_CHAIN);
      r2BootLive(r2Man([{ kind: "list", binding: { path: "/api/escrow" }, item: { title: "id", statusFrom: "status" } }]), [r2Ok([{ id: "e1", status: k }])]);
      await flush();
      const row = document.querySelector(".pcc-list-row .pcc-pill") as HTMLElement;
      expect(row.className, k).toContain("st-unknown");
      expect(row.textContent, k).toBe("bound record reports: " + label + NOT_CONFIRMED_ON_CHAIN);
      r2BootLive(r2Man([{ kind: "run", binding: { path: "/api/escrow/e1" }, statusFrom: "status" }]), [r2Ok({ status: k })]);
      await flush();
      const run = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
      expect(run.className, k).toContain("st-unknown");
      expect(run.textContent, k).toBe("bound record reports: " + label + NOT_CONFIRMED_ON_CHAIN);
    }
    // a money word on a NON-money read (a job): neutral pill, qualified text
    r2BootLive(r2Man([{ kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", statusFrom: "status" } }]),
      [r2Ok([{ id: "j1", status: "refunded" }, { id: "j2", status: "funded" }, { id: "j3", status: "locked" }, { id: "j4", status: "running" }])]);
    await flush();
    const rows = Array.from(document.querySelectorAll(".pcc-list-row .pcc-pill")).map((p) => [(p as HTMLElement).className, p.textContent]);
    expect(rows).toEqual([
      ["pcc-pill st-unknown", "reported status: refunded - status unverified"],
      ["pcc-pill st-unknown", "reported status: funded - status unverified"],
      ["pcc-pill st-unknown", "reported status: locked - status unverified"],
      ["pcc-pill st-running", "running"],
    ]);
  });
});

describe("R12 r2 D (the same class, receipt sinks): a pinned read whose fields disagree states no money fact", () => {
  const ECON = { amount: "1000000", feeAmount: "23500", recipient: "0x" + "34".repeat(20), token: "0x" + "56".repeat(20), assuranceTier: 1 };
  it("a pinned live body with an inconsistent state: the pill refuses, the amount and the payee are not shown as facts", async () => {
    for (const bad of [r2Lifecycle(8, { isAllocated: true, economics: ECON }), r2Receipt(8, { phase: "allocated", economics: ECON }), r2Lifecycle(8, { unitState: 0, economics: ECON })]) {
      r2BootLive(r2Man([{ kind: "receipt", binding: { path: R2_RC } }]), [r2Ok(bad)]);
      await flush();
      const pill = document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement;
      const tag = JSON.stringify(bad);
      expect(pill.className, tag).toContain("st-unknown");
      const body = document.querySelector(".pcc-win-body")!.textContent!;
      expect(body, tag).toContain("amount not shown - the settlement record is not readable");
      expect(body, tag).toContain("payee not shown");
      expect(body, tag).not.toContain("1000000 base units");
      expect(body, tag).not.toContain(ECON.recipient);
      // the read itself is still referenced, so the reader can check what the chain says
      expect(document.querySelector(".pcc-pin-ref"), tag).not.toBeNull();
    }
  });
  it("positive control: the same body, consistent, shows its amount and payee as facts with the reference", async () => {
    r2BootLive(r2Man([{ kind: "receipt", binding: { path: R2_RC } }]), [r2Ok(r2Receipt(8, { economics: ECON }))]);
    await flush();
    const body = document.querySelector(".pcc-win-body")!.textContent!;
    expect((document.querySelector(".pcc-receipt-rail .pcc-pill") as HTMLElement).className).toContain("st-settled");
    expect(body).toContain("1000000 base units (decimals not reported)");
    expect(body).toContain(ECON.recipient);
  });
});

// ── R12 r2 A (run 3 F1 HIGH = run 2 F4 HIGH): the run window's money pill carries THIS poll's chain reference ──
/** LIVE boot whose every request is answered by the TEST (deferred), so each poll's update can be inspected
 *  before the next one; an unanswered poll stays pending, which ends the poll chain. */
type R2Call = { url: string; settle: (r: R2Reply) => void };
function r2BootGated(manifest: string): R2Call[] {
  assertKitTextBeforeBoot();
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
  const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
  const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest"; mNode.textContent = manifest;
  document.body.appendChild(mNode); // LIVE mode
  const calls: R2Call[] = [];
  (window as unknown as { fetch: unknown }).fetch = (url: unknown) => new Promise((resolve, reject) => {
    calls.push({ url: String(url), settle: (r) => {
      if (r === "reject") { reject(new Error("network down")); return; }
      resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: () => Promise.resolve(r.body ?? {}), text: () => Promise.resolve(JSON.stringify(r.body ?? {})) });
    } });
  });
  // eslint-disable-next-line no-eval
  (0, eval)(kitSrc);
  assertKitTextViolations();
  return calls;
}
/** Answer the i-th request (waiting for the kit to make it), then let the update land. */
async function r2Answer(calls: R2Call[], i: number, reply: R2Reply) {
  for (let t = 0; t < 400 && calls.length <= i; t++) await r2Wait(2);
  expect(calls.length, "request " + i + " was made").toBeGreaterThan(i);
  calls[i]!.settle(reply);
  await flush();
}
/** End a polling test: wait until the window has made its NEXT request into this test's own mock, and leave
 *  it unanswered. The window then waits forever, so it can never take a later test's reply (a stale window's
 *  timer would otherwise call whatever fetch the next test installs). */
async function r2Park(calls: R2Call[], i: number) {
  for (let t = 0; t < 400 && calls.length <= i; t++) await r2Wait(2);
  expect(calls.length, "the window parked on request " + i).toBeGreaterThan(i);
}
const r2Short = (h: string) => h.slice(0, 6) + "…" + h.slice(-4);
/** The visible reference the kit must show for a pinned body (from the body's own fields). */
function r2ExpectedRef(b: Record<string, unknown>): string {
  const net = (SETTLEMENT_NETWORKS as Record<number, string>)[b.chainId as number]!;
  const block = String(b.asOfBlock).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${net} · escrow ${r2Short(String(b.escrow))} · unit ${r2Short(String(b.unitId))} · block ${block} (${r2Short(String(b.asOfBlockHash))}) · finalized`;
}

describe("R12 r2 A (run 3 F1 HIGH = run 2 F4 HIGH): no run pill carries a chain-derived money tone without THIS read's visible reference", () => {
  // Run 3's exact reproduction (verdict-run3.md, F1).
  const RUN3_PATH = "/api/settlement/units/0xabababababababababababababababababababababababababababababababab/lifecycle";
  const RUN3_MANIFEST = { csd: "pcc://artifacts/dashboard/v1", title: "Settlement", sections: [{ windows: [{ kind: "run", binding: { path: RUN3_PATH }, statusFrom: "finalState" }] }] };
  const RUN3_BODY = {
    chainId: 84532, escrow: "0x1212121212121212121212121212121212121212",
    unitId: "0xabababababababababababababababababababababababababababababababab",
    asOfBlock: "12345678", asOfBlockHash: "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    finality: "finalized", unitState: 8, finalState: "SETTLED_RELEASED", isTerminal: true, isAllocated: false, phase: "settled",
  };
  // The same manifest, polling every 5ms, so the test can drive the next polls (each one answered by the test).
  const RUN3_POLLING = JSON.stringify({ ...RUN3_MANIFEST, sections: [{ windows: [{ ...RUN3_MANIFEST.sections[0]!.windows[0]!, binding: { path: RUN3_PATH, pollMs: 5 } }] }] });
  const pill = () => document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
  const ref = () => document.querySelector(".pcc-run-pin .pcc-pin-ref")?.textContent ?? null;
  const details = () => document.querySelector(".pcc-run-pin .pcc-pin-details");
  const PENDING = "pending - not confirmed at a finalized block";
  /** The invariant, checked after every update: a chain-derived money tone (any money tone but the pending
   *  refusal) has exactly the reference of the body that produced it; anything else has none. */
  function invariant(body: Record<string, unknown> | null, tag: string) {
    const cls = pill().className, text = pill().textContent;
    const chainTone = /st-(settled|refunded|running|failed)/.test(cls) || (cls.includes("st-waiting") && text !== PENDING);
    if (chainTone) {
      expect(body, tag + ": a money tone came from a body").not.toBeNull();
      expect(ref(), tag).toBe(r2ExpectedRef(body!));
      expect(details()?.textContent, tag).toContain(String(body!.asOfBlockHash));
    } else {
      expect(ref(), tag + " (" + cls + " / " + text + ")").toBeNull();
    }
  }

  it("run 3's exact manifest and body: a green pill AND the visible reference (Base Sepolia, the escrow, the unit, 12345678, the hash)", async () => {
    const calls = r2BootGated(JSON.stringify(RUN3_MANIFEST));
    await r2Answer(calls, 0, r2Ok(RUN3_BODY));
    expect(calls[0]!.url).toContain(RUN3_PATH);
    expect(pill().className).toContain("st-settled");
    expect(pill().textContent).toBe("SETTLED_RELEASED");
    expect(ref()).toBe("Base Sepolia · escrow 0x1212…1212 · unit 0xabab…abab · block 12,345,678 (0xcdcd…cdcd) · finalized");
    const d = details()!;
    expect(d.querySelector("summary")!.textContent).toBe("Reference: the chain read behind this money fact");
    const rows = Array.from(d.querySelectorAll(".pcc-pin-row .pcc-mono")).map((x) => x.textContent);
    expect(rows).toEqual(["84532", RUN3_BODY.escrow, RUN3_BODY.unitId, "12345678", RUN3_BODY.asOfBlockHash, "finalized"]);
    invariant(RUN3_BODY, "run 3 body");
  });

  it("then a failing poll removes the reference and the green; an unpinned poll is pending with no reference; an other-unit body has no reference", async () => {
    const calls = r2BootGated(RUN3_POLLING);
    await r2Answer(calls, 0, r2Ok(RUN3_BODY));
    expect(pill().className).toContain("st-settled");
    expect(ref()).not.toBeNull();
    invariant(RUN3_BODY, "1 pinned");
    await r2Answer(calls, 1, "reject"); // a failing poll
    expect(pill().className).not.toContain("st-settled");
    expect(pill().textContent).toBe("unknown · read failed");
    expect(ref()).toBeNull();
    expect(details()).toBeNull();
    invariant(null, "2 failed");
    await r2Answer(calls, 2, r2Ok(RUN3_BODY)); // pinned again: the reference comes back with the green
    invariant(RUN3_BODY, "3 pinned again");
    await r2Answer(calls, 3, r2Ok({ ...RUN3_BODY, finality: "safe" })); // finality not "finalized"
    expect(pill().className).toContain("st-waiting");
    expect(pill().textContent).toBe(PENDING);
    expect(ref()).toBeNull();
    invariant(null, "4 unfinalized");
    await r2Answer(calls, 4, r2Ok(RUN3_BODY));
    invariant(RUN3_BODY, "5 pinned again");
    await r2Answer(calls, 5, r2Ok({ ...RUN3_BODY, unitId: R2_OTHER_UNIT })); // a body for another unit
    expect(pill().className).not.toContain("st-settled");
    expect(ref()).toBeNull();
    invariant(null, "6 other unit");
    await r2Park(calls, 6);
  });

  it("a state change replaces the reference in the same update: never an earlier poll's pin", async () => {
    const calls = r2BootGated(RUN3_POLLING);
    const six = { ...r2Lifecycle(6), unitId: RUN3_BODY.unitId, escrow: RUN3_BODY.escrow, asOfBlock: "12345600", asOfBlockHash: "0x" + "77".repeat(32) };
    await r2Answer(calls, 0, r2Ok(six));
    expect(pill().className).toContain("st-waiting"); // RELEASE_ALLOCATED, pinned: a chain-derived money state (D)
    expect(pill().textContent).toBe("release decided - payout outstanding");
    expect(ref()).toBe(r2ExpectedRef(six));
    invariant(six, "6 pinned");
    await r2Answer(calls, 1, r2Ok(RUN3_BODY)); // the unit settles at a later block
    expect(pill().className).toContain("st-settled");
    expect(ref()).toBe(r2ExpectedRef(RUN3_BODY));
    expect(ref()).not.toContain("12,345,600");
    invariant(RUN3_BODY, "8 pinned");
    await r2Answer(calls, 2, r2Ok(r2Without(six, R2_PIN_KEYS))); // back to 6, unpinned
    expect(ref()).toBeNull();
    invariant(null, "6 unpinned");
    await r2Park(calls, 3);
  });

  it("the invariant holds over every state 1..9, pinned, broken and failed, in any order", async () => {
    const calls = r2BootGated(RUN3_POLLING);
    let i = 0;
    for (let n = 1; n <= 9; n++) {
      const pinned = { ...r2Lifecycle(n), unitId: RUN3_BODY.unitId, asOfBlock: String(12345600 + n) };
      await r2Answer(calls, i++, r2Ok(pinned));
      invariant(pinned, n + " pinned");
      expect(ref(), n + " pinned").not.toBeNull(); // every state 1..9 is chain-derived money state (D)
      for (const [name, broken] of R2_BROKEN_PINS) {
        await r2Answer(calls, i++, r2Ok(broken(pinned)));
        invariant(null, n + " " + name);
      }
      await r2Answer(calls, i++, "reject");
      invariant(null, n + " failed");
    }
    await r2Park(calls, i);
  });

  it("a snapshot, a stream event and a nested pinned object never paint a reference (only the poll's own unprojected live body can)", async () => {
    boot({}, JSON.stringify(RUN3_MANIFEST), { _ts: "2026-09-24T00:00:00Z", [RUN3_PATH]: RUN3_BODY }); // baked: never a live read
    await flush();
    expect(pill().textContent).toBe("state not shown - not a live read of a settlement route");
    expect(ref()).toBeNull();
    // binding.select names a nested object: the run classifies its whole read, and the nested pin lends nothing
    const calls = r2BootGated(JSON.stringify({ ...RUN3_MANIFEST, sections: [{ windows: [{ kind: "run", binding: { path: RUN3_PATH, select: "claim" }, statusFrom: "claim.finalState" }] }] }));
    await r2Answer(calls, 0, r2Ok({ finalState: null, isAllocated: false, phase: "active", claim: RUN3_BODY }));
    expect(pill().className).not.toContain("st-settled");
    expect(ref()).toBeNull();
  });

  it("an SSE event carrying a pinned settled body is never a verified read: no state, no reference", async () => {
    const ssePath = "/sse/stream/settlement/u1";
    assertKitTextBeforeBoot();
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
    const main = document.createElement("main"); main.id = "pcc-root"; document.body.appendChild(main);
    const mNode = document.createElement("script"); mNode.type = "application/json"; mNode.id = "pcc-manifest";
    mNode.textContent = JSON.stringify({ ...RUN3_MANIFEST, sections: [{ windows: [{ kind: "run", binding: { path: RUN3_PATH, sse: ssePath }, statusFrom: "finalState" }] }] });
    document.body.appendChild(mNode);
    const frame = "data: " + JSON.stringify(RUN3_BODY) + "\n\n";
    (window as unknown as { fetch: unknown }).fetch = (url: unknown) => {
      if (new URL(String(url)).pathname !== ssePath) return new Promise(() => {});
      const enc = new TextEncoder();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({ pull(c) { if (!sent) { sent = true; c.enqueue(enc.encode(frame)); } else c.close(); } });
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body });
    };
    // eslint-disable-next-line no-eval
    (0, eval)(kitSrc);
    assertKitTextViolations();
    await flush();
    await flush();
    expect(pill().className).not.toContain("st-settled");
    expect(pill().textContent).toBe("state not shown - not a live read of a settlement route");
    expect(ref()).toBeNull();
  });
});

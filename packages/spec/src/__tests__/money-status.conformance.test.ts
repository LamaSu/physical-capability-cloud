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
import { MONEY_STATUS_MAP, classifyMoneyStatus } from "../money/money-status.js";

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
};

function extractRegion(): KitRegion {
  const m = kitSrc.match(/\/\/ <status-map v2>[^\n]*\n([\s\S]*?)\/\/ <\/status-map v2>/);
  if (!m) throw new Error("<status-map v2> markers not found in pcc-ui.js");
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(
    m[1] +
      "\nthis.MONEY_STATUS = MONEY_STATUS; this.GENERIC_STATES = GENERIC_STATES;" +
      " this.statusClass = statusClass; this.moneyStatusClass = moneyStatusClass;" +
      " this.settlementLabel = settlementLabel; this.isMoneyData = isMoneyData; this.dataStatusClass = dataStatusClass;",
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

  it("a genuine final release renders settled with its direction label", async () => {
    const r = await renderedPill({ status: "SETTLED_RELEASED" });
    expect(r.cls).toContain("st-settled");
    expect(r.rail).toContain("operator distribution discharged");
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
    expect(pills.slice(0, 3).some((c) => c.includes("st-settled"))).toBe(false);
    expect(pills[3]).toContain("st-settled"); // a documented final release still reads as one
  });

  it("a JOB list keeps generic tones for non-money rows (completed job = done)", async () => {
    const pills = await listPills("/api/jobs", [{ id: "j1", status: "completed" }, { id: "j2", status: "completed", amount: "5" }]);
    expect(pills[0]).toContain("st-settled");
    expect(pills[1]).toContain("st-waiting"); // a paid job row is money data
  });
});

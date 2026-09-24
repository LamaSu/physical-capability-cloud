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
};

function extractRegion(): KitRegion {
  const m = kitSrc.match(/\/\/ <status-map v2>[^\n]*\n([\s\S]*?)\/\/ <\/status-map v2>/);
  if (!m) throw new Error("<status-map v2> markers not found in pcc-ui.js");
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(
    m[1] +
      "\nthis.MONEY_STATUS = MONEY_STATUS; this.GENERIC_STATES = GENERIC_STATES;" +
      " this.statusClass = statusClass; this.moneyStatusClass = moneyStatusClass;" +
      " this.settlementLabel = settlementLabel;",
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

function boot(escrow: Record<string, unknown>) {
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
  mNode.textContent = receiptManifest;
  document.body.appendChild(mNode);
  const sNode = document.createElement("script");
  sNode.type = "application/json";
  sNode.id = "pcc-snapshot";
  sNode.textContent = JSON.stringify({ _ts: "2026-09-24T00:00:00Z", [ESC]: escrow });
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

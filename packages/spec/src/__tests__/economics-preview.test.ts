/**
 * buildEconomicPreview (PX-12): "who gets paid what, when, and why" before accepting. The preview
 * adds no arithmetic, so the tests pin that its groupings re-add to the compiled totals exactly, that
 * every payment carries a reason in the agreement's own words, and that it never claims to be a deal.
 */

import { describe, expect, it } from "vitest";
import { compileEconomics } from "../economics/compile.js";
import { AGREEMENT_TEMPLATES, exampleIncompatibleLicense, examplePrintAndMail, exampleSparePrinter, PRINTER_KIT_SCHEDULE } from "../economics/examples.js";
import { buildEconomicPreview, formatAmount, MAX_LINES_PER_PAYEE } from "../economics/preview.js";
import { simulateEconomics } from "../economics/simulate.js";
import type { EconomicAgreement } from "../economics/types.js";
import { a, baseAgreement } from "./economics-helpers.js";

const opts = { schedules: [PRINTER_KIT_SCHEDULE] };

describe("formatAmount is exact", () => {
  it.each([
    ["25000000", 6, "25.00"],
    ["587500", 6, "0.5875"],
    ["1", 6, "0.000001"],
    ["100000", 6, "0.10"],
    ["0", 6, "0.00"],
    ["7", 0, "7"],
    ["123456789012345678901234567890", 18, "123456789012.34567890123456789"],
  ])("%s at %i decimals is %s", (amount, decimals, text) => {
    expect(formatAmount(amount, decimals)).toBe(text);
  });
});

describe("buildEconomicPreview", () => {
  it.each(AGREEMENT_TEMPLATES.map((t) => [t.templateId, t] as const))("%s: the groupings re-add to the compiled totals, to the base unit", (_id, t) => {
    const ag = t.build();
    const compiled = compileEconomics(ag, t.compileOptions);
    if (!compiled.ok) throw new Error("fixture");
    const p = buildEconomicPreview(ag, compiled, { feeVerified: true });
    expect(p.status).toBe("fundable");
    expect(p.layer).toBe("C");
    const sum = (xs: Array<{ amount: string }>) => xs.reduce((s, x) => s + BigInt(x.amount), 0n);
    // Every category, plus PCC's fee, is exactly the most the payer can spend.
    expect(sum(p.byCategory.map((c) => c.amount)) + BigInt(p.totals!.protocolFee.amount)).toBe(BigInt(p.totals!.maxSpend.amount));
    // Every payee's lines add up to their total, and all payees to what the parties get.
    for (const payee of p.payees) expect(sum(payee.lines.map((l) => l.amount))).toBe(BigInt(payee.total.amount));
    expect(sum(p.payees.map((x) => x.total))).toBe(BigInt(p.totals!.toParties.amount));
    // Each payment says why, and each step says when it is paid and what happens if it fails.
    for (const payee of p.payees) for (const l of payee.lines) expect(l.why.length).toBeGreaterThan(5);
    for (const s of p.steps) {
      expect(s.whenPaid).toContain("released");
      expect(s.ifItFails).toContain("goes back to");
    }
    // Acceptance binds this hash; the preview is its own evidence of what was shown.
    expect(p.agreement.agreementHash).toBe(compiled.agreementHash);
  });

  it("the spare printer, in plain words: Priya's royalty is upstream, required by her license, and verified", () => {
    const ag = exampleSparePrinter();
    const compiled = compileEconomics(ag, opts);
    if (!compiled.ok) throw new Error("fixture");
    const p = buildEconomicPreview(ag, compiled, { feeVerified: true });
    expect(p.headline).toBe(
      "You pay at most 25.00 USDC. 0.5875 USDC of that is PCC's protocol fee (2.35%). The rest, 24.4125 USDC, goes to 2 parties, step by step, only as each step is released.",
    );
    const priya = p.payees.find((x) => x.partyId === "priya")!;
    expect(priya.total.display).toBe("0.10 USDC");
    expect(priya.lines[0]!.category).toBe("upstream");
    expect(priya.lines[0]!.why).toContain('required by the license "Printer kit license v2');
    expect(p.byCategory.map((c) => [c.category, c.amount.display])).toEqual([
      ["provider", "24.3125 USDC"],
      ["upstream", "0.10 USDC"],
      ["fee", "0.00 USDC"],
      ["margin", "0.00 USDC"],
    ]);
    expect(p.rates).toEqual([{ clause: "Kit royalty: 0.40% of the job", percent: "0.40%", verified: true, note: "Checked against the published rate schedule at the time of this agreement." }]);
    expect(p.rights[0]).toMatchObject({ licensor: "Priya (wrote the printer kit)", attributionRequired: true });
    expect(p.moneyState.reserved!.amount).toBe("0");
    expect(p.moneyState.paid!.amount).toBe("0");
  });

  it("a pinned rate on a clause that pays nothing here is not called checked, even with its schedule supplied", () => {
    const ag = exampleSparePrinter();
    const royalty = ag.clauses.find((c) => c.clauseId === "kit-royalty")!;
    ag.clauses.push({ ...structuredClone(royalty), clauseId: "unused-royalty", label: "Royalty if the kit ran", appliesTo: { usingComponent: "kit:never-used" }, underLicense: null });
    const compiled = compileEconomics(ag, opts);
    if (!compiled.ok) throw new Error("fixture");
    const p = buildEconomicPreview(ag, compiled, { feeVerified: true });
    expect(p.rates.find((r) => r.clause === "Royalty if the kit ran")).toEqual({
      clause: "Royalty if the kit ran",
      percent: "0.40%",
      verified: false,
      note: "Not checked, because this clause pays nothing in this agreement.",
    });
  });

  it("print-and-mail: the composer's margin and the upstream method fee are told apart", () => {
    const ag = examplePrintAndMail();
    const compiled = compileEconomics(ag);
    if (!compiled.ok) throw new Error("fixture");
    const p = buildEconomicPreview(ag, compiled, { feeVerified: true });
    const orbit = p.payees.find((x) => x.partyId === "orbit")!;
    expect(orbit.lines.every((l) => l.category === "margin")).toBe(true);
    expect(p.obligations).toEqual([{ license: "Address check method: $0.25 per use, commercial use allowed", licensor: "Mei (invented the address check)", clause: "Address check: $0.25 each time it runs", amount: { amount: "250000", display: "0.25 USDC" } }]);
  });

  it("an unverified fee is said so in the headline", () => {
    const ag = exampleSparePrinter();
    const compiled = compileEconomics(ag, opts);
    if (!compiled.ok) throw new Error("fixture");
    const p = buildEconomicPreview(ag, compiled, { feeVerified: false });
    expect(p.headline).toContain("not yet checked against the fee PCC charges");
    expect(p.protocolFee!.verified).toBe(false);
  });

  it("a refused agreement explains itself and shows no money as if it could move", () => {
    const ag = exampleIncompatibleLicense();
    const r = compileEconomics(ag);
    const p = buildEconomicPreview(ag, r, { feeVerified: true });
    expect(p.status).toBe("refused");
    expect(p.totals).toBeNull();
    expect(p.payees).toEqual([]);
    expect(p.refusals[0]!.explanation).toBe("A license does not allow this use. license lic-weld-defects@1: commercial use is not granted");
    expect(p.headline).toContain("cannot be funded");
  });

  it("scenarios are shown as the simulator computed them, fundable or not", () => {
    const ag = examplePrintAndMail();
    const compiled = compileEconomics(ag);
    if (!compiled.ok) throw new Error("fixture");
    const scenarios = simulateEconomics(ag, [
      { scenarioId: "mail-fails", label: "The mailing step fails", grossOverrides: [], usesOverrides: [], outcomes: [{ unitRef: "b-mail", outcome: "refunded" }] },
      { scenarioId: "too-cheap", label: "Print at $11", grossOverrides: [{ unitRef: "a-print", gross: "11000000" }], usesOverrides: [], outcomes: [] },
    ]);
    const p = buildEconomicPreview(ag, compiled, { feeVerified: true, scenarios });
    const [fails, cheap] = p.scenarios;
    if (!fails!.fundable || cheap!.fundable) throw new Error("fixture");
    expect(fails!.payer.refunded.display).toBe("8.00 USDC");
    expect(fails!.paid.find((x) => x.partyId === "courier")).toBeUndefined();
    expect(cheap!.reasons[0]).toContain("The payments add up to more than the price");
  });
});

describe("a large agreement stays readable, and exact", () => {
  /** `units` steps; `splits` percent clauses on every step, each paying a split of `members` parties. */
  function wide(units: number, splits: number, members: number): EconomicAgreement {
    const parties = [
      ...baseAgreement().parties,
      ...Array.from({ length: members }, (_, i) => ({ partyId: `p${i}`, label: `Member ${i}`, kind: "person" as const, payTo: a(0x1000 + i) })),
    ];
    const splitDefs = Array.from({ length: splits }, (_, k) => ({
      splitId: `s${k}`,
      label: `Pool ${k}`,
      members: Array.from({ length: members }, (_, i) => ({ to: { party: `p${i}` }, weight: 1 + ((i + k) % 7), role: null, subject: null })),
    }));
    const clauses = [
      ...splitDefs.map((sp, k) => ({
        clauseId: `c${String(k).padStart(2, "0")}`,
        label: `Pool ${k} share`,
        role: "integrator" as const,
        to: { split: sp.splitId },
        subject: null,
        appliesTo: { allUnits: true as const },
        underLicense: null,
        rule: { kind: "percent" as const, bps: 10 + k, of: "gross" as const, min: null, max: null, rateSource: null },
      })),
      baseAgreement().clauses[0]!,
    ];
    const steps = Array.from({ length: units }, (_, u) => ({ unitRef: `u${String(u).padStart(3, "0")}`, label: `Step ${u}`, gross: String(1_000_000_000 + u * 7919), components: [], measures: [] }));
    return baseAgreement({ parties, splits: splitDefs, clauses, units: steps });
  }

  const previewOf = (ag: EconomicAgreement) => {
    const compiled = compileEconomics(ag);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.refusals));
    return { compiled, p: buildEconomicPreview(ag, compiled, { feeVerified: true }) };
  };
  const reAdds = (p: ReturnType<typeof buildEconomicPreview>) => {
    for (const payee of p.payees) {
      expect(payee.lines.length).toBeLessThanOrEqual(MAX_LINES_PER_PAYEE);
      expect(payee.lines.reduce((s, l) => s + BigInt(l.amount.amount), 0n)).toBe(BigInt(payee.total.amount));
    }
  };

  it("61,696 allocations: each payee shows at most 24 lines that re-add to its total, in well under a megabyte", () => {
    const { compiled, p } = previewOf(wide(256, 16, 15));
    expect(compiled.units.reduce((n, u) => n + u.legs.reduce((m, l) => m + l.attribution.length, 0), 0)).toBe(256 * (16 * 15 + 1));
    reAdds(p);
    const member = p.payees.find((x) => x.partyId === "p0")!;
    expect(member.lines.map((l) => l.stepLabel)).toEqual(Array(16).fill("256 steps"));
    expect(member.lines.every((l) => l.unitRef === null && l.why.startsWith("Pool "))).toBe(true);
    expect(JSON.stringify(p).length).toBeLessThan(1_000_000);
  });

  it("more reasons than lines: the largest are kept and the rest summed per kind of payment", () => {
    const { p } = previewOf(wide(2, 40, 2));
    reAdds(p);
    const member = p.payees.find((x) => x.partyId === "p0")!;
    expect(member.lines).toHaveLength(MAX_LINES_PER_PAYEE - 3);
    expect(member.lines.at(-1)!.why).toBe("20 more payments: Licenses and contributors");
    expect(member.lines.at(-1)!.stepLabel).toBe("2 steps");
  });

  it("a small agreement keeps one line per step and reason", () => {
    const { p } = previewOf(wide(3, 2, 2));
    const member = p.payees.find((x) => x.partyId === "p0")!;
    expect(member.lines.map((l) => [l.unitRef, l.stepLabel])).toEqual([
      ["u000", "Step 0"],
      ["u000", "Step 0"],
      ["u001", "Step 1"],
      ["u001", "Step 1"],
      ["u002", "Step 2"],
      ["u002", "Step 2"],
    ]);
  });
});

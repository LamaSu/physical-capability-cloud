import { describe, expect, it } from "vitest";
import { compileEconomics, type CompiledEconomics } from "../economics/compile.js";
import { AGREEMENT_TEMPLATES, exampleIncompatibleLicense, examplePrintAndMail } from "../economics/examples.js";
import type { Refusal } from "../economics/refusals.js";
import { simulateEconomics, type ScenarioResult } from "../economics/simulate.js";
import { ADDRESS_PATTERN, ZERO_ADDRESS, type EconomicAgreement } from "../economics/types.js";

// E1: literal output contracts from compile.ts:113-170. No output key is optional;
// nullable fields (feeRecipient and zeroLeg.subject) must still be present.
const COMPILED_KEYS = [
  "ok", "schema", "agreementId", "version", "agreementHash", "economicTermsHash", "rightsTermsHash",
  "currency", "payer", "asOf", "fee", "units", "notEligible", "rights", "rates", "totals",
] as const;
const CURRENCY_KEYS = ["code", "decimals"] as const;
const FEE_KEYS = ["feeBps", "feeRecipient"] as const;
const TOTALS_KEYS = ["gross", "fee", "net", "byParty"] as const;
const UNIT_KEYS = ["unitRef", "gross", "fee", "net", "payouts", "legs", "zeroLegs", "clauses"] as const;
const PAYOUT_KEYS = ["recipient", "amount"] as const;
const LEG_KEYS = ["recipient", "amount", "partyIds", "roles", "subjects", "compacted", "attribution"] as const;
const ATTRIBUTION_KEYS = ["clauseId", "partyId", "path", "amount"] as const;
const ZERO_LEG_KEYS = ["partyId", "role", "subject", "path"] as const;
const CLAUSE_KEYS = ["clauseId", "amount"] as const;
const NOT_ELIGIBLE_KEYS = ["clauseId", "reason"] as const;
const RIGHTS_KEYS = ["licenseId", "version", "subject", "licensor", "class", "attributionRequired", "authority", "compatible"] as const;
const RATE_KEYS = ["clauseId", "scheduleHash", "bps", "verified"] as const;
const PARTY_TOTAL_KEYS = ["partyId", "amount"] as const;

// ScenarioResult's two variants are pinned from simulate.ts:49-60; neither has
// optional keys. A successful fee.recipient is nullable, never omitted.
const SCENARIO_OK_KEYS = ["scenarioId", "label", "ok", "agreementHash", "units", "paid", "payer", "fee"] as const;
const SCENARIO_REFUSED_KEYS = ["scenarioId", "label", "ok", "refusals"] as const;
const SCENARIO_UNIT_KEYS = ["unitRef", "outcome", "gross", "fee", "net"] as const;
const SCENARIO_PAYER_KEYS = ["partyId", "spent", "refunded", "reserved"] as const;
const SCENARIO_FEE_KEYS = ["paid", "recipient"] as const;
const REFUSAL_KEYS = ["code", "message", "path"] as const;
const COMPILE_REFUSED_KEYS = ["ok", "refusals"] as const;

const PAYERS: Record<string, string> = {
  "spare-printer": "dana",
  "print-and-mail": "buyer",
  "guild-repair": "homeowner",
  "lab-assay": "client",
  "deck-milestones": "homeowner",
};

// A fresh coverage map belongs to one test, so shuffling tests cannot hide an
// unvisited array element kind behind checks performed by an earlier test.
type KeyCoverage = Map<readonly string[], number>;

function exactKeys(value: object, expected: readonly string[], checked?: KeyCoverage): void {
  expect(Object.keys(value).sort()).toStrictEqual([...expected].sort());
  if (checked) checked.set(expected, (checked.get(expected) ?? 0) + 1);
}

function recipient(value: string | null, nullable = false): void {
  if (nullable && value === null) return;
  expect(value).toMatch(ADDRESS_PATTERN);
  expect(value?.toLowerCase()).not.toBe(ZERO_ADDRESS);
}

function dataOnly(value: unknown): void {
  // This also rejects undefined, bigint, functions, symbols, Maps and class
  // instances: JSON must round-trip to exactly the original data, recursively.
  expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      expect(node, path).not.toMatch(/0x[0-9a-f]{65,}/i);
    } else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    }
  };
  walk(value, "output");
}

function compiledShape(out: CompiledEconomics, agreement: EconomicAgreement, payer: string, checked?: KeyCoverage): void {
  exactKeys(out, COMPILED_KEYS, checked);
  exactKeys(out.currency, CURRENCY_KEYS, checked);
  exactKeys(out.fee, FEE_KEYS, checked);
  exactKeys(out.totals, TOTALS_KEYS, checked);
  recipient(out.fee.feeRecipient, true);
  // compileEconomics preserves a party id; it does not resolve the payer to payTo.
  expect(out.payer).toBe(payer);
  expect(out.payer).toBe(agreement.payer);
  expect(out.payer).not.toMatch(ADDRESS_PATTERN);
  expect(agreement.parties.some((party) => party.partyId === out.payer)).toBe(true);
  for (const unit of out.units) {
    exactKeys(unit, UNIT_KEYS, checked);
    for (const payout of unit.payouts) {
      exactKeys(payout, PAYOUT_KEYS, checked);
      recipient(payout.recipient);
    }
    for (const leg of unit.legs) {
      exactKeys(leg, LEG_KEYS, checked);
      recipient(leg.recipient);
      for (const attribution of leg.attribution) exactKeys(attribution, ATTRIBUTION_KEYS, checked);
    }
    for (const zeroLeg of unit.zeroLegs) exactKeys(zeroLeg, ZERO_LEG_KEYS, checked);
    for (const clause of unit.clauses) exactKeys(clause, CLAUSE_KEYS, checked);
  }
  for (const entry of out.notEligible) exactKeys(entry, NOT_ELIGIBLE_KEYS, checked);
  for (const entry of out.rights) exactKeys(entry, RIGHTS_KEYS, checked);
  for (const entry of out.rates) exactKeys(entry, RATE_KEYS, checked);
  for (const entry of out.totals.byParty) exactKeys(entry, PARTY_TOTAL_KEYS, checked);
  dataOnly(out);
}

function refusalsShape(refusals: Refusal[], checked?: KeyCoverage): void {
  expect(refusals.length).toBeGreaterThan(0);
  for (const refusal of refusals) exactKeys(refusal, REFUSAL_KEYS, checked);
}

function scenarioShape(result: ScenarioResult, payer: string, checked?: KeyCoverage): void {
  if (result.ok) {
    exactKeys(result, SCENARIO_OK_KEYS, checked);
    for (const unit of result.units) exactKeys(unit, SCENARIO_UNIT_KEYS, checked);
    for (const paid of result.paid) exactKeys(paid, PARTY_TOTAL_KEYS, checked);
    exactKeys(result.payer, SCENARIO_PAYER_KEYS, checked);
    expect(result.payer.partyId).toBe(payer);
    expect(result.payer.partyId).not.toMatch(ADDRESS_PATTERN);
    exactKeys(result.fee, SCENARIO_FEE_KEYS, checked);
    recipient(result.fee.recipient, true);
  } else {
    exactKeys(result, SCENARIO_REFUSED_KEYS, checked);
    refusalsShape(result.refusals, checked);
  }
  dataOnly(result);
}


// These branches do not occur in the five templates as supplied. Each build
// returns fresh objects, just like the templates themselves.
const EDGE_INPUTS = [
  {
    label: "notEligible",
    build: (): EconomicAgreement => {
      const agreement = examplePrintAndMail();
      // Same participation case as economics-compile.test.ts:458-463.
      agreement.units[1]!.components = agreement.units[1]!.components.filter((component) => component.ref !== "method:address-verify@1");
      return agreement;
    },
  },
  {
    label: "zero-leg",
    build: (): EconomicAgreement => {
      const agreement = examplePrintAndMail();
      const printCost = agreement.clauses.find((clause) => clause.clauseId === "print-cost")!;
      if (printCost.rule.kind !== "fixed") throw new Error("print-cost must be a fixed price");
      printCost.rule.amount = "0";
      return agreement;
    },
  },
  {
    label: "zero-fee",
    build: (): EconomicAgreement => {
      const agreement = examplePrintAndMail();
      agreement.fee = { feeBps: 0, feeRecipient: null };
      return agreement;
    },
  },
] as const;

describe("E1 economics outputs contain only declared data", () => {
  it("pins the five compilable templates", () => {
    expect(AGREEMENT_TEMPLATES.map((template) => template.templateId)).toStrictEqual(Object.keys(PAYERS));
  });

  for (const template of AGREEMENT_TEMPLATES) {
    it(`${template.templateId}: compile has exact keys, address recipients and a party-id payer`, () => {
      const agreement = template.build();
      const out = compileEconomics(agreement, template.compileOptions);
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error(JSON.stringify(out.refusals));
      compiledShape(out, agreement, PAYERS[template.templateId]!);
    });

    it(`${template.templateId}: both simulator variants have exact data-only shapes`, () => {
      const agreement = template.build();
      const first = agreement.units[0]!;
      // Templates carry no scenarios. These are the release/refund/pending,
      // gross/uses override and refusal shapes in economics-simulate.test.ts.
      const base = { grossOverrides: [], usesOverrides: [], outcomes: [] };
      const scenarios = [
        { ...base, scenarioId: "all-good", label: "Every step done" },
        { ...base, scenarioId: "refunded", label: "First step fails", outcomes: [{ unitRef: first.unitRef, outcome: "refunded" }] },
        { ...base, scenarioId: "waiting", label: "Waiting on the first step", outcomes: [{ unitRef: first.unitRef, outcome: "pending" }] },
        { ...base, scenarioId: "price", label: "Explicit price", grossOverrides: [{ unitRef: first.unitRef, gross: first.gross }] },
        {
          ...base, scenarioId: "skip", label: "Component did not run",
          usesOverrides: first.components.slice(0, 1).map(({ ref }) => ({ unitRef: first.unitRef, ref, uses: "0" })),
        },
        { ...base, scenarioId: "typo", label: "Unknown unit", outcomes: [{ unitRef: "m9-nope", outcome: "refunded" }] },
        { scenarioId: "bad", label: "Malformed scenario", grossOverrides: [], outcomes: [] },
      ];
      const results = simulateEconomics(agreement, scenarios, template.compileOptions);
      expect(results).toHaveLength(scenarios.length);
      expect(results[0]!.ok).toBe(true);
      expect(results.at(-2)!.ok).toBe(false);
      expect(results.at(-1)!.ok).toBe(false);
      for (const result of results) scenarioShape(result, PAYERS[template.templateId]!);
      dataOnly(results);
    });
  }

  for (const edge of EDGE_INPUTS) {
    it(`${edge.label}: compiler and simulator branches retain exact data-only keys`, () => {
      const agreement = edge.build();
      const out = compileEconomics(agreement);
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error(JSON.stringify(out.refusals));
      compiledShape(out, agreement, "buyer");
      if (edge.label === "notEligible") {
        expect(out.notEligible).toStrictEqual([{ clauseId: "address-check-fee", reason: "component-not-used" }]);
      } else if (edge.label === "zero-leg") {
        expect(out.units.flatMap((unit) => unit.zeroLegs).length).toBeGreaterThan(0);
      } else {
        expect(out.fee).toStrictEqual({ feeBps: 0, feeRecipient: null });
        expect(out.totals.fee).toBe("0");
      }
      const results = simulateEconomics(agreement, [
        { scenarioId: "released", label: "All released", grossOverrides: [], usesOverrides: [], outcomes: [] },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(true);
      scenarioShape(results[0]!, "buyer");
      if (edge.label === "zero-fee" && results[0]!.ok) {
        expect(results[0]!.fee).toStrictEqual({ paid: "0", recipient: null });
      }
      dataOnly(results);
    });
  }

  it("checks every declared object and array-element kind at least once within this test", () => {
    const checked: KeyCoverage = new Map();
    const inputs = [
      ...AGREEMENT_TEMPLATES.map((template) => ({ agreement: template.build(), options: template.compileOptions })),
      ...EDGE_INPUTS.map((edge) => ({ agreement: edge.build(), options: {} })),
    ];
    for (const { agreement, options } of inputs) {
      const out = compileEconomics(agreement, options);
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error(JSON.stringify(out.refusals));
      compiledShape(out, agreement, agreement.payer, checked);
      const results = simulateEconomics(agreement, [
        { scenarioId: "released", label: "All released", grossOverrides: [], usesOverrides: [], outcomes: [] },
        { scenarioId: "refused", label: "Unknown unit", grossOverrides: [], usesOverrides: [], outcomes: [{ unitRef: "unknown", outcome: "refunded" }] },
      ], options);
      expect(results.map((result) => result.ok)).toStrictEqual([true, false]);
      for (const result of results) scenarioShape(result, agreement.payer, checked);
    }
    const refused = compileEconomics(exampleIncompatibleLicense());
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("incompatible license must be refused");
    exactKeys(refused, COMPILE_REFUSED_KEYS, checked);
    refusalsShape(refused.refusals, checked);
    for (const keys of [
      COMPILED_KEYS, CURRENCY_KEYS, FEE_KEYS, TOTALS_KEYS, UNIT_KEYS, PAYOUT_KEYS,
      LEG_KEYS, ATTRIBUTION_KEYS, ZERO_LEG_KEYS, CLAUSE_KEYS, NOT_ELIGIBLE_KEYS,
      RIGHTS_KEYS, RATE_KEYS, PARTY_TOTAL_KEYS, SCENARIO_OK_KEYS, SCENARIO_REFUSED_KEYS,
      SCENARIO_UNIT_KEYS, SCENARIO_PAYER_KEYS, SCENARIO_FEE_KEYS, REFUSAL_KEYS, COMPILE_REFUSED_KEYS,
    ]) {
      expect(checked.get(keys) ?? 0, `unvisited key contract: ${keys.join(", ")}`).toBeGreaterThan(0);
    }
  });

  it("the data-only guard detects an embedded calldata-shaped string and accepts a 32-byte hash", () => {
    expect(() => dataOnly({ label: `prefix 0x${"a".repeat(65)} suffix` })).toThrow();
    expect(() => dataOnly({ hash: `0x${"a".repeat(64)}` })).not.toThrow();
  });

  it("a refused compile exposes exactly ok/refusals and the declared Refusal keys", () => {
    // The noncommercial dataset input is also refused in economics-compile.test.ts.
    const out = compileEconomics(exampleIncompatibleLicense());
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("the incompatible-license example must be refused");
    exactKeys(out, COMPILE_REFUSED_KEYS);
    refusalsShape(out.refusals);
    expect(out.refusals.some((refusal) => refusal.code === "RIGHTS_INCOMPATIBLE")).toBe(true);
    dataOnly(out);
  });
});

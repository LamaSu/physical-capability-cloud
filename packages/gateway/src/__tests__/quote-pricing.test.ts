/**
 * Unit tests for the quote-pricing module (#498 round 2 — N98 r2).
 *
 * These test the pure functions directly (no HTTP, no DB): exact arithmetic
 * (F1), the settlement-currency gate (F2), usage-rate validation (F3),
 * pricing-rule validation (F4), and the conjunctive condition filter whose
 * `every` must never become `some` (F5).
 */
import { describe, it, expect } from "vitest";
import {
  SETTLEMENT_CURRENCY,
  amountCents,
  centsToDecimal,
  registeredQuotePrice,
  validatePricingRules,
  pricingRulesThatApply,
  exactQuoteTotal,
  type ValidRule,
} from "../services/quote-pricing.js";

describe("quote-pricing: amountCents / centsToDecimal", () => {
  it("parses whole, one- and two-decimal amounts exactly", () => {
    expect(amountCents("25")).toBe(2500n);
    expect(amountCents("25.5")).toBe(2550n);
    expect(amountCents("25.50")).toBe(2550n);
    expect(amountCents(25)).toBe(2500n);
    expect(amountCents("0")).toBe(0n);
  });

  it("refuses more than two decimals, non-finite, and non-numeric text", () => {
    expect(amountCents("25.005")).toBeNull();
    expect(amountCents("abc")).toBeNull();
    expect(amountCents(Number.NaN)).toBeNull();
    expect(amountCents(-5)).toBeNull();
  });

  it("round-trips through centsToDecimal", () => {
    expect(centsToDecimal(2500n)).toBe("25.00");
    expect(centsToDecimal(1n)).toBe("0.01");
    expect(centsToDecimal(0n)).toBe("0.00");
  });
});

describe("quote-pricing: registeredQuotePrice — F2 settlement currency", () => {
  it("accepts a well-formed USDC price", () => {
    const r = registeredQuotePrice({ currency: "USDC", baseCost: "25.00", minimum: "25.00" });
    expect(r).toEqual({ ok: true, cents: 2500n, currency: "USDC", minimumCents: 2500n, usage: {} });
  });

  it.each(["EUR", "ETH", "USD", "JPY"])("refuses a well-formed but non-settlement currency (%s) as unsupported-currency", (currency) => {
    const r = registeredQuotePrice({ currency, baseCost: "25.00" });
    expect(r).toEqual({ ok: false, reason: "unsupported-currency", currency });
  });

  it("refuses malformed currency syntax as invalid-currency (not unsupported-currency)", () => {
    expect(registeredQuotePrice({ currency: "usdc", baseCost: "25.00" })).toEqual({ ok: false, reason: "invalid-currency" });
    expect(registeredQuotePrice({ currency: "", baseCost: "25.00" })).toEqual({ ok: false, reason: "invalid-currency" });
    expect(registeredQuotePrice({ currency: "US", baseCost: "25.00" })).toEqual({ ok: false, reason: "invalid-currency" });
  });

  it("SETTLEMENT_CURRENCY is USDC", () => {
    expect(SETTLEMENT_CURRENCY).toBe("USDC");
  });
});

describe("quote-pricing: registeredQuotePrice — F3 usage rates validated before disclosed", () => {
  it("refuses a value whose String() would throw, instead of crashing (toString: null)", () => {
    const r = registeredQuotePrice({ currency: "USDC", baseCost: "25.00", perMinute: { toString: null } });
    expect(r).toEqual({ ok: false, reason: "invalid-usage" });
  });

  it("refuses an arbitrary object, never disclosing '[object Object]'", () => {
    const r = registeredQuotePrice({ currency: "USDC", baseCost: "25.00", perGram: { a: 1 } });
    expect(r).toEqual({ ok: false, reason: "invalid-usage" });
  });

  it("refuses a negative rate and exponential notation", () => {
    expect(registeredQuotePrice({ currency: "USDC", baseCost: "25.00", perMinute: -0.5 })).toEqual({ ok: false, reason: "invalid-usage" });
    expect(registeredQuotePrice({ currency: "USDC", baseCost: "25.00", perMinute: "1e3" })).toEqual({ ok: false, reason: "invalid-usage" });
  });

  it("discloses a canonical rate exactly and omits every all-zero form", () => {
    const r = registeredQuotePrice({ currency: "USDC", baseCost: "25.00", perMinute: "0.015", perGram: "0.00", perCm3: 0 });
    expect(r).toEqual({ ok: true, cents: 2500n, currency: "USDC", minimumCents: null, usage: { perMinute: "0.015" } });
  });

  it("accepts a rate given as a JSON number", () => {
    const r = registeredQuotePrice({ currency: "USDC", baseCost: "25.00", perMinute: 0.08 });
    expect(r).toEqual({ ok: true, cents: 2500n, currency: "USDC", minimumCents: null, usage: { perMinute: "0.08" } });
  });
});

describe("quote-pricing: validatePricingRules — F4", () => {
  const okRule = { id: "r1", type: "custom", label: "L", enabled: true, condition: {}, impact: { mode: "percent", value: "10" } };

  it("undefined means no rules", () => {
    expect(validatePricingRules(undefined)).toEqual({ ok: true, rules: [] });
  });

  it("any other non-array refuses", () => {
    expect(validatePricingRules("garbage")).toEqual({ ok: false, ruleIndex: -1, reason: "rules-not-an-array" });
    expect(validatePricingRules(42)).toEqual({ ok: false, ruleIndex: -1, reason: "rules-not-an-array" });
    expect(validatePricingRules(null)).toEqual({ ok: false, ruleIndex: -1, reason: "rules-not-an-array" });
  });

  it("a well-formed rule round-trips with its canonical fields", () => {
    const r = validatePricingRules([okRule]);
    expect(r).toEqual({ ok: true, rules: [{ id: "r1", label: "L", enabled: true, condition: {}, impact: { mode: "percent", value: "10" } }] });
  });

  it.each([
    ["not a plain object", [null], "not-an-object"],
    ["not a plain object (array)", [[]], "not-an-object"],
    ["missing id", [{ ...okRule, id: undefined }], "invalid-id"],
    ["empty id", [{ ...okRule, id: "" }], "invalid-id"],
    ["missing label", [{ ...okRule, label: undefined }], "invalid-label"],
    ["enabled not boolean", [{ ...okRule, enabled: "yes" }], "invalid-enabled"],
    ["condition: false", [{ ...okRule, condition: false }], "invalid-condition"],
    ["condition: null", [{ ...okRule, condition: null }], "invalid-condition"],
    ["condition: 0", [{ ...okRule, condition: 0 }], "invalid-condition"],
    ["condition: []", [{ ...okRule, condition: [] }], "invalid-condition"],
    ["condition.minQuantity not a safe non-negative integer", [{ ...okRule, condition: { minQuantity: -1 } }], "invalid-condition-minQuantity"],
    ["condition.material empty string", [{ ...okRule, condition: { material: "" } }], "invalid-condition-material"],
    ["condition.maxLeadTimeMs negative", [{ ...okRule, condition: { maxLeadTimeMs: -1 } }], "invalid-condition-maxLeadTimeMs"],
    ["condition.timeWindow not an object", [{ ...okRule, condition: { timeWindow: "always" } }], "invalid-condition-timeWindow"],
    ["impact not a plain object", [{ ...okRule, impact: "percent:10" }], "invalid-impact"],
    ["impact.mode invalid", [{ ...okRule, impact: { mode: "percentage", value: "10" } }], "invalid-impact-mode"],
    ["impact.value NaN-ish", [{ ...okRule, impact: { mode: "percent", value: "abc" } }], "invalid-impact-value"],
    ["impact.value exponential", [{ ...okRule, impact: { mode: "percent", value: "1e3" } }], "invalid-impact-value"],
    ["impact.value more than 6 decimals", [{ ...okRule, impact: { mode: "percent", value: "1.1234567" } }], "invalid-impact-value"],
  ])("rejects a malformed rule: %s", (_label, rules, expectedReason) => {
    const r = validatePricingRules(rules);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.ruleIndex).toBe(0);
      expect(r.reason).toBe(expectedReason);
    }
  });

  it("an unknown condition key is ALLOWED (not a validation error)", () => {
    const r = validatePricingRules([{ ...okRule, condition: { futureFact: "x" } }]);
    expect(r).toEqual({ ok: true, rules: [{ id: "r1", label: "L", enabled: true, condition: { futureFact: "x" }, impact: { mode: "percent", value: "10" } }] });
  });

  it("reports the ruleIndex of the SECOND rule when the first is well-formed", () => {
    const r = validatePricingRules([okRule, { ...okRule, id: "r2", enabled: "nope" }]);
    expect(r).toEqual({ ok: false, ruleIndex: 1, ruleId: "r2", reason: "invalid-enabled" });
  });

  it("omits ruleId when the malformed rule's id did not parse as a string", () => {
    const r = validatePricingRules([{ ...okRule, id: 42 }]);
    expect(r).toEqual({ ok: false, ruleIndex: 0, reason: "invalid-id" });
  });
});

describe("quote-pricing: pricingRulesThatApply — the every->some mutant must die here", () => {
  const rule = (condition: Record<string, unknown>): ValidRule => ({
    id: "r", label: "L", enabled: true, condition, impact: { mode: "percent", value: "-10" },
  });

  it("a rule with two condition keys applies ONLY when BOTH hold (conjunctive, not disjunctive)", () => {
    const r = rule({ minQuantity: 5, material: "PETG" });
    expect(pricingRulesThatApply([r], { quantity: 10, material: "PLA" })).toEqual([]); // qty holds, material fails
    expect(pricingRulesThatApply([r], { quantity: 1, material: "PETG" })).toEqual([]); // material holds, qty fails
    expect(pricingRulesThatApply([r], { quantity: 10, material: "PETG" })).toEqual([r]); // both hold
  });

  it("a disabled rule never applies even with a satisfied condition", () => {
    const r = { ...rule({}), enabled: false };
    expect(pricingRulesThatApply([r], { quantity: 1, material: "x" })).toEqual([]);
  });

  it("an empty condition always applies", () => {
    const r = rule({});
    expect(pricingRulesThatApply([r], { quantity: 1, material: null })).toEqual([r]);
  });

  it("timeWindow and unknown keys never apply (route has no such fact)", () => {
    expect(pricingRulesThatApply([rule({ timeWindow: { start: "00:00", end: "23:59" } })], { quantity: 1, material: null })).toEqual([]);
    expect(pricingRulesThatApply([rule({ minCompletedJobs: 0 })], { quantity: 1, material: null })).toEqual([]);
  });
});

describe("quote-pricing: exactQuoteTotal — F1 exact arithmetic (no Number for money)", () => {
  it("no rules: total equals the subtotal exactly, even above Number.MAX_SAFE_INTEGER cents", () => {
    // 9999999999999.99 * 10 = 99999999999999.90 exactly; 32934d3a's Number(...)/100 truncated to .91.
    const subtotalCents = 999999999999999n * 10n; // registered.cents (baseCost in cents) * quantity
    const { totalCents, adjustments } = exactQuoteTotal(subtotalCents, []);
    expect(centsToDecimal(totalCents)).toBe("99999999999999.90");
    expect(adjustments).toEqual([]);
  });

  it("at MAX_QUOTE_QUANTITY the exact result diverges from a Number(n)/1e8 round-trip (kills a reintroduced float)", () => {
    // baseCost 9999999999999.99 (999999999999999 cents) at quantity 1_000_000: a double can only
    // carry ~15-17 significant decimal digits, so Number(subtotalCents * 10^8) rounds to a nearby
    // value whose /1e8 + Math.round recovers 999999999999999082496, NOT the exact
    // 999999999999999000000 BigInt division gives. Verified once in node (not by eye): this is the
    // boundary where "put a Number() back in the total path" is actually distinguishable.
    const subtotalCents = 999999999999999n * 1_000_000n;
    const { totalCents } = exactQuoteTotal(subtotalCents, []);
    expect(totalCents).toBe(999999999999999000000n);
    expect(BigInt(Math.round(Number(subtotalCents * 100_000_000n) / 1e8))).not.toBe(totalCents);
  });

  it("a tie rounds half up: 1 cent + 50% = 1.5 cents -> 2 cents", () => {
    const { totalCents } = exactQuoteTotal(1n, [{ id: "t", label: "t", enabled: true, condition: {}, impact: { mode: "percent", value: "50" } }]);
    expect(totalCents).toBe(2n);
  });

  it("a negative tie rounds half AWAY FROM ZERO: 1 cent - 50% = 0.5 cents -> total 1 cent, impact -1 cent", () => {
    const { totalCents, adjustments } = exactQuoteTotal(1n, [{ id: "t", label: "t", enabled: true, condition: {}, impact: { mode: "percent", value: "-50" } }]);
    expect(totalCents).toBe(1n);
    expect(adjustments).toEqual([{ ruleId: "t", label: "t", impact: "-0.01" }]);
  });

  it("floors at zero when rules would push the total negative", () => {
    const { totalCents } = exactQuoteTotal(1000n, [{ id: "t", label: "t", enabled: true, condition: {}, impact: { mode: "percent", value: "-150" } }]);
    expect(totalCents).toBe(0n);
  });

  it("a flat rule with 6 decimals loses no precision: 10.00 + 0.123456 -> half-up 10.12", () => {
    const { totalCents, adjustments } = exactQuoteTotal(1000n, [{ id: "f", label: "f", enabled: true, condition: {}, impact: { mode: "flat", value: "0.123456" } }]);
    expect(totalCents).toBe(1012n);
    expect(adjustments).toEqual([{ ruleId: "f", label: "f", impact: "0.12" }]);
  });

  it("a flat negative rule rounds its own display half away from zero independent of the total", () => {
    const { adjustments } = exactQuoteTotal(1000n, [{ id: "f", label: "f", enabled: true, condition: {}, impact: { mode: "flat", value: "-0.005" } }]);
    // -0.005 is an exact tie at the cent boundary -> half away from zero -> -0.01 (never -0.00).
    expect(adjustments).toEqual([{ ruleId: "f", label: "f", impact: "-0.01" }]);
  });

  it("multiple rules stack in the SAME exact accumulator, and the total is never a sum of the rounded display lines", () => {
    // Two rules whose individual rounded displays would sum to a different cent total than the
    // unrounded exact sum does: this would fail if adjustments[].impact were summed instead of N.
    const { totalCents, adjustments } = exactQuoteTotal(300n, [
      { id: "a", label: "a", enabled: true, condition: {}, impact: { mode: "flat", value: "0.004" } },
      { id: "b", label: "b", enabled: true, condition: {}, impact: { mode: "flat", value: "0.004" } },
    ]);
    // Exact: 3.00 + 0.004 + 0.004 = 3.008 -> half-up cents = 3.01 (301 cents).
    // Each rounded display independently is "0.00" (0.004 rounds down alone) + "0.00" = 0.00, which
    // would wrongly total 3.00 if summed from the display lines instead of the exact accumulator.
    expect(totalCents).toBe(301n);
    expect(adjustments).toEqual([
      { ruleId: "a", label: "a", impact: "0.00" },
      { ruleId: "b", label: "b", impact: "0.00" },
    ]);
  });
});

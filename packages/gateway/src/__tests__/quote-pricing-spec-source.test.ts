import { describe, it, expect } from "vitest";
import * as spec from "@pcc/spec";
import * as qp from "../services/quote-pricing.js";

describe("quote-pricing uses the spec registered-price source (N281 PR-B)", () => {
  it("QP2 re-exports the same functions and settlement currency as spec", () => {
    expect(typeof qp.registeredQuotePrice).toBe("function");
    expect(typeof spec.registeredQuotePrice).toBe("function");
    expect(qp.registeredQuotePrice).toBe(spec.registeredQuotePrice);
    expect(typeof qp.amountCents).toBe("function");
    expect(typeof spec.amountCents).toBe("function");
    expect(qp.amountCents).toBe(spec.amountCents);
    expect(qp.SETTLEMENT_CURRENCY).toBe("USDC");
    expect(qp.SETTLEMENT_CURRENCY).toBe(spec.SETTLEMENT_CURRENCY);
  });

  it("QP2b preserves all eight gateway runtime exports", () => {
    expect(Object.keys(qp).sort()).toEqual([
      "MAX_QUOTE_QUANTITY",
      "SETTLEMENT_CURRENCY",
      "amountCents",
      "centsToDecimal",
      "exactQuoteTotal",
      "pricingRulesThatApply",
      "registeredQuotePrice",
      "validatePricingRules",
    ]);
  });
});

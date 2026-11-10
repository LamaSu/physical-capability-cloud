import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as spec from "../index.js";

describe("registered price from the spec root (N281 PR-B)", () => {
  it("QP1 returns the registered discovery price or its exact refusal", () => {
    const rows: ReadonlyArray<readonly [unknown, unknown]> = [
      [{ currency: "USDC", baseCost: "25.00" }, { ok: true, cents: 2500n, currency: "USDC", minimumCents: null, usage: {} }],
      [{ currency: "USDC", baseCost: 25, minimum: "50.00" }, { ok: true, cents: 2500n, currency: "USDC", minimumCents: 5000n, usage: {} }],
      [{ currency: "ETH", baseCost: "25.00" }, { ok: false, reason: "unsupported-currency", currency: "ETH" }],
      [{ currency: "SOL", baseCost: "25.00" }, { ok: false, reason: "unsupported-currency", currency: "SOL" }],
      [{ currency: "usd", baseCost: "25.00" }, { ok: false, reason: "invalid-currency" }],
      [{ currency: "USDC", baseCost: "5abc" }, { ok: false, reason: "invalid-price" }],
      [{ currency: "USDC", baseCost: "10.555" }, { ok: false, reason: "invalid-price" }],
      [{ currency: "USDC", baseCost: "1e3" }, { ok: false, reason: "invalid-price" }],
      [{ currency: "USDC", baseCost: "0" }, { ok: false, reason: "zero-price" }],
      [{ currency: "USDC", baseCost: "25.00", minimum: "x" }, { ok: false, reason: "invalid-minimum" }],
      [{ currency: "USDC", baseCost: "25.00", perMinute: "1.1234567" }, { ok: false, reason: "invalid-usage" }],
      [{ currency: "USDC", baseCost: "25.00", perMinute: "0.015", perGram: "0.00", perCm3: 0 }, { ok: true, cents: 2500n, currency: "USDC", minimumCents: null, usage: { perMinute: "0.015" } }],
      [null, { ok: false, reason: "no-pricing" }],
    ];
    for (const [index, [input, expected]] of rows.entries()) {
      expect(spec.registeredQuotePrice(input), `QP1 row ${index + 1}`).toEqual(expected);
    }
  });

  it("QP1b parses canonical amounts into exact cents and settles USDC", () => {
    const rows: ReadonlyArray<readonly [unknown, bigint | null]> = [
      ["25", 2500n],
      ["25.5", 2550n],
      [25, 2500n],
      ["0", 0n],
      ["9999999999999.99", 999999999999999n],
      ["25.005", null],
      ["abc", null],
      [Number.NaN, null],
      [-5, null],
      ["10000000000000", null],
    ];
    for (const [index, [input, expected]] of rows.entries()) {
      expect(spec.amountCents(input), `QP1b row ${index + 1}`).toEqual(expected);
    }
    expect(spec.SETTLEMENT_CURRENCY).toBe("USDC");
  });

  it("QP4 keeps the registered-price source free of imports and environment reads", () => {
    const source = readFileSync(new URL("../pricing/registered-price.ts", import.meta.url), "utf8");
    const rows = [
      /^\s*import\b/m,
      /\bimport\s*\(|\brequire\s*\(|\bprocess\b|\bBuffer\b|\bglobalThis\b|node:/,
    ];
    for (const [index, pattern] of rows.entries()) {
      expect(source, `QP4 row ${index + 1}`).not.toMatch(pattern);
    }
  });
});

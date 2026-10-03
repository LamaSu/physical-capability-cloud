/**
 * AmountDisplay must not invent money (PX-3 / PX-15; product-steward #2573):
 *  - a missing or unreadable amount is unavailable (an em dash), never $0.00;
 *  - amounts are read and printed exactly, with no float and no rounding, so a
 *    real non-zero amount is never shown as 0.00;
 *  - the number carries no payment-state colour; the money badge shows state.
 * The strict-parsing cases (grouped thousands, the refusal list) come from
 * pcc-shell's 7f66a20e, so both lanes test the same formatter.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AmountDisplay, type AmountDisplayProps } from "./AmountDisplay.js";
import { formatAmountExact, parseAmountExact } from "../utils.js";

function fmt(amount: unknown, decimals?: number): string | null {
  const exact = parseAmountExact(amount, decimals);
  return exact === null ? null : formatAmountExact(exact);
}

function markup(props: AmountDisplayProps): string {
  return renderToStaticMarkup(React.createElement(AmountDisplay, props));
}

function text(props: AmountDisplayProps): string {
  return markup(props).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("parseAmountExact + formatAmountExact", () => {
  it("reads plain decimals", () => {
    expect(fmt("1234.5")).toBe("1,234.50");
    expect(fmt("-3")).toBe("-3.00");
    expect(fmt("0")).toBe("0.00");
    expect(fmt(" 12.00 ")).toBe("12.00");
    expect(fmt("+7")).toBe("7.00");
    expect(fmt(7.25)).toBe("7.25");
    expect(fmt(BigInt(42))).toBe("42.00");
  });

  it("reads correctly grouped thousands", () => {
    expect(fmt("1,234.56")).toBe("1,234.56");
    expect(fmt("12,345,678")).toBe("12,345,678.00");
  });

  it("never rounds: every significant digit stays, so a non-zero amount is never 0.00", () => {
    expect(fmt("0.004")).toBe("0.004");
    expect(fmt("0.000001")).toBe("0.000001");
    expect(fmt("12.345")).toBe("12.345");
    expect(fmt("1.100")).toBe("1.10");
    expect(fmt("007.50")).toBe("7.50");
  });

  it("stays exact past float precision", () => {
    expect(fmt("123456789012345678901234567890.123456789")).toBe(
      "123,456,789,012,345,678,901,234,567,890.123456789",
    );
    expect(fmt("9007199254740993")).toBe("9,007,199,254,740,993.00");
  });

  it("reads base units exactly when decimals are given", () => {
    expect(fmt("1500000", 6)).toBe("1.50");
    expect(fmt("1", 6)).toBe("0.000001");
    expect(fmt("0", 6)).toBe("0.00");
    expect(fmt("-2500000", 6)).toBe("-2.50");
    expect(fmt(BigInt(1500000), 6)).toBe("1.50");
    expect(fmt("123", 0)).toBe("123.00");
  });

  it("refuses base units it can't read exactly", () => {
    expect(fmt("1.5", 6)).toBeNull();
    expect(fmt("1,500", 6)).toBeNull();
    for (const d of [-1, 1.5, 37, Number.NaN]) expect(fmt("1500000", d), String(d)).toBeNull();
  });

  it("does not print a negative zero", () => {
    expect(fmt("-0")).toBe("0.00");
    expect(fmt("-0.000")).toBe("0.00");
  });

  it("refuses anything else instead of guessing", () => {
    for (const bad of ["", "   ", "abc", "1,23.4", "12,3456", "1.2.3", "$5", "5 USDC", "NaN", "Infinity", ".5", "5.", "1e3"]) {
      expect(fmt(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 1e21, {}, [], true]) {
      expect(fmt(bad), String(bad)).toBeNull();
    }
  });
});

describe("AmountDisplay (server render)", () => {
  it("renders an unavailable amount as an em dash with a screen-reader label, never $0.00", () => {
    for (const amount of [undefined, null, "", "abc", "n/a", "5 USDC"]) {
      const t = text({ amount });
      expect(t, String(amount)).toContain("—");
      expect(t, String(amount)).toContain("amount unavailable");
      expect(t, String(amount)).not.toMatch(/0\.00/);
      expect(markup({ amount }), String(amount)).toContain('data-amount="unavailable"');
    }
  });

  it("renders a real amount exactly", () => {
    expect(text({ amount: "12.5" })).toBe("$ 12.50 USDC");
    expect(text({ amount: "0" })).toBe("$ 0.00 USDC");
    expect(text({ amount: "1,234.56" })).toBe("$ 1,234.56 USDC");
    expect(text({ amount: "0.004" })).toBe("$ 0.004 USDC");
    expect(text({ amount: "-5" })).toBe("- $ 5.00 USDC");
    expect(text({ amount: "1500000", decimals: 6, currency: "USDC" })).toBe("$ 1.50 USDC");
  });

  it("uses tabular numerals", () => {
    expect(markup({ amount: "12.5" })).toContain("font-variant-numeric:tabular-nums");
  });

  it("shows a $ only for dollar currencies", () => {
    expect(text({ amount: "1.5", currency: "ETH" })).toBe("1.50 ETH");
    expect(text({ amount: "1.5", currency: "EUR" })).toBe("1.50 EUR");
    expect(text({ amount: "1.5", currency: "usd" })).toBe("$ 1.50 usd");
    expect(text({ amount: "1.5", currency: "USDT" })).toBe("$ 1.50 USDT");
  });

  it("does not crash or claim dollars when a dynamic currency is missing", () => {
    for (const currency of [null, "", "   "]) {
      const props = { amount: "1.5", currency } as unknown as AmountDisplayProps;
      expect(text(props), JSON.stringify(currency)).toBe("1.50");
    }
  });

  it("carries no payment-state colour or glow, even when glow is asked for", () => {
    for (const props of [{ amount: "12.5" }, { amount: "12.5", glow: true }, { amount: undefined, glow: true }]) {
      const m = markup(props);
      expect(m).not.toMatch(/green|glow|text-(red|gold|teal|cyan)-/);
    }
  });
});

/**
 * astra's pack-30 review of 050455a3 (SHIP-WITH-FIXES). Each finding is pinned
 * here; the first three failed on 050455a3 before the fix.
 */
describe("astra pack 30 findings", () => {
  // Finding 1 (HIGH): className reopened the colour channel the primitive closes.
  it("ignores a className, so a caller cannot restore payment-state colour or glow", () => {
    for (const amount of ["12.5", undefined]) {
      const props = { amount, className: "text-green-400 glow-text-green" } as unknown as AmountDisplayProps;
      expect(markup(props), String(amount)).not.toMatch(/green|glow/);
    }
  });

  // Finding 2 (HIGH): a JSON number past 2^53 has already lost digits before it arrives.
  it("refuses a number it cannot hold exactly, with or without decimals", () => {
    const n = (JSON.parse('{"n":9007199254740993}') as { n: number }).n;
    for (const d of [0, 6, undefined]) {
      expect(fmt(n, d), String(d)).toBeNull();
      expect(fmt(-n, d), String(d)).toBeNull();
    }
    expect(fmt(Number.MAX_SAFE_INTEGER, 0)).toBe("9,007,199,254,740,991.00");
    expect(fmt(Number.MAX_SAFE_INTEGER)).toBe("9,007,199,254,740,991.00");
    expect(fmt(1.5, 6)).toBeNull();
    // The same count as a string or bigint stays exact.
    expect(fmt("9007199254740993", 0)).toBe("9,007,199,254,740,993.00");
    expect(fmt(BigInt("9007199254740993"), 6)).toBe("9,007,199,254.740993");
  });

  // Finding 3 (HIGH): Unicode case folding let look-alikes ("UſDC") earn a "$".
  it("shows a $ only for an ASCII dollar code, never a Unicode look-alike", () => {
    expect(text({ amount: "1.5", currency: "UſDC" })).toBe("1.50 UſDC");
    expect(text({ amount: "1.5", currency: "UſD" })).toBe("1.50 UſD");
    expect(text({ amount: "1.5", currency: "ＵＳＤＣ" })).toBe("1.50 ＵＳＤＣ");
    expect(text({ amount: "1.5", currency: "USDC.e" })).toBe("1.50 USDC.e");
    expect(text({ amount: "1.5", currency: "usdc" })).toBe("$ 1.50 usdc");
    expect(text({ amount: "1.5", currency: " USDC " })).toBe("$ 1.50 USDC");
    expect(text({ amount: "1.5", currency: "USDbC" })).toBe("$ 1.50 USDbC");
  });

  // Finding 4 (MEDIUM): resolved by narrowing the contract. A number that prints in
  // exponent form is refused, not guessed; such amounts must arrive as strings.
  it("refuses a number that prints in exponent form", () => {
    expect(fmt(1e-7)).toBeNull();
    expect(fmt(1e21)).toBeNull();
    expect(fmt(0.000001)).toBe("0.000001");
    expect(fmt("0.0000001")).toBe("0.0000001");
    expect(fmt("1000000000000000000000")).toBe("1,000,000,000,000,000,000,000.00");
  });

  // Coverage astra listed as missing; these already held on 050455a3.
  it("pins the remaining edge cases", () => {
    expect(fmt("1", 1)).toBe("0.10");
    expect(fmt("1", 18)).toBe("0.000000000000000001");
    expect(fmt("1" + "0".repeat(36), 36)).toBe("1.00");
    expect(fmt(BigInt(-2500000), 6)).toBe("-2.50");
    expect(fmt(-0)).toBe("0.00");
    expect(fmt(-0, 6)).toBe("0.00");
    for (const bad of ["1,2345", ",123", "123,", "1,,234", "1,234,56", "１２"]) {
      expect(fmt(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(fmt("\u00a012.5\u00a0")).toBe("12.50");
    const hostile = { toString: () => "1.5", valueOf: () => 1.5 };
    expect(fmt(hostile)).toBeNull();
  });
});

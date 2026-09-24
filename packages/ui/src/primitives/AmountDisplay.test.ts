/**
 * AmountDisplay must not invent money: an unreadable amount is unknown, not
 * $0.00, and a formatted amount is read in full, not truncated at the comma.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AmountDisplay, parseAmount } from "./AmountDisplay.js";

function text(amount: string): string {
  return renderToStaticMarkup(React.createElement(AmountDisplay, { amount }))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("parseAmount", () => {
  it("reads plain decimals", () => {
    expect(parseAmount("1234.5")).toBe(1234.5);
    expect(parseAmount("-3")).toBe(-3);
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount(" 12.00 ")).toBe(12);
    expect(parseAmount(7.25)).toBe(7.25);
  });

  it("reads correctly grouped thousands", () => {
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("12,345,678")).toBe(12345678);
  });

  it("refuses anything else instead of guessing", () => {
    for (const bad of ["", "abc", "1,23.4", "12,3456", "1.2.3", "$5", "5 USDC", "NaN", "Infinity"]) {
      expect(parseAmount(bad), bad).toBeNull();
    }
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(Number.NaN)).toBeNull();
  });
});

describe("AmountDisplay", () => {
  it("renders a real amount", () => {
    expect(text("12.5")).toContain("12.50");
    expect(text("0")).toContain("0.00");
  });

  it("renders a formatted amount in full, not truncated at the comma", () => {
    expect(text("1,234.56")).toContain("1234.56");
    expect(text("1,234.56")).not.toMatch(/\$\s*1\.00/);
  });

  it("renders an unreadable amount as unknown, never $0.00", () => {
    for (const bad of ["", "abc", "n/a"]) {
      const t = text(bad);
      expect(t, bad).toContain("—");
      expect(t, bad).not.toContain("0.00");
    }
  });
});

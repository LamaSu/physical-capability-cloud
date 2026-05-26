import { describe, it, expect } from "vitest";
import {
  toAtomicUsdc,
  decimalUsdc,
  isPaidPrice,
  priceTagHmac,
  verifyPriceTag,
  type PriceTagFields,
} from "../pricing.js";

const SECRET = "abcdef0123456789".repeat(4);

describe("toAtomicUsdc", () => {
  it("converts standard prices correctly", () => {
    expect(toAtomicUsdc("0.001")).toBe("1000");
    expect(toAtomicUsdc("0.01")).toBe("10000");
    expect(toAtomicUsdc("0.10")).toBe("100000");
    expect(toAtomicUsdc("1")).toBe("1000000");
    expect(toAtomicUsdc("1.5")).toBe("1500000");
    expect(toAtomicUsdc("10")).toBe("10000000");
  });

  it("returns 0 for zero / empty / undefined / null", () => {
    expect(toAtomicUsdc("0")).toBe("0");
    expect(toAtomicUsdc("0.0")).toBe("0");
    expect(toAtomicUsdc("")).toBe("0");
    expect(toAtomicUsdc("   ")).toBe("0");
    expect(toAtomicUsdc(undefined)).toBe("0");
    expect(toAtomicUsdc(null)).toBe("0");
  });

  it("returns 0 for negative / non-finite / garbage", () => {
    expect(toAtomicUsdc("-0.5")).toBe("0");
    expect(toAtomicUsdc("NaN")).toBe("0");
    expect(toAtomicUsdc("Infinity")).toBe("0");
    expect(toAtomicUsdc("abc")).toBe("0");
  });
});

describe("decimalUsdc", () => {
  it("converts atomic units back to decimal strings", () => {
    expect(decimalUsdc("1000")).toBe("0.001");
    expect(decimalUsdc("10000")).toBe("0.01");
    expect(decimalUsdc("100000")).toBe("0.1");
    expect(decimalUsdc("1000000")).toBe("1");
    expect(decimalUsdc("1500000")).toBe("1.5");
    expect(decimalUsdc("0")).toBe("0");
  });

  it("handles trailing zeros correctly", () => {
    expect(decimalUsdc("1100000")).toBe("1.1");
    expect(decimalUsdc("100")).toBe("0.0001");
  });

  it("handles large amounts via BigInt", () => {
    expect(decimalUsdc("123456789012345")).toBe("123456789.012345");
  });

  it("returns 0 for invalid / empty / null", () => {
    expect(decimalUsdc("")).toBe("0");
    expect(decimalUsdc(undefined)).toBe("0");
    expect(decimalUsdc(null)).toBe("0");
    expect(decimalUsdc("abc")).toBe("0");
    expect(decimalUsdc("-100")).toBe("0");
  });
});

describe("toAtomicUsdc ↔ decimalUsdc round-trip", () => {
  it("preserves common pricing inputs", () => {
    const inputs = ["0.001", "0.01", "0.1", "1", "1.5", "10", "100.123456"];
    for (const input of inputs) {
      const atomic = toAtomicUsdc(input);
      const back = decimalUsdc(atomic);
      expect(back).toBe(input === "10" ? "10" : input.replace(/^0+(?=\d)/, "") || "0");
    }
  });
});

describe("isPaidPrice", () => {
  it("returns true for positive prices", () => {
    expect(isPaidPrice("0.001")).toBe(true);
    expect(isPaidPrice("0.01")).toBe(true);
    expect(isPaidPrice("100")).toBe(true);
  });

  it("returns false for zero / undefined / empty", () => {
    expect(isPaidPrice("0")).toBe(false);
    expect(isPaidPrice("0.00")).toBe(false);
    expect(isPaidPrice(undefined)).toBe(false);
    expect(isPaidPrice(null)).toBe(false);
    expect(isPaidPrice("")).toBe(false);
  });

  it("returns false for negative / garbage", () => {
    expect(isPaidPrice("-0.5")).toBe(false);
    expect(isPaidPrice("abc")).toBe(false);
    expect(isPaidPrice("NaN")).toBe(false);
  });
});

describe("priceTagHmac + verifyPriceTag", () => {
  const fields: PriceTagFields = {
    toolId: "tool-abc",
    amount: "1000",
    network: "eip155:84532",
    payTo: "0x1234567890abcdef1234567890abcdef12345678",
    validUntil: (Math.floor(Date.now() / 1000) + 300).toString(),
  };

  it("produces a 64-char hex tag", () => {
    const tag = priceTagHmac(fields, SECRET);
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyPriceTag returns true for a fresh, matching tag", () => {
    const tag = priceTagHmac(fields, SECRET);
    expect(verifyPriceTag(tag, fields, SECRET)).toBe(true);
  });

  it("verifyPriceTag returns false if the tag is altered", () => {
    const tag = priceTagHmac(fields, SECRET);
    const tampered = tag.slice(0, -2) + "00";
    expect(verifyPriceTag(tampered, fields, SECRET)).toBe(false);
  });

  it("verifyPriceTag returns false if the amount field differs", () => {
    const tag = priceTagHmac(fields, SECRET);
    const altered = { ...fields, amount: "9999" };
    expect(verifyPriceTag(tag, altered, SECRET)).toBe(false);
  });

  it("verifyPriceTag returns false if the payTo field differs", () => {
    const tag = priceTagHmac(fields, SECRET);
    const altered = { ...fields, payTo: "0xdeadbeef00000000000000000000000000000000" };
    expect(verifyPriceTag(tag, altered, SECRET)).toBe(false);
  });

  it("verifyPriceTag is case-insensitive on payTo (lowercased before hashing)", () => {
    const lower = { ...fields, payTo: fields.payTo.toLowerCase() };
    const upper = { ...fields, payTo: fields.payTo.toUpperCase() as `0x${string}` };
    const tagLower = priceTagHmac(lower, SECRET);
    expect(verifyPriceTag(tagLower, upper, SECRET)).toBe(true);
  });

  it("verifyPriceTag returns false if expired", () => {
    const expired: PriceTagFields = {
      ...fields,
      validUntil: (Math.floor(Date.now() / 1000) - 10).toString(),
    };
    const tag = priceTagHmac(expired, SECRET);
    expect(verifyPriceTag(tag, expired, SECRET)).toBe(false);
  });

  it("verifyPriceTag returns false with a wrong secret", () => {
    const tag = priceTagHmac(fields, SECRET);
    const otherSecret = "deadbeef" + "0".repeat(56);
    expect(verifyPriceTag(tag, fields, otherSecret)).toBe(false);
  });

  it("verifyPriceTag respects an explicit nowSec for determinism", () => {
    const issuedAt = 1_700_000_000;
    const validUntil = issuedAt + 300;
    const tagFields: PriceTagFields = {
      ...fields,
      validUntil: validUntil.toString(),
    };
    const tag = priceTagHmac(tagFields, SECRET);
    expect(verifyPriceTag(tag, tagFields, SECRET, issuedAt + 100)).toBe(true);
    expect(verifyPriceTag(tag, tagFields, SECRET, validUntil + 10)).toBe(false);
  });
});

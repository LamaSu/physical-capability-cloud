/**
 * Reserved description prefixes: the Unicode screening (WP-B, astra pack 88, Q2).
 *
 * astra's verdict on 2c3064b7 reproduced two descriptions that read as the
 * server's "PROOF SUBMITTED:" review record and were accepted:
 *   1. a Lisu letter PA (U+A4D1) for the P, which the targeted look-alike
 *      table did not list;
 *   2. 1,023 zero-width spaces and then a supplementary variation selector
 *      (U+E0100). The scan was cut at 1,024 UTF-16 units, in the middle of the
 *      selector's surrogate pair, and the stranded high surrogate was not
 *      removed, so the truncated-prefix check had nothing it could refuse.
 *
 * Every special character below is written as an escape so a reviewer can see
 * what it is.
 */

import { describe, it, expect } from "vitest";
import { isReservedDescription } from "../routes/onboard-evidence.js";

const ZWSP = "​";

/**
 * Lisu letters (U+A4D0..U+A4FF) are drawn as the Latin capital they are
 * shaped like, and the Lisu tone letter U+A4FD is drawn as a colon.
 */
const LISU: Record<string, string> = {
  P: "ꓑ",
  R: "ꓣ",
  O: "ꓳ",
  F: "ꓝ",
  S: "ꓢ",
  U: "ꓴ",
  B: "ꓐ",
  M: "ꓟ",
  I: "ꓲ",
  T: "ꓔ",
  E: "ꓰ",
  D: "ꓓ",
  V: "ꓦ",
  ":": "ꓽ",
};
const inLisu = (text: string): string => Array.from(text, (ch) => LISU[ch] ?? ch).join("");

describe("isReservedDescription: the two inputs astra pack 88 reproduced", () => {
  it("refuses a Lisu PA (U+A4D1) standing in for the P", () => {
    expect(isReservedDescription("ꓑROOF SUBMITTED: {}")).toBe(true);
  });

  it("refuses a variation selector (U+E0100) split at the 1,024-unit boundary", () => {
    expect(isReservedDescription(ZWSP.repeat(1023) + "\u{E0100}PROOF SUBMITTED: {}")).toBe(true);
  });
});

describe("isReservedDescription: the scan never cuts a surrogate pair", () => {
  it("refuses a visible supplementary letter cut at the boundary (a mathematical sans-serif bold P)", () => {
    // U+1D5E3 folds to "P" under NFKD; its two UTF-16 units straddle unit 1,024.
    expect(isReservedDescription(ZWSP.repeat(1023) + "\u{1D5E3}ROOF SUBMITTED: {}")).toBe(true);
  });

  it.each([
    ["a stranded high surrogate first", "\uD800PROOF SUBMITTED: {}"],
    ["a stranded low surrogate inside", "PROOF\uDC00 SUBMITTED: {}"],
    ["a low surrogate before a high one, then the prefix", "\uDD00\uDB40PROOF SUBMITTED: {}"],
  ])("drops lone surrogates before matching: %s", (_label, description) => {
    expect(isReservedDescription(description)).toBe(true);
  });
});

describe("isReservedDescription: Lisu look-alikes (U+A4D0..U+A4FF)", () => {
  it("refuses PROOF SUBMITTED: written entirely in Lisu letters", () => {
    const description = inLisu("PROOF SUBMITTED: {}");
    // Not one ASCII letter is left, so only the look-alike table can catch it.
    expect(description.match(/[A-Za-z]/g)).toBeNull();
    expect(isReservedDescription(description)).toBe(true);
  });

  it("refuses PROVED: written entirely in Lisu letters", () => {
    const description = inLisu("PROVED: {}");
    expect(description.match(/[A-Za-z]/g)).toBeNull();
    expect(isReservedDescription(description)).toBe(true);
  });

  it("refuses the Lisu tone letter U+A4FD, which is drawn as a colon", () => {
    expect(isReservedDescription("PROOF SUBMITTEDꓽ {}")).toBe(true);
    expect(isReservedDescription("PROVEDꓽ {}")).toBe(true);
  });
});

describe("isReservedDescription: a non-Latin letter the table does not know is a wildcard", () => {
  it.each([
    ["a Latin O-stroke for the E of SUBMITTED", "PROOF SUBMITTØD: {}"],
    ["a Cyrillic ZHE for an O", "PRЖOF SUBMITTED: {}"],
    ["a Greek zeta for the P", "ζROOF SUBMITTED: {}"],
    ["an Armenian KEH for the S", "PROOF քUBMITTED: {}"],
    ["a CJK ideograph for the O of PROVED", "PR日VED: {}"],
    ["a Hebrew final mem for the P of PROVED", "םROVED: {}"],
    ["a Latin eth for the D of PROVED", "PROVEð: {}"],
  ])("refuses %s", (_label, description) => {
    expect(isReservedDescription(description)).toBe(true);
  });

  it("applies the same rule to a scan that is cut short (the rest is not seen)", () => {
    expect(isReservedDescription(ZWSP.repeat(1023) + "ЖROOF SUBMITTED: {}")).toBe(true);
  });
});

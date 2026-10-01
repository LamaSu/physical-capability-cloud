/**
 * WP-A round 8 (astra, authz r2, weakest link): identity comparison uses Unicode
 * FULL case folding, not lower -> upper -> lower. The round trip turned dotless
 * "ı" into "i", so "alıce@example.com" and "alice@example.com" were one identity.
 *
 * fixtures/casefold-golden.json (from scripts/gen-casefold-table.py) holds every
 * assigned code point whose fold changes it, with Python's str.casefold()
 * result. An exhaustive check of all 1,112,064 code points was also run when the
 * table was generated: 0 mismatches on code points assigned in Unicode 15.0.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { caseFold, normalizeIdentity, sameIdentity } from "../auth/identity-normalize.js";

const golden = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "casefold-golden.json"), "utf8"),
) as { unicode: string; folds: Record<string, number[]> };

describe("caseFold is Unicode full case folding", () => {
  it(`matches Python's str.casefold() for all ${Object.keys(golden.folds).length} golden code points`, () => {
    const wrong: string[] = [];
    for (const [hex, fold] of Object.entries(golden.folds)) {
      const c = String.fromCodePoint(parseInt(hex, 16));
      if (caseFold(c) !== String.fromCodePoint(...fold)) wrong.push(hex);
    }
    expect(wrong).toEqual([]);
  });

  it("[neg] dotless i has no fold: it stays itself, never becomes ASCII i", () => {
    expect(caseFold("ı")).toBe("ı");
    expect(normalizeIdentity("alıce@example.com")).not.toBe(normalizeIdentity("alice@example.com"));
    expect(sameIdentity("alice@example.com", "alıce@example.com")).toBe(false);
    expect(sameIdentity("ALICE@EXAMPLE.COM", "alıce@example.com")).toBe(false);
  });

  it("leaves characters that do not fold alone", () => {
    for (const c of ["a", "z", "0", "9", "@", ".", "ı", "漢", "😀", "ꙮ"]) expect(caseFold(c)).toBe(c);
  });

  it.each<[string, string]>([
    ["straße@x.test", "STRASSE@x.test"],
    ["ẞ@x.test", "ss@x.test"],
    ["οδος@x.test", "ΟΔΟΣ@x.test"], // final sigma folds like sigma
    ["ſecret@x.test", "secret@x.test"], // long s
    ["ꭰ@x.test", "Ꭰ@x.test"], // Cherokee small and capital
    ["ｖｉｃｔｉｍ＠ｘ．ｔｅｓｔ", "victim@x.test"], // NFKC compatibility forms
    ["é@x.test", "é@x.test"], // composed and decomposed
    ["  Alice@Example.COM ", "alice@example.com"],
  ])("%s and %s are one identity", (a, b) => {
    expect(sameIdentity(a, b)).toBe(true);
  });

  it("[neg] an empty or blank id matches nobody", () => {
    expect(sameIdentity("", "")).toBe(false);
    expect(sameIdentity("   ", "   ")).toBe(false);
    expect(sameIdentity(undefined, undefined)).toBe(false);
  });
});

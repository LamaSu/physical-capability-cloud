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

const ZWSP = "\u{200B}";

/**
 * Lisu letters (U+A4D0..U+A4FF) are drawn as the Latin capital they are
 * shaped like, and the Lisu tone letter U+A4FD is drawn as a colon.
 */
const LISU: Record<string, string> = {
  P: "\u{A4D1}",
  R: "\u{A4E3}",
  O: "\u{A4F3}",
  F: "\u{A4DD}",
  S: "\u{A4E2}",
  U: "\u{A4F4}",
  B: "\u{A4D0}",
  M: "\u{A4DF}",
  I: "\u{A4F2}",
  T: "\u{A4D4}",
  E: "\u{A4F0}",
  D: "\u{A4D3}",
  V: "\u{A4E6}",
  ":": "\u{A4FD}",
};
const inLisu = (text: string): string => Array.from(text, (ch) => LISU[ch] ?? ch).join("");

describe("isReservedDescription: the two inputs astra pack 88 reproduced", () => {
  it("refuses a Lisu PA (U+A4D1) standing in for the P", () => {
    expect(isReservedDescription("\u{A4D1}ROOF SUBMITTED: {}")).toBe(true);
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
    expect(isReservedDescription("PROOF SUBMITTED\u{A4FD} {}")).toBe(true);
    expect(isReservedDescription("PROVED\u{A4FD} {}")).toBe(true);
  });
});

describe("isReservedDescription: a non-Latin letter the table does not know is a wildcard", () => {
  it.each([
    ["a Latin O-stroke for the E of SUBMITTED", "PROOF SUBMITT\u{D8}D: {}"],
    ["a Cyrillic ZHE for an O", "PR\u{416}OF SUBMITTED: {}"],
    ["a Greek zeta for the P", "\u{3B6}ROOF SUBMITTED: {}"],
    ["an Armenian KEH for the S", "PROOF \u{584}UBMITTED: {}"],
    ["a CJK ideograph for the O of PROVED", "PR日VED: {}"],
    ["a Hebrew final mem for the P of PROVED", "\u{5DD}ROVED: {}"],
    ["a Latin eth for the D of PROVED", "PROVE\u{F0}: {}"],
  ])("refuses %s", (_label, description) => {
    expect(isReservedDescription(description)).toBe(true);
  });

  it("applies the same rule to a scan that is cut short (the rest is not seen)", () => {
    expect(isReservedDescription(ZWSP.repeat(1023) + "\u{416}ROOF SUBMITTED: {}")).toBe(true);
  });
});

// ── What is NOT reserved: the guard must not eat honest descriptions ─────────

describe("isReservedDescription: ordinary descriptions are not reserved", () => {
  it.each([
    ["Japanese", "3Dプリンターで試作品を印刷します"],
    ["Japanese with a colon in the reserved position", "試作印刷機能: 3Dプリンター"],
    ["Russian", "Принтер для печати 3D-моделей"],
    ["Russian, 'Verified: it works'", "Проверено: принтер работает"],
    ["Russian, 'Prototype: a drone housing'", "Прототип: корпус дрона"],
    ["Greek", "Εκτυπωτής 3D για πρωτότυπα"],
    ["Greek, 'First test: printing'", "Πρώτη δοκιμή: εκτύπωση"],
    ["Latin with accents", "Café-style espresso robot, très précis"],
    ["English that mentions proof", "Proof of concept 3D printer"],
    ["English, a colon after 'proof'", "The proof: it works"],
    ["English words that end like PROVED", "Approved: by the garage owner"],
    ["English, 'reproved'", "Reproved: nothing to report"],
    ["a Danish word one letter short of PROVED", "Prøve: a Danish word"],
    ["PROOF SUBMITTED without its colon", "Proof submitted - waiting for review"],
  ])("does not reserve %s", (_label, description) => {
    expect(isReservedDescription(description)).toBe(false);
  });

  it("does not reserve a long description in another script, or one with a supplementary character at the scan boundary", () => {
    expect(isReservedDescription("日本語のプリンターの説明。".repeat(300))).toBe(false);
    expect(isReservedDescription("x".repeat(1023) + "\u{1F600}" + "y".repeat(10))).toBe(false);
    expect(isReservedDescription("\u{1F600}".repeat(1500))).toBe(false);
  });

  it("does not reserve a short description that is only the start of a reserved word, when nothing was cut off", () => {
    for (const description of ["Proof", "PROVED", "pro", "proofsubmitted", "Proof submitted", "p", ""]) {
      expect({ description, reserved: isReservedDescription(description) }).toEqual({ description, reserved: false });
    }
  });

  it("refuses a scan that is cut short only while it could still become a reserved prefix", () => {
    // 1,023 invisible characters and then an "x": the visible text starts with x, not with PROOF.
    expect(isReservedDescription(ZWSP.repeat(1023) + "xROOF SUBMITTED: {}")).toBe(false);
    // The same, but the visible start is still consistent with the reserved prefix.
    expect(isReservedDescription(ZWSP.repeat(1023) + "pROOF SUBMITTED: {}")).toBe(true);
    expect(isReservedDescription(ZWSP.repeat(1020) + "PROOF SUBMITTED: {}")).toBe(true);
  });

  it("answers false for what is not text, and never throws on unpaired surrogates", () => {
    for (const value of [null, undefined, 0, 12, {}, ["PROOF SUBMITTED:"], true]) {
      expect(isReservedDescription(value)).toBe(false);
    }
    expect(() => isReservedDescription("\uD800".repeat(5000))).not.toThrow();
    expect(() => isReservedDescription("a\uDC00".repeat(2000) + "\uD800")).not.toThrow();
  });
});

// ── The wildcard rule: letters only, and at least half the letters literal ───

/** CJK ideograph U+65E5: a letter that no look-alike table folds to ASCII. */
const WILD = "\u{65E5}";

/**
 * `reserved` (letters and the colon, no spaces) with the characters at the
 * `wild` indexes replaced by WILD and those at the `lisu` indexes replaced by
 * their Lisu twin.
 */
function spoof(reserved: string, wild: readonly number[], lisu: readonly number[] = []): string {
  return Array.from(reserved, (ch, i) => (wild.includes(i) ? WILD : lisu.includes(i) ? LISU[ch.toUpperCase()]! : ch)).join("");
}

describe("isReservedDescription: the wildcard rule", () => {
  const LONG = "proofsubmitted:"; // 14 letters, the colon at index 14
  const SHORT = "proved:"; // 6 letters, the colon at index 6

  it("matches when exactly half of the letters are really there, and not when fewer are", () => {
    expect(isReservedDescription(spoof(LONG, [1, 3, 5, 7, 9, 11, 13]) + " {}")).toBe(true); // 7 of 14
    expect(isReservedDescription(spoof(LONG, [0, 1, 3, 5, 7, 9, 11, 13]) + " {}")).toBe(false); // 6 of 14
    expect(isReservedDescription(spoof(SHORT, [1, 3, 5]) + " {}")).toBe(true); // 3 of 6
    expect(isReservedDescription(spoof(SHORT, [0, 1, 3, 5]) + " {}")).toBe(false); // 2 of 6
  });

  it("never matches text with no reserved letter in it, at the reserved lengths", () => {
    expect(isReservedDescription(WILD.repeat(14) + ": {}")).toBe(false);
    expect(isReservedDescription(WILD.repeat(6) + ": {}")).toBe(false);
    expect(isReservedDescription("\u{416}".repeat(14) + ": {}")).toBe(false); // Cyrillic ZHE
    expect(isReservedDescription("\u{3B6}".repeat(6) + ": {}")).toBe(false); // Greek zeta
  });

  it("is for letters only: a symbol, an emoji or a punctuation mark in a letter position is not a wildcard", () => {
    expect(isReservedDescription("proofsubmitt\u{20AC}d: {}")).toBe(false); // euro sign
    expect(isReservedDescription("proofsubmitt\u{1F600}d: {}")).toBe(false);
    expect(isReservedDescription("proofsubmitt-d: {}")).toBe(false);
  });

  it("does not make the colon a wildcard", () => {
    expect(isReservedDescription(spoof(LONG, [14]) + " {}")).toBe(false);
    expect(isReservedDescription("proofsubmitted\u{2014} {}")).toBe(false); // em dash
    expect(isReservedDescription("proved\u{2026} {}")).toBe(false); // ellipsis
  });

  it("holds for a seeded sample of descriptions that are entirely in other scripts", () => {
    // CJK, kana, Hangul, Thai and Devanagari letters: none has a look-alike in
    // the table, so no reserved letter can be present and none of these may be
    // reserved. Runs of exactly the reserved lengths followed by a colon are
    // the shapes that a wildcard-only match would need.
    const letters = Array.from("日本語試作印刷機能のプリンタ한국어프린터ไทยพิมพ์हिन्दीप्रिंटर").filter((ch) => /^\p{L}$/u.test(ch));
    const punctuation = [" {}", "-", " (", ") "];
    let state = 1;
    const rand = (n: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    for (let i = 0; i < 2000; i++) {
      const run = [6, 14, 1 + rand(30)][i % 3]!;
      let text = "";
      for (let k = 0; k < run; k++) text += letters[rand(letters.length)]!;
      text += ":" + punctuation[rand(punctuation.length)]!;
      expect(isReservedDescription(text), text).toBe(false);
    }
  });
});

// ── The Lisu table, letter by letter ─────────────────────────────────────────

describe("isReservedDescription: each Lisu twin counts as the letter it is drawn as", () => {
  // With exactly half of the letters "there", the match depends on every one of
  // them: if a twin were missing from the table it would be a wildcard instead
  // of a literal letter, the count would fall below half, and the text would be
  // let through.
  const LONG = "proofsubmitted:";
  const SHORT = "proved:";
  const cases: Array<[string, number[], number[]]> = [
    [LONG, [1, 3, 5, 7, 9, 11, 13], [0, 2, 4, 6, 8, 10, 12]], // p o f u m t e are literal here
    [LONG, [0, 2, 4, 6, 8, 10, 12], [1, 3, 5, 7, 9, 11, 13]], // r o s b i t d are literal here
    [SHORT, [1, 3, 5], [0, 2, 4]], // p o e
    [SHORT, [0, 2, 4], [1, 3, 5]], // r v d
  ];

  it.each(cases.flatMap(([reserved, wild, literal]) => literal.map((index) => [reserved, wild, index] as const)))(
    "%s with wildcards at %j and a Lisu twin at index %i",
    (reserved, wild, index) => {
      const twin = LISU[reserved[index]!.toUpperCase()]!;
      expect(twin).toMatch(/^[\u{A4D0}-\u{A4FF}]$/u);
      expect(isReservedDescription(spoof(reserved, wild, [index]) + " {}")).toBe(true);
    },
  );

  it("maps the Lisu tone letter U+A4FD to the colon", () => {
    expect(isReservedDescription("proofsubmitted\u{A4FD} {}")).toBe(true);
    expect(isReservedDescription("proved\u{A4FD} {}")).toBe(true);
    // Another Lisu tone letter is drawn as a semicolon, which is not the colon.
    expect(isReservedDescription("proofsubmitted\u{A4FC} {}")).toBe(false);
  });
});

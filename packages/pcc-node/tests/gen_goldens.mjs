/**
 * Golden generator for Python<->TS hash parity (evidence #52 log chain).
 *
 * The `canonicalize` function below is copied VERBATIM (logic-for-logic) from
 * `packages/spec/src/util/canonical.ts` -- only the TypeScript type annotations
 * (erased at runtime) are dropped so it runs as plain ESM. It MUST stay a
 * byte-for-byte behavioral copy; if canonical.ts changes, re-copy it here and
 * regenerate goldens.json.
 *
 * `computeEntryHash` mirrors `computeLogEntryHash` in
 * `packages/spec/src/evidence/verifiers/log-chain.ts:76`:
 *   sha256(canonicalize({ capturedAt, rawContent, source }))  -> "sha256:"+hex.
 *
 * Emits tests/goldens.json with two sections:
 *   - entry_hash: [{name, rawContent, source, capturedAt, expected}]  (money seam)
 *   - canonical:  [{name, value, expected}]  (raw canonical STRING, structural)
 *
 * Tricky fixture strings (quote, backslash, control chars) are built from
 * explicit code points via String.fromCharCode so there are NO raw control
 * chars or ambiguous backslash escapes in this source file.
 *
 * Run:  node packages/pcc-node/tests/gen_goldens.mjs
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- VERBATIM copy of canonicalize() from spec/src/util/canonical.ts ---------
// (TypeScript types stripped; every runtime operation preserved exactly.)
function canonicalize(value) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const pairs = keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]));
    return "{" + pairs.join(",") + "}";
  }
  return String(value);
}
// -----------------------------------------------------------------------------

// sha256() from canonical.ts: SHA-256 over UTF-8 bytes, lowercase hex, prefixed.
function sha256(input) {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex");
}

// computeLogEntryHash() from log-chain.ts:76.
function computeEntryHash(rawContent, source, capturedAt) {
  return sha256(canonicalize({ capturedAt, rawContent, source }));
}

// Explicit code points -- avoids any raw control char / backslash ambiguity.
const CC = String.fromCharCode;
const BS = CC(92); // backslash  \
const DQ = CC(34); // double quote  "

// A string exercising every JSON escape shortcut (\b \t \n \f \r) AND the
// non-shortcut control chars that must go to \u00xx: bell U+0007,
// vertical-tab U+000B, unit-separator U+001F.
const CONTROL_STR =
  "tab" + CC(9) + "nl" + CC(10) + "cr" + CC(13) +
  "bell" + CC(7) + "vt" + CC(11) + "ff" + CC(12) +
  "bs" + CC(8) + "us" + CC(31) + "end";

// --- Fixture inputs ----------------------------------------------------------
// Coverage required by the wire contract: plain ASCII; embedded " and \;
// \n + tab + control chars; a non-ASCII string; an emoji. The first vector is
// ALSO the oracle's existing golden (log-chain-parity.test.ts): rawContent
// "hello", source "cups://job-1", capturedAt "2026-07-09T00:00:00.000Z" ->
// sha256:c31408369756b766d5ee02b1403cbee4ab64ed39f9c3de0b7bee4605fdf3d9cd.
const ENTRY_HASH_FIXTURES = [
  {
    name: "ascii_oracle_shared_vector",
    rawContent: "hello",
    source: "cups://job-1",
    capturedAt: "2026-07-09T00:00:00.000Z",
  },
  {
    name: "quote_and_backslash",
    rawContent: "she said " + DQ + "hi" + DQ + " then a back" + BS + "slash " + BS + " done",
    source: "cups://job-2",
    capturedAt: "2026-07-09T00:01:00.000Z",
  },
  {
    name: "newline_tab_control",
    rawContent: CONTROL_STR,
    source: "serial://tty0",
    capturedAt: "2026-07-09T00:02:00.000Z",
  },
  {
    name: "non_ascii",
    rawContent: "café ☕ 日本語 — naïve",
    source: "mdns://kettle.local",
    capturedAt: "2026-07-09T00:03:00.000Z",
  },
  {
    name: "emoji_zwj",
    rawContent: "done ✅ launch 🚀 family 👨‍👩‍👧 flag 🇺🇸",
    source: "octoprint://printer-1",
    capturedAt: "2026-07-09T00:04:00.000Z",
  },
  {
    // N60 K1: a raw device line with a lone surrogate still hashes the same.
    name: "lone_surrogate_raw",
    rawContent: "log " + CC(0xd800) + " tail " + CC(0xdfff),
    source: "serial://tty1",
    capturedAt: "2026-07-09T00:05:00.000Z",
  },
];

// Structural fixtures: compare the raw canonical STRING (keys sorted, escaping,
// numbers, booleans, null, arrays, nested) -- proves the mirror beyond hashes.
const CANONICAL_FIXTURES = [
  { name: "key_sort", value: { b: 2, a: 1, c: 3 } },
  { name: "nested", value: { z: { y: 1, x: 2 }, a: [3, 2, 1] } },
  { name: "mixed_array", value: [1, true, false, null, "s"] },
  { name: "null_value_included", value: { k: null, a: 1 } },
  { name: "bool_num", value: { t: true, f: false, n: 42, neg: -7, zero: 0 } },
  { name: "floats", value: { pi: 3.14, half: 1.5 } },
  { name: "string_escapes", value: { q: "a" + DQ + "b", bs: "a" + BS + "b", ws: CONTROL_STR } },
  { name: "unicode_key_val", value: { "café": "☕", emoji: "🚀", ascii: "z" } },
  { name: "slash_not_escaped", value: { url: "cups://job/1?x=2" } },
  // Number::toString edges (sensors #3458): JS writes decimal for exponents
  // -7..20 and exponent form otherwise, with no zero-padded exponent.
  { name: "small_floats", value: { a: 0.00005, b: 1.5e-5, c: 1e-7, d: 1e-6, e: 0.0001 } },
  { name: "large_numbers", value: { a: 1e20, b: 1e21, c: 123456789012345680000, d: 1.7976931348623157e308 } },
  { name: "extreme_doubles", value: [5e-324, -2.5e-8, 9007199254740992, -1e21] },
  // N60 K1: .sort() compares UTF-16 code units, so a key above U+FFFF (lead
  // unit D800-DBFF) sorts BEFORE one in U+E000-U+FFFF; code-point order puts
  // it after.  A lone surrogate key sorts by its one unit.
  { name: "key_sort_utf16", value: { "\u{FFFF}": 1, "\u{10000}": 2, "\u{E000}": 3, a: 4, "\u{1F600}": 5, "\u{D800}": 6, "\u{FB01}": 7 } },
  { name: "key_sort_utf16_nested", value: { outer: { "\u{1D11E}": [1, { "\u{FFFD}": "x", "\u{20000}": "y" }], "\u{F8FF}": 0 } } },
  // Well-formed JSON.stringify (ES2019): a lone surrogate is written as a
  // lowercase \udxxx escape; a valid pair is the character it encodes.
  { name: "lone_surrogates", value: { high: "a\u{D800}b", low: "\u{DC00}", pair: "\u{D83D}\u{DE00}", reversed: "\u{DE00}\u{D83D}", end: "z\u{DBFF}" } },
];

// A deterministic number sweep: String(x) for many doubles, so the Python
// mirror is checked against JS itself, not against a reading of the spec.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NUMBER_SWEEP = [
  0, 1, -1, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, 92.86, 100, 0.5, 5e-324, Number.MAX_VALUE,
  Number.MIN_VALUE, Number.EPSILON, 2 ** 53, 2 ** 53 + 2, -(2 ** 53), 2 ** 31, 2 ** 32, 2 ** 64,
];
for (let e = -12; e <= 25; e++) {
  NUMBER_SWEEP.push(10 ** e, 1.5 * 10 ** e, -7.25 * 10 ** e, 123456789 * 10 ** e);
}
const rand = mulberry32(3458);
for (let i = 0; i < 200; i++) {
  const exponent = Math.floor(rand() * 64) - 32;
  const sign = rand() < 0.5 ? -1 : 1;
  NUMBER_SWEEP.push(sign * rand() * 10 ** exponent);
}

const goldens = {
  _comment:
    "Generated by tests/gen_goldens.mjs from the VERBATIM canonicalize() of " +
    "packages/spec/src/util/canonical.ts. entry_hash = computeLogEntryHash " +
    "parity (money seam); canonical = raw canonicalize() string parity. " +
    "Regenerate if canonical.ts changes.",
  entry_hash: ENTRY_HASH_FIXTURES.map((f) => ({
    ...f,
    expected: computeEntryHash(f.rawContent, f.source, f.capturedAt),
  })),
  canonical: CANONICAL_FIXTURES.map((f) => ({
    name: f.name,
    value: f.value,
    expected: canonicalize(f.value),
  })),
  numbers: NUMBER_SWEEP.map((value) => ({ value, expected: canonicalize(value) })),
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), "goldens.json");
writeFileSync(outPath, JSON.stringify(goldens, null, 2) + "\n", "utf8");
console.log("wrote " + outPath);
console.log("oracle shared vector -> " + goldens.entry_hash[0].expected);

/**
 * The time path of delegation-rules.ts was rewritten to run inside the hardened LO-EV-9
 * binding leg: no RegExp, no Date and no global looked up at call time (code units and
 * civil-date arithmetic instead). This pins that it answers EXACTLY what the replaced
 * RegExp-and-Date.UTC version (#438 @3706780a) answered: the old functions are kept here
 * verbatim as the reference, and both run over a seeded corpus of valid, boundary and
 * malformed inputs.
 */
import { describe, expect, it } from "vitest";
import { parseEvidenceTimeBound, parseEvidenceTimestamp } from "../evidence/delegation-rules.js";

// ── The reference: #438 @3706780a, verbatim ──────────────────────────────────
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
function legacyParseEvidenceTimestamp(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const m = RFC3339.exec(ts);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offsetSeconds = 0;
  if (m[8] !== "Z") {
    const offsetHours = Number(m[10]);
    const offsetMinutes = Number(m[11]);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offsetSeconds = (offsetHours * 60 + offsetMinutes) * 60 * (m[9] === "-" ? -1 : 1);
  }
  return ms / 1000 - offsetSeconds;
}
const UNIX_SECONDS = /^(0|[1-9][0-9]*)$/;
function legacyParseEvidenceTimeBound(value: unknown): number | null {
  if (typeof value !== "string" || !UNIX_SECONDS.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// ── A seeded corpus ──────────────────────────────────────────────────────────
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function timestampCorpus(count: number): string[] {
  const r = prng(0x438d1e);
  const years = [0, 1, 99, 100, 1969, 1970, 1971, 1999, 2000, 2001, 2024, 2025, 2026, 2100, 2400, 2401, 9998, 9999];
  const out: string[] = [
    "1970-01-01T00:00:00Z",
    "1969-12-31T23:59:59Z",
    "1970-01-01T00:00:00+00:01",
    "1970-01-01T00:00:00-23:59",
    "2024-02-29T12:00:00Z",
    "2023-02-29T12:00:00Z",
    "2100-02-29T00:00:00Z",
    "2400-02-29T00:00:00Z",
    "2026-09-24T10:00:00.000Z",
    "2026-09-24T10:00:00.123456789Z",
    "2026-09-24T10:00:00.1234567890Z",
    "2026-09-24T10:00:00.Z",
    "2026-09-24T10:00:60Z",
    "2026-09-24T24:00:00Z",
    "2026-09-24t10:00:00Z",
    "2026-09-24T10:00:00z",
    "2026-09-24 10:00:00Z",
    "2026-09-24T10:00:00",
    "2026-09-24T10:00:00+24:00",
    "2026-09-24T10:00:00+05:60",
    "2026-09-24T10:00:00+0530",
    "2026-09-24T10:00:00+05:30:00",
    "2026-09-24T10:00:00Z\n",
    " 2026-09-24T10:00:00Z",
    "+2026-09-24T10:00:00Z",
    "2026-9-24T10:00:00Z",
    "2026-09-24T10:00:00\u0000Z",
    "２０２６-09-24T10:00:00Z",
    "",
    "Z",
  ];
  for (let i = 0; i < count; i++) {
    const y = r() < 0.3 ? pick(r, years) : 1960 + Math.floor(r() * 200);
    const mo = Math.floor(r() * 14);
    const d = Math.floor(r() * 33);
    const h = Math.floor(r() * 26);
    const mi = Math.floor(r() * 62);
    const s = Math.floor(r() * 62);
    const fracLen = r() < 0.5 ? 0 : Math.floor(r() * 12);
    const frac = fracLen === 0 ? (r() < 0.05 ? "." : "") : "." + Array.from({ length: fracLen }, () => Math.floor(r() * 10)).join("");
    const offKind = r();
    const off =
      offKind < 0.4
        ? "Z"
        : offKind < 0.45
          ? "z"
          : offKind < 0.5
            ? ""
            : `${r() < 0.5 ? "+" : "-"}${pad(Math.floor(r() * 26), 2)}:${pad(Math.floor(r() * 62), 2)}`;
    let ts = `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}${frac}${off}`;
    // Sometimes break one character, drop one, or add one.
    const mutate = r();
    if (mutate < 0.1 && ts.length > 0) {
      const at = Math.floor(r() * ts.length);
      ts = ts.slice(0, at) + pick(r, ["0", "9", "-", ":", "T", "t", "Z", ".", " ", "+", "a"]) + ts.slice(at + 1);
    } else if (mutate < 0.15 && ts.length > 0) {
      const at = Math.floor(r() * ts.length);
      ts = ts.slice(0, at) + ts.slice(at + 1);
    } else if (mutate < 0.2) {
      const at = Math.floor(r() * (ts.length + 1));
      ts = ts.slice(0, at) + pick(r, ["0", "5", "Z", ":", "-"]) + ts.slice(at);
    }
    out.push(ts);
  }
  return out;
}

function boundCorpus(count: number): unknown[] {
  const r = prng(0xb0d5);
  const out: unknown[] = [
    "0", "00", "01", "1", "10", "123", "9007199254740991", "9007199254740992", "9007199254740993",
    "99999999999999999999", "", "-1", "+1", "1.0", " 1", "1 ", "１", "1e3", "0x10",
    0, 1, null, undefined, {}, [], true,
  ];
  for (let i = 0; i < count; i++) {
    const len = Math.floor(r() * 22);
    let s = "";
    for (let k = 0; k < len; k++) s += r() < 0.92 ? String(Math.floor(r() * 10)) : pick(r, ["-", "+", ".", " ", "a", "0"]);
    out.push(s);
  }
  return out;
}

describe("delegation-rules time path: the rewrite answers exactly what the RegExp-and-Date version answered", () => {
  it("parseEvidenceTimestamp over 60,000 timestamps (boundaries, calendars, offsets, fractions, mutations)", () => {
    const corpus = timestampCorpus(60_000);
    let accepted = 0;
    const diffs: string[] = [];
    for (const ts of corpus) {
      const want = legacyParseEvidenceTimestamp(ts);
      const got = parseEvidenceTimestamp(ts);
      if (want !== null) accepted++;
      if (got !== want && diffs.length < 10) diffs.push(`${JSON.stringify(ts)}: legacy ${want}, new ${got}`);
    }
    expect(diffs).toEqual([]);
    // The corpus exercises both answers, not just refusals.
    expect(accepted).toBeGreaterThan(5_000);
    expect(corpus.length - accepted).toBeGreaterThan(5_000);
  });

  it("parseEvidenceTimestamp refuses non-strings exactly as before", () => {
    for (const v of [undefined, null, 0, 1700000000, {}, [], true]) {
      expect(parseEvidenceTimestamp(v)).toBe(legacyParseEvidenceTimestamp(v));
    }
  });

  it("parseEvidenceTimeBound over 20,000 strings and the edge values", () => {
    const diffs: string[] = [];
    for (const v of boundCorpus(20_000)) {
      const want = legacyParseEvidenceTimeBound(v);
      const got = parseEvidenceTimeBound(v);
      if (got !== want && diffs.length < 10) diffs.push(`${JSON.stringify(v)}: legacy ${want}, new ${got}`);
    }
    expect(diffs).toEqual([]);
  });
});

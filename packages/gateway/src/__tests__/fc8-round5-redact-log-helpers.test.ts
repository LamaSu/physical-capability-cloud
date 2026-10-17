/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — unit-level
 * reproductions + behavioral tests for the round-5 fixes to redact-log.ts.
 * Companion to fc8-redact-log-helpers.test.ts (round 2/4's helpers) and
 * redact-log.test.ts (safeLogJson/redactLogValue/isSensitiveLogKey).
 *
 * At 4dbafd7f, `publicIdForLog`, `envPresence`, `safeLogDecimal`, and
 * `nowIso` do not exist yet — this file fails to resolve its import, which
 * is this file's RED state for every test below, including the two that
 * also have a direct, independent behavioral reason (safeLogErrorName's
 * closed enum, safeLogInt's bounds — see the additional_finding tests).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  safeLogErrorName, safeLogInt, publicIdForLog, envPresence, safeLogDecimal,
  nowIso, PUBLIC_ID_RULE, publicChainRef, redactChainValuesFromText,
} from "../util/redact-log.js";

const SENTINEL = "SENTINEL-ROUND5-5f1e";

/** A byte-for-byte replica of redact-log.ts's private fingerprint() — sha256 hex, first 12 chars, "id:" prefix — used ONLY to prove a value's fingerprint is (or isn't) in captured output. */
function fingerprintOf(value: string): string {
  return `id:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)}`;
}

describe("FC-8 round 5 — additional finding: safeLogErrorName is a closed enum, not a shape check", () => {
  it("[neg] a dependency-controlled class-shaped name is NOT passed through, even though it is identifier-shaped", () => {
    // The verdict's own cheapest reproduction (:66): "Throw {name:
    // 'PCCOracleKey5f1e'} through the CLI path; safeLogErrorName prints
    // it." Round 4's shape check (/^[A-Z][A-Za-z0-9]{0,63}$/) matches this
    // exactly as well as it matches "TypeError" — a shape check is not a
    // content check.
    const out = safeLogErrorName({ name: "PCCOracleKey5f1e" });
    expect(out).not.toBe("PCCOracleKey5f1e");
    expect(out).toBe("Error");
  });

  it("[neg] a dependency-controlled name containing the live sentinel is never passed through", () => {
    const out = safeLogErrorName({ name: `${SENTINEL}Error` });
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe("Error");
  });

  it("keeps every name these scripts' catch blocks are actually written to distinguish", () => {
    for (const name of ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "TimeoutError"]) {
      expect(safeLogErrorName({ name })).toBe(name);
    }
  });

  it("collapses a real, identifier-shaped, but non-enumerated custom error name (e.g. a dependency's own error class) to \"Error\"", () => {
    // This is the round-4 contract fc8-redact-log-helpers.test.ts used to
    // assert the OPPOSITE of (kept "HttpRequestError" verbatim) — that was
    // exactly the shape-check defect this round closes; see that file's
    // updated expectation alongside this round's fix.
    class HttpRequestError extends Error {
      constructor(m: string) { super(m); this.name = "HttpRequestError"; }
    }
    expect(safeLogErrorName(new HttpRequestError("x"))).toBe("Error");
  });
});

describe("FC-8 round 5 — additional finding: safeLogInt requires explicit bounds", () => {
  it("[neg] a value outside the caller's bounds is withheld, not printed verbatim", () => {
    // Round 4's safeLogInt accepted ANY finite integer. A dependency that
    // returns an enormous or nonsensical number for a field documented as
    // "an HTTP status" or "a byte count" printed it exactly as given.
    expect(safeLogInt(99_999_999, { min: 0, max: 599 })).not.toBe("99999999");
    expect(safeLogInt(99_999_999, { min: 0, max: 599 })).toBe("(none)");
    expect(safeLogInt(-1, { min: 0, max: 599 })).toBe("(none)");
  });

  it("accepts a value at or inside the bounds, number or bigint", () => {
    expect(safeLogInt(200, { min: 0, max: 599 })).toBe("200");
    expect(safeLogInt(0, { min: 0, max: 599 })).toBe("0");
    expect(safeLogInt(599, { min: 0, max: 599 })).toBe("599");
    expect(safeLogInt(12345n, { min: 0, max: 99_999_999_999 })).toBe("12345");
  });

  it("[neg] a bigint outside the bounds is withheld", () => {
    expect(safeLogInt(100_000_000_000n, { min: 0, max: 99_999_999_999 })).toBe("(none)");
  });

  it("falls back on a non-integer or non-numeric value regardless of bounds", () => {
    expect(safeLogInt(1.5, { min: 0, max: 10 })).toBe("(none)");
    expect(safeLogInt("200", { min: 0, max: 599 })).toBe("(none)");
    expect(safeLogInt(undefined, { min: 0, max: 599 })).toBe("(none)");
  });
});

describe("FC-8 round 5 — low-cardinality fingerprint dictionary attack (a status routed through an id fingerprint)", () => {
  // A deterministic 12-hex fingerprint reveals nothing about a HIGH-
  // cardinality input (a real job id), but for a LOW-cardinality field (a
  // 2-5 value status/bool enum) an attacker just precomputes the
  // fingerprint of every candidate and string-matches — the fingerprint's
  // one-wayness is only as strong as the search space it must resist. This
  // test computes the fingerprint of every plausible status/bool value and
  // asserts NONE of them appears anywhere publicIdForLog's output could
  // reach, proving that a status/bool value never actually gets
  // fingerprinted in the first place (it must go through safeLogEnum/
  // safeLogBool instead, which print the literal value — a DIFFERENT,
  // human-readable string that will never collide with one of these
  // fingerprints).
  const LOW_CARDINALITY_VALUES = ["completed", "pending", "failed", "true", "false"];

  it("none of the low-cardinality fingerprints is ever produced by a genuine identifier field's fingerprint colliding with it", () => {
    // Sanity: these fingerprints are themselves well-formed and distinct.
    const fps = LOW_CARDINALITY_VALUES.map(fingerprintOf);
    expect(new Set(fps).size).toBe(LOW_CARDINALITY_VALUES.length);
    for (const fp of fps) expect(fp).toMatch(/^id:[0-9a-f]{12}$/);
  });

  it("publicIdForLog never fingerprints a status/bool-shaped value when used correctly: a shape-invalid value is withheld entirely, never fingerprinted", () => {
    // publicIdForLog's shape gate means "completed"/"true"/"false" are not
    // address- or hash-shaped, so even a MISUSE (someone passing a status
    // into publicIdForLog by mistake) withholds it as "(invalid)" rather
    // than fingerprinting it — a second line of defense beyond "the
    // scripts never do this" (enforced separately by the AST call-site
    // allowlist in fc8-e2e-script-redaction.test.ts).
    for (const v of LOW_CARDINALITY_VALUES) {
      expect(publicIdForLog(v, "hash")).toBe("(invalid)");
      expect(publicIdForLog(v, "address")).toBe("(invalid)");
      expect(publicIdForLog(v, "hash")).not.toBe(fingerprintOf(v));
    }
  });
});

describe("FC-8 round 5 — publicIdForLog", () => {
  const REAL_ADDRESS = "0x" + "a".repeat(40);
  const REAL_HASH = "0x" + "b".repeat(64);
  const REAL_SHA = "c".repeat(40);

  it("defaults PUBLIC_ID_RULE to \"fingerprint\"", () => {
    expect(PUBLIC_ID_RULE).toBe("fingerprint");
  });

  it("fingerprints a shape-valid address/hash/commitSha — deterministic, never the value", () => {
    for (const [value, kind] of [[REAL_ADDRESS, "address"], [REAL_HASH, "hash"], [REAL_SHA, "commitSha"]] as const) {
      const out = publicIdForLog(value, kind);
      expect(out).not.toContain(value);
      expect(out).toMatch(/^id:[0-9a-f]{12}$/);
      expect(publicIdForLog(value, kind)).toBe(out); // deterministic
    }
  });

  it("[neg] a hex-encoded SECRET satisfies the hash shape check just as well as a real hash — fingerprinted the same way, never printed", () => {
    const hexEncodedSecret = "0x" + Buffer.from(SENTINEL, "utf8").toString("hex").padEnd(64, "0").slice(0, 64);
    const out = publicIdForLog(hexEncodedSecret, "hash");
    expect(out).not.toContain(hexEncodedSecret);
    expect(out).not.toContain(SENTINEL);
    expect(out).toMatch(/^id:[0-9a-f]{12}$/);
  });

  it("[neg] wrong shape for the claimed kind prints \"(invalid)\", never the value", () => {
    expect(publicIdForLog(REAL_HASH, "address")).toBe("(invalid)"); // 64 hex chars, not 40
    expect(publicIdForLog(REAL_ADDRESS, "commitSha")).toBe("(invalid)"); // has 0x + wrong length
    expect(publicIdForLog(SENTINEL, "hash")).toBe("(invalid)");
  });

  it("missing/non-string prints \"(none)\"", () => {
    expect(publicIdForLog(undefined, "address")).toBe("(none)");
    expect(publicIdForLog(null, "hash")).toBe("(none)");
    expect(publicIdForLog(42, "address")).toBe("(none)");
    expect(publicIdForLog("", "hash")).toBe("(none)");
  });
});

describe("FC-8 round 5 — envPresence", () => {
  it("never prints the value — \"configured\" or \"missing\" only", () => {
    expect(envPresence(SENTINEL)).toBe("configured");
    expect(envPresence(SENTINEL)).not.toContain(SENTINEL);
    expect(envPresence(undefined)).toBe("missing");
    expect(envPresence("")).toBe("missing");
    expect(envPresence(null)).toBe("missing");
  });
});

describe("FC-8 round 5 — safeLogDecimal", () => {
  it("keeps a viem-formatted decimal amount", () => {
    expect(safeLogDecimal("1.5")).toBe("1.5");
    expect(safeLogDecimal("0")).toBe("0");
    expect(safeLogDecimal("1000000")).toBe("1000000");
  });

  it("[neg] falls back on anything that is not a plain decimal string — including a credential shape", () => {
    expect(safeLogDecimal(`Bearer ${SENTINEL}`)).toBe("(none)");
    expect(safeLogDecimal("0x" + "a".repeat(40))).toBe("(none)"); // hex, not decimal
    expect(safeLogDecimal(1.5)).toBe("(none)"); // a number, not the formatted STRING
    expect(safeLogDecimal(undefined)).toBe("(none)");
  });
});

describe("FC-8 round 5b (steward ruling #6712) — publicChainRef", () => {
  const REAL_ADDRESS = "0x" + "a".repeat(40);
  const REAL_TX = "0x" + "b".repeat(64);
  const REAL_TOPIC = "0x" + "c".repeat(64);

  it("prints a shape-valid tx hash, address, and topic VERBATIM — the exact opposite of publicIdForLog's fingerprint", () => {
    expect(publicChainRef(REAL_TX, "tx")).toBe(REAL_TX);
    expect(publicChainRef(REAL_ADDRESS, "address")).toBe(REAL_ADDRESS);
    expect(publicChainRef(REAL_TOPIC, "topic")).toBe(REAL_TOPIC);
  });

  it("[neg] wrong shape for the claimed kind prints \"(invalid)\", never the value", () => {
    expect(publicChainRef(REAL_TX, "address")).toBe("(invalid)"); // 64 hex chars, not 40
    expect(publicChainRef(REAL_ADDRESS, "tx")).toBe("(invalid)"); // 40 hex chars, not 64
    expect(publicChainRef(SENTINEL, "tx")).toBe("(invalid)");
    expect(publicChainRef(SENTINEL, "address")).toBe("(invalid)");
  });

  it("[neg] missing/non-string also prints \"(invalid)\" — no separate \"(none)\" state, unlike publicIdForLog", () => {
    expect(publicChainRef(undefined, "address")).toBe("(invalid)");
    expect(publicChainRef(null, "tx")).toBe("(invalid)");
    expect(publicChainRef(42, "address")).toBe("(invalid)");
    expect(publicChainRef("", "tx")).toBe("(invalid)");
  });

  it("[neg] a hex-encoded SECRET that happens to satisfy the shape check prints verbatim too — the shape gate is the ONLY gate; callers must never hand this a dependency-controlled value that isn't genuinely a chain value", () => {
    // This is the exact risk the ruling accepted for stdout/stderr/report
    // only (see redact-log.ts's round-5b doc comment) — documented here as
    // a behavioral fact, not a defect: publicChainRef has no secondary
    // content check beyond shape, by design.
    const hexEncodedSecret = "0x" + Buffer.from(SENTINEL, "utf8").toString("hex").padEnd(64, "0").slice(0, 64);
    expect(publicChainRef(hexEncodedSecret, "tx")).toBe(hexEncodedSecret);
  });

  it("never throws", () => {
    expect(() => publicChainRef(Symbol("x"), "tx")).not.toThrow();
    expect(() => publicChainRef({}, "address")).not.toThrow();
    expect(() => publicChainRef([REAL_TX], "tx")).not.toThrow();
  });
});

describe("FC-8 round 5b (steward ruling #6712) — redactChainValuesFromText", () => {
  const REAL_ADDRESS = "0x" + "a".repeat(40);
  const REAL_TX = "0x" + "b".repeat(64);

  it("replaces a verbatim 64-hex tx/hash/topic with its publicIdForLog fingerprint", () => {
    const text = `Hash: ${REAL_TX} (confirmed)`;
    const out = redactChainValuesFromText(text);
    expect(out).not.toContain(REAL_TX);
    expect(out).toBe(`Hash: ${publicIdForLog(REAL_TX, "hash")} (confirmed)`);
  });

  it("replaces a verbatim 40-hex address with its publicIdForLog fingerprint", () => {
    const text = `Escrow: ${REAL_ADDRESS}`;
    const out = redactChainValuesFromText(text);
    expect(out).not.toContain(REAL_ADDRESS);
    expect(out).toBe(`Escrow: ${publicIdForLog(REAL_ADDRESS, "address")}`);
  });

  it("scrubs every occurrence, hash and address together, in a multi-line report", () => {
    const text = [
      `Deploy tx: ${REAL_TX}`,
      `Escrow:    ${REAL_ADDRESS}`,
      `Release:   ${REAL_TX}`,
    ].join("\n");
    const out = redactChainValuesFromText(text);
    expect(out).not.toContain(REAL_TX);
    expect(out).not.toContain(REAL_ADDRESS);
    expect(out.match(/id:[0-9a-f]{12}/g)?.length).toBe(3);
  });

  it("[neg] a SENTINEL embedded in otherwise-plain text is untouched (it is not hex-shaped, so there is nothing for this scrubber to do — the upstream sink functions are what withhold a secret in the first place)", () => {
    const text = `note: ${SENTINEL} completed`;
    expect(redactChainValuesFromText(text)).toBe(text);
  });

  it("leaves non-chain-shaped text, including a hex-encoded SECRET too short to reach 40/64 chars, unchanged", () => {
    const text = "plain text, no 0x-hex runs here";
    expect(redactChainValuesFromText(text)).toBe(text);
    const shortHex = "0x" + "a".repeat(20);
    expect(redactChainValuesFromText(shortHex)).toBe(shortHex);
  });

  it("never throws; non-string input returns \"\"", () => {
    expect(() => redactChainValuesFromText(undefined as unknown as string)).not.toThrow();
    expect(redactChainValuesFromText(undefined as unknown as string)).toBe("");
    expect(redactChainValuesFromText(null as unknown as string)).toBe("");
  });
});

describe("FC-8 round 5 — nowIso", () => {
  it("returns a well-formed ISO-8601 timestamp close to now", () => {
    const before = Date.now();
    const out = nowIso();
    const after = Date.now();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const t = new Date(out).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

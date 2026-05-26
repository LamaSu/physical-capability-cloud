import { describe, it, expect } from "vitest";
import {
  sha256Hex,
  sha256OfCanonical,
  keccak256Hex,
  ZERO_HASH,
} from "../../src/shared/hash.js";
import { canonicalJSON } from "../../src/shared/canonical-json.js";

describe("sha256Hex", () => {
  it("returns 64-character lowercase hex", () => {
    const out = sha256Hex("hello");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a known-vector for the empty string", () => {
    // Standard SHA-256 empty-input vector.
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("accepts Uint8Array input and produces the same digest as the string form", () => {
    const s = "abc";
    const bytes = new TextEncoder().encode(s);
    expect(sha256Hex(bytes)).toBe(sha256Hex(s));
  });

  it("is collision-free for different inputs in the tested range", () => {
    const inputs = Array.from({ length: 32 }, (_, i) => `msg-${i}`);
    const digests = inputs.map(sha256Hex);
    expect(new Set(digests).size).toBe(digests.length);
  });
});

describe("sha256OfCanonical + canonicalJSON integration", () => {
  it("same canonical form = same hash (order-insensitive object)", () => {
    const a = sha256OfCanonical(canonicalJSON({ a: 1, b: 2 }));
    const b = sha256OfCanonical(canonicalJSON({ b: 2, a: 1 }));
    expect(a).toBe(b);
  });

  it("different values produce different hashes", () => {
    const a = sha256OfCanonical(canonicalJSON({ a: 1 }));
    const b = sha256OfCanonical(canonicalJSON({ a: 2 }));
    expect(a).not.toBe(b);
  });
});

describe("keccak256Hex", () => {
  it("returns 0x-prefixed 64-character hex", () => {
    const out = keccak256Hex("foo");
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("matches known EVM vector for empty input", () => {
    // keccak256("") — canonical empty-string digest used everywhere in EVM tests.
    expect(keccak256Hex("")).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("differs from sha256 for the same input", () => {
    expect(keccak256Hex("abc").slice(2)).not.toBe(sha256Hex("abc"));
  });

  it("Uint8Array and string inputs match", () => {
    const s = "pcc-workflow";
    const bytes = new TextEncoder().encode(s);
    expect(keccak256Hex(bytes)).toBe(keccak256Hex(s));
  });
});

describe("ZERO_HASH sentinel", () => {
  it("is 64 zero characters (prev_hash of first event in a stream)", () => {
    expect(ZERO_HASH).toBe("0".repeat(64));
    expect(ZERO_HASH.length).toBe(64);
  });
});

describe("chain-building helpers (illustrative)", () => {
  it("simulates a 2-event hash chain where each event_hash depends on prev_hash", () => {
    // Model the hashing the eventStore would do per design §6.4:
    //   event_hash = sha256(prev_hash | payload_hash | event_order | event_type | aggregate_id | sequence)
    const prev0 = ZERO_HASH;
    const payload0 = canonicalJSON({ a: 1 });
    const ph0 = sha256Hex(payload0);
    const eh0 = sha256Hex([prev0, ph0, 1, "T", "agg-1", 1].join("|"));

    const payload1 = canonicalJSON({ a: 2 });
    const ph1 = sha256Hex(payload1);
    const eh1 = sha256Hex([eh0, ph1, 2, "T", "agg-1", 2].join("|"));

    // Property: if we alter any component, event 1's hash changes.
    const ehAlt = sha256Hex([eh0, ph1, 2, "T", "agg-1", 3].join("|"));
    expect(eh1).not.toBe(ehAlt);
    // Chain hashes are distinct.
    expect(eh0).not.toBe(eh1);
  });
});

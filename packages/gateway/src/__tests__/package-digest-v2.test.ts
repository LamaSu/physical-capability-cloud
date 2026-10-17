/**
 * FinalMilestonePackageV2 producer (G2) — invariant + malleability tests.
 *
 * The oracle's ingestion binds `raw.packageHash === packageDigestV2`, and the
 * gateway receipt binds `receipt.packageDigest` to the same value. Both consume;
 * this module produces. These tests pin the properties that make the digest
 * SAFE to bind money to.
 *
 * NAMING (F3, cross-family E9): the wire VALUE is still called packageDigestV2;
 * `packageDigestV2Unchecked` is the lenient IMPLEMENTATION tested below (sample
 * vectors, goldens). The money-bound implementation is `mintablePackageDigest`,
 * which only accepts a `MintablePackage` from `assertMintablePackage` — see its
 * own describe block near the end of this file.
 *
 * The malleability block is the point. If a relayer can reorder, duplicate, or
 * RE-CASE signatures and move the digest without changing a single semantic
 * fact, then one piece of evidence has two package identities and the
 * anti-replay bind is decorative. Reordering is a NO-OP (the entries are sorted);
 * a signer in any spelling but the pinned one is REFUSED, never normalized.
 *
 * Signature shape is the ORACLE's (#1395, ingestion owner): `{signer, scheme,
 * sig}`. The signer SET is {operator, kernel} per evidence's frozen profile (D1
 * operator secp256k1-EIP712, D2 kernel ed25519-raw32). A signer is `0x` +
 * lowercase hex (an address, 40 digits, or an ed25519 key, 64 digits).
 *
 * The digest validates its body FIRST (`validatePackageBody`) and hashes only the
 * validated copy, so every fixture here is a conforming FinalMilestonePackageV2
 * body: a body that is not one is refused, never hashed.
 *
 * GOLDEN: evidence's integrated settlement vector (#1202, 974b3ff1) is pinned at
 * the end of this file, byte for byte. It is a SAMPLE vector (free-text principal
 * ids, signatures labelled "secp256k1" / "ed25519"), which is why a few rules are
 * only enforced by the mint guard; see the it.todo block.
 */

import { describe, it, expect } from "vitest";
import { canonicalize } from "@pcc/spec";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { toBytes } from "viem";
import GOLDEN from "./fixtures/g2-settlement-vector-golden.json";
import {
  packageDigestV2PreImage,
  canonicalSignatures,
  assertCanonicalizable,
  NonCanonicalizableBodyError,
  InvalidSignatureEntryError,
  SIGNATURES_KEY,
  mintablePackageDigest,
  MintablePackage,
  PackageNotMintableError,
  type PackageSignature,
} from "../settlement/package-digest-v2.js";
import { packageDigestV2Unchecked } from "../settlement/package-digest-v2-vectors.js";
import {
  PACKAGE_FORMAT,
  PACKAGE_SCHEMA_VERSION,
  PackageBodyValidationError,
  assertMintablePackage,
  computePackageBodyHash,
  type FinalMilestonePackageV2Body,
} from "../settlement/final-milestone-package-v2.js";
import { signWithPrivateKeyHex } from "../auth/ed25519.js";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const H = (n: string) => `0x${n.repeat(64).slice(0, 64)}`;

/** A conforming package body. Every hex field carries letters, so case matters. */
const BODY = {
  packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
  packageFormat: PACKAGE_FORMAT,
  compositionSchemaVersion: "1",
  unitBinding: {
    chainId: "8453",
    escrow: "0x00000000000000000000000000000000000e5c0f",
    settlementUnitId: H("a1"),
    jobIdHash: H("b2"),
    milestoneIndex: "3",
    stepId: H("c3"),
    compositionRoot: H("d4"),
    acceptedEnvelopeHash: H("e5"),
  },
  producer: { operatorPrincipalId: "op-1", kernelId: "kernel-1", devicePrincipalId: "dev-1" },
  challengeBinding: { nonce: H("f6"), tChallengeRef: "chal-1" },
  evidence: { evidenceBlockHash: H("1a") },
  evidenceTimeBounds: { start: "1700000000", end: "1700000100" },
};

// Signers are the two pinned forms: 0x + lowercase hex, an address (40 digits)
// or an ed25519 key (64 digits). In the sorted order A < B < C.
const SIGNER_A = `0x${"a1".repeat(20)}`;
const SIGNER_B = `0x${"b2".repeat(32)}`;
const SIGNER_C = `0x${"c3".repeat(20)}`;
const SIG_A: PackageSignature = { signer: SIGNER_A, scheme: "secp256k1-eip712", sig: "0xsig-a" };
const SIG_B: PackageSignature = { signer: SIGNER_B, scheme: "ed25519-raw32", sig: "0xsig-b" };
const SIG_C: PackageSignature = { signer: SIGNER_C, scheme: "secp256k1-eip712", sig: "0xsig-c" };

/** Every spelling of a signer that is NOT 0x + 40 or 64 lowercase hex digits. */
const BAD_SIGNERS: Array<[string, unknown]> = [
  ["uppercase digits", SIGNER_A.toUpperCase().replace("0X", "0x")],
  ["EIP-55 style mixed case", `0x${"Aa".repeat(20)}`],
  ["a 0X prefix", `0X${"a1".repeat(20)}`],
  ["no prefix", "a1".repeat(20)],
  ["38 digits", `0x${"a1".repeat(19)}`],
  ["42 digits", `0x${"a1".repeat(21)}`],
  ["62 digits", `0x${"b2".repeat(31)}`],
  ["66 digits", `0x${"b2".repeat(33)}`],
  ["not hex", `0x${"zz".repeat(20)}`],
  ["free text", "kernel-key-1"],
  ["empty", ""],
  ["just the prefix", "0x"],
  ["leading space", ` ${SIGNER_A}`],
  ["trailing newline", `${SIGNER_A}\n`],
  ["a number", 12345],
  ["null", null],
  ["undefined", undefined],
];

describe("canonicalSignatures — the malleability closure", () => {
  it("sorts by signer, so reordering is a no-op", () => {
    expect(canonicalSignatures([SIG_B, SIG_A]).map((s) => s.signer)).toEqual([SIGNER_A, SIGNER_B]);
    expect(canonicalSignatures([SIG_A, SIG_B]).map((s) => s.signer)).toEqual([SIGNER_A, SIGNER_B]);
    expect(canonicalSignatures([SIG_C, SIG_B]).map((s) => s.signer)).toEqual([SIGNER_B, SIGNER_C]);
  });

  it("REFUSES a duplicate signer wherever it sits; it never deduplicates (F4)", () => {
    // Under "first wins" a forged duplicate placed ahead of the real entry was the
    // one that won, and it moved the digest silently. It is an error now.
    const forged: PackageSignature = { ...SIG_A, sig: "0xFORGED" };
    const cases: Array<[string, PackageSignature[]]> = [
      ["forged ahead of the real entry", [forged, SIG_A]],
      ["forged after the real entry", [SIG_A, forged]],
      ["the same entry twice", [SIG_A, SIG_A]],
      ["the same signer under another scheme", [SIG_A, { ...SIG_A, scheme: "ed25519-raw32" }]],
    ];
    for (const [name, input] of cases) {
      expect(() => canonicalSignatures(input), name).toThrow(/signer appears twice/);
    }
  });

  it("REFUSES two signatures in the same role (same scheme, different signer) (F4)", () => {
    expect(() => canonicalSignatures([SIG_A, SIG_C])).toThrow(/same role/);
  });

  it("REFUSES a set that is not exactly two entries, and a value that is not an array (F4)", () => {
    const sets: Array<[string, PackageSignature[]]> = [
      ["none", []],
      ["one", [SIG_A]],
      ["three", [SIG_A, SIG_B, SIG_C]],
      ["a forged duplicate ahead of the real pair", [{ ...SIG_A, sig: "0xFORGED" }, SIG_A, SIG_B]],
    ];
    for (const [name, input] of sets) {
      expect(() => canonicalSignatures(input), name).toThrow(/exactly 2 signatures/);
    }
    for (const notAnArray of [undefined, null, "A,B", { 0: SIG_A, 1: SIG_B, length: 2 }, new Set([SIG_A, SIG_B])]) {
      expect(() => canonicalSignatures(notAnArray), String(notAnArray)).toThrow(/must be an array/);
    }
  });

  it("REFUSES an entry with a key other than signer, scheme, sig (F4)", () => {
    // The digest hashes the whole entry, so an extra key moved it without changing a fact.
    const cases: Array<[string, unknown]> = [
      ["an extra key", { ...SIG_A, note: "x" }],
      ["an extra empty key", { ...SIG_A, "": "x" }],
      ["a missing sig", { signer: SIG_A.signer, scheme: SIG_A.scheme }],
      ["a missing scheme", { signer: SIG_A.signer, sig: SIG_A.sig }],
      ["a missing signer", { scheme: SIG_A.scheme, sig: SIG_A.sig }],
      ["a renamed key", { signer: SIG_A.signer, scheme: SIG_A.scheme, signature: SIG_A.sig }],
      ["a key in another case", { Signer: SIG_A.signer, scheme: SIG_A.scheme, sig: SIG_A.sig }],
      ["an empty object", {}],
    ];
    for (const [name, entry] of cases) {
      expect(() => canonicalSignatures([entry, SIG_B]), name).toThrow(/exactly the keys/);
    }
  });

  it("REFUSES an entry that is not an object, and a scheme or signature that is not a non-empty string (F4)", () => {
    for (const entry of [null, undefined, "x", 7, true, [SIG_A.signer, SIG_A.scheme, SIG_A.sig]]) {
      expect(() => canonicalSignatures([entry, SIG_B]), String(entry)).toThrow(/is not an object/);
    }
    for (const bad of [1, null, undefined, "", {}, []]) {
      expect(() => canonicalSignatures([{ ...SIG_A, scheme: bad }, SIG_B]), `scheme ${String(bad)}`).toThrow(/scheme must be a non-empty string/);
      expect(() => canonicalSignatures([{ ...SIG_A, sig: bad }, SIG_B]), `sig ${String(bad)}`).toThrow(/sig must be a non-empty string/);
    }
  });

  it("REFUSES a signer that is not 0x + 40 or 64 lowercase hex digits, and never normalizes it (F5)", () => {
    // The same address in two spellings must not become two package identities,
    // and must not be quietly repaired either: one accepted spelling, one digest.
    for (const [name, signer] of BAD_SIGNERS) {
      expect(() => canonicalSignatures([{ ...SIG_A, signer } as PackageSignature, SIG_B]), name).toThrow(
        InvalidSignatureEntryError,
      );
    }
    // Both pinned widths are accepted: an address and an ed25519 key.
    expect(() => canonicalSignatures([SIG_A, SIG_B])).not.toThrow();
  });

  it("does not mutate the caller's array or its entries", () => {
    const input = [SIG_B, SIG_A];
    const snapshot = JSON.stringify(input);
    const out = canonicalSignatures(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    // The sorted result is a new array of new entries: the caller's objects are
    // never reordered in place and never aliased.
    expect(input[0]).toBe(SIG_B);
    expect(out).toEqual([SIG_A, SIG_B]);
    expect(out[0]).not.toBe(SIG_A);
    expect(out[1]).not.toBe(SIG_B);
  });

  it("rejects a malformed entry rather than silently skipping it", () => {
    expect(() => canonicalSignatures([{ sig: "x" } as unknown as PackageSignature, SIG_B])).toThrow(
      InvalidSignatureEntryError,
    );
    expect(() => canonicalSignatures([null as unknown as PackageSignature, SIG_B])).toThrow(
      InvalidSignatureEntryError,
    );
  });
});

/**
 * Replica of `canonicalSigs` in evidence's `settlement-vector-golden-mirror.cjs`
 * (read from the evidence worktree; the mirror itself is not touched): dedup by
 * the LOWERCASED signer keeping the entry exactly as given, then sort by the
 * lowercased signer.
 */
function mirrorCanonicalSigs(sigs: readonly PackageSignature[]): PackageSignature[] {
  const kept = new Map<string, PackageSignature>();
  for (const s of sigs) {
    const id = s.signer.toLowerCase();
    if (!kept.has(id)) kept.set(id, s);
  }
  const lower = (s: PackageSignature) => s.signer.toLowerCase();
  return [...kept.values()].sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0));
}

describe("producer vs evidence's mirror — signer case (F6)", () => {
  it("agrees with the mirror, byte for byte, on every input it accepts", () => {
    const accepted: Array<[string, PackageSignature[]]> = [
      ["A,B", [SIG_A, SIG_B]],
      ["B,A", [SIG_B, SIG_A]],
      ["another signature value", [{ ...SIG_A, sig: "0xother" }, SIG_B]],
      ["another kernel key", [SIG_A, { ...SIG_B, signer: `0x${"d4".repeat(32)}` }]],
    ];
    for (const [name, input] of accepted) {
      expect(canonicalSignatures(input), name).toEqual(mirrorCanonicalSigs(input));
      expect(packageDigestV2PreImage(BODY, input), name).toBe(
        canonicalize({ body: BODY, [SIGNATURES_KEY]: mirrorCanonicalSigs(input) }),
      );
    }
  });

  it("refuses exactly where a lowercasing producer would have differed: a signer whose case the mirror keeps", () => {
    for (const signer of [SIGNER_A.toUpperCase().replace("0X", "0x"), `0x${"Aa".repeat(20)}`]) {
      const input = [{ ...SIG_A, signer }, SIG_B];
      // The mirror keeps the case it is given, so lowercasing here would diverge from it...
      expect(mirrorCanonicalSigs(input).some((s) => s.signer === signer)).toBe(true);
      // ...so the producer refuses the input instead of repairing it.
      expect(() => canonicalSignatures(input), signer).toThrow(InvalidSignatureEntryError);
      expect(() => packageDigestV2PreImage(BODY, input), signer).toThrow(InvalidSignatureEntryError);
    }
  });

  it("emits each accepted signer exactly as given", () => {
    const out = canonicalSignatures([SIG_B, SIG_A]);
    expect(out.map((s) => s.signer)).toEqual([SIGNER_A, SIGNER_B]);
    expect(out[0]).toEqual(SIG_A);
    expect(out[1]).toEqual(SIG_B);
  });
});

describe("packageDigestV2Unchecked — signature malleability closes by REFUSAL, reordering is a NO-OP", () => {
  const base = packageDigestV2Unchecked(BODY, [SIG_A, SIG_B]);

  it("is stable under signature REORDERING", () => {
    expect(packageDigestV2Unchecked(BODY, [SIG_B, SIG_A])).toBe(base);
  });

  it("REFUSES a duplicated signer instead of deduplicating it, wherever the duplicate sits (F4)", () => {
    // Before: the first occurrence won, so a forged duplicate placed ahead of the
    // real entry changed the digest silently while looking like a no-op.
    const forged = { ...SIG_A, sig: "0xforged" };
    for (const sigs of [
      [forged, SIG_A, SIG_B],
      [SIG_A, SIG_B, { ...SIG_A, sig: "0xreplay" }],
      [forged, SIG_A],
      [SIG_A, forged],
    ]) {
      expect(() => packageDigestV2Unchecked(BODY, sigs)).toThrow(InvalidSignatureEntryError);
    }
  });

  it("REFUSES an extra key on a signature entry: it would move the digest without changing a fact (F4)", () => {
    const withNote = { ...SIG_A, note: "x" } as PackageSignature;
    expect(() => packageDigestV2Unchecked(BODY, [withNote, SIG_B])).toThrow(/exactly the keys/);
  });

  /**
   * CASE MUST NOT REACH THE DIGEST. Oracle #1395: "Do NOT depend on case;
   * changing a signer id's case MUST be a no-op." Signer ids are EIP-55-checksummed
   * in some paths and lowercase in others, so if spelling reached the digest the
   * SAME evidence assembled by two services would hash differently, and both the
   * oracle's packageHash bind and the gateway's receipt.packageDigest bind would
   * fail on identical, valid evidence. (The gateway already shipped one EIP-55
   * casing bug on this seam, #286.)
   *
   * The producer closes that by accepting ONE spelling, 0x + lowercase hex, and
   * REFUSING every other. A re-cased signer is not a second digest, and it is not
   * quietly repaired either, so the producer never emits a digest over a spelling
   * the oracle or the evidence mirror would treat differently.
   */
  it("REFUSES a re-cased signer: a case change is never a second digest (F5)", () => {
    for (const signer of [SIGNER_A, SIGNER_B]) {
      const recased = signer.toUpperCase().replace("0X", "0x");
      const sigs = [SIG_A, SIG_B].map((s) => (s.signer === signer ? { ...s, signer: recased } : s));
      expect(() => packageDigestV2Unchecked(BODY, sigs), recased).toThrow(/lowercase hex/);
    }
  });

  it("is stable under BODY key insertion order, at every depth", () => {
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const reordered = reverseKeys(BODY);
    expect(Object.keys(reordered as object)).not.toEqual(Object.keys(BODY));
    expect(packageDigestV2Unchecked(reordered, [SIG_A, SIG_B])).toBe(base);
  });
});

describe("packageDigestV2Unchecked — negative parity, every fact must be bound", () => {
  const base = packageDigestV2Unchecked(BODY, [SIG_A, SIG_B]);

  it("moves when ANY body field changes", () => {
    const mutate = (f: (b: typeof BODY) => void) => {
      const b = clone(BODY);
      f(b);
      return b;
    };
    for (const mutated of [
      mutate((b) => { b.unitBinding.milestoneIndex = "4"; }),
      mutate((b) => { b.unitBinding.chainId = "1"; }),
      mutate((b) => { b.unitBinding.escrow = `0x${"9".repeat(40)}`; }),
      mutate((b) => { b.unitBinding.settlementUnitId = H("91"); }),
      mutate((b) => { b.producer.kernelId = "kernel-2"; }),
      mutate((b) => { b.challengeBinding.nonce = H("92"); }),
      mutate((b) => { b.evidence.evidenceBlockHash = H("93"); }),
      mutate((b) => { b.evidenceTimeBounds.end = "1700000200"; }),
    ]) {
      expect(packageDigestV2Unchecked(mutated, [SIG_A, SIG_B])).not.toBe(base);
    }
  });

  it("moves when a signature VALUE changes", () => {
    expect(packageDigestV2Unchecked(BODY, [{ ...SIG_A, sig: "0xforged" }, SIG_B])).not.toBe(base);
  });

  it("moves when the SCHEME changes", () => {
    // scheme selects the verification algorithm; swapping it must not be free.
    expect(packageDigestV2Unchecked(BODY, [{ ...SIG_A, scheme: "secp256k1" }, SIG_B])).not.toBe(base);
  });

  it("moves when a SIGNER changes", () => {
    expect(packageDigestV2Unchecked(BODY, [SIG_A, { ...SIG_B, signer: `0x${"d4".repeat(32)}` }])).not.toBe(base);
    expect(packageDigestV2Unchecked(BODY, [SIG_C, SIG_B])).not.toBe(base);
  });
});

describe("packageDigestV2Unchecked — framing", () => {
  it("returns 0x-prefixed 32-byte hex, NOT the sha256: evidence framing", () => {
    // @pcc/spec's sha256() returns "sha256:<hex>" — the evidence-bundle framing.
    // This digest is bound on-chain as bytes32; mixing the two looks right in a
    // log and fails every bind.
    const d = packageDigestV2Unchecked(BODY, [SIG_A, SIG_B]);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.startsWith("sha256:")).toBe(false);
  });

  it("exposes an inspectable pre-image so a cross-codebase mismatch is debuggable", () => {
    const pre = packageDigestV2PreImage(BODY, [SIG_B, SIG_A]);
    expect(pre).toContain(`"${SIGNATURES_KEY}"`);
    // Canonical JSON: keys sorted at all depths, no whitespace.
    expect(pre).not.toMatch(/\s/);
    // Signers appear exactly as given (they are already lowercase) and in canonical order.
    // (located by key: a body hash may legitimately equal a signer's digits)
    expect(pre).toContain(`"signer":"${SIGNER_A}"`);
    expect(pre.indexOf(`"signer":"${SIGNER_A}"`)).toBeLessThan(pre.indexOf(`"signer":"${SIGNER_B}"`));
  });
});

describe("assertCanonicalizable — the tripwire on the object about to be hashed", () => {
  // The shared canonicalizer serializes numbers with String(), which is not
  // RFC 8785. A validated body is all strings, so packageDigestV2Unchecked never reaches
  // these; they pin the tripwire itself for the day the schema gains a number.
  it("refuses a non-integer number rather than letting an unreproducible digest through", () => {
    expect(() => assertCanonicalizable({ amount: 1.5 })).toThrow(NonCanonicalizableBodyError);
  });

  it("refuses a bigint", () => {
    expect(() => assertCanonicalizable({ amount: 10n })).toThrow(NonCanonicalizableBodyError);
  });

  it("accepts safe integers, strings, booleans, null and nesting", () => {
    expect(() => assertCanonicalizable({ a: 1, b: "x", c: true, d: null, e: { f: [1, "y", false] } })).not.toThrow();
  });
});

describe("packageDigestV2Unchecked — the body is validated first, and a body that is not conforming is never hashed", () => {
  const SIGS = [SIG_A, SIG_B];

  it("refuses a JS number where the schema says decimal string (F7)", () => {
    const num: any = clone(BODY);
    num.unitBinding.chainId = 8453;
    expect(() => packageDigestV2Unchecked(num, SIGS)).toThrow(PackageBodyValidationError);
    expect(() => packageDigestV2Unchecked(num, SIGS)).toThrow(/\$\.unitBinding\.chainId/);
  });

  it("refuses an unknown key at any level, and a missing field (F7)", () => {
    for (const mutate of [
      (b: any) => { b.extra = "x"; },
      (b: any) => { b.unitBinding.chainName = "base"; },
      (b: any) => { b.producer.role = "operator"; },
      (b: any) => { delete b.evidence; },
      (b: any) => { delete b.unitBinding.escrow; },
    ]) {
      const b = clone(BODY);
      mutate(b);
      expect(() => packageDigestV2Unchecked(b, SIGS)).toThrow(PackageBodyValidationError);
      expect(() => packageDigestV2PreImage(b, SIGS)).toThrow(PackageBodyValidationError);
    }
  });

  it("refuses an EIP-55 checksummed escrow address instead of letting it move the digest (F3)", () => {
    const eip55: any = clone(BODY);
    eip55.unitBinding.escrow = "0x00000000000000000000000000000000000E5c0F";
    expect(() => packageDigestV2Unchecked(eip55, SIGS)).toThrow(PackageBodyValidationError);
    expect(() => packageDigestV2Unchecked(eip55, SIGS)).toThrow(/\$\.unitBinding\.escrow/);
    // The lowercase spelling of the same address is the one accepted spelling.
    expect(() => packageDigestV2Unchecked(BODY, SIGS)).not.toThrow();
  });

  it("refuses an uppercase hash and a 0X prefix (F3)", () => {
    const upper: any = clone(BODY);
    upper.evidence.evidenceBlockHash = `0x${"1A".repeat(32)}`;
    const prefix: any = clone(BODY);
    prefix.challengeBinding.nonce = `0X${"f6".repeat(32)}`;
    expect(() => packageDigestV2Unchecked(upper, SIGS)).toThrow(/\$\.evidence\.evidenceBlockHash/);
    expect(() => packageDigestV2Unchecked(prefix, SIGS)).toThrow(/\$\.challengeBinding\.nonce/);
  });

  it("refuses empty principal ids (F7)", () => {
    for (const key of ["operatorPrincipalId", "kernelId", "devicePrincipalId"]) {
      const b: any = clone(BODY);
      b.producer[key] = "";
      expect(() => packageDigestV2Unchecked(b, SIGS), key).toThrow(/must not be empty/);
    }
  });

  it("refuses a body that is not an object", () => {
    for (const bad of [null, undefined, "body", 7, [BODY]]) {
      expect(() => packageDigestV2Unchecked(bad, SIGS), String(bad)).toThrow(PackageBodyValidationError);
    }
  });
});

describe("packageDigestV2Unchecked — evidence's published golden (#1202, 974b3ff1)", () => {
  // The input vector (body + rawSigs) and the digest come from evidence's
  // integrated settlement-vector mirror, computed with a different JCS and hash
  // toolchain — so agreement here is a cross-check, not self-agreement.
  it("matches the golden digest over the published body and sample signature set", () => {
    const body: unknown = JSON.parse(GOLDEN.jcsBody);
    expect(packageDigestV2Unchecked(body, GOLDEN.rawSigs)).toBe(GOLDEN.packageDigestV2);
  });

  it("stays on the golden when the published signatures are reordered", () => {
    const [a, b] = GOLDEN.rawSigs as PackageSignature[];
    const body: unknown = JSON.parse(GOLDEN.jcsBody);
    expect(packageDigestV2Unchecked(body, [b!, a!])).toBe(GOLDEN.packageDigestV2);
  });

  it("REFUSES the published signatures with one duplicated: the mirror deduplicates, the producer refuses (F4)", () => {
    // The mirror's own check collapses reorder + duplicate onto the golden. The
    // producer accepts a subset of what the mirror accepts, and where it accepts
    // they agree: it refuses the duplicate instead of repairing it.
    const [a, b] = GOLDEN.rawSigs as PackageSignature[];
    const body: unknown = JSON.parse(GOLDEN.jcsBody);
    expect(() => packageDigestV2Unchecked(body, [b!, a!, b!])).toThrow(InvalidSignatureEntryError);
  });
});

/**
 * F3 (cross-family E9): before this, nothing stopped `packageDigestV2Unchecked`
 * (then named `packageDigestV2`) from being called directly on a body/
 * signature set `assertMintablePackage` would have refused — there was no
 * enforced seam between the lenient digest and the mint guard.
 * `mintablePackageDigest` is that seam: it only accepts a `MintablePackage`,
 * which is obtainable solely from `assertMintablePackage`.
 */
describe("mintablePackageDigest — the only money-bound digest (F3)", () => {
  function ed25519PublicKeyHexFromSeed(seedHex: string): string {
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const pkcs8Der = Buffer.concat([pkcs8Prefix, Buffer.from(seedHex, "hex")]);
    const privateKey = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    return `0x${spkiDer.subarray(12).toString("hex")}`;
  }
  const H = (n: string) => `0x${n.repeat(64).slice(0, 64)}`;
  const D1 = { signer: `0x${"ab".repeat(20)}`, scheme: "secp256k1-eip712", sig: `0x${"11".repeat(65)}` };
  const DEVICE_SEED = "44".repeat(32);
  const DEVICE_PUB = ed25519PublicKeyHexFromSeed(DEVICE_SEED);
  const MINTABLE_BODY: FinalMilestonePackageV2Body = {
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    packageFormat: PACKAGE_FORMAT,
    compositionSchemaVersion: "1",
    unitBinding: {
      chainId: "8453",
      escrow: "0x00000000000000000000000000000000000e5c0f",
      settlementUnitId: H("a1"),
      jobIdHash: H("b2"),
      milestoneIndex: "3",
      stepId: H("c3"),
      compositionRoot: H("d4"),
      acceptedEnvelopeHash: H("e5"),
    },
    producer: {
      operatorPrincipalId: `eip155:8453:${D1.signer}`,
      kernelId: "kernel-1",
      devicePrincipalId: `ed25519:${DEVICE_PUB}`,
    },
    challengeBinding: { nonce: H("f6"), tChallengeRef: "chal-1" },
    evidence: { evidenceBlockHash: H("1a") },
    evidenceTimeBounds: { start: "1700000000", end: "1700000100" },
  };
  const D2 = {
    signer: DEVICE_PUB,
    scheme: "ed25519-raw32",
    sig: `0x${signWithPrivateKeyHex(DEVICE_SEED, Buffer.from(toBytes(computePackageBodyHash(MINTABLE_BODY))))!}`,
  };
  const REGISTRY = { signerForKernel: async () => ({ algorithm: "ed25519" as const, publicKey: DEVICE_PUB }) };
  const CHALLENGES = {
    recordFor: async () => ({
      nonce: MINTABLE_BODY.challengeBinding.nonce,
      tChallengeRef: MINTABLE_BODY.challengeBinding.tChallengeRef,
      state: "issued" as const,
    }),
    // One use is pinned in final-milestone-package-v2.test.ts (E9b); this double always consumes.
    consumeIssued: async () => true,
  };
  // F1 (D1 half): this file only needs a positive control, so this verifier
  // simply answers true — the D1 fail-closed rules themselves are pinned in
  // final-milestone-package-v2.test.ts, not re-tested here.
  const OPERATOR_VERIFIER = { verifyOperatorSignature: async () => true };

  it("hashes a real MintablePackage exactly as packageDigestV2Unchecked would over the same body/signatures", async () => {
    const mintable = await assertMintablePackage(MINTABLE_BODY, [D1, D2], REGISTRY, CHALLENGES, OPERATOR_VERIFIER);
    expect(mintable).toBeInstanceOf(MintablePackage);
    expect(mintablePackageDigest(mintable)).toBe(packageDigestV2Unchecked(mintable.body, mintable.signatures));
  });

  it("refuses a structural fake: a hand-built {body, signatures} object is not a MintablePackage", () => {
    // A real caller would have to `as unknown as MintablePackage` to even get
    // this past TypeScript — the private `#brand` field makes the class
    // nominal, so this assignment is rejected at compile time; this test
    // pins the RUNTIME half of that protection (the `instanceof` check).
    const fake = { body: MINTABLE_BODY, signatures: [D1, D2] } as unknown as MintablePackage;
    expect(() => mintablePackageDigest(fake)).toThrow(PackageNotMintableError);
    expect(() => mintablePackageDigest(fake)).toThrow(/not a MintablePackage/);
  });

  it("refuses null/undefined/a plain object masquerading as MintablePackage", () => {
    for (const bad of [null, undefined, {}, MINTABLE_BODY]) {
      expect(() => mintablePackageDigest(bad as unknown as MintablePackage), String(bad)).toThrow(
        PackageNotMintableError,
      );
    }
  });

  // ── evidence-lane round 3 (fixer-zulu), cross-family E9, finding 1: the
  // `instanceof` check used to be forgeable two ways. See
  // triage-E9-358-fixer-tango.md, "Round 3 (fixer-zulu)".
  describe("evidence-lane round 3, finding 1 — the brand check is #brand in x, not instanceof", () => {
    it("refuses an Object.create(MintablePackage.prototype) fake carrying its own body/signatures", () => {
      // Object.create puts the fake on the right prototype chain WITHOUT ever
      // running the private constructor, so it has no #brand. Before this
      // fix, mintablePackageDigest's `instanceof` check could not tell this
      // apart from a real MintablePackage and would digest it — "the digest
      // then covers a package nobody verified."
      const fake = Object.create(MintablePackage.prototype) as MintablePackage;
      (fake as { body: unknown }).body = MINTABLE_BODY;
      (fake as { signatures: unknown }).signatures = [D1, D2];
      expect(fake instanceof MintablePackage).toBe(true); // the forgery itself still works
      expect(() => mintablePackageDigest(fake)).toThrow(PackageNotMintableError);
      expect(() => mintablePackageDigest(fake)).toThrow(/not a MintablePackage/);
    });

    it("refuses a fake even when Symbol.hasInstance is overridden to always answer true", () => {
      // Since E9b the class is frozen, so the override itself is refused. Either way the
      // digest does not consult instanceof, so the fake is refused.
      const original = Object.getOwnPropertyDescriptor(MintablePackage, Symbol.hasInstance);
      let overridden = false;
      try {
        Object.defineProperty(MintablePackage, Symbol.hasInstance, { value: () => true, configurable: true });
        overridden = true;
      } catch {
        // frozen: not extensible
      }
      try {
        const fake = { body: MINTABLE_BODY, signatures: [D1, D2] } as unknown as MintablePackage;
        expect(() => mintablePackageDigest(fake)).toThrow(PackageNotMintableError);
      } finally {
        if (overridden) {
          if (original) Object.defineProperty(MintablePackage, Symbol.hasInstance, original);
          else delete (MintablePackage as unknown as Record<symbol, unknown>)[Symbol.hasInstance];
        }
      }
      expect(overridden).toBe(false);
    });

    it("MintablePackage.isMintable agrees with a real mint and disagrees with both forgeries and every non-object", async () => {
      const real = await assertMintablePackage(MINTABLE_BODY, [D1, D2], REGISTRY, CHALLENGES, OPERATOR_VERIFIER);
      expect(MintablePackage.isMintable(real)).toBe(true);
      expect(MintablePackage.isMintable(Object.create(MintablePackage.prototype))).toBe(false);
      expect(MintablePackage.isMintable({ body: MINTABLE_BODY, signatures: [D1, D2] })).toBe(false);
      for (const bad of [null, undefined, "x", 7, true, []]) {
        expect(MintablePackage.isMintable(bad)).toBe(false);
      }
    });
  });
});

describe("packageDigestV2Unchecked — rules the published golden blocks (STOPPED, not applied)", () => {
  // The golden's sample signature set labels its entries "secp256k1" / "ed25519"
  // and gives the "ed25519" entry a 40-digit signer, and its digest 0xf78103a1...
  // must stay byte-identical. Until evidence re-issues the sample set in the
  // frozen D1/D2 forms (or the owners agree the digest path stays lenient and the
  // mint guard is the only gate), these cannot be enforced on the digest path.
  it.todo("pins the scheme names to exactly secp256k1-eip712 (D1) and ed25519-raw32 (D2), which fixes the roles of the two entries");
  it.todo("pins the signer width per scheme: D1 = 0x + 40 digits, D2 = 0x + 64 digits");
});

describe("E9b: the unchecked digest is vectors-only, by construction", () => {
  it("no production module under packages/gateway/src imports package-digest-v2-vectors", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(path);
          continue;
        }
        if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(name) || /\.test\./.test(name)) continue;
        if (name === "package-digest-v2-vectors.ts") continue;
        const text = readFileSync(path, "utf8");
        if (/(from\s+|import\s*\(\s*)["'][^"']*package-digest-v2-vectors(\.js)?["']/.test(text)) offenders.push(path);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

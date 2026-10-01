/**
 * FinalMilestonePackageV2 producer (G2) — invariant + malleability tests.
 *
 * The oracle's ingestion binds `raw.packageHash === packageDigestV2`, and the
 * gateway receipt binds `receipt.packageDigest` to the same value. Both consume;
 * this module produces. These tests pin the properties that make the digest
 * SAFE to bind money to.
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
 * GOLDEN STATUS — read before trusting any cross-codebase claim: the byte-exact
 * golden against the oracle's crossconfirm test is still a `todo`. Q1/Q2 are now
 * answered, but the oracle's exact input VECTOR (the body + rawSigs that produced
 * their published digest) has not landed, and the authoritative BODY SCHEMA is
 * evidence's to give. The BODY below is a placeholder that exercises invariants —
 * it is NOT a claim about the real schema. A fabricated golden that agrees only
 * with itself would be worse than none.
 */

import { describe, it, expect } from "vitest";
import { canonicalize } from "@pcc/spec";
import GOLDEN from "./fixtures/g2-settlement-vector-golden.json";
import {
  packageDigestV2,
  packageDigestV2PreImage,
  canonicalSignatures,
  NonCanonicalizableBodyError,
  InvalidSignatureEntryError,
  SIGNATURES_KEY,
  type PackageSignature,
} from "../settlement/package-digest-v2.js";

/** PLACEHOLDER body — invariant fixture only. Real schema is evidence's. */
const BODY = {
  settlementUnitId:
    "0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1",
  milestoneIndex: 3,
  outcome: "released",
  evidenceCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
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
  it("sorts by signer", () => {
    const out = canonicalSignatures([SIG_C, SIG_A, SIG_B]);
    expect(out.map((s) => s.signer)).toEqual([SIGNER_A, SIGNER_B, SIGNER_C]);
  });

  it("dedups by signer with FIRST occurrence winning", () => {
    const dup: PackageSignature = { signer: SIGNER_A, scheme: "x", sig: "0xLATER" };
    const out = canonicalSignatures([SIG_A, dup]);
    expect(out).toHaveLength(1);
    expect(out[0].sig).toBe("0xsig-a");
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
    const input = [SIG_C, SIG_A];
    const snapshot = JSON.stringify(input);
    canonicalSignatures(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    // In particular the caller's entries survive: the sorted copy is a new array.
    expect(input[0]).toBe(SIG_C);
    expect(SIG_A.signer).toBe(SIGNER_A);
  });

  it("rejects a malformed entry rather than silently skipping it", () => {
    expect(() =>
      canonicalSignatures([{ sig: "x" } as unknown as PackageSignature]),
    ).toThrow(InvalidSignatureEntryError);
    expect(() =>
      canonicalSignatures([null as unknown as PackageSignature]),
    ).toThrow(InvalidSignatureEntryError);
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

describe("packageDigestV2 — signature malleability must be a NO-OP", () => {
  const base = packageDigestV2(BODY, [SIG_A, SIG_B, SIG_C]);

  it("is stable under signature REORDERING", () => {
    expect(packageDigestV2(BODY, [SIG_C, SIG_B, SIG_A])).toBe(base);
    expect(packageDigestV2(BODY, [SIG_B, SIG_A, SIG_C])).toBe(base);
  });

  it("is stable when a signer is DUPLICATED", () => {
    const withDup = [SIG_A, SIG_B, SIG_C, { ...SIG_A, sig: "0xreplay" }];
    expect(packageDigestV2(BODY, withDup)).toBe(base);
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
    for (const signer of [SIGNER_A, SIGNER_B, SIGNER_C]) {
      const recased = signer.toUpperCase().replace("0X", "0x");
      const sigs = [SIG_A, SIG_B, SIG_C].map((s) => (s.signer === signer ? { ...s, signer: recased } : s));
      expect(() => packageDigestV2(BODY, sigs), recased).toThrow(InvalidSignatureEntryError);
    }
  });

  it("is stable under BODY key insertion order", () => {
    const reordered = {
      evidenceCid: BODY.evidenceCid,
      outcome: BODY.outcome,
      milestoneIndex: BODY.milestoneIndex,
      settlementUnitId: BODY.settlementUnitId,
    };
    expect(packageDigestV2(reordered, [SIG_A, SIG_B, SIG_C])).toBe(base);
  });
});

describe("packageDigestV2 — negative parity, every fact must be bound", () => {
  const base = packageDigestV2(BODY, [SIG_A, SIG_B]);

  it("moves when ANY body field changes", () => {
    for (const mutated of [
      { ...BODY, milestoneIndex: 4 },
      { ...BODY, outcome: "refunded" },
      { ...BODY, evidenceCid: "bafyREPLACED" },
      { ...BODY, settlementUnitId: `0x${"1".repeat(64)}` },
    ]) {
      expect(packageDigestV2(mutated, [SIG_A, SIG_B])).not.toBe(base);
    }
  });

  it("moves when a signature VALUE changes", () => {
    expect(packageDigestV2(BODY, [{ ...SIG_A, sig: "0xforged" }, SIG_B])).not.toBe(base);
  });

  it("moves when the SCHEME changes", () => {
    // scheme selects the verification algorithm; swapping it must not be free.
    expect(
      packageDigestV2(BODY, [{ ...SIG_A, scheme: "ed25519-raw32" }, SIG_B]),
    ).not.toBe(base);
  });

  it("moves when a DISTINCT signer is added or removed", () => {
    expect(packageDigestV2(BODY, [SIG_A, SIG_B, SIG_C])).not.toBe(base);
    expect(packageDigestV2(BODY, [SIG_A])).not.toBe(base);
  });
});

describe("packageDigestV2 — framing", () => {
  it("returns 0x-prefixed 32-byte hex, NOT the sha256: evidence framing", () => {
    // @pcc/spec's sha256() returns "sha256:<hex>" — the evidence-bundle framing.
    // This digest is bound on-chain as bytes32; mixing the two looks right in a
    // log and fails every bind.
    const d = packageDigestV2(BODY, [SIG_A]);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.startsWith("sha256:")).toBe(false);
  });

  it("exposes an inspectable pre-image so a cross-codebase mismatch is debuggable", () => {
    const pre = packageDigestV2PreImage(BODY, [SIG_B, SIG_A]);
    expect(pre).toContain(`"${SIGNATURES_KEY}"`);
    // Canonical JSON: keys sorted at all depths, no whitespace.
    expect(pre).not.toMatch(/\s/);
    // Signers appear exactly as given (they are already lowercase) and in canonical order.
    expect(pre).toContain(`"signer":"${SIGNER_A}"`);
    expect(pre.indexOf(SIGNER_A)).toBeLessThan(pre.indexOf(SIGNER_B));
  });
});

describe("packageDigestV2 — fails closed on values the canonicalizer is unsafe for", () => {
  it("refuses a non-integer number rather than emitting an unreproducible digest", () => {
    // The shared canonicalizer serializes numbers with String(), which is not
    // RFC 8785. Rather than silently produce a digest the oracle may not
    // reproduce, refuse it loudly.
    expect(() => packageDigestV2({ amount: 1.5 }, [SIG_A])).toThrow(
      NonCanonicalizableBodyError,
    );
  });

  it("refuses a bigint", () => {
    expect(() => packageDigestV2({ amount: 10n }, [SIG_A])).toThrow(
      NonCanonicalizableBodyError,
    );
  });

  it("accepts safe integers, strings, booleans, null and nesting", () => {
    expect(() =>
      packageDigestV2(
        { a: 1, b: "x", c: true, d: null, e: { f: [1, "y", false] } },
        [SIG_A],
      ),
    ).not.toThrow();
  });
});

describe("packageDigestV2 — evidence's published golden (#1202, 974b3ff1)", () => {
  // The input vector (body + rawSigs) and the digest come from evidence's
  // integrated settlement-vector mirror, computed with a different JCS and hash
  // toolchain — so agreement here is a cross-check, not self-agreement.
  it("matches the golden digest over the published body and sample signature set", () => {
    const body: unknown = JSON.parse(GOLDEN.jcsBody);
    expect(packageDigestV2(body, GOLDEN.rawSigs)).toBe(GOLDEN.packageDigestV2);
  });

  it("stays on the golden when the published signatures are reordered and duplicated", () => {
    const [a, b] = GOLDEN.rawSigs as PackageSignature[];
    const body: unknown = JSON.parse(GOLDEN.jcsBody);
    expect(packageDigestV2(body, [b!, a!, b!])).toBe(GOLDEN.packageDigestV2);
  });
});

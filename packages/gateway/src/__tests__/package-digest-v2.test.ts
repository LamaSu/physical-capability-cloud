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
 * anti-replay bind is decorative. Each of those must be a NO-OP.
 *
 * Signature shape and case semantics are the ORACLE's (#1395, ingestion owner):
 * `{signer, scheme, sig}`, and signer is CASE-INSENSITIVE — "changing a signer
 * id's case MUST be a no-op". The signer SET is {operator, kernel} per
 * evidence's frozen profile (D1 operator secp256k1-EIP712, D2 kernel
 * ed25519-raw32).
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

// Deliberately mixed case, to prove case never reaches the digest.
const SIG_A: PackageSignature = { signer: "0xAAA1", scheme: "secp256k1-eip712", sig: "0xsig-a" };
const SIG_B: PackageSignature = { signer: "0xbbb2", scheme: "ed25519-raw32", sig: "0xsig-b" };
const SIG_C: PackageSignature = { signer: "0xCCC3", scheme: "secp256k1-eip712", sig: "0xsig-c" };

describe("canonicalSignatures — the malleability closure", () => {
  it("emits signer LOWERCASED and sorted", () => {
    const out = canonicalSignatures([SIG_C, SIG_A, SIG_B]);
    expect(out.map((s) => s.signer)).toEqual(["0xaaa1", "0xbbb2", "0xccc3"]);
  });

  it("dedups by signer with FIRST occurrence winning", () => {
    const dup: PackageSignature = { signer: "0xAAA1", scheme: "x", sig: "0xLATER" };
    const out = canonicalSignatures([SIG_A, dup]);
    expect(out).toHaveLength(1);
    expect(out[0].sig).toBe("0xsig-a");
  });

  it("treats case-differing signers as ONE signer", () => {
    // The same address in two spellings must not become two signers, or the
    // dedup that closes malleability is trivially bypassed.
    const lower: PackageSignature = { signer: "0xaaa1", scheme: "x", sig: "0xother" };
    expect(canonicalSignatures([SIG_A, lower])).toHaveLength(1);
  });

  it("does not mutate the caller's array or its entries", () => {
    const input = [SIG_C, SIG_A];
    const snapshot = JSON.stringify(input);
    canonicalSignatures(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    // In particular the caller's original casing survives — normalization
    // happens in the returned copy, not in place.
    expect(SIG_A.signer).toBe("0xAAA1");
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
   * CASE MUST NOT REACH THE DIGEST — oracle #1395, verbatim: "Do NOT depend on
   * case; changing a signer id's case MUST be a no-op."
   *
   * This is the assertion that matters most for first live mint. Signer ids are
   * EIP-55-checksummed in some paths and lowercase in others, so if spelling
   * reached the digest, the SAME evidence assembled by two services would hash
   * differently and both the oracle's packageHash bind and the gateway's
   * receipt.packageDigest bind would fail on identical, valid evidence.
   *
   * The gateway already shipped exactly one EIP-55 casing bug on this seam
   * (#286, InvalidAddressError, caught by CI). This test is the guard against
   * the second.
   */
  it("is stable under signer CASE changes", () => {
    const recased = [
      { ...SIG_A, signer: "0xaaa1" },
      { ...SIG_B, signer: "0xBBB2" },
      { ...SIG_C, signer: "0xccc3" },
    ];
    expect(packageDigestV2(BODY, recased)).toBe(base);
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
    // Signers appear lowercased and in canonical order.
    expect(pre).toContain('"signer":"0xaaa1"');
    expect(pre).not.toContain("0xAAA1");
    expect(pre.indexOf("0xaaa1")).toBeLessThan(pre.indexOf("0xbbb2"));
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

describe("packageDigestV2 — oracle cross-confirm", () => {
  it.todo(
    "matches the oracle's published golden — PENDING their exact input vector " +
      "(body + rawSigs) and evidence's authoritative body schema; a golden that " +
      "agrees only with itself proves nothing",
  );
});

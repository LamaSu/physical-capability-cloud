/**
 * FinalMilestonePackageV2 producer (G2) — invariant + malleability tests.
 *
 * The oracle's ingestion binds `raw.packageHash === packageDigestV2`, and the
 * gateway receipt binds `receipt.packageDigest` to the same value. Both consume;
 * this module produces. These tests pin the properties that make the digest
 * SAFE to bind money to.
 *
 * The malleability block is the point. If a relayer can reorder or duplicate
 * signatures and move the digest without changing a single semantic fact, then
 * one piece of evidence has two package identities and the anti-replay bind is
 * decorative. Each of those must be a NO-OP.
 *
 * GOLDEN STATUS — read this before trusting a cross-chain claim: the byte-exact
 * golden against the oracle's `finalmilestonepackage-v2-crossconfirm.test.ts`
 * (0xe1e5c30d…) is NOT asserted here yet, because the oracle's shorthand
 * `SHA-256(JCS({body, canonicalSignatures(sigs)}))` does not state (a) the
 * literal key name the signatures nest under or (b) the exact body/sigs vector
 * that produced 0xe1e5c30d. Both change the digest. Asked on the bus; the
 * moment the vector lands, the pending test below becomes a real assertion.
 * A fabricated golden that agrees with itself would be worse than none.
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

const BODY = {
  settlementUnitId:
    "0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1",
  milestoneIndex: 3,
  outcome: "released",
  evidenceCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
};

const SIG_A: PackageSignature = { signerId: "0xAAA1", signature: "0xsig-a" };
const SIG_B: PackageSignature = { signerId: "0xbbb2", signature: "0xsig-b" };
const SIG_C: PackageSignature = { signerId: "0xCCC3", signature: "0xsig-c" };

describe("canonicalSignatures — the malleability closure", () => {
  it("sorts by LOWERCASED signerId", () => {
    const out = canonicalSignatures([SIG_C, SIG_A, SIG_B]);
    expect(out.map((s) => s.signerId)).toEqual(["0xAAA1", "0xbbb2", "0xCCC3"]);
  });

  it("dedups by signer with FIRST occurrence winning", () => {
    const dup: PackageSignature = { signerId: "0xAAA1", signature: "0xLATER" };
    const out = canonicalSignatures([SIG_A, dup]);
    expect(out).toHaveLength(1);
    expect(out[0].signature).toBe("0xsig-a");
  });

  it("treats case-differing signerIds as ONE signer", () => {
    // The same address in two spellings must not become two signers, or the
    // dedup that closes malleability is trivially bypassed.
    const lower: PackageSignature = { signerId: "0xaaa1", signature: "0xother" };
    expect(canonicalSignatures([SIG_A, lower])).toHaveLength(1);
  });

  it("does not mutate the caller's array", () => {
    const input = [SIG_C, SIG_A];
    const snapshot = [...input];
    canonicalSignatures(input);
    expect(input).toEqual(snapshot);
  });

  it("rejects a malformed entry rather than silently skipping it", () => {
    expect(() =>
      canonicalSignatures([{ signature: "x" } as unknown as PackageSignature]),
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
    const withDup = [SIG_A, SIG_B, SIG_C, { ...SIG_A, signature: "0xreplay" }];
    expect(packageDigestV2(BODY, withDup)).toBe(base);
  });

  /**
   * CASE IS BOUND — and this is an OPEN QUESTION raised with the oracle, not a
   * settled decision. Their contract says "sort-by-lowercased-signer-id", which
   * specifies the ORDERING key only; it does not say the emitted signerId is
   * normalized. So we bind the spelling as given.
   *
   * The consequence is real: signerIds are EIP-55-checksummed addresses in some
   * paths and lowercase in others, so the SAME signer over the SAME evidence can
   * produce TWO package identities depending only on spelling. Within one
   * package the dedup collapses them (see the case-insensitive dedup test
   * above); across two independently-assembled packages it does not.
   *
   * That is a liveness/bind-failure risk at first live mint, which is exactly
   * the class of defect the cross-confirm loop exists to catch — the gateway
   * already shipped one EIP-55 casing bug on this seam (#286, caught by CI).
   * This test pins CURRENT behavior so a change is deliberate and visible; if
   * the oracle confirms normalization, this test flips and the producer
   * lowercases signerId in the canonical form.
   */
  it("BINDS signerId case (oracle-confirmation pending — see comment)", () => {
    const recased = [
      { ...SIG_A, signerId: "0xaaa1" },
      { ...SIG_B, signerId: "0xBBB2" },
      SIG_C,
    ];
    expect(packageDigestV2(BODY, recased)).not.toBe(base);
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
    const tampered = [{ ...SIG_A, signature: "0xforged" }, SIG_B];
    expect(packageDigestV2(BODY, tampered)).not.toBe(base);
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
    // Signatures appear in canonical (lowercased-sorted) order in the pre-image.
    expect(pre.indexOf("0xAAA1")).toBeLessThan(pre.indexOf("0xbbb2"));
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
    "matches the oracle's golden 0xe1e5c30d… — PENDING the oracle's exact " +
      "vector (body + rawSigs) and the literal signatures key name; both " +
      "change the digest, so neither may be guessed",
  );
});

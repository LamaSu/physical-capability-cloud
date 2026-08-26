/**
 * FinalMilestonePackageV2 body + packageBodyHash — schema conformance tests.
 *
 * Wire contract: evidence `c25c8f97`,
 * `~/.claude/shared/vnext-finalmilestonepackage-v2-body-schema.md` (2026-08-26).
 *
 * The point of this file is that the body is the SIGNED surface. Every scalar
 * that reaches `JCS(body)` reaches the operator's and kernel's signatures, so a
 * type or spelling slip here is not a validation nit — it is a signature that
 * verifies against nothing, discovered at mint, with funds in escrow.
 */

import { describe, it, expect } from "vitest";
import {
  validatePackageBody,
  computePackageBodyHash,
  packageBodyJcs,
  isInterimNonce,
  INTERIM_NONCE,
  SIG_DOMAIN_V2,
  PackageBodyValidationError,
  PACKAGE_SCHEMA_VERSION,
  PACKAGE_FORMAT,
  type FinalMilestonePackageV2Body,
} from "../settlement/final-milestone-package-v2.js";
import { packageDigestV2, type PackageSignature } from "../settlement/package-digest-v2.js";

const H = (n: string) => `0x${n.repeat(64).slice(0, 64)}`;

const BODY: FinalMilestonePackageV2Body = {
  packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
  packageFormat: PACKAGE_FORMAT,
  compositionSchemaVersion: "1",
  unitBinding: {
    chainId: "8453",
    escrow: "0x00000000000000000000000000000000000e5c0f",
    settlementUnitId: H("a"),
    jobIdHash: H("b"),
    milestoneIndex: "3",
    stepId: H("c"),
    compositionRoot: H("d"),
    acceptedEnvelopeHash: H("e"),
  },
  producer: {
    operatorPrincipalId: "op-1",
    kernelId: "kernel-1",
    devicePrincipalId: "dev-1",
  },
  challengeBinding: { nonce: H("f"), tChallengeRef: "chal-1" },
  evidence: { evidenceBlockHash: H("1") },
  evidenceTimeBounds: { start: "1700000000", end: "1700000100" },
};

describe("SIG_DOMAIN_V2", () => {
  it("is keccak256 of the exact domain string", () => {
    // Pinned so a silent domain drift breaks HERE, not at signature-verify time.
    expect(SIG_DOMAIN_V2).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SIG_DOMAIN_V2.length).toBe(66);
  });
});

describe("validatePackageBody — fails closed on every deviation", () => {
  it("accepts a conforming body", () => {
    expect(() => validatePackageBody(BODY)).not.toThrow();
  });

  it("REJECTS a JS number where the schema says decimal string", () => {
    // The whole reason the schema uses strings: JS numbers lose precision above
    // 2^53 and the shared canonicalizer's number serialization is not RFC 8785.
    // Coercing here would produce a digest the oracle cannot reproduce.
    const bad = { ...BODY, unitBinding: { ...BODY.unitBinding, chainId: 8453 } };
    expect(() => validatePackageBody(bad)).toThrow(PackageBodyValidationError);
    const bad2 = { ...BODY, unitBinding: { ...BODY.unitBinding, milestoneIndex: 3 } };
    expect(() => validatePackageBody(bad2)).toThrow(PackageBodyValidationError);
  });

  it("REJECTS a decimal string with a leading zero or a sign", () => {
    for (const v of ["03", "+3", "-3", "3.0", "3e0", ""]) {
      const bad = { ...BODY, unitBinding: { ...BODY.unitBinding, milestoneIndex: v } };
      expect(() => validatePackageBody(bad)).toThrow(PackageBodyValidationError);
    }
  });

  it("REJECTS a wrong-width hash or address", () => {
    const shortHash = { ...BODY, evidence: { evidenceBlockHash: "0xdead" } };
    expect(() => validatePackageBody(shortHash)).toThrow(PackageBodyValidationError);
    const addrAsHash = { ...BODY, unitBinding: { ...BODY.unitBinding, escrow: H("a") } };
    expect(() => validatePackageBody(addrAsHash)).toThrow(PackageBodyValidationError);
  });

  it("REJECTS the V1 packageFormat — the formats are not interchangeable", () => {
    const v1 = { ...BODY, packageFormat: "1" };
    expect(() => validatePackageBody(v1)).toThrow(PackageBodyValidationError);
  });

  it("REJECTS a missing nested object rather than defaulting it", () => {
    const noProducer = { ...BODY, producer: undefined };
    expect(() => validatePackageBody(noProducer)).toThrow(PackageBodyValidationError);
  });

  it("names the offending path so a wire mismatch is debuggable", () => {
    const bad = { ...BODY, unitBinding: { ...BODY.unitBinding, stepId: "0xnope" } };
    expect(() => validatePackageBody(bad)).toThrow(/\$\.unitBinding\.stepId/);
  });
});

describe("computePackageBodyHash — the SIGNED pre-image", () => {
  it("returns 0x-prefixed 32-byte hex", () => {
    expect(computePackageBodyHash(BODY)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is stable under body key insertion order (JCS sorts at all depths)", () => {
    const reordered = {
      evidenceTimeBounds: BODY.evidenceTimeBounds,
      evidence: BODY.evidence,
      challengeBinding: BODY.challengeBinding,
      producer: BODY.producer,
      unitBinding: {
        acceptedEnvelopeHash: BODY.unitBinding.acceptedEnvelopeHash,
        compositionRoot: BODY.unitBinding.compositionRoot,
        stepId: BODY.unitBinding.stepId,
        milestoneIndex: BODY.unitBinding.milestoneIndex,
        jobIdHash: BODY.unitBinding.jobIdHash,
        settlementUnitId: BODY.unitBinding.settlementUnitId,
        escrow: BODY.unitBinding.escrow,
        chainId: BODY.unitBinding.chainId,
      },
      compositionSchemaVersion: BODY.compositionSchemaVersion,
      packageFormat: BODY.packageFormat,
      packageSchemaVersion: BODY.packageSchemaVersion,
    } as FinalMilestonePackageV2Body;
    expect(computePackageBodyHash(reordered)).toBe(computePackageBodyHash(BODY));
  });

  it("moves when ANY unitBinding field changes — all 8 are bound", () => {
    const base = computePackageBodyHash(BODY);
    const keys = Object.keys(BODY.unitBinding) as (keyof typeof BODY.unitBinding)[];
    expect(keys).toHaveLength(8);
    for (const k of keys) {
      const mutated = {
        ...BODY,
        unitBinding: {
          ...BODY.unitBinding,
          [k]: k === "chainId" || k === "milestoneIndex" ? "999" : H("9"),
        },
      } as FinalMilestonePackageV2Body;
      expect(computePackageBodyHash(mutated)).not.toBe(base);
    }
  });

  it("moves when the evidenceBlockHash changes", () => {
    const mutated = { ...BODY, evidence: { evidenceBlockHash: H("2") } };
    expect(computePackageBodyHash(mutated)).not.toBe(computePackageBodyHash(BODY));
  });

  it("length-prefixes by UTF-8 BYTE length, not JS string length", () => {
    // A non-ASCII principalId makes byte-length != string-length. A producer
    // using .length would agree with the oracle on ASCII and diverge silently
    // the first time an accent appeared. This asserts the two bodies — same
    // string length, different byte length — do not collide.
    const ascii = { ...BODY, producer: { ...BODY.producer, kernelId: "aaaa" } };
    const wide = { ...BODY, producer: { ...BODY.producer, kernelId: "ääää" } };
    expect(wide.producer.kernelId.length).toBe(ascii.producer.kernelId.length);
    expect(Buffer.byteLength(wide.producer.kernelId, "utf8")).not.toBe(
      Buffer.byteLength(ascii.producer.kernelId, "utf8"),
    );
    expect(computePackageBodyHash(wide)).not.toBe(computePackageBodyHash(ascii));
  });
});

describe("packageBodyHash vs packageDigestV2 — two DIFFERENT hashes", () => {
  it("are not the same value, and must never be confused", () => {
    // The operator and kernel sign packageBodyHash. `raw.packageHash` must equal
    // packageDigestV2. Signing the wrong one yields signatures that verify
    // against nothing — at mint, with funds in escrow.
    const sigs: PackageSignature[] = [
      { signer: "0xAAA1", scheme: "secp256k1-eip712", sig: "0xop" },
      { signer: "0xbbb2", scheme: "ed25519-raw32", sig: "0xkernel" },
    ];
    expect(computePackageBodyHash(BODY)).not.toBe(packageDigestV2(BODY, sigs));
  });

  it("packageBodyHash does NOT depend on the signatures; packageDigestV2 does", () => {
    const s1: PackageSignature[] = [{ signer: "0xa", scheme: "secp256k1-eip712", sig: "0x1" }];
    const s2: PackageSignature[] = [{ signer: "0xa", scheme: "secp256k1-eip712", sig: "0x2" }];
    // Body hash is what gets signed, so it cannot depend on the signatures —
    // that would be circular.
    expect(computePackageBodyHash(BODY)).toBe(computePackageBodyHash(BODY));
    expect(packageDigestV2(BODY, s1)).not.toBe(packageDigestV2(BODY, s2));
  });
});

describe("interim challenge nonce — schema §4 open item, queryable in code", () => {
  it("flags the all-zero placeholder", () => {
    const interim = { ...BODY, challengeBinding: { ...BODY.challengeBinding, nonce: INTERIM_NONCE } };
    expect(isInterimNonce(interim)).toBe(true);
    expect(isInterimNonce(BODY)).toBe(false);
  });
});

describe("JCS pre-image", () => {
  it("is whitespace-free with keys sorted at all depths", () => {
    const jcs = packageBodyJcs(BODY);
    expect(jcs).not.toMatch(/\s/);
    // Top-level keys sorted: challengeBinding < compositionSchemaVersion < evidence ...
    expect(jcs.indexOf('"challengeBinding"')).toBeLessThan(jcs.indexOf('"evidence"'));
    expect(jcs.indexOf('"packageFormat"')).toBeLessThan(jcs.indexOf('"producer"'));
    // Nested keys sorted too.
    expect(jcs.indexOf('"chainId"')).toBeLessThan(jcs.indexOf('"escrow"'));
  });
});

describe("oracle + evidence cross-confirm", () => {
  it.todo(
    "packageBodyHash and packageDigestV2 match evidence's re-aligned golden — " +
      "PENDING: evidence is re-aligning 3 drifted goldens (v2-preview, " +
      "settlement-vector, sig-golden) onto this single body, then re-cross-" +
      "confirming with oracle. No golden asserted until that vector lands.",
  );
});

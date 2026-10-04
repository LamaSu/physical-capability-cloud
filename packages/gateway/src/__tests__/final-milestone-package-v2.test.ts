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
import { keccak256, toBytes } from "viem";
import { createPrivateKey, createPublicKey } from "node:crypto";
import GOLDEN from "./fixtures/g2-settlement-vector-golden.json";
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
  PackageNotMintableError,
  assertMintablePackage,
  MintablePackage,
  isMintablePackage,
  type FinalMilestonePackageV2Body,
  type KernelRegistryReader,
  type KernelRegistrySigner,
  type ChallengeReader,
  type OperatorSignatureVerifier,
  type OperatorSignatureVerifierInput,
} from "../settlement/final-milestone-package-v2.js";
import {
  canonicalSignatures,
  mintablePackageDigest,
  type PackageSignature,
} from "../settlement/package-digest-v2.js";
import { packageDigestV2Unchecked } from "../settlement/package-digest-v2-vectors.js";
import { COMPROMISED_DEVICE_PUBLIC_KEYS } from "@pcc/spec";
import { signWithPrivateKeyHex } from "../auth/ed25519.js";

const H = (n: string) => `0x${n.repeat(64).slice(0, 64)}`;

/**
 * Deterministic Ed25519 keypair from a 32-byte hex seed — test-only, so D2
 * fixtures below are REAL signatures instead of the pre-fix 0x22-repeated
 * placeholder (F1). Mirrors the ASN.1 handling in
 * `gateway/src/auth/ed25519.ts` (`generateEd25519Keypair`), just keyed from a
 * fixed seed instead of a random one.
 */
function ed25519PublicKeyHexFromSeed(seedHex: string): string {
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const pkcs8Der = Buffer.concat([pkcs8Prefix, Buffer.from(seedHex, "hex")]);
  const privateKey = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return `0x${spkiDer.subarray(12).toString("hex")}`;
}

/** A `KernelRegistryReader` that always answers the same signer (or `null`), regardless of kernelId. */
function registryReturning(signer: KernelRegistrySigner | null): KernelRegistryReader {
  return { signerForKernel: async () => signer };
}
/** A `KernelRegistryReader` keyed by kernelId — F2: the registry binding must be looked up BY kernel id. */
function registryFromMap(map: Record<string, KernelRegistrySigner | null>): KernelRegistryReader {
  return { signerForKernel: async (kernelId) => (Object.hasOwn(map, kernelId) ? map[kernelId]! : null) };
}
/** A `ChallengeReader` that always answers the same record (or `null`), regardless of unitBinding. */
function challengesReturning(
  record: { nonce: string; tChallengeRef: string; state: string } | null,
): ChallengeReader {
  // A double that does NOT model one use: its consume always succeeds, so the many
  // positive-path tests that share it can each mint. One use is tested with
  // `oneUseChallenges` below (cross-family E9b).
  return { recordFor: async () => record as never, consumeIssued: async () => true };
}
/**
 * A challenge store with the contract `consumeIssued` requires: an atomic, one-use
 * compare-and-set from "issued" to "consumed". JavaScript runs this check-and-set
 * without interleaving, so it is atomic here; a real store does it in one transaction.
 */
function oneUseChallenges(record: { nonce: string; tChallengeRef: string }): ChallengeReader & { consumeCalls: number } {
  let state = "issued";
  const store = {
    consumeCalls: 0,
    recordFor: async () => ({ ...record, state }) as never,
    consumeIssued: async (_unit: unknown, expected: { nonce: string; tChallengeRef: string }) => {
      store.consumeCalls++;
      if (state !== "issued" || expected.nonce !== record.nonce || expected.tChallengeRef !== record.tChallengeRef) return false;
      state = "consumed";
      return true;
    },
  };
  return store as never;
}
/**
 * An `OperatorSignatureVerifier` that answers `true` only when the input's
 * claimed D1 signer and signature are EXACTLY the ones given — never a blind
 * `true`, so a positive-path test using this stub proves the guard calls the
 * verifier with the REAL D1 entry it validated, not a caller-supplied
 * stand-in.
 */
function verifierFor(signer: string, sig: string): OperatorSignatureVerifier {
  return { verifyOperatorSignature: async (input) => input.signer === signer && input.sig === sig };
}

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

// The two signer forms (0x + lowercase hex): the operator's address and the kernel's ed25519 key.
const SIGNER_OP = `0x${"a1".repeat(20)}`;
const SIGNER_KERNEL = `0x${"b2".repeat(32)}`;

describe("SIG_DOMAIN_V2", () => {
  it("is keccak256 of the exact domain string", () => {
    // Pinned so a silent domain drift breaks HERE, not at signature-verify time.
    expect(SIG_DOMAIN_V2).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SIG_DOMAIN_V2.length).toBe(66);
    // The VALUE, not just the shape. The suffix is ":v1" (evidence #1202, oracle
    // #1414): the "V2" is the raw32 framing, not the domain suffix. A format-only
    // check let the drifted ":v2" domain (0x1e98b1f8...) through unnoticed.
    expect(SIG_DOMAIN_V2).toBe(GOLDEN.sigDomain);
    expect(SIG_DOMAIN_V2).toBe(keccak256(toBytes("PCC:vnext:evidence-package-sig:v1")));
    expect(SIG_DOMAIN_V2).not.toBe(keccak256(toBytes("PCC:vnext:evidence-package-sig:v2")));
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
          // a value of the field's own form: a decimal, a 40-digit address or a 64-digit hash
          [k]: k === "chainId" || k === "milestoneIndex" ? "999" : k === "escrow" ? `0x${"9".repeat(40)}` : H("9"),
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
    // A non-ASCII value makes byte-length != string-length. A producer using
    // .length would agree with the oracle on ASCII and diverge silently the first
    // time an accent appeared. This asserts the two bodies — same string length,
    // different byte length — do not collide. (tChallengeRef is the one free-form
    // field: every other string in the body is hex, a decimal or an ASCII id.)
    const ascii = { ...BODY, challengeBinding: { ...BODY.challengeBinding, tChallengeRef: "aaaa" } };
    const wide = { ...BODY, challengeBinding: { ...BODY.challengeBinding, tChallengeRef: "ääää" } };
    expect(wide.challengeBinding.tChallengeRef.length).toBe(ascii.challengeBinding.tChallengeRef.length);
    expect(Buffer.byteLength(wide.challengeBinding.tChallengeRef, "utf8")).not.toBe(
      Buffer.byteLength(ascii.challengeBinding.tChallengeRef, "utf8"),
    );
    expect(computePackageBodyHash(wide)).not.toBe(computePackageBodyHash(ascii));
  });
});

/**
 * F3: hex case carries no meaning but it changes the canonical bytes, so a body
 * hashed in two spellings would have two hashes. One accepted spelling per field,
 * 0x + lowercase hex of its exact width, by REJECTION: every function that hashes
 * a body validates it first and refuses any other spelling with a typed error.
 */
describe("hex spelling is pinned by rejection on every hashing path (F3)", () => {
  const SIGS = [
    { signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0xop" },
    { signer: SIGNER_KERNEL, scheme: "ed25519-raw32", sig: "0xkernel" },
  ];
  const FIELDS: Array<{ path: string; digits: number; set: (b: any, v: string) => void }> = [
    { path: "$.unitBinding.escrow", digits: 40, set: (b, v) => { b.unitBinding.escrow = v; } },
    { path: "$.unitBinding.settlementUnitId", digits: 64, set: (b, v) => { b.unitBinding.settlementUnitId = v; } },
    { path: "$.unitBinding.jobIdHash", digits: 64, set: (b, v) => { b.unitBinding.jobIdHash = v; } },
    { path: "$.unitBinding.stepId", digits: 64, set: (b, v) => { b.unitBinding.stepId = v; } },
    { path: "$.unitBinding.compositionRoot", digits: 64, set: (b, v) => { b.unitBinding.compositionRoot = v; } },
    { path: "$.unitBinding.acceptedEnvelopeHash", digits: 64, set: (b, v) => { b.unitBinding.acceptedEnvelopeHash = v; } },
    { path: "$.challengeBinding.nonce", digits: 64, set: (b, v) => { b.challengeBinding.nonce = v; } },
    { path: "$.evidence.evidenceBlockHash", digits: 64, set: (b, v) => { b.evidence.evidenceBlockHash = v; } },
  ];
  const hashers: Array<[string, (b: unknown) => unknown]> = [
    ["computePackageBodyHash", (b) => computePackageBodyHash(b)],
    ["packageBodyJcs", (b) => packageBodyJcs(b)],
    ["packageDigestV2Unchecked", (b) => packageDigestV2Unchecked(b, SIGS)],
  ];

  it("every hashing function refuses every hex field in every spelling but 0x + lowercase, naming the field", () => {
    for (const f of FIELDS) {
      const hex = "ab12cd34ef56".repeat(6).slice(0, f.digits); // has letters, so case is observable
      const bad: Array<[string, string]> = [
        ["uppercase", `0x${hex.toUpperCase()}`],
        ["mixed case (EIP-55 style)", `0x${hex.slice(0, 5)}${hex.slice(5).toUpperCase()}`],
        ["a 0X prefix", `0X${hex}`],
        ["no prefix", hex],
      ];
      const good = clone(BODY);
      f.set(good, `0x${hex}`);
      for (const [fn, hash] of hashers) expect(() => hash(good), `${fn} ${f.path} lowercase`).not.toThrow();
      for (const [spelling, value] of bad) {
        const b = clone(BODY);
        f.set(b, value);
        for (const [fn, hash] of hashers) {
          expect(() => hash(b), `${fn} ${f.path} ${spelling}`).toThrow(PackageBodyValidationError);
          expect(() => hash(b), `${fn} ${f.path} ${spelling}`).toThrow(f.path);
        }
      }
    }
  });

  it("an EIP-55 checksummed escrow address is refused by BOTH hashes instead of moving them", () => {
    const eip55 = clone(BODY);
    eip55.unitBinding.escrow = "0x00000000000000000000000000000000000E5c0F" as `0x${string}`;
    expect(() => computePackageBodyHash(eip55)).toThrow(PackageBodyValidationError);
    expect(() => packageDigestV2Unchecked(eip55, SIGS)).toThrow(PackageBodyValidationError);
    // The lowercase spelling of the same address is the one accepted spelling, and it hashes.
    expect(computePackageBodyHash(BODY)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("every hashing function refuses a body that does not conform, instead of hashing what it can", () => {
    const unknownKey: any = clone(BODY);
    unknownKey.extra = "x";
    const number: any = clone(BODY);
    number.unitBinding.chainId = 8453;
    const missing: any = clone(BODY);
    delete missing.producer;
    for (const [fn, hash] of hashers) {
      for (const bad of [unknownKey, number, missing, null, "body", [BODY]]) {
        expect(() => hash(bad), `${fn} ${JSON.stringify(bad)?.slice(0, 40)}`).toThrow(PackageBodyValidationError);
      }
    }
  });

  it("hashes the canonical lowercase body to the same value as before the validation step", () => {
    // Validation changes what is accepted, never what a canonical body hashes to.
    const golden = JSON.parse(GOLDEN.jcsBody);
    expect(computePackageBodyHash(golden)).toBe(GOLDEN.packageBodyHash);
    expect(packageBodyJcs(golden)).toBe(GOLDEN.jcsBody);
  });
});

describe("packageBodyHash vs packageDigestV2Unchecked — two DIFFERENT hashes", () => {
  it("are not the same value, and must never be confused", () => {
    // The operator and kernel sign packageBodyHash. `raw.packageHash` must equal
    // packageDigestV2Unchecked. Signing the wrong one yields signatures that verify
    // against nothing — at mint, with funds in escrow.
    const sigs: PackageSignature[] = [
      { signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0xop" },
      { signer: SIGNER_KERNEL, scheme: "ed25519-raw32", sig: "0xkernel" },
    ];
    expect(computePackageBodyHash(BODY)).not.toBe(packageDigestV2Unchecked(BODY, sigs));
  });

  it("packageBodyHash does NOT depend on the signatures; packageDigestV2Unchecked does", () => {
    const kernel: PackageSignature = { signer: SIGNER_KERNEL, scheme: "ed25519-raw32", sig: "0xkernel" };
    const s1: PackageSignature[] = [{ signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0x1" }, kernel];
    const s2: PackageSignature[] = [{ signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0x2" }, kernel];
    // Body hash is what gets signed, so it cannot depend on the signatures —
    // that would be circular.
    expect(computePackageBodyHash(BODY)).toBe(computePackageBodyHash(BODY));
    expect(packageDigestV2Unchecked(BODY, s1)).not.toBe(packageDigestV2Unchecked(BODY, s2));
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

/**
 * Evidence's re-aligned golden LANDED: the integrated settlement vector
 * (settlement-vector-golden-mirror.cjs @ 974b3ff1, bulletin #1202). It is a
 * cross-toolchain check — evidence's mirror hashes with its own string-leaf JCS
 * and ethers; this side uses @pcc/spec canonicalize and viem. Body values are
 * SAMPLE values; the structure and the digests are what is being checked.
 */
describe("evidence's published settlement-vector golden (#1202, 974b3ff1)", () => {
  const body = validatePackageBody(JSON.parse(GOLDEN.jcsBody));

  it("JCS(body) is byte-identical to evidence's published pre-image", () => {
    expect(packageBodyJcs(body)).toBe(GOLDEN.jcsBody);
  });

  it("packageBodyHash matches the golden under the :v1 signing domain", () => {
    expect(computePackageBodyHash(body)).toBe(GOLDEN.packageBodyHash);
  });

  it("packageDigestV2Unchecked over the same body matches the golden", () => {
    expect(packageDigestV2Unchecked(body, GOLDEN.rawSigs)).toBe(GOLDEN.packageDigestV2);
  });
});


// ── Pinned input forms and the mint-time guard (evidence schema owner) ──────

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("validatePackageBody — pinned forms", () => {
  it("refuses an unknown key at any level instead of dropping it", () => {
    const cases: Array<[string, (b: any) => void]> = [
      ["$", (b) => { b.extra = "x"; }],
      ["$.unitBinding", (b) => { b.unitBinding.chainName = "base"; }],
      ["$.producer", (b) => { b.producer.role = "operator"; }],
      ["$.challengeBinding", (b) => { b.challengeBinding.issuedAt = "1"; }],
      ["$.evidence", (b) => { b.evidence.bundleHash = H("2"); }],
      ["$.evidenceTimeBounds", (b) => { b.evidenceTimeBounds.tz = "UTC"; }],
    ];
    for (const [path, mutate] of cases) {
      const b = clone(BODY);
      mutate(b);
      expect(() => validatePackageBody(b), path).toThrow(new RegExp(`at \\${path}: unknown key`));
    }
  });

  it("refuses a checksummed escrow address and uppercase hashes", () => {
    const eip55 = clone(BODY);
    eip55.unitBinding.escrow = "0x00000000000000000000000000000000000E5c0F" as `0x${string}`;
    expect(() => validatePackageBody(eip55)).toThrow(PackageBodyValidationError);
    const upper = clone(BODY);
    upper.evidence.evidenceBlockHash = `0x${"E".repeat(64)}` as `0x${string}`; // uppercase hex digits
    expect(() => validatePackageBody(upper)).toThrow(PackageBodyValidationError);
  });

  it("refuses empty identifiers and time bounds", () => {
    for (const set of [
      (b: any) => { b.producer.operatorPrincipalId = ""; },
      (b: any) => { b.producer.kernelId = ""; },
      (b: any) => { b.producer.devicePrincipalId = ""; },
      (b: any) => { b.challengeBinding.tChallengeRef = ""; },
      (b: any) => { b.evidenceTimeBounds.start = ""; },
      (b: any) => { b.evidenceTimeBounds.end = ""; },
    ]) {
      const b = clone(BODY);
      set(b);
      expect(() => validatePackageBody(b)).toThrow(/must not be empty/);
    }
  });

  it("refuses a lone UTF-16 surrogate in any free-text field, before hashing (F5)", () => {
    // operatorPrincipalId / devicePrincipalId / tChallengeRef are the body's
    // free-text fields (kernelId is already ASCII-only via isValidKernelId).
    // The shared canonicalizer's JSON.stringify happily escapes a lone
    // surrogate as "\udXXX" — the public producer can hash it — but the
    // private Oracle's jcs() refuses it, so it must be refused HERE, first.
    for (const key of ["operatorPrincipalId", "devicePrincipalId"] as const) {
      const b = clone(BODY);
      b.producer[key] = "kernel-\ud800";
      expect(() => validatePackageBody(b), key).toThrow(PackageBodyValidationError);
      expect(() => validatePackageBody(b), key).toThrow(/lone UTF-16 surrogate/);
      expect(() => computePackageBodyHash(b), key).toThrow(PackageBodyValidationError);
    }
    const b2 = clone(BODY);
    b2.challengeBinding.tChallengeRef = "\ud800";
    expect(() => validatePackageBody(b2)).toThrow(/lone UTF-16 surrogate/);
    // A lone LOW surrogate (not just a lone high one) is refused too.
    const b3 = clone(BODY);
    b3.challengeBinding.tChallengeRef = "x\udc00y";
    expect(() => validatePackageBody(b3)).toThrow(/lone UTF-16 surrogate/);
    // A well-formed surrogate PAIR (a real non-ASCII character) is accepted —
    // this check is specifically about LONE surrogates, not all of Unicode.
    const ok = clone(BODY);
    ok.challengeBinding.tChallengeRef = "chal-😀"; // 😀, a valid pair
    expect(() => validatePackageBody(ok)).not.toThrow();
  });

  it("every hashing function refuses empty principal ids too, instead of hashing them (F7)", () => {
    const sigs = [
      { signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0xop" },
      { signer: SIGNER_KERNEL, scheme: "ed25519-raw32", sig: "0xkernel" },
    ];
    for (const key of ["operatorPrincipalId", "kernelId", "devicePrincipalId"] as const) {
      const b = clone(BODY);
      b.producer[key] = "";
      expect(() => computePackageBodyHash(b), key).toThrow(/must not be empty/);
      expect(() => packageBodyJcs(b), key).toThrow(/must not be empty/);
      expect(() => packageDigestV2Unchecked(b, sigs), key).toThrow(/must not be empty/);
    }
  });

  it("pins the kernel id to #399's rule: 1-128 printable ASCII, no space, not eip155:/ed25519: in any case (F7)", () => {
    const bad: Array<[string, string]> = [
      ["non-ASCII", "ääää"],
      ["a space", "kernel 1"],
      ["a tab", "kernel\t1"],
      ["a control character", "kernel\u0001"],
      ["DEL", "kernel\u007f"],
      ["129 characters", "k".repeat(129)],
      ["the reserved operator prefix", "eip155:8453:0xabc"],
      ["the reserved operator prefix in upper case", "EIP155:1"],
      ["the reserved device prefix", "ed25519:0xabc"],
      ["the reserved device prefix in mixed case", "Ed25519:x"],
      ["a lone surrogate", "kernel-\ud800"],
    ];
    for (const [name, id] of bad) {
      const b = clone(BODY);
      b.producer.kernelId = id;
      expect(() => validatePackageBody(b), name).toThrow(/\$\.producer\.kernelId/);
      expect(() => computePackageBodyHash(b), name).toThrow(PackageBodyValidationError);
    }
    for (const id of ["kernel-1", "k".repeat(128), "a:b", "eip155", "ed25519-key", "!~"]) {
      const b = clone(BODY);
      b.producer.kernelId = id;
      expect(validatePackageBody(b).producer.kernelId, id).toBe(id);
    }
  });

  it("time bounds are decimal Unix-second strings, start <= end, kept byte-for-byte (bus #3567)", () => {
    for (const [start, end] of [
      ["2026-08-20T00:00:00Z", "2026-08-20T00:05:00Z"],
      ["01700000000", "1700000100"],
      ["-1", "1700000100"],
      ["1700000000.5", "1700000100"],
      ["1e9", "1700000100"],
      ["1700000000", "9007199254740992"],
    ]) {
      const b = clone(BODY);
      b.evidenceTimeBounds = { start, end };
      expect(() => validatePackageBody(b), `${start}..${end}`).toThrow(/decimal string of Unix seconds/);
    }
    const numeric: any = clone(BODY);
    numeric.evidenceTimeBounds = { start: 1700000000, end: 1700000100 };
    expect(() => validatePackageBody(numeric)).toThrow();
    const inverted = clone(BODY);
    inverted.evidenceTimeBounds = { start: "1700000100", end: "1700000000" };
    expect(() => validatePackageBody(inverted)).toThrow(/start is after end/);
    const equal = clone(BODY);
    equal.evidenceTimeBounds = { start: "1700000000", end: "1700000000" };
    expect(validatePackageBody(equal).evidenceTimeBounds).toEqual({ start: "1700000000", end: "1700000000" });
  });
});

describe("assertMintablePackage — only the frozen D1 + D2 signer set is minted", () => {
  const D1 = { signer: `0x${"ab".repeat(20)}`, scheme: "secp256k1-eip712", sig: `0x${"11".repeat(65)}` };
  // D2 is now a REAL ed25519 signature from a deterministic test key (F1: the
  // old 0x22-repeated placeholder proved nothing). D1 stays shape-only for
  // now; see the STOP note above MINT_SIGNER_PROFILE.
  const DEVICE_SEED = "11".repeat(32);
  const OTHER_SEED = "22".repeat(32);
  const DEVICE_PUB = ed25519PublicKeyHexFromSeed(DEVICE_SEED);
  // A mintable body names its principals in the pinned forms, bound to D1 and D2,
  // and the registry holds D2's key for the producing kernel.
  const MINTABLE = clone(BODY);
  MINTABLE.producer.operatorPrincipalId = `eip155:${BODY.unitBinding.chainId}:${D1.signer}`;
  MINTABLE.producer.devicePrincipalId = `ed25519:${DEVICE_PUB}`;
  const BODY_HASH_RAW32 = Buffer.from(toBytes(computePackageBodyHash(MINTABLE)));
  const D2 = {
    signer: DEVICE_PUB,
    scheme: "ed25519-raw32",
    sig: `0x${signWithPrivateKeyHex(DEVICE_SEED, BODY_HASH_RAW32)!}`,
  };
  const REGISTRY = registryReturning({ algorithm: "ed25519", publicKey: DEVICE_PUB });
  const CHALLENGES = challengesReturning({
    nonce: MINTABLE.challengeBinding.nonce,
    tChallengeRef: MINTABLE.challengeBinding.tChallengeRef,
    state: "issued",
  });
  // F1 (D1 half): answers true only for the exact, unmutated D1 signer+sig above.
  const VERIFIER = verifierFor(D1.signer, D1.sig);

  it("accepts a real D1 + D2 set and hashes exactly what the digest function would", async () => {
    const minted = await assertMintablePackage(MINTABLE, [D2, D1], REGISTRY, CHALLENGES, VERIFIER);
    expect(minted).toBeInstanceOf(MintablePackage);
    expect(minted.signatures.map((s) => s.scheme)).toEqual(["secp256k1-eip712", "ed25519-raw32"]);
    expect(packageDigestV2Unchecked(minted.body, minted.signatures)).toBe(packageDigestV2Unchecked(MINTABLE, [D1, D2]));
  });

  // ── F1 (cross-family E9): D2's ed25519 signature is now cryptographically
  // verified over raw32(packageBodyHash). D1 is unchanged (shape-only; STOP).
  describe("F1 — D2 is cryptographically verified, not just shape-checked", () => {
    it("refuses random bytes as the D2 signature", async () => {
      const d2 = { ...D2, sig: `0x${"ab".repeat(64)}` }; // right shape, not a real signature
      await expect(assertMintablePackage(MINTABLE, [D1, d2], REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
      await expect(assertMintablePackage(MINTABLE, [D1, d2], REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(
        /D2 ed25519 signature does not verify/,
      );
    });

    it("refuses a real D2 signature over the WRONG body", async () => {
      const otherBody = clone(MINTABLE);
      otherBody.unitBinding.milestoneIndex = "999";
      const otherHashRaw32 = Buffer.from(toBytes(computePackageBodyHash(otherBody)));
      const wrongBodySig = { ...D2, sig: `0x${signWithPrivateKeyHex(DEVICE_SEED, otherHashRaw32)!}` };
      await expect(assertMintablePackage(MINTABLE, [D1, wrongBodySig], REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });

    it("refuses a real signature produced by the WRONG key", async () => {
      // Signed by OTHER_SEED's key, but the entry still CLAIMS signer = DEVICE_PUB.
      const wrongKeySig = { ...D2, sig: `0x${signWithPrivateKeyHex(OTHER_SEED, BODY_HASH_RAW32)!}` };
      await expect(assertMintablePackage(MINTABLE, [D1, wrongKeySig], REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });

    it("refuses a real signature over the ASCII-HEX STRING of packageBodyHash instead of its raw 32 bytes", async () => {
      const hexString = computePackageBodyHash(MINTABLE); // "0x" + 64 hex chars, as ASCII
      const asciiHexSig = {
        ...D2,
        sig: `0x${signWithPrivateKeyHex(DEVICE_SEED, Buffer.from(hexString, "utf8"))!}`,
      };
      await expect(assertMintablePackage(MINTABLE, [D1, asciiHexSig], REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });
  });

  // ── F1 (D1 half), cross-family E9 round 2: D1 is verified ONLY by the
  // injected OperatorSignatureVerifier. No production verifier exists yet
  // (see the STOP note above MINT_SIGNER_PROFILE in the source), so every
  // package is refused until one is wired in; these tests pin the exact
  // fail-closed rules of the injected seam itself, not any cryptography.
  describe("F1 (D1 half) — the operator's EIP-712 signature must be verified by an injected verifier, fail-closed", () => {
    it("refuses when no verifier is injected (undefined) — D1 cannot be verified yet", async () => {
      await expect(
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, undefined),
      ).rejects.toThrow(PackageNotMintableError);
      await expect(
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, undefined),
      ).rejects.toThrow(
        /D1 cannot be verified until the FinalMilestonePackageV2 EIP-712 struct is pinned/,
      );
    });

    it("refuses when the verifier is explicitly null", async () => {
      await expect(
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, null),
      ).rejects.toThrow(PackageNotMintableError);
    });

    it("refuses when the verifier returns false", async () => {
      const verifier: OperatorSignatureVerifier = { verifyOperatorSignature: async () => false };
      await expect(
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, verifier),
      ).rejects.toThrow(PackageNotMintableError);
    });

    it("refuses when the verifier returns a truthy non-true value — nothing is coerced", async () => {
      for (const notTrue of [1, "true"]) {
        const verifier = {
          verifyOperatorSignature: async () => notTrue,
        } as unknown as OperatorSignatureVerifier;
        await expect(
          assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, verifier),
          JSON.stringify(notTrue),
        ).rejects.toThrow(PackageNotMintableError);
      }
    });

    it("refuses when the verifier throws, converting it to PackageNotMintableError — never a different error type", async () => {
      const verifier: OperatorSignatureVerifier = {
        verifyOperatorSignature: () => {
          throw new RangeError("boom");
        },
      };
      await expect(
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, verifier),
      ).rejects.toBeInstanceOf(PackageNotMintableError);
      await assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, verifier).catch((e) => {
        expect(e).not.toBeInstanceOf(RangeError);
      });
    });

    it("refuses when the verifier's returned promise rejects — refused, not an unhandled rejection", async () => {
      const verifier: OperatorSignatureVerifier = {
        verifyOperatorSignature: async () => {
          throw new Error("async boom");
        },
      };
      await expect(
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, verifier),
      ).rejects.toBeInstanceOf(PackageNotMintableError);
    });

    it("mints when the verifier returns exactly true — the positive control", async () => {
      const minted = await assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, VERIFIER);
      expect(minted).toBeInstanceOf(MintablePackage);
    });

    it("passes the verifier the VALIDATED packageBodyHash, unitBinding and operatorPrincipalId — never a caller-suppliable stand-in", async () => {
      let received: OperatorSignatureVerifierInput | undefined;
      const spy: OperatorSignatureVerifier = {
        verifyOperatorSignature: async (input) => {
          received = input;
          return input.signer === D1.signer && input.sig === D1.sig;
        },
      };
      await assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, spy);
      expect(received?.packageBodyHash).toBe(computePackageBodyHash(MINTABLE));
      expect(received?.unitBinding).toEqual(MINTABLE.unitBinding);
      expect(received?.operatorPrincipalId).toBe(MINTABLE.producer.operatorPrincipalId);
      expect(received?.signer).toBe(D1.signer);
      expect(received?.sig).toBe(D1.sig);
    });
  });

  it("fails closed on the interim challenge nonce: nothing is minted until the durable challenge exists (F7)", async () => {
    // Everything else about this package is valid (it mints with a real nonce),
    // so the refusal below is the interim check and nothing else.
    await expect(assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, VERIFIER)).resolves.not.toThrow();
    const b = clone(MINTABLE);
    b.challengeBinding.nonce = INTERIM_NONCE;
    expect(b).toEqual({ ...MINTABLE, challengeBinding: { ...MINTABLE.challengeBinding, nonce: INTERIM_NONCE } });
    expect(isInterimNonce(b)).toBe(true);
    await expect(assertMintablePackage(b, [D1, D2], REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(PackageNotMintableError);
    await expect(assertMintablePackage(b, [D1, D2], REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(
      /\$\.challengeBinding\.nonce: is the interim placeholder/,
    );
  });

  it("refuses anything but exactly one D1 and one D2", async () => {
    for (const sigs of [[D1], [D1, D2, { ...D2, signer: `0x${"ef".repeat(32)}` }], [D1, { ...D1, signer: `0x${"cc".repeat(20)}` }], [{ ...D1, scheme: "secp256k1" }, D2], "D1,D2"]) {
      await expect(assertMintablePackage(MINTABLE, sigs, REGISTRY, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    }
  });

  it("refuses an extra key, a foreign scheme or a wrong-form signer or signature", async () => {
    const bad: unknown[] = [
      { ...D2, note: "x" },
      { ...D2, scheme: "ed25519" }, // a bare label says nothing about what was signed
      { ...D2, scheme: "secp256k1-eip712" },
      { ...D2, signer: `0x${"aa".repeat(20)}` }, // an address where the kernel key belongs
      { ...D2, signer: D2.signer.toUpperCase().replace("0X", "0x") },
      { ...D2, sig: `0x${"22".repeat(65)}` },
    ];
    for (const d2 of bad) {
      await expect(
        assertMintablePackage(MINTABLE, [D1, d2], REGISTRY, CHALLENGES, VERIFIER),
        JSON.stringify(d2),
      ).rejects.toThrow(PackageNotMintableError);
    }
  });

  it("the published golden's sample signature set is not a mintable set", async () => {
    // Its "ed25519" entry carries a 40-hex signer: fine as a digest vector,
    // never as a real kernel signature.
    await expect(
      assertMintablePackage(JSON.parse(GOLDEN.jcsBody), GOLDEN.rawSigs, REGISTRY, CHALLENGES, VERIFIER),
    ).rejects.toThrow(PackageNotMintableError);
  });

  it("refuses principal ids that are not the pinned forms bound to D1 and D2 (pcc.evidence.principal-id.v1)", async () => {
    const withProducer = (patch: Partial<typeof MINTABLE.producer>) => {
      const b = clone(MINTABLE);
      Object.assign(b.producer, patch);
      return b;
    };
    const cases: [string, typeof MINTABLE][] = [
      ["free-text operator", withProducer({ operatorPrincipalId: "op-1" })],
      ["operator not the D1 signer", withProducer({ operatorPrincipalId: `eip155:${BODY.unitBinding.chainId}:0x${"ee".repeat(20)}` })],
      ["operator on another chain", withProducer({ operatorPrincipalId: `eip155:1:${D1.signer}` })],
      ["checksum-case operator", withProducer({ operatorPrincipalId: `eip155:${BODY.unitBinding.chainId}:${D1.signer.toUpperCase().replace("0X", "0x")}` })],
      ["free-text device", withProducer({ devicePrincipalId: "dev-1" })],
      ["device not the D2 signer", withProducer({ devicePrincipalId: `ed25519:0x${"ef".repeat(32)}` })],
    ];
    for (const [name, b] of cases) {
      await expect(assertMintablePackage(b, [D1, D2], REGISTRY, CHALLENGES, VERIFIER), name).rejects.toThrow(
        PackageNotMintableError,
      );
    }
  });

  it("refuses a device principal the registry holds when the D2 signature is by another key", async () => {
    const other = `0x${"ef".repeat(32)}`;
    const b = clone(MINTABLE);
    b.producer.devicePrincipalId = `ed25519:${other}`;
    await expect(
      assertMintablePackage(b, [D1, D2], registryReturning({ algorithm: "ed25519", publicKey: other }), CHALLENGES, VERIFIER),
    ).rejects.toThrow(PackageNotMintableError);
  });

  it("refuses a device key the registry does not hold for the producing kernel", async () => {
    for (const registry of [
      registryReturning({ algorithm: "ed25519", publicKey: `0x${"ef".repeat(32)}` }),
      registryReturning(null),
      registryReturning({ algorithm: "secp256k1", address: D1.signer }),
    ]) {
      await expect(assertMintablePackage(MINTABLE, [D1, D2], registry, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    }
  });

  it("refuses a device principal whose secret is public, even when the registry and D2 agree", async () => {
    const leaked = [...COMPROMISED_DEVICE_PUBLIC_KEYS][0]!;
    const b = clone(MINTABLE);
    b.producer.devicePrincipalId = `ed25519:${leaked}`;
    const d2 = { ...D2, signer: leaked };
    await expect(
      assertMintablePackage(b, [D1, d2], registryReturning({ algorithm: "ed25519", publicKey: leaked }), CHALLENGES, VERIFIER),
    ).rejects.toThrow(PackageNotMintableError);
  });

  // ── F2 (cross-family E9): the registry binding is keyed by the VALIDATED
  // producer.kernelId, never a bare caller-asserted signer.
  describe("F2 — the kernel registry binding is authenticated, keyed by producer.kernelId", () => {
    it("refuses a kernelId renamed to another kernel's name when the registry maps it to a DIFFERENT key", async () => {
      // The reviewer's exact reproduction: kernelId swapped to "kernel-victim"
      // while the attacker's own D2 key is presented as if it were the answer.
      // D2's signature verifies fine (it is real, by the attacker's own key) —
      // the registry lookup, keyed by kernelId, is what must refuse this.
      const victimKey = `0x${"ef".repeat(32)}`;
      const b = clone(MINTABLE);
      b.producer.kernelId = "kernel-victim";
      const registry = registryFromMap({ "kernel-victim": { algorithm: "ed25519", publicKey: victimKey } });
      await expect(assertMintablePackage(b, [D1, D2], registry, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });

    it("refuses when the registry has no entry at all for the claimed kernelId", async () => {
      const registry = registryFromMap({}); // no kernel registered anywhere
      await expect(assertMintablePackage(MINTABLE, [D1, D2], registry, CHALLENGES, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });
  });

  // ── F4 (cross-family E9): freshness is authenticated against an issued,
  // unit-bound challenge record — nonzero is not proof of issuance.
  describe("F4 — challenge freshness is authenticated, not just nonzero", () => {
    it("refuses a nonzero nonce when no challenge record was ever issued", async () => {
      const b = clone(MINTABLE);
      b.challengeBinding.nonce = H("77"); // nonzero, attacker-chosen, never issued
      await expect(
        assertMintablePackage(b, [D1, D2], REGISTRY, challengesReturning(null), VERIFIER),
      ).rejects.toThrow(PackageNotMintableError);
    });

    it("refuses a record whose state is not 'issued' (e.g. already consumed)", async () => {
      const consumed = challengesReturning({
        nonce: MINTABLE.challengeBinding.nonce,
        tChallengeRef: MINTABLE.challengeBinding.tChallengeRef,
        state: "consumed",
      });
      await expect(assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, consumed, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });

    it("refuses when the issued record's nonce does not match the package's", async () => {
      const mismatched = challengesReturning({
        nonce: H("88"),
        tChallengeRef: MINTABLE.challengeBinding.tChallengeRef,
        state: "issued",
      });
      await expect(assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, mismatched, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });

    it("refuses when the issued record's tChallengeRef does not match the package's", async () => {
      const mismatched = challengesReturning({
        nonce: MINTABLE.challengeBinding.nonce,
        tChallengeRef: "a-different-challenge",
        state: "issued",
      });
      await expect(assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, mismatched, VERIFIER)).rejects.toThrow(
        PackageNotMintableError,
      );
    });
  });

  // ── evidence-lane round 3 (fixer-zulu), cross-family E9: three gaps found
  // by the evidence lane's own review of tango's and xray's work (not astra).
  // See triage-E9-358-fixer-tango.md, "Round 3 (fixer-zulu)".
  describe("evidence-lane round 3, finding 2 — the freeze is deep, not shallow", () => {
    it("mutating body.unitBinding after a successful assert throws (strict mode) and never moves the digest", async () => {
      const minted = await assertMintablePackage(MINTABLE, [D2, D1], REGISTRY, CHALLENGES, VERIFIER);
      const digestBefore = mintablePackageDigest(minted);
      expect(() => {
        (minted.body.unitBinding as { milestoneIndex: string }).milestoneIndex = "9";
      }).toThrow(TypeError);
      expect(minted.body.unitBinding.milestoneIndex).toBe(MINTABLE.unitBinding.milestoneIndex);
      expect(mintablePackageDigest(minted)).toBe(digestBefore);
    });

    it("mutating body.producer after a successful assert throws (strict mode) — every nested body object is frozen, not just unitBinding", async () => {
      const minted = await assertMintablePackage(MINTABLE, [D2, D1], REGISTRY, CHALLENGES, VERIFIER);
      expect(() => {
        (minted.body.producer as { kernelId: string }).kernelId = "kernel-attacker";
      }).toThrow(TypeError);
    });

    it("mutating a signature entry after a successful assert throws (strict mode) and never moves the digest", async () => {
      const minted = await assertMintablePackage(MINTABLE, [D2, D1], REGISTRY, CHALLENGES, VERIFIER);
      const digestBefore = mintablePackageDigest(minted);
      expect(() => {
        (minted.signatures[0] as { sig: string }).sig = `0x${"ff".repeat(65)}`;
      }).toThrow(TypeError);
      expect(mintablePackageDigest(minted)).toBe(digestBefore);
    });

    it("the freeze survives a caller replacing the global Object.freeze with a no-op, because the intrinsic was captured at module load", async () => {
      const realFreeze = Object.freeze;
      try {
        // @ts-expect-error -- deliberately breaking the global for this test
        Object.freeze = (x: unknown) => x;
        const minted = await assertMintablePackage(MINTABLE, [D2, D1], REGISTRY, CHALLENGES, VERIFIER);
        expect(() => {
          (minted.body.unitBinding as { milestoneIndex: string }).milestoneIndex = "9";
        }).toThrow(TypeError);
      } finally {
        Object.freeze = realFreeze;
      }
    });
  });

  describe("evidence-lane round 3, finding 3 — the validated body is frozen before any injected call, not after", () => {
    it("a ChallengeReader that tries to mutate the unitBinding it receives cannot change what gets minted", async () => {
      let attempted = false;
      let mutationThrew = false;
      const mutatingChallenges: ChallengeReader = {
        consumeIssued: async () => true,
        recordFor: async (unitBinding) => {
          attempted = true;
          try {
            (unitBinding as { milestoneIndex: string }).milestoneIndex = "9999";
          } catch {
            mutationThrew = true;
          }
          return {
            nonce: MINTABLE.challengeBinding.nonce,
            tChallengeRef: MINTABLE.challengeBinding.tChallengeRef,
            state: "issued",
          };
        },
      };
      const minted = await assertMintablePackage(MINTABLE, [D2, D1], REGISTRY, mutatingChallenges, VERIFIER);
      expect(attempted).toBe(true);
      expect(mutationThrew).toBe(true);
      expect(minted.body.unitBinding.milestoneIndex).toBe(MINTABLE.unitBinding.milestoneIndex);
    });

    it("the SAME frozen unitBinding reaches the D1 verifier too — a verifier that tries to mutate it also fails to change anything", async () => {
      let mutationThrew = false;
      const spyVerifier: OperatorSignatureVerifier = {
        verifyOperatorSignature: async (input) => {
          try {
            (input.unitBinding as { milestoneIndex: string }).milestoneIndex = "9999";
          } catch {
            mutationThrew = true;
          }
          return input.signer === D1.signer && input.sig === D1.sig;
        },
      };
      const minted = await assertMintablePackage(MINTABLE, [D2, D1], REGISTRY, CHALLENGES, spyVerifier);
      expect(mutationThrew).toBe(true);
      expect(minted.body.unitBinding.milestoneIndex).toBe(MINTABLE.unitBinding.milestoneIndex);
    });
  });

  // ── E9b (astra r2 on 425c0d39): reproductions, asserting the CORRECT behavior ──
  describe("E9b — the mint seam cannot be manufactured, and a challenge mints once", () => {
    it("E9b-1 CRITICAL: Reflect.construct cannot build a MintablePackage the digest accepts", () => {
      // astra's reproduction. At 425c0d39 this built a branded instance and the digest accepted it.
      expect(() => Reflect.construct(MintablePackage as unknown as Function, [clone(MINTABLE), [D1, D2]])).toThrow(PackageNotMintableError);
      let forged: unknown;
      try {
        forged = Reflect.construct(MintablePackage as unknown as Function, [clone(MINTABLE), [D1, D2]]);
      } catch {
        forged = undefined;
      }
      expect(() => mintablePackageDigest(forged as MintablePackage)).toThrow(PackageNotMintableError);
    });

    it("E9b-1 CRITICAL: new (MintablePackage as any)(...) cannot either", () => {
      let forged: unknown;
      try {
        forged = new (MintablePackage as unknown as new (...a: unknown[]) => unknown)(clone(MINTABLE), [D1, D2]);
      } catch {
        forged = undefined;
      }
      expect(() => mintablePackageDigest(forged as MintablePackage)).toThrow(PackageNotMintableError);
    });

    it("E9b-1 CRITICAL: replacing MintablePackage.isMintable cannot make a plain object digestible", () => {
      const original = Object.getOwnPropertyDescriptor(MintablePackage, "isMintable")!;
      let replaced = false;
      try {
        Object.defineProperty(MintablePackage, "isMintable", { value: () => true, configurable: true, writable: true });
        replaced = true;
      } catch {
        // a frozen class refuses the replacement, which is the point
      }
      try {
        const fake = { body: clone(MINTABLE), signatures: [D1, D2] } as unknown as MintablePackage;
        expect(() => mintablePackageDigest(fake)).toThrow(PackageNotMintableError);
      } finally {
        if (replaced) Object.defineProperty(MintablePackage, "isMintable", original);
      }
    });

    it("E9b-2 HIGH: two concurrent assertions with one issued challenge mint at most once", async () => {
      // astra's reader: answers the issued record every time and never consumes it.
      const issued = {
        nonce: MINTABLE.challengeBinding.nonce,
        tChallengeRef: MINTABLE.challengeBinding.tChallengeRef,
        state: "issued",
      };
      const challenges = { recordFor: async () => issued } as unknown as ChallengeReader;
      const results = await Promise.allSettled([
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, challenges, VERIFIER),
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, challenges, VERIFIER),
      ]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
    });

    it("E9b-2 HIGH: a second, sequential assertion with the same challenge does not mint again", async () => {
      const issued = {
        nonce: MINTABLE.challengeBinding.nonce,
        tChallengeRef: MINTABLE.challengeBinding.tChallengeRef,
        state: "issued",
      };
      const challenges = { recordFor: async () => issued } as unknown as ChallengeReader;
      const first = await assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, challenges, VERIFIER).then(() => "minted", () => "refused");
      const second = await assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, challenges, VERIFIER).then(() => "minted", () => "refused");
      expect([first, second].filter((r) => r === "minted").length).toBeLessThanOrEqual(1);
    });

    it("E9b-2 HIGH: with a one-use store, exactly one of two concurrent assertions mints", async () => {
      const store = oneUseChallenges(MINTABLE.challengeBinding);
      const results = await Promise.allSettled([
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, store, VERIFIER),
        assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, store, VERIFIER),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(PackageNotMintableError);
      expect(String(refused.reason.message)).toMatch(/mints at most once/);
    });

    it("E9b-2 HIGH: a reader without consumeIssued, or one answering anything but true, refuses", async () => {
      const issued = { ...MINTABLE.challengeBinding, state: "issued" };
      const readers: unknown[] = [
        { recordFor: async () => issued },
        { recordFor: async () => issued, consumeIssued: async () => false },
        { recordFor: async () => issued, consumeIssued: async () => 1 },
        { recordFor: async () => issued, consumeIssued: async () => "true" },
        { recordFor: async () => issued, consumeIssued: async () => { throw new Error("store down"); } },
      ];
      for (const r of readers) {
        await expect(assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, r as ChallengeReader, VERIFIER)).rejects.toThrow(
          PackageNotMintableError,
        );
      }
    });

    it("E9b-2 HIGH: the challenge is consumed LAST, so a package refused for another reason does not burn it", async () => {
      const store = oneUseChallenges(MINTABLE.challengeBinding);
      // No D1 verifier: refused at the D1 gate, before consumption.
      await expect(assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, store, null)).rejects.toThrow(PackageNotMintableError);
      expect(store.consumeCalls).toBe(0);
      // The same challenge then still mints once.
      await expect(assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, store, VERIFIER)).resolves.toBeInstanceOf(MintablePackage);
      expect(store.consumeCalls).toBe(1);
    });

    it("E9b-1: a genuinely minted package is in the registry; the class and its prototype are frozen", async () => {
      const minted = await assertMintablePackage(MINTABLE, [D1, D2], REGISTRY, CHALLENGES, VERIFIER);
      expect(isMintablePackage(minted)).toBe(true);
      expect(MintablePackage.isMintable(minted)).toBe(true);
      expect(Object.isFrozen(MintablePackage)).toBe(true);
      expect(Object.isFrozen(MintablePackage.prototype)).toBe(true);
      expect(isMintablePackage({ body: minted.body, signatures: minted.signatures })).toBe(false);
      expect(isMintablePackage(Object.create(MintablePackage.prototype))).toBe(false);
      expect(() => mintablePackageDigest(minted)).not.toThrow();
    });
  });
});

// ── read-once ────────────────────────────────────────────────────────────────
// validatePackageBody, packageDigestV2Unchecked and assertMintablePackage must read every
// input field exactly ONCE into a local copy and validate and hash only the
// copies, so no getter's second answer, and no change the caller makes after a
// check, can make what was checked differ from what was hashed.

type Counts = Record<string, number>;

/** A copy of a plain object whose every field is a getter that counts how often it is read. */
function counting(
  value: unknown,
  counts: Counts,
  path: string,
  answer?: (p: string, n: number, v: unknown) => unknown,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = `${path}.${k}`;
    const inner = counting(v, counts, p, answer);
    Object.defineProperty(out, k, {
      enumerable: true,
      get() {
        counts[p] = (counts[p] ?? 0) + 1;
        return answer ? answer(p, counts[p]!, inner) : inner;
      },
    });
  }
  return out;
}

/** The counts a function that reads every field of `value` exactly once leaves behind. */
function eachOnce(value: unknown, path: string): Counts {
  const out: Counts = {};
  const walk = (v: unknown, p: string) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return;
    for (const [k, x] of Object.entries(v)) {
      out[`${p}.${k}`] = 1;
      walk(x, `${p}.${k}`);
    }
  };
  walk(value, path);
  return out;
}

/** Answers the first read truthfully and every later read with a different, still well-formed, value. */
const flipLast = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
const flipLaterReads =
  (suffixes: readonly string[]) =>
  (p: string, n: number, v: unknown): unknown =>
    n >= 2 && typeof v === "string" && suffixes.some((s) => p.endsWith(s)) ? flipLast(v) : v;
const BODY_FLIPS = [".unitBinding.escrow", ".unitBinding.chainId", ".producer.kernelId", ".nonce", ".evidenceBlockHash"];

/** An array that counts reads of its length and of each index. */
function countingArray<T>(arr: T[], reads: Counts): T[] {
  return new Proxy(arr, {
    get(target, key, receiver) {
      const k = String(key);
      if (k === "length" || /^[0-9]+$/.test(k)) reads[k] = (reads[k] ?? 0) + 1;
      return Reflect.get(target, key, receiver);
    },
  });
}

describe("read-once: every input field is read exactly once and only the copies are validated and hashed", () => {
  const D1r = { signer: `0x${"ab".repeat(20)}`, scheme: "secp256k1-eip712", sig: `0x${"11".repeat(65)}` };
  const DEVICE_SEED_R = "33".repeat(32);
  const DEVICE_PUB_R = ed25519PublicKeyHexFromSeed(DEVICE_SEED_R);
  const MINT_BODY = clone(BODY);
  MINT_BODY.producer.operatorPrincipalId = `eip155:${BODY.unitBinding.chainId}:${D1r.signer}`;
  MINT_BODY.producer.devicePrincipalId = `ed25519:${DEVICE_PUB_R}`;
  const MINT_BODY_HASH_RAW32 = Buffer.from(toBytes(computePackageBodyHash(MINT_BODY)));
  const D2r = {
    signer: DEVICE_PUB_R,
    scheme: "ed25519-raw32",
    sig: `0x${signWithPrivateKeyHex(DEVICE_SEED_R, MINT_BODY_HASH_RAW32)!}`,
  };
  const REGISTRY_ED = { algorithm: "ed25519" as const, publicKey: DEVICE_PUB_R };
  const ISSUED_RECORD = {
    nonce: MINT_BODY.challengeBinding.nonce,
    tChallengeRef: MINT_BODY.challengeBinding.tChallengeRef,
    state: "issued" as const,
  };
  // F1 (D1 half): answers true only for the exact, unmutated D1r signer+sig below.
  const VERIFIER_R = verifierFor(D1r.signer, D1r.sig);

  it("validatePackageBody reads each of the body's fields exactly once and returns a copy the caller cannot reach", () => {
    const counts: Counts = {};
    const src = clone(BODY);
    const out = validatePackageBody(counting(src, counts, "$"));
    expect(counts).toEqual(eachOnce(BODY, "$"));
    // the result is a fresh object: changing the caller's input afterwards does not reach it
    src.unitBinding.chainId = "999";
    src.producer.kernelId = "changed";
    expect(out.unitBinding.chainId).toBe(BODY.unitBinding.chainId);
    expect(out.producer.kernelId).toBe(BODY.producer.kernelId);
  });

  it("validatePackageBody over fields that answer differently after the first read equals validatePackageBody over the first answers", () => {
    const flipping = counting(BODY, {}, "$", flipLaterReads(BODY_FLIPS));
    expect(validatePackageBody(flipping)).toEqual(validatePackageBody(BODY));
  });

  it("computePackageBodyHash and packageBodyJcs read each body field once and hash the first answers", () => {
    for (const [name, run] of [
      ["computePackageBodyHash", (b: unknown) => computePackageBodyHash(b)],
      ["packageBodyJcs", (b: unknown) => packageBodyJcs(b)],
    ] as Array<[string, (b: unknown) => unknown]>) {
      const counts: Counts = {};
      run(counting(BODY, counts, "$"));
      expect(counts, name).toEqual(eachOnce(BODY, "$"));
      expect(run(counting(BODY, {}, "$", flipLaterReads(BODY_FLIPS))), name).toEqual(run(BODY));
    }
  });

  it("packageDigestV2Unchecked reads each body field and each signature field once, and hashes the first answers", () => {
    const sigs = [D1r, D2r];
    const bodyCounts: Counts = {};
    const sigCounts: Counts = {};
    const arrayReads: Counts = {};
    const digest = packageDigestV2Unchecked(
      counting(BODY, bodyCounts, "$"),
      countingArray([counting(D1r, sigCounts, "$d1"), counting(D2r, sigCounts, "$d2")], arrayReads),
    );
    expect(bodyCounts).toEqual(eachOnce(BODY, "$"));
    expect(sigCounts).toEqual({ ...eachOnce(D1r, "$d1"), ...eachOnce(D2r, "$d2") });
    expect(arrayReads).toEqual({ length: 1, "0": 1, "1": 1 });
    expect(digest).toBe(packageDigestV2Unchecked(BODY, sigs));

    // a getter that answers differently the second time cannot move the digest off the first answers
    const flipSig = flipLaterReads([".signer"]);
    const flipped = packageDigestV2Unchecked(
      counting(BODY, {}, "$", flipLaterReads(BODY_FLIPS)),
      [counting(D1r, {}, "$d1", flipSig), counting(D2r, {}, "$d2", flipSig)],
    );
    expect(flipped).toBe(digest);
  });

  it("canonicalSignatures reads the list's length and each index once, each entry's fields once, and returns copies", () => {
    const counts: Counts = {};
    const arrayReads: Counts = {};
    const live = [clone(D1r), clone(D2r)];
    const out = canonicalSignatures(countingArray([counting(live[0], counts, "$d1"), counting(live[1], counts, "$d2")], arrayReads));
    expect(counts).toEqual({ ...eachOnce(D1r, "$d1"), ...eachOnce(D2r, "$d2") });
    expect(arrayReads).toEqual({ length: 1, "0": 1, "1": 1 });
    // the returned entries are not the caller's objects: a later change to them does not reach the result
    live[0]!.signer = `0x${"ee".repeat(20)}`;
    // Sorted by signer — NOT necessarily [D1r, D2r] in source order; D2r's
    // signer is now a real derived ed25519 key (F1) and may sort either side
    // of D1r's fake address, so compute the expected order the same way
    // canonicalSignatures does rather than hardcoding one.
    const expected = [D1r, D2r].sort((a, b) => (a.signer < b.signer ? -1 : a.signer > b.signer ? 1 : 0));
    expect(out).toEqual(expected);
  });

  it("assertMintablePackage reads each body field, signature field, list slot, registry field and challenge-record field once", async () => {
    for (const registry of [REGISTRY_ED, { algorithm: "secp256k1" as const, address: D1r.signer }]) {
      const body: Counts = {};
      const sigCounts: Counts = {};
      const arrayReads: Counts = {};
      const regCounts: Counts = {};
      const chalCounts: Counts = {};
      const wrappedRegistry = counting(registry, regCounts, "$reg");
      const wrappedRecord = counting(ISSUED_RECORD, chalCounts, "$chal");
      try {
        await assertMintablePackage(
          counting(MINT_BODY, body, "$"),
          countingArray([counting(D1r, sigCounts, "$d1"), counting(D2r, sigCounts, "$d2")], arrayReads),
          { signerForKernel: async () => wrappedRegistry as KernelRegistrySigner },
          { recordFor: async () => wrappedRecord as never, consumeIssued: async () => true },
          VERIFIER_R,
        );
      } catch {
        // the secp256k1 registry is refused (it is not the device key); the reads still must be single
      }
      expect(body, registry.algorithm).toEqual(eachOnce(MINT_BODY, "$"));
      expect(sigCounts, registry.algorithm).toEqual({ ...eachOnce(D1r, "$d1"), ...eachOnce(D2r, "$d2") });
      expect(arrayReads, registry.algorithm).toEqual({ length: 1, "0": 1, "1": 1 });
      expect(regCounts, registry.algorithm).toEqual(eachOnce(registry, "$reg"));
      // The secp256k1 registry case throws at the registry-binding check (F2),
      // before the challenge (F4) is ever consulted — zero reads there is
      // correct, not a miscount. The ed25519 case reaches F4 and reads it once.
      if (registry.algorithm === "ed25519") {
        expect(chalCounts, registry.algorithm).toEqual(eachOnce(ISSUED_RECORD, "$chal"));
      } else {
        expect(chalCounts, registry.algorithm).toEqual({});
      }
    }
  });

  it("assertMintablePackage over fields that answer differently after the first read returns exactly what it returns over the first answers", async () => {
    const first = await assertMintablePackage(
      MINT_BODY,
      [D1r, D2r],
      registryReturning(REGISTRY_ED),
      challengesReturning(ISSUED_RECORD),
      VERIFIER_R,
    );
    const flipSig = flipLaterReads([".signer", ".sig"]);
    const flippedRegistry = counting(REGISTRY_ED, {}, "$reg", flipLaterReads([".publicKey"]));
    const flippedRecord = counting(ISSUED_RECORD, {}, "$chal", flipLaterReads([".nonce", ".tChallengeRef"]));
    const flipped = await assertMintablePackage(
      counting(MINT_BODY, {}, "$", flipLaterReads([".unitBinding.escrow", ".producer.kernelId", ".nonce"])),
      [counting(D1r, {}, "$d1", flipSig), counting(D2r, {}, "$d2", flipSig)],
      { signerForKernel: async () => flippedRegistry as KernelRegistrySigner },
      { recordFor: async () => flippedRecord as never, consumeIssued: async () => true },
      VERIFIER_R,
    );
    expect(flipped).toEqual(first);
  });

  it("assertMintablePackage returns copies: changing the caller's inputs after the call does not reach the result", async () => {
    const body = clone(MINT_BODY);
    const sigs = [clone(D1r), clone(D2r)];
    const out = await assertMintablePackage(
      body,
      sigs,
      registryReturning(REGISTRY_ED),
      challengesReturning(ISSUED_RECORD),
      VERIFIER_R,
    );
    const snapshot = JSON.stringify(out);
    body.unitBinding.chainId = "1";
    body.producer.kernelId = "changed";
    sigs[0]!.sig = `0x${"ff".repeat(65)}`;
    sigs[1]!.signer = `0x${"ee".repeat(32)}`;
    expect(JSON.stringify(out)).toBe(snapshot);
  });

  it("a scheme named like an Object.prototype key is a typed refusal, not a crash", async () => {
    for (const scheme of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const registry = registryReturning(REGISTRY_ED);
      const challenges = challengesReturning(ISSUED_RECORD);
      await expect(
        assertMintablePackage(MINT_BODY, [{ ...D1r, scheme }, D2r], registry, challenges, VERIFIER_R),
        scheme,
      ).rejects.toThrow(PackageNotMintableError);
      await expect(
        assertMintablePackage(MINT_BODY, [{ ...D1r, scheme }, D2r], registry, challenges, VERIFIER_R),
        scheme,
      ).rejects.toThrow(/\.scheme: must be/);
    }
  });
});

describe("rules the published golden blocks (STOPPED, not applied)", () => {
  // The golden's body is evidence's SAMPLE vector and carries the free-text
  // principal ids "op-golden" / "dev-golden"; its packageBodyHash 0x94a48c16... and
  // packageDigestV2Unchecked 0xf78103a1... must stay byte-identical, so validatePackageBody
  // can only require them to be non-empty. The mint guard above pins them.
  it.todo("validatePackageBody pins operatorPrincipalId and devicePrincipalId to the #399 forms (parseOperatorPrincipalId, parseDevicePrincipalId)");
});

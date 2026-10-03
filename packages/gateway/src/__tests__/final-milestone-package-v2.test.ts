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
  type FinalMilestonePackageV2Body,
} from "../settlement/final-milestone-package-v2.js";
import { packageDigestV2, canonicalSignatures, type PackageSignature } from "../settlement/package-digest-v2.js";
import { COMPROMISED_DEVICE_PUBLIC_KEYS } from "@pcc/spec";

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
    ["packageDigestV2", (b) => packageDigestV2(b, SIGS)],
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
    expect(() => packageDigestV2(eip55, SIGS)).toThrow(PackageBodyValidationError);
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

describe("packageBodyHash vs packageDigestV2 — two DIFFERENT hashes", () => {
  it("are not the same value, and must never be confused", () => {
    // The operator and kernel sign packageBodyHash. `raw.packageHash` must equal
    // packageDigestV2. Signing the wrong one yields signatures that verify
    // against nothing — at mint, with funds in escrow.
    const sigs: PackageSignature[] = [
      { signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0xop" },
      { signer: SIGNER_KERNEL, scheme: "ed25519-raw32", sig: "0xkernel" },
    ];
    expect(computePackageBodyHash(BODY)).not.toBe(packageDigestV2(BODY, sigs));
  });

  it("packageBodyHash does NOT depend on the signatures; packageDigestV2 does", () => {
    const kernel: PackageSignature = { signer: SIGNER_KERNEL, scheme: "ed25519-raw32", sig: "0xkernel" };
    const s1: PackageSignature[] = [{ signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0x1" }, kernel];
    const s2: PackageSignature[] = [{ signer: SIGNER_OP, scheme: "secp256k1-eip712", sig: "0x2" }, kernel];
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

  it("packageDigestV2 over the same body matches the golden", () => {
    expect(packageDigestV2(body, GOLDEN.rawSigs)).toBe(GOLDEN.packageDigestV2);
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
      expect(() => packageDigestV2(b, sigs), key).toThrow(/must not be empty/);
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
  const D2 = { signer: `0x${"cd".repeat(32)}`, scheme: "ed25519-raw32", sig: `0x${"22".repeat(64)}` };
  // A mintable body names its principals in the pinned forms, bound to D1 and D2,
  // and the registry holds D2's key for the producing kernel.
  const MINTABLE = clone(BODY);
  MINTABLE.producer.operatorPrincipalId = `eip155:${BODY.unitBinding.chainId}:${D1.signer}`;
  MINTABLE.producer.devicePrincipalId = `ed25519:${D2.signer}`;
  const REGISTRY = { algorithm: "ed25519", publicKey: D2.signer };

  it("accepts a real D1 + D2 set and hashes exactly what the digest function would", () => {
    const minted = assertMintablePackage(MINTABLE, [D2, D1], REGISTRY);
    expect(minted.signatures.map((s) => s.scheme)).toEqual(["secp256k1-eip712", "ed25519-raw32"]);
    expect(packageDigestV2(minted.body, minted.signatures)).toBe(packageDigestV2(MINTABLE, [D1, D2]));
  });

  it("fails closed on the interim challenge nonce: nothing is minted until the durable challenge exists (F7)", () => {
    // Everything else about this package is valid (it mints with a real nonce),
    // so the refusal below is the interim check and nothing else.
    expect(() => assertMintablePackage(MINTABLE, [D1, D2], REGISTRY)).not.toThrow();
    const b = clone(MINTABLE);
    b.challengeBinding.nonce = INTERIM_NONCE;
    expect(b).toEqual({ ...MINTABLE, challengeBinding: { ...MINTABLE.challengeBinding, nonce: INTERIM_NONCE } });
    expect(isInterimNonce(b)).toBe(true);
    expect(() => assertMintablePackage(b, [D1, D2], REGISTRY)).toThrow(PackageNotMintableError);
    expect(() => assertMintablePackage(b, [D1, D2], REGISTRY)).toThrow(/\$\.challengeBinding\.nonce: is the interim placeholder/);
  });

  it("refuses anything but exactly one D1 and one D2", () => {
    for (const sigs of [[D1], [D1, D2, { ...D2, signer: `0x${"ef".repeat(32)}` }], [D1, { ...D1, signer: `0x${"cc".repeat(20)}` }], [{ ...D1, scheme: "secp256k1" }, D2], "D1,D2"]) {
      expect(() => assertMintablePackage(MINTABLE, sigs, REGISTRY)).toThrow(PackageNotMintableError);
    }
  });

  it("refuses an extra key, a foreign scheme or a wrong-form signer or signature", () => {
    const bad: unknown[] = [
      { ...D2, note: "x" },
      { ...D2, scheme: "ed25519" }, // a bare label says nothing about what was signed
      { ...D2, scheme: "secp256k1-eip712" },
      { ...D2, signer: `0x${"aa".repeat(20)}` }, // an address where the kernel key belongs
      { ...D2, signer: D2.signer.toUpperCase().replace("0X", "0x") },
      { ...D2, sig: `0x${"22".repeat(65)}` },
    ];
    for (const d2 of bad) {
      expect(() => assertMintablePackage(MINTABLE, [D1, d2], REGISTRY), JSON.stringify(d2)).toThrow(PackageNotMintableError);
    }
  });

  it("the published golden's sample signature set is not a mintable set", () => {
    // Its "ed25519" entry carries a 40-hex signer: fine as a digest vector,
    // never as a real kernel signature.
    expect(() => assertMintablePackage(JSON.parse(GOLDEN.jcsBody), GOLDEN.rawSigs, REGISTRY)).toThrow(PackageNotMintableError);
  });

  it("refuses principal ids that are not the pinned forms bound to D1 and D2 (pcc.evidence.principal-id.v1)", () => {
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
      expect(() => assertMintablePackage(b, [D1, D2], REGISTRY), name).toThrow(PackageNotMintableError);
    }
  });

  it("refuses a device principal the registry holds when the D2 signature is by another key", () => {
    const other = `0x${"ef".repeat(32)}`;
    const b = clone(MINTABLE);
    b.producer.devicePrincipalId = `ed25519:${other}`;
    expect(() => assertMintablePackage(b, [D1, D2], { algorithm: "ed25519", publicKey: other })).toThrow(PackageNotMintableError);
  });

  it("refuses a device key the registry does not hold for the producing kernel", () => {
    for (const registry of [{ algorithm: "ed25519", publicKey: `0x${"ef".repeat(32)}` }, null, { algorithm: "secp256k1", address: D1.signer }]) {
      expect(() => assertMintablePackage(MINTABLE, [D1, D2], registry), JSON.stringify(registry)).toThrow(PackageNotMintableError);
    }
  });

  it("refuses a device principal whose secret is public, even when the registry and D2 agree", () => {
    const leaked = [...COMPROMISED_DEVICE_PUBLIC_KEYS][0]!;
    const b = clone(MINTABLE);
    b.producer.devicePrincipalId = `ed25519:${leaked}`;
    const d2 = { ...D2, signer: leaked };
    expect(() => assertMintablePackage(b, [D1, d2], { algorithm: "ed25519", publicKey: leaked })).toThrow(PackageNotMintableError);
  });
});

// ── read-once ────────────────────────────────────────────────────────────────
// validatePackageBody, packageDigestV2 and assertMintablePackage must read every
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
  const D2r = { signer: `0x${"cd".repeat(32)}`, scheme: "ed25519-raw32", sig: `0x${"22".repeat(64)}` };
  const MINT_BODY = clone(BODY);
  MINT_BODY.producer.operatorPrincipalId = `eip155:${BODY.unitBinding.chainId}:${D1r.signer}`;
  MINT_BODY.producer.devicePrincipalId = `ed25519:${D2r.signer}`;
  const REGISTRY_ED = { algorithm: "ed25519", publicKey: D2r.signer };

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

  it("packageDigestV2 reads each body field and each signature field once, and hashes the first answers", () => {
    const sigs = [D1r, D2r];
    const bodyCounts: Counts = {};
    const sigCounts: Counts = {};
    const arrayReads: Counts = {};
    const digest = packageDigestV2(
      counting(BODY, bodyCounts, "$"),
      countingArray([counting(D1r, sigCounts, "$d1"), counting(D2r, sigCounts, "$d2")], arrayReads),
    );
    expect(bodyCounts).toEqual(eachOnce(BODY, "$"));
    expect(sigCounts).toEqual({ ...eachOnce(D1r, "$d1"), ...eachOnce(D2r, "$d2") });
    expect(arrayReads).toEqual({ length: 1, "0": 1, "1": 1 });
    expect(digest).toBe(packageDigestV2(BODY, sigs));

    // a getter that answers differently the second time cannot move the digest off the first answers
    const flipSig = flipLaterReads([".signer"]);
    const flipped = packageDigestV2(
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
    expect(out).toEqual([D1r, D2r]);
  });

  it("assertMintablePackage reads each body field, signature field, list slot and registry field once", () => {
    for (const registry of [REGISTRY_ED, { algorithm: "secp256k1", address: D1r.signer }]) {
      const body: Counts = {};
      const sigCounts: Counts = {};
      const arrayReads: Counts = {};
      const regCounts: Counts = {};
      try {
        assertMintablePackage(
          counting(MINT_BODY, body, "$"),
          countingArray([counting(D1r, sigCounts, "$d1"), counting(D2r, sigCounts, "$d2")], arrayReads),
          counting(registry, regCounts, "$reg"),
        );
      } catch {
        // the secp256k1 registry is refused (it is not the device key); the reads still must be single
      }
      expect(body, registry.algorithm).toEqual(eachOnce(MINT_BODY, "$"));
      expect(sigCounts, registry.algorithm).toEqual({ ...eachOnce(D1r, "$d1"), ...eachOnce(D2r, "$d2") });
      expect(arrayReads, registry.algorithm).toEqual({ length: 1, "0": 1, "1": 1 });
      expect(regCounts, registry.algorithm).toEqual(eachOnce(registry, "$reg"));
    }
  });

  it("assertMintablePackage over fields that answer differently after the first read returns exactly what it returns over the first answers", () => {
    const first = assertMintablePackage(MINT_BODY, [D1r, D2r], REGISTRY_ED);
    const flipSig = flipLaterReads([".signer", ".sig"]);
    const flipped = assertMintablePackage(
      counting(MINT_BODY, {}, "$", flipLaterReads([".unitBinding.escrow", ".producer.kernelId", ".nonce"])),
      [counting(D1r, {}, "$d1", flipSig), counting(D2r, {}, "$d2", flipSig)],
      counting(REGISTRY_ED, {}, "$reg", flipLaterReads([".publicKey"])),
    );
    expect(flipped).toEqual(first);
  });

  it("assertMintablePackage returns copies: changing the caller's inputs after the call does not reach the result", () => {
    const body = clone(MINT_BODY);
    const sigs = [clone(D1r), clone(D2r)];
    const out = assertMintablePackage(body, sigs, REGISTRY_ED);
    const snapshot = JSON.stringify(out);
    body.unitBinding.chainId = "1";
    body.producer.kernelId = "changed";
    sigs[0]!.sig = `0x${"ff".repeat(65)}`;
    sigs[1]!.signer = `0x${"ee".repeat(32)}`;
    expect(JSON.stringify(out)).toBe(snapshot);
  });

  it("a scheme named like an Object.prototype key is a typed refusal, not a crash", () => {
    for (const scheme of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(() => assertMintablePackage(MINT_BODY, [{ ...D1r, scheme }, D2r], REGISTRY_ED), scheme).toThrow(PackageNotMintableError);
      expect(() => assertMintablePackage(MINT_BODY, [{ ...D1r, scheme }, D2r], REGISTRY_ED), scheme).toThrow(/\.scheme: must be/);
    }
  });
});

describe("rules the published golden blocks (STOPPED, not applied)", () => {
  // The golden's body is evidence's SAMPLE vector and carries the free-text
  // principal ids "op-golden" / "dev-golden"; its packageBodyHash 0x94a48c16... and
  // packageDigestV2 0xf78103a1... must stay byte-identical, so validatePackageBody
  // can only require them to be non-empty. The mint guard above pins them.
  it.todo("validatePackageBody pins operatorPrincipalId and devicePrincipalId to the #399 forms (parseOperatorPrincipalId, parseDevicePrincipalId)");
});

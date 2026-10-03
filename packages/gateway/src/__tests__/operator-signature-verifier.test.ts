/**
 * createEip712OperatorVerifier — golden-vector and end-to-end tests for the production D1
 * (operator) EIP-712 verifier injected into FinalMilestonePackageV2's mint guard.
 *
 * Fixture: `fixtures/finalmilestonepackage-v2-d1-eip712.vectors.json`, copied BYTE-IDENTICAL
 * from #270 @59f6c45f (see the sibling `.source.md` for the exact source path). This file
 * re-asserts that copy's sha256 below, so a drift between the two is caught as a test failure,
 * never silently tested against a stale struct/domain.
 *
 * Contract: `returns/pcc-evidence-work/d1-eip712-struct-proposal.md`, RATIFIED by the oracle
 * (bus #5773) and escrow (bus #5785), 2026-10-03.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { createEip712OperatorVerifier } from "../settlement/operator-signature-verifier.js";
import {
  assertMintablePackage,
  computePackageBodyHash,
  MintablePackage,
  PackageNotMintableError,
  PACKAGE_SCHEMA_VERSION,
  PACKAGE_FORMAT,
  type Hex,
  type FinalMilestonePackageV2Body,
  type UnitBinding,
  type KernelRegistryReader,
  type ChallengeReader,
  type OperatorSignatureVerifierInput,
} from "../settlement/final-milestone-package-v2.js";
import { signWithPrivateKeyHex } from "../auth/ed25519.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(HERE, "fixtures/finalmilestonepackage-v2-d1-eip712.vectors.json");
const VECTORS_RAW = readFileSync(VECTORS_PATH, "utf8");

/** sha256 of the #270 @59f6c45f source file, pinned in the sibling `.source.md`. A drift in
 *  either copy changes this, which fails the very first test below before anything else runs. */
const VECTORS_SHA256 = "0323924ae3f9676302ed156968e344f9259309d3184fdcbd52c718b52da80d6c";

interface VectorMessage {
  chainId: string;
  escrow: string;
  settlementUnitId: string;
  jobIdHash: string;
  milestoneIndex: string;
  stepId: string;
  compositionRoot: string;
  acceptedEnvelopeHash: string;
  packageBodyHash: string;
}
interface VectorDomain {
  name: string;
  version: string;
  chainId: string;
  verifyingContract: string;
}
interface VectorNegative {
  name: string;
  domain: VectorDomain;
  message: VectorMessage;
  signature: { full: string };
  claimedOperatorPrincipalId: string;
  expected: { accepted: boolean };
}
interface D1Vectors {
  keys: {
    operator: { privateKey: string; address: string };
    nonOperator: { privateKey: string; address: string };
  };
  positive: {
    message: VectorMessage;
    signature: { full: string };
    operatorPrincipalId: string;
    signerLabel: string;
    expected: { accepted: boolean };
  };
  negatives: VectorNegative[];
}

const VECTORS = JSON.parse(VECTORS_RAW) as D1Vectors;

const OPERATOR_ADDRESS_LOWER = VECTORS.keys.operator.address.toLowerCase() as Hex;
const NON_OPERATOR_ADDRESS_LOWER = VECTORS.keys.nonOperator.address.toLowerCase() as Hex;

/** An `operatorForUnit` that always answers the same address, regardless of unitBinding — every
 *  vector (positive and negative alike) shares the SAME golden operator as its "expectedOperator",
 *  matching the mirror's own fixed `expectedOperator` parameter (see finalmilestonepackage-v2-d1-
 *  eip712-mirror.cjs's `verifyD1`/`verifyD1Entry` call sites, read-only, in wt-evidence-270). */
function operatorForUnitAlways(address: string) {
  return (_unitBinding: UnitBinding) => address;
}

function unitBindingFromMessage(m: VectorMessage): UnitBinding {
  return {
    chainId: m.chainId,
    escrow: m.escrow as Hex,
    settlementUnitId: m.settlementUnitId as Hex,
    jobIdHash: m.jobIdHash as Hex,
    milestoneIndex: m.milestoneIndex,
    stepId: m.stepId as Hex,
    compositionRoot: m.compositionRoot as Hex,
    acceptedEnvelopeHash: m.acceptedEnvelopeHash as Hex,
  };
}

describe("fixture integrity", () => {
  it("the mirrored fixture's sha256 matches #270 @59f6c45f's source file (see the sibling .source.md)", () => {
    expect(createHash("sha256").update(VECTORS_RAW).digest("hex")).toBe(VECTORS_SHA256);
  });
});

describe("createEip712OperatorVerifier — golden vectors (#270 @59f6c45f: 1 positive + 15 negatives)", () => {
  it("POSITIVE: accepts the golden operator signature", async () => {
    const verifier = createEip712OperatorVerifier({ operatorForUnit: operatorForUnitAlways(OPERATOR_ADDRESS_LOWER) });
    const input: OperatorSignatureVerifierInput = {
      unitBinding: unitBindingFromMessage(VECTORS.positive.message),
      packageBodyHash: VECTORS.positive.message.packageBodyHash as Hex,
      operatorPrincipalId: VECTORS.positive.operatorPrincipalId,
      signer: VECTORS.positive.signerLabel as Hex,
      sig: VECTORS.positive.signature.full as Hex,
    };
    await expect(verifier.verifyOperatorSignature(input)).resolves.toBe(true);
  });

  // 13 of the 15 negatives map 1:1 onto `input` from the vector's own `message` (the 8
  // unitBinding fields + packageBodyHash), `signature.full` and `claimedOperatorPrincipalId`.
  // The claimed D1 signer LABEL is the golden operator address for every one of the 15 (the
  // mirror's own default: none of its `pushNeg`/`verifyD1Entry` call sites for these 13
  // override `claimedSignerLabel`; see d1-eip712-struct-proposal.md and the read-only mirror).
  const DIRECT_MAP_NEGATIVES = [
    "high-s",
    "v-29",
    "v-raw-recid-0",
    "v-raw-recid-1",
    "eip2098-compact-64-byte",
    "r-zero",
    "s-zero",
    "mutated-milestoneIndex",
    "mutated-stepId",
    "mutated-packageBodyHash",
    "valid-signature-non-operator-key",
    "eip191-personal-sign-over-same-digest",
    "operatorPrincipalId-checksummed-case",
  ] as const;

  for (const name of DIRECT_MAP_NEGATIVES) {
    it(`NEGATIVE ${name}: refused`, async () => {
      const vector = VECTORS.negatives.find((n) => n.name === name);
      expect(vector, `vector "${name}" must exist in the fixture`).toBeDefined();
      const verifier = createEip712OperatorVerifier({ operatorForUnit: operatorForUnitAlways(OPERATOR_ADDRESS_LOWER) });
      const input: OperatorSignatureVerifierInput = {
        unitBinding: unitBindingFromMessage(vector!.message),
        packageBodyHash: vector!.message.packageBodyHash as Hex,
        operatorPrincipalId: vector!.claimedOperatorPrincipalId,
        signer: OPERATOR_ADDRESS_LOWER,
        sig: vector!.signature.full as Hex,
      };
      await expect(verifier.verifyOperatorSignature(input)).resolves.toBe(false);
    });
  }

  // The remaining 2 negatives ("wrong-domain-chainId", "wrong-verifyingContract") pose a
  // MISMATCHED domain against an unchanged struct — a knob the mirror's generic
  // verifyD1(digest, sig, expectedOperator) has (it takes an arbitrary pre-built digest) but
  // THIS module's actual API does not: createEip712OperatorVerifier has no separate "domain
  // chainId" / "domain verifyingContract" input, because the ratified contract makes them the
  // SAME fields as unitBinding.chainId / unitBinding.escrow, always, by construction (see the
  // module doc in operator-signature-verifier.ts). So these two are ADAPTED, not byte-replayed:
  // each takes the vector's own unitBinding (from `message`, otherwise unchanged) and overrides
  // EXACTLY the one field the vector's `domain` diverges on, reusing the vector's own (now
  // stale) positive signature. That is the faithful way to pose "a signature signed for one
  // chain id / escrow, replayed against a verifier configured for a different one" through this
  // module's real input shape. The resulting digest necessarily differs from the vector's own
  // stated `digest` field (this module has no independent domain knob to reproduce that exact
  // value), but the property under test — the stale signature must not verify — is the same
  // one the vector pins, and the assertion is the same boolean the vector expects: refused.
  it("NEGATIVE wrong-domain-chainId (adapted): a signature over a different chain id's digest does not recover the operator", async () => {
    const vector = VECTORS.negatives.find((n) => n.name === "wrong-domain-chainId");
    expect(vector).toBeDefined();
    const verifier = createEip712OperatorVerifier({ operatorForUnit: operatorForUnitAlways(OPERATOR_ADDRESS_LOWER) });
    // The principal id names the OTHER chain too, so rule 6 holds and only the digest's chain id
    // binding can refuse (with the vector's own eip155:8453 principal id, rule 6 alone would).
    const input: OperatorSignatureVerifierInput = {
      unitBinding: { ...unitBindingFromMessage(vector!.message), chainId: vector!.domain.chainId },
      packageBodyHash: vector!.message.packageBodyHash as Hex,
      operatorPrincipalId: `eip155:${vector!.domain.chainId}:${OPERATOR_ADDRESS_LOWER}`,
      signer: OPERATOR_ADDRESS_LOWER,
      sig: vector!.signature.full as Hex,
    };
    await expect(verifier.verifyOperatorSignature(input)).resolves.toBe(false);
  });

  it("NEGATIVE wrong-verifyingContract (adapted): a signature over a different escrow's digest does not recover the operator", async () => {
    const vector = VECTORS.negatives.find((n) => n.name === "wrong-verifyingContract");
    expect(vector).toBeDefined();
    const verifier = createEip712OperatorVerifier({ operatorForUnit: operatorForUnitAlways(OPERATOR_ADDRESS_LOWER) });
    const input: OperatorSignatureVerifierInput = {
      unitBinding: { ...unitBindingFromMessage(vector!.message), escrow: vector!.domain.verifyingContract as Hex },
      packageBodyHash: vector!.message.packageBodyHash as Hex,
      operatorPrincipalId: vector!.claimedOperatorPrincipalId,
      signer: OPERATOR_ADDRESS_LOWER,
      sig: vector!.signature.full as Hex,
    };
    await expect(verifier.verifyOperatorSignature(input)).resolves.toBe(false);
  });

  it("exactly 15 negative vectors are present in the fixture, and every one is covered above", () => {
    expect(VECTORS.negatives).toHaveLength(15);
    const covered = [...DIRECT_MAP_NEGATIVES, "wrong-domain-chainId", "wrong-verifyingContract"].sort();
    expect(VECTORS.negatives.map((n) => n.name).sort()).toEqual(covered);
  });
});

describe("createEip712OperatorVerifier — the injected operatorForUnit dependency (rule 5)", () => {
  function baseInput(): OperatorSignatureVerifierInput {
    return {
      unitBinding: unitBindingFromMessage(VECTORS.positive.message),
      packageBodyHash: VECTORS.positive.message.packageBodyHash as Hex,
      operatorPrincipalId: VECTORS.positive.operatorPrincipalId,
      signer: VECTORS.positive.signerLabel as Hex,
      sig: VECTORS.positive.signature.full as Hex,
    };
  }

  it("refuses when operatorForUnit answers null", async () => {
    const verifier = createEip712OperatorVerifier({ operatorForUnit: () => null });
    await expect(verifier.verifyOperatorSignature(baseInput())).resolves.toBe(false);
  });

  it("refuses when operatorForUnit answers a different (non-operator) address", async () => {
    const verifier = createEip712OperatorVerifier({ operatorForUnit: operatorForUnitAlways(NON_OPERATOR_ADDRESS_LOWER) });
    await expect(verifier.verifyOperatorSignature(baseInput())).resolves.toBe(false);
  });

  it("refuses when operatorForUnit throws synchronously — converted to false, never rethrown", async () => {
    const verifier = createEip712OperatorVerifier({
      operatorForUnit: () => {
        throw new Error("chain read boom");
      },
    });
    await expect(verifier.verifyOperatorSignature(baseInput())).resolves.toBe(false);
  });

  it("refuses when operatorForUnit's returned promise rejects — converted to false, never an unhandled rejection", async () => {
    const verifier = createEip712OperatorVerifier({
      operatorForUnit: async () => {
        throw new Error("async chain read boom");
      },
    });
    await expect(verifier.verifyOperatorSignature(baseInput())).resolves.toBe(false);
  });

  it("accepts when operatorForUnit resolves asynchronously to the real operator (positive control)", async () => {
    const verifier = createEip712OperatorVerifier({ operatorForUnit: async () => OPERATOR_ADDRESS_LOWER });
    await expect(verifier.verifyOperatorSignature(baseInput())).resolves.toBe(true);
  });
});

describe("createEip712OperatorVerifier — the claimed D1 signer label (rule 4)", () => {
  it("refuses when the signer label differs from the recovered address, even though the signature and operatorForUnit are both otherwise correct", async () => {
    const verifier = createEip712OperatorVerifier({ operatorForUnit: operatorForUnitAlways(OPERATOR_ADDRESS_LOWER) });
    const input: OperatorSignatureVerifierInput = {
      unitBinding: unitBindingFromMessage(VECTORS.positive.message),
      packageBodyHash: VECTORS.positive.message.packageBodyHash as Hex,
      operatorPrincipalId: VECTORS.positive.operatorPrincipalId,
      signer: NON_OPERATOR_ADDRESS_LOWER, // claims the WRONG label
      sig: VECTORS.positive.signature.full as Hex, // but the signature really is the operator's
    };
    await expect(verifier.verifyOperatorSignature(input)).resolves.toBe(false);
  });
});

// ── End to end: a FRESH, self-consistent mintable package, signed for real, verified through
//    assertMintablePackage with createEip712OperatorVerifier wired in as the D1 verifier. ──
describe("end to end — assertMintablePackage with createEip712OperatorVerifier wired in", () => {
  const H = (n: string) => `0x${n.repeat(64).slice(0, 64)}` as Hex;

  // The golden operator's REAL secp256k1 key (deterministic, public test data — see the
  // fixture's `keys.operator`), now used to sign for real via viem's local-account signer. This
  // reuses the SAME operator identity as the golden-vector tests above, over a FRESH body/unit
  // (own challenge nonce, own kernel, own evidence hash) so this block also exercises D2 / the
  // kernel registry / the challenge reader exactly like the existing assertMintablePackage
  // tests in final-milestone-package-v2.test.ts do (ed25519PublicKeyHexFromSeed +
  // signWithPrivateKeyHex for D2, a registry/challenge test double each) — reimplemented here
  // since that file does not export its private test helpers.
  const operatorAccount = privateKeyToAccount(VECTORS.keys.operator.privateKey as Hex);

  /** Mirrors `ed25519PublicKeyHexFromSeed` in final-milestone-package-v2.test.ts: a deterministic
   *  Ed25519 public key (hex) from a 32-byte hex seed, via node:crypto's PKCS8/SPKI plumbing. */
  function ed25519PublicKeyHexFromSeed(seedHex: string): string {
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const pkcs8Der = Buffer.concat([pkcs8Prefix, Buffer.from(seedHex, "hex")]);
    const privateKey = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    return `0x${spkiDer.subarray(12).toString("hex")}`;
  }

  const CHAIN_ID = "8453";
  const ESCROW = "0x00000000000000000000000000000000000e5c0f" as Hex;
  const DEVICE_SEED = "33".repeat(32);
  const DEVICE_PUB = ed25519PublicKeyHexFromSeed(DEVICE_SEED);

  const E2E_UNIT_BINDING: UnitBinding = {
    chainId: CHAIN_ID,
    escrow: ESCROW,
    settlementUnitId: H("1"),
    jobIdHash: H("2"),
    milestoneIndex: "7",
    stepId: H("3"),
    compositionRoot: H("4"),
    acceptedEnvelopeHash: H("5"),
  };

  const E2E_BODY: FinalMilestonePackageV2Body = {
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    packageFormat: PACKAGE_FORMAT,
    compositionSchemaVersion: "1",
    unitBinding: E2E_UNIT_BINDING,
    producer: {
      operatorPrincipalId: `eip155:${CHAIN_ID}:${operatorAccount.address.toLowerCase()}`,
      kernelId: "kernel-d1-e2e",
      devicePrincipalId: `ed25519:${DEVICE_PUB}`,
    },
    challengeBinding: { nonce: H("6"), tChallengeRef: "chal-d1-e2e" },
    evidence: { evidenceBlockHash: H("7") },
    evidenceTimeBounds: { start: "1700000000", end: "1700000100" },
  };

  const E2E_PACKAGE_BODY_HASH = computePackageBodyHash(E2E_BODY);

  // The ratified struct, independently re-stated here (not imported from the production
  // module): this block's job is to prove the WIRING into assertMintablePackage works: that a
  // real signature, over the real digest, through the real guard, mints — and that the 16
  // golden vectors above already independently establish the struct/domain bytes are correct
  // (those vectors come from an ethers-based mirror in #270, not from this viem-based module),
  // so re-deriving the same literal here for signing is not circular for THAT question.
  const TYPES = {
    FinalMilestonePackageV2: [
      { name: "chainId", type: "uint256" },
      { name: "escrow", type: "address" },
      { name: "settlementUnitId", type: "bytes32" },
      { name: "jobIdHash", type: "bytes32" },
      { name: "milestoneIndex", type: "uint256" },
      { name: "stepId", type: "bytes32" },
      { name: "compositionRoot", type: "bytes32" },
      { name: "acceptedEnvelopeHash", type: "bytes32" },
      { name: "packageBodyHash", type: "bytes32" },
    ],
  } as const;

  async function signD1(): Promise<Hex> {
    const sig = await operatorAccount.signTypedData({
      domain: { name: "PCC FinalMilestonePackage", version: "2", chainId: BigInt(CHAIN_ID), verifyingContract: ESCROW },
      types: TYPES,
      primaryType: "FinalMilestonePackageV2",
      message: {
        chainId: BigInt(CHAIN_ID),
        escrow: ESCROW,
        settlementUnitId: E2E_UNIT_BINDING.settlementUnitId,
        jobIdHash: E2E_UNIT_BINDING.jobIdHash,
        milestoneIndex: BigInt(E2E_UNIT_BINDING.milestoneIndex),
        stepId: E2E_UNIT_BINDING.stepId,
        compositionRoot: E2E_UNIT_BINDING.compositionRoot,
        acceptedEnvelopeHash: E2E_UNIT_BINDING.acceptedEnvelopeHash,
        packageBodyHash: E2E_PACKAGE_BODY_HASH,
      },
    });
    return sig.toLowerCase() as Hex;
  }

  const E2E_REGISTRY: KernelRegistryReader = {
    signerForKernel: async () => ({ algorithm: "ed25519", publicKey: DEVICE_PUB }),
  };
  // An always-succeeds double (same style as `challengesReturning` in
  // final-milestone-package-v2.test.ts): it does not model one-use, so both tests below (mint,
  // then refuse-on-flipped-byte) can each call assertMintablePackage against the same record.
  const E2E_CHALLENGES: ChallengeReader = {
    recordFor: async () => ({ nonce: E2E_BODY.challengeBinding.nonce, tChallengeRef: E2E_BODY.challengeBinding.tChallengeRef, state: "issued" }),
    consumeIssued: async () => true,
  };

  const operatorVerifier = createEip712OperatorVerifier({
    // The injected chain read: production reads the escrow clone's operator() at a pinned
    // block after binding the clone (see the module doc); this test double simply returns the
    // known test operator — there is only one unit/operator in this block.
    operatorForUnit: async () => operatorAccount.address.toLowerCase(),
  });

  function flipOneHexNibble(hex: Hex): Hex {
    const body = hex.slice(2);
    const idx = 10; // well inside the `r` component, nowhere near the `v` byte
    const digits = "0123456789abcdef";
    const replacement = digits[(digits.indexOf(body[idx]) + 1) % digits.length];
    return (`0x${body.slice(0, idx)}${replacement}${body.slice(idx + 1)}`) as Hex;
  }

  it("sanity: the viem-derived operator address matches the fixture's ethers-derived address for the same private key", () => {
    expect(operatorAccount.address.toLowerCase()).toBe(OPERATOR_ADDRESS_LOWER);
  });

  it("mints when the D1 signature is real and verified by the wired verifier, end to end through assertMintablePackage", async () => {
    const d1Sig = await signD1();
    const bodyHashRaw32 = Buffer.from(E2E_PACKAGE_BODY_HASH.slice(2), "hex");
    const d2Sig = signWithPrivateKeyHex(DEVICE_SEED, bodyHashRaw32);
    expect(d2Sig).not.toBeNull();
    const D1 = { signer: operatorAccount.address.toLowerCase(), scheme: "secp256k1-eip712", sig: d1Sig };
    const D2 = { signer: DEVICE_PUB, scheme: "ed25519-raw32", sig: `0x${d2Sig}` };

    const minted = await assertMintablePackage(E2E_BODY, [D1, D2], E2E_REGISTRY, E2E_CHALLENGES, operatorVerifier);
    expect(minted).toBeInstanceOf(MintablePackage);
  });

  it("refuses when one byte of the D1 signature is flipped", async () => {
    const d1Sig = await signD1();
    const bodyHashRaw32 = Buffer.from(E2E_PACKAGE_BODY_HASH.slice(2), "hex");
    const d2Sig = signWithPrivateKeyHex(DEVICE_SEED, bodyHashRaw32);
    expect(d2Sig).not.toBeNull();
    const D1 = { signer: operatorAccount.address.toLowerCase(), scheme: "secp256k1-eip712", sig: flipOneHexNibble(d1Sig) };
    const D2 = { signer: DEVICE_PUB, scheme: "ed25519-raw32", sig: `0x${d2Sig}` };

    await expect(
      assertMintablePackage(E2E_BODY, [D1, D2], E2E_REGISTRY, E2E_CHALLENGES, operatorVerifier),
    ).rejects.toThrow(PackageNotMintableError);
  });
});

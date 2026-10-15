import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUnitConfig, computeFee, jobPolicyTypedData, policySalt, predictEscrow,
  prePolicyRoot, settlementUnitId, unitsRoot, type JobPolicyFields,
} from "@pcc/contracts/vnext";
import {
  authorizedTuple, computeAcceptedPolicyDigest, computeBindingsRoot, computePlanUnitKey,
  computeSubjectBlockHash, formatOperatorPrincipalId, principalTupleWord,
  type SubjectBinding, type SubjectBlockFields,
} from "@pcc/spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, verifyTypedData, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadOperatorKey, OperatorSigningError, type HostTerms, type OperatorKey } from "../src/keys.js";
import {
  computeJobPolicyCommitments, prepareJobPolicyAcceptance, validateHostTerms, type JobPolicyAcceptanceInput,
} from "../src/operator-signing.js";
import { computeMilestonesRoot, computeTermsHash } from "../src/terms-hash.js";

// Provenance: pcc-oracle commit 87bc14e,
// config/testnet/s2-subject-block-thursday-shape-golden.json.
// The unchanged vendored copy has SHA-256
// 4fbfa2d9d334c601f7670935b6235c5c6bc401b0779f2789baf75a1ae26e54a8.
const goldenBytes = readFileSync(new URL("./fixtures/oracle-87bc14e-s2-thursday-shape-golden.json", import.meta.url));
const golden = JSON.parse(goldenBytes.toString("utf8")) as {
  chainId: 84532;
  inputs: { payerAddress: Address; hostAddress: Address; kernelId: string; devicePublicKey: Hex };
  principals: { payer: { id: string; word: Hex }; operator: { id: string; word: Hex } };
  authorizedTuples: readonly (readonly [Hex, Hex, Hex])[];
  termsHash: Hex;
  subjects: SubjectBlockFields;
  bindings: SubjectBinding[];
  subjectBlockHash: Hex;
  bindingsRoot: Hex;
  acceptedPolicyDigest: Hex;
};

// Provenance: pcc-oracle fold/thursday-20261015-r2 @23bdcc2,
// config/testnet/s2-subject-block-thursday-shape-golden.json (schema v2).
// The unchanged vendored copy has SHA-256
// bd5aeb3100b8d1115fce22961c160f4634608c8d1228fd679b261d8dc3bc9ed2.
const goldenV2Bytes = readFileSync(new URL("./fixtures/oracle-23bdcc2-s2-thursday-shape-golden-v2.json", import.meta.url));
const goldenV2 = JSON.parse(goldenV2Bytes.toString("utf8")) as typeof golden & {
  schema: "pcc.oracle.s2-subject-block-thursday-shape-golden/v2";
  terms: {
    policyBuildTime: number;
    reclaimDelaySeconds: number;
    reclaimAt: number;
    token: Address;
    assuranceTier: number;
    milestones: { milestoneIndex: number; stepId: Hex; amount: number; deadline: number }[];
  };
};

const signing = vi.hoisted(() => ({ calls: 0 }));
vi.mock("viem/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/accounts")>();
  return { ...actual, privateKeyToAccount: (...args: Parameters<typeof actual.privateKeyToAccount>) => {
    const account = actual.privateKeyToAccount(...args);
    return { ...account, async signTypedData(input: Parameters<typeof account.signTypedData>[0]) {
      signing.calls++;
      return account.signTypedData(input);
    } };
  } };
});

const now = new Date("2026-10-10T12:00:00.000Z");
const settlementToken = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const nowSeconds = BigInt(now.getTime() / 1000);
const zeroFields = [
  "childrenRoot", "expertSetRoot", "executorSetRoot", "expectedRecipient", "targetSystemIdentity",
  "recipeRef", "sampleManifestRef", "operatingEnvelopeHash", "expectedRouteArea", "expectedLocationHash",
  "captureNonceAnchor", "challengeAnchor",
] as const satisfies readonly (keyof SubjectBlockFields)[];
let directory: string;
let keyPath: string;
let key: OperatorKey;
let hostAddress: Address;
let factory: Address;
let implementation: Address;
let feeRecipient: Address;

function randomAddress(): Address {
  return getAddress(`0x${randomBytes(20).toString("hex")}`);
}
function word(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}
function changedByte(value: Hex): Hex {
  const byte = Number.parseInt(value.slice(-2), 16) ^ 1;
  return `${value.slice(0, -2)}${byte.toString(16).padStart(2, "0")}` as Hex;
}
function principalWord(address: Address): Hex {
  return principalTupleWord("operator", formatOperatorPrincipalId(golden.chainId, address));
}
function runtimeSubject(): SubjectBlockFields {
  return {
    ...golden.subjects,
    payer: principalWord(golden.inputs.payerAddress),
    operatorPrincipal: principalWord(hostAddress),
    operatorSettlementAddress: hostAddress.toLowerCase() as Address,
    // The host checks this supplied pin. It does not produce an authorized-tuples root.
    authorizedTuplesRoot: golden.subjects.authorizedTuplesRoot,
  };
}
function terms(subject = runtimeSubject()): HostTerms {
  const subjectPins: HostTerms["subjectPins"] = {
    committedProgramHash: subject.committedProgramHash,
    operatorPrincipal: subject.operatorPrincipal,
    operatorSettlementAddress: subject.operatorSettlementAddress,
    authorizedTuplesRoot: subject.authorizedTuplesRoot,
    ...Object.fromEntries(zeroFields.map((field) => [field, zeroHash])),
    integrityGrade: 0,
  };
  return {
    chainId: golden.chainId, factory, implementation,
    settlementToken, subjectPins, bindingsRoot: golden.bindingsRoot,
    operatorPayoutRecipient: hostAddress,
    maxPassThrough: 0n, minG: 1_000n, allowedRequiredTiers: [1],
    reclaimMinSeconds: 864_000, reclaimMaxSeconds: 1_728_000,
    maxFeeBps: 100, allowedFeeRecipients: [feeRecipient], allowedPayoutRecipients: [hostAddress],
    maxUnits: 1, maxAcceptanceSeconds: 600,
  };
}
function refresh(candidate: JobPolicyAcceptanceInput): void {
  candidate.policy.acceptedPolicyDigest = computeAcceptedPolicyDigest({
    termsHash: candidate.policy.termsHash,
    subjectBlockHash: computeSubjectBlockHash(candidate.subjectBlock),
    bindingsRoot: computeBindingsRoot(candidate.bindings),
  });
  candidate.policy.escrow = predictEscrow({
    factory: candidate.policy.factory, implementation: candidate.policy.implementation,
    salt: policySalt(candidate.policy),
  });
  candidate.policy.unitsRoot = unitsRoot(candidate.units.map((unit) => settlementUnitId({
    chainId: candidate.policy.chainId, escrow: candidate.policy.escrow, jobIdHash: candidate.policy.jobIdHash,
    milestoneIndex: unit.milestoneIndex, stepId: unit.stepId,
  })));
}
function input(subjectBlock = runtimeSubject()): JobPolicyAcceptanceInput {
  const { n } = computeFee(10_000n, 50);
  const units = [buildUnitConfig({
    milestoneIndex: 0n, stepId: word("thursday-step"), requiredTier: 1,
    g: 10_000n, feeBps: 50, feeRecipient, reclaimAt: nowSeconds + 1_000_000n,
    compositionSchemaVersion: 0, compositionRoot: zeroHash,
    payouts: [{ recipient: hostAddress, amount: n }],
  })];
  const policy: JobPolicyFields = {
    chainId: BigInt(golden.chainId), factory, implementation, escrow: zeroAddress,
    payer: getAddress(golden.inputs.payerAddress), operator: getAddress(subjectBlock.operatorSettlementAddress),
    jobIdHash: word("thursday-job"), termsHash: computeTermsHash({
      token: settlementToken, assuranceTier: units[0]!.requiredTier,
      milestones: units.map((unit) => ({
        milestoneIndex: unit.milestoneIndex, stepId: unit.stepId, amount: unit.g, deadline: unit.reclaimAt,
      })),
    }), policyNonce: 1n,
    prePolicyRoot: prePolicyRoot(units), unitsRoot: zeroHash, expiry: nowSeconds + 300n,
    acceptedPolicyDigest: zeroHash,
  };
  const candidate = { policy, units, subjectBlock, bindings: structuredClone(golden.bindings) };
  refresh(candidate);
  return candidate;
}
function v2Terms(): HostTerms {
  return validateHostTerms({
    ...terms(goldenV2.subjects),
    settlementToken: goldenV2.terms.token,
    bindingsRoot: goldenV2.bindingsRoot,
    operatorPayoutRecipient: goldenV2.inputs.hostAddress,
    maxPassThrough: 250_000n, minG: 750_000n, allowedRequiredTiers: [1],
    reclaimMinSeconds: 864_000, reclaimMaxSeconds: 1_814_400,
    maxFeeBps: 0, allowedFeeRecipients: [],
    allowedPayoutRecipients: [goldenV2.inputs.hostAddress, "0x6463ACd05141c1EF6583E4Fd978FC61Fff4045DC"],
    maxUnits: 1, maxAcceptanceSeconds: 600,
  });
}
function v2Input(): JobPolicyAcceptanceInput {
  const units = goldenV2.terms.milestones.map((milestone) => buildUnitConfig({
    milestoneIndex: BigInt(milestone.milestoneIndex), stepId: milestone.stepId,
    requiredTier: goldenV2.terms.assuranceTier, g: BigInt(milestone.amount),
    feeBps: 0, feeRecipient: zeroAddress, reclaimAt: BigInt(milestone.deadline),
    compositionSchemaVersion: 0, compositionRoot: zeroHash,
    payouts: [
      { recipient: goldenV2.inputs.hostAddress, amount: 500_000n },
      { recipient: "0x6463ACd05141c1EF6583E4Fd978FC61Fff4045DC", amount: 250_000n },
    ],
  }));
  const policy: JobPolicyFields = {
    chainId: BigInt(goldenV2.chainId), factory, implementation, escrow: zeroAddress,
    payer: goldenV2.inputs.payerAddress, operator: goldenV2.inputs.hostAddress,
    jobIdHash: word("thursday-v2-job"), termsHash: goldenV2.termsHash, policyNonce: 1n,
    prePolicyRoot: prePolicyRoot(units), unitsRoot: zeroHash,
    expiry: BigInt(goldenV2.terms.policyBuildTime) + 300n, acceptedPolicyDigest: zeroHash,
  };
  const candidate = {
    policy, units, subjectBlock: structuredClone(goldenV2.subjects), bindings: structuredClone(goldenV2.bindings),
  };
  refresh(candidate);
  return candidate;
}
function prepareV2(candidate: JobPolicyAcceptanceInput) {
  // Sign one second after construction, keeping reclaimAt + 1 inside the F1
  // reclaim window so its refusal specifically exercises the derived termsHash.
  return prepareJobPolicyAcceptance(candidate, goldenV2.chainId, goldenV2.inputs.hostAddress,
    v2Terms(), () => new Date((goldenV2.terms.policyBuildTime + 1) * 1000));
}
async function refusal(candidate: JobPolicyAcceptanceInput, code: OperatorSigningError["code"], bound = key): Promise<void> {
  refresh(candidate);
  await expect(bound.signJobPolicyAcceptance(candidate)).rejects.toMatchObject({
    name: "OperatorSigningError", code, message: code,
  } satisfies Partial<OperatorSigningError>);
  expect(signing.calls).toBe(0);
}

beforeEach(async () => {
  signing.calls = 0;
  directory = await mkdtemp(join(tmpdir(), "ph-thursday-golden-"));
  await chmod(directory, 0o700);
  keyPath = join(directory, "operator.json");
  const secret = generatePrivateKey();
  hostAddress = privateKeyToAccount(secret).address;
  factory = randomAddress();
  implementation = randomAddress();
  feeRecipient = randomAddress();
  await writeFile(keyPath, JSON.stringify({
    kind: "pcc-printhost.operator-key", version: 1, algorithm: "secp256k1", purpose: "runtime Thursday test",
    createdAt: now.toISOString(), address: hostAddress, privateKey: secret,
  }), { mode: 0o600 });
  key = await loadOperatorKey(keyPath, golden.chainId, { now, clock: () => now, terms: terms() });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("the oracle's Thursday subject-block golden", () => {
  it("preserves the oracle fixture's exact bytes and provenance checksum", () => {
    expect(createHash("sha256").update(goldenBytes).digest("hex"))
      .toBe("4fbfa2d9d334c601f7670935b6235c5c6bc401b0779f2789baf75a1ae26e54a8");
  });
  it("pins digest arithmetic over the 87bc14e oracle's literal termsHash input and derived principal words", () => {
    const payerId = formatOperatorPrincipalId(golden.chainId, golden.inputs.payerAddress);
    const operatorId = formatOperatorPrincipalId(golden.chainId, golden.inputs.hostAddress);
    expect(payerId).toBe(golden.principals.payer.id);
    expect(operatorId).toBe(golden.principals.operator.id);
    const subjectBlock = {
      ...golden.subjects,
      payer: principalTupleWord("operator", payerId),
      operatorPrincipal: principalTupleWord("operator", operatorId),
      operatorSettlementAddress: golden.inputs.hostAddress,
    };
    expect(subjectBlock.payer).toBe(golden.principals.payer.word);
    expect(subjectBlock.operatorPrincipal).toBe(golden.principals.operator.word);
    expect(subjectBlock).toEqual(golden.subjects);
    expect(authorizedTuple(operatorId, golden.inputs.kernelId, `ed25519:${golden.inputs.devicePublicKey}`))
      .toEqual(golden.authorizedTuples[0]);
    // This vector pins digest arithmetic over the oracle's literal termsHash;
    // end-to-end acceptance below derives termsHash from its own funded units.
    const arithmeticVector = input(subjectBlock);
    arithmeticVector.policy.termsHash = golden.termsHash;
    refresh(arithmeticVector);
    expect(computeJobPolicyCommitments(arithmeticVector)).toEqual({
      subjectBlockHash: golden.subjectBlockHash,
      bindingsRoot: golden.bindingsRoot,
      acceptedPolicyDigest: golden.acceptedPolicyDigest,
    });
  });
  it("signs the complete Thursday shape with a runtime key and every Thursday terms pin", async () => {
    const candidate = input();
    expect(candidate.subjectBlock.operatorSettlementAddress).toBe(key.address.toLowerCase());
    expect(candidate.subjectBlock.operatorPrincipal).toBe(principalWord(key.address));
    expect(candidate.subjectBlock.payer).toBe(principalWord(candidate.policy.payer));
    expect(candidate.subjectBlock.authorizedTuplesRoot).toBe(golden.subjects.authorizedTuplesRoot);
    for (const field of zeroFields) expect(candidate.subjectBlock[field]).toBe(zeroHash);
    expect(candidate.subjectBlock.integrityGrade).toBe(0);
    expect(candidate.bindings).toEqual([]);
    const signature = await key.signJobPolicyAcceptance(candidate);
    expect(await verifyTypedData({ ...jobPolicyTypedData(candidate.policy), address: key.address, signature })).toBe(true);
    expect(signing.calls).toBe(1);
  });
  for (const field of zeroFields) {
    it(`refuses a one-byte change to the Thursday zero pin ${field} before signing`, async () => {
      const candidate = input();
      candidate.subjectBlock[field] = changedByte(candidate.subjectBlock[field]);
      await refusal(candidate, "subject_pin_mismatch");
    });
  }
  it("refuses a one-byte change to the authorizedTuplesRoot pin before signing", async () => {
    const candidate = input();
    candidate.subjectBlock.authorizedTuplesRoot = changedByte(candidate.subjectBlock.authorizedTuplesRoot);
    await refusal(candidate, "subject_pin_mismatch");
  });
  it("refuses a one-byte operatorPrincipal change by derivation with its terms pin removed before signing", async () => {
    const localTerms = terms();
    const { operatorPrincipal: _pin, ...subjectPins } = localTerms.subjectPins;
    const bound = await loadOperatorKey(keyPath, golden.chainId, {
      now, clock: () => now, terms: { ...localTerms, subjectPins },
    });
    const candidate = input();
    candidate.subjectBlock.operatorPrincipal = changedByte(candidate.subjectBlock.operatorPrincipal);
    await refusal(candidate, "operator_principal_mismatch", bound);
  });
  it("refuses a one-byte payer principal change by derivation before signing", async () => {
    const candidate = input();
    candidate.subjectBlock.payer = changedByte(candidate.subjectBlock.payer);
    await refusal(candidate, "payer_principal_mismatch");
  });
  it("refuses integrityGrade 1 against the Thursday zero pin before signing", async () => {
    const candidate = input();
    candidate.subjectBlock.integrityGrade = 1;
    await refusal(candidate, "subject_pin_mismatch");
  });
  it("refuses non-empty bindings against the Thursday empty bindingsRoot pin before signing", async () => {
    const candidate = input();
    const unit = candidate.units[0]!;
    candidate.bindings.push({
      planUnitKey: computePlanUnitKey(0, unit.milestoneIndex, unit.stepId),
      requirementIdHash: word("thursday-requirement"), sourceKind: 1, propositionKind: 2,
      valueRef: word("thursday-binding-value"),
    });
    await refusal(candidate, "bindings_root_mismatch");
  });
});

describe("the oracle's v2 Thursday derived-termsHash golden", () => {
  it("preserves the 23bdcc2 schema-v2 fixture's exact bytes and provenance checksum", () => {
    expect(goldenV2.schema).toBe("pcc.oracle.s2-subject-block-thursday-shape-golden/v2");
    expect(createHash("sha256").update(goldenV2Bytes).digest("hex"))
      .toBe("bd5aeb3100b8d1115fce22961c160f4634608c8d1228fd679b261d8dc3bc9ed2");
  });
  it("derives the v2 milestonesRoot and termsHash from the vector's tier-1 terms", () => {
    expect(goldenV2.terms.assuranceTier).toBe(1);
    expect(computeMilestonesRoot(goldenV2.terms.milestones))
      .toBe("0x16bb1546dd13804dd874e718b41d1375d606ca1ebe6650a5db23b09a682bedc2");
    const derivedTermsHash = computeTermsHash(goldenV2.terms);
    expect(derivedTermsHash).toBe("0x3f8dbb379a2ff55a557a24aba75661166d03898dec2b0745747b3755d69f64ae");
    expect(derivedTermsHash).toBe(goldenV2.termsHash);
  });
  it("derives the v2 subjectBlockHash, bindingsRoot and acceptedPolicyDigest with @pcc/spec", () => {
    const subjectBlockHash = computeSubjectBlockHash(goldenV2.subjects);
    const bindingsRoot = computeBindingsRoot(goldenV2.bindings);
    expect(subjectBlockHash).toBe(goldenV2.subjectBlockHash);
    expect(bindingsRoot).toBe(goldenV2.bindingsRoot);
    const acceptedPolicyDigest = computeAcceptedPolicyDigest({
      termsHash: computeTermsHash(goldenV2.terms), subjectBlockHash, bindingsRoot,
    });
    expect(acceptedPolicyDigest).toBe("0x6814b378016fd7f40c1e72aa98187b14656338f002ab2774fa86d9ed9361fe23");
    expect(acceptedPolicyDigest).toBe(goldenV2.acceptedPolicyDigest);
    expect(computeJobPolicyCommitments(v2Input())).toEqual({
      subjectBlockHash, bindingsRoot, acceptedPolicyDigest,
    });
  });
  it("accepts the exact v2 shape with the vector host and complete F1 Thursday limits", () => {
    const candidate = v2Input();
    expect(candidate.subjectBlock).toEqual(goldenV2.subjects);
    expect(candidate.bindings).toEqual(goldenV2.bindings);
    expect(candidate.policy.acceptedPolicyDigest).toBe(goldenV2.acceptedPolicyDigest);
    expect(prepareV2(candidate)).toEqual(jobPolicyTypedData(candidate.policy));
    expect(signing.calls).toBe(0);
  });
  it("refuses the retired economics file digest on the v2 shape after refreshing digest and escrow", () => {
    const candidate = v2Input();
    candidate.policy.termsHash = "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7";
    refresh(candidate);
    expect(() => prepareV2(candidate)).toThrowError(expect.objectContaining({
      name: "OperatorSigningError", code: "terms_hash_mismatch", message: "terms_hash_mismatch",
    }));
    expect(signing.calls).toBe(0);
  });
  it("refuses v2 reclaimAt moved by one second after refreshing the digest and escrow", () => {
    const candidate = v2Input();
    candidate.units[0]!.reclaimAt += 1n;
    candidate.policy.prePolicyRoot = prePolicyRoot(candidate.units);
    refresh(candidate);
    expect(() => prepareV2(candidate)).toThrowError(expect.objectContaining({
      name: "OperatorSigningError", code: "terms_hash_mismatch", message: "terms_hash_mismatch",
    }));
    expect(signing.calls).toBe(0);
  });
});

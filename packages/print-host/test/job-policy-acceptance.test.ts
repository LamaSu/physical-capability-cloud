import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  acceptanceDigest,
  buildUnitConfig,
  checkAcceptance,
  computeFee,
  domainSeparator,
  jobPolicyHash,
  jobPolicyTypedData,
  prePolicyRoot,
  policySalt,
  predictEscrow,
  settlementUnitId,
  unitsRoot,
  VNEXT,
  type JobPolicyFields,
  type UnitConfig,
} from "@pcc/contracts/vnext";
import {
  computeAcceptedPolicyDigest,
  computeBindingsRoot,
  computePlanUnitKey,
  computeSubjectBlockHash,
  formatOperatorPrincipalId,
  principalTupleWord,
  type SubjectBinding,
  type SubjectBlockFields,
} from "@pcc/spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAddress,
  hashTypedData,
  recoverAddress,
  verifyTypedData,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  loadOperatorKey,
  OperatorSigningError,
  type HostTerms,
  type OperatorKey,
} from "../src/keys.js";
import { validateHostTerms } from "../src/operator-signing.js";
import { computeTermsHash } from "../src/terms-hash.js";

const failure = vi.hoisted(() => ({ enabled: false, signCalls: 0, principalProducer: "" }));
vi.mock("@pcc/spec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pcc/spec")>();
  return { ...actual,
    formatOperatorPrincipalId: (...args: Parameters<typeof actual.formatOperatorPrincipalId>) => {
      if (failure.principalProducer === "formatOperatorPrincipalId") throw new Error("producer-private-input");
      return actual.formatOperatorPrincipalId(...args);
    },
    principalTupleWord: (...args: Parameters<typeof actual.principalTupleWord>) => {
      if (failure.principalProducer === "principalTupleWord") throw new Error("producer-private-input");
      return actual.principalTupleWord(...args);
    },
  };
});
vi.mock("viem/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem/accounts")>();
  return { ...actual, privateKeyToAccount: (...args: Parameters<typeof actual.privateKeyToAccount>) => {
    const account = actual.privateKeyToAccount(...args);
    return { ...account, async signTypedData(input: Parameters<typeof account.signTypedData>[0]) {
      failure.signCalls++;
      if (failure.enabled) throw new Error(args[0], { cause: { secret: args[0] } });
      return account.signTypedData(input);
    } };
  } };
});

const now = new Date("2026-10-10T12:00:00.000Z");
const nowSeconds = BigInt(now.getTime() / 1000);
const factory = getAddress(`0x${"ab".repeat(20)}`);
const implementation = getAddress(`0x${"cd".repeat(20)}`);
const unrelatedEscrow = getAddress(`0x${"ef".repeat(20)}`);
const payer = getAddress(`0x${"12".repeat(20)}`);
const feeRecipient = getAddress(`0x${"ab34".repeat(10)}`);
const otherRecipient = getAddress(`0x${"56".repeat(20)}`);
const payoutRecipient = getAddress(`0x${"ab78".repeat(10)}`);
const settlementToken = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const supersededTermsFileDigest: Hex = "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7";
const s2ProgramHash: Hex = "0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a";
let directory: string;
let path: string;
let secret: Hex;
let key: OperatorKey;

function terms(chainId: 84532 | 31337 = 84532) {
  return {
    chainId, factory, implementation,
    settlementToken,
    subjectPins: { committedProgramHash: s2ProgramHash, targetSystemIdentity: word("target-system") },
    operatorPayoutRecipient: payoutRecipient,
    maxPassThrough: 20_000n,
    minG: 1_000n,
    allowedRequiredTiers: [1, 2],
    reclaimMinSeconds: 864_000,
    reclaimMaxSeconds: 1_728_000,
    maxFeeBps: 100,
    allowedFeeRecipients: [feeRecipient],
    allowedPayoutRecipients: [payoutRecipient],
    maxUnits: 2,
    maxAcceptanceSeconds: 600,
  } satisfies HostTerms;
}
function word(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}
function changedByte(value: Hex): Hex {
  const byte = Number.parseInt(value.slice(-2), 16) ^ 1;
  return `${value.slice(0, -2)}${byte.toString(16).padStart(2, "0")}` as Hex;
}
// These are synthetic shape fixtures, not an oracle subject-block golden.
function subjectBlock(chainId = 84532, operator = key?.address ?? payer, payingAddress = payer): SubjectBlockFields {
  return {
    payer: principalTupleWord("operator", formatOperatorPrincipalId(chainId, payingAddress)),
    operatorPrincipal: principalTupleWord("operator", formatOperatorPrincipalId(chainId, operator)),
    operatorSettlementAddress: payoutRecipient.toLowerCase() as Address,
    authorizedTuplesRoot: word("authorized-tuples"), expertSetRoot: word("experts"),
    executorSetRoot: word("executors"), expectedRecipient: word("expected-recipient"),
    targetSystemIdentity: word("target-system"), committedProgramHash: s2ProgramHash,
    recipeRef: word("recipe"), sampleManifestRef: word("sample-manifest"), childrenRoot: word("children"),
    operatingEnvelopeHash: word("operating-envelope"), expectedRouteArea: word("route-area"),
    expectedLocationHash: word("location"), captureNonceAnchor: word("capture-nonce"),
    challengeAnchor: word("challenge"), integrityGrade: 2,
  };
}
function unit(overrides: Partial<UnitConfig> = {}, index = 0): UnitConfig {
  const gross = overrides.g ?? 10_000n;
  const bps = overrides.feeBps ?? 50;
  const { n } = computeFee(gross, bps);
  return {
    ...buildUnitConfig({
      milestoneIndex: BigInt(index), stepId: word(`step-${index}`), requiredTier: 1,
      g: gross, feeBps: bps, feeRecipient: bps === 0 ? zeroAddress : feeRecipient,
      reclaimAt: nowSeconds + 1_000_000n, compositionSchemaVersion: 0,
      compositionRoot: zeroHash,
      payouts: [{ recipient: payoutRecipient, amount: n }],
    }),
    ...overrides,
  };
}
function termsHashFromUnits(configs: UnitConfig[], token: Address = settlementToken,
  assuranceTier = configs[0].requiredTier): Hex {
  return computeTermsHash({ token, assuranceTier, milestones: configs.map((config) => ({
    milestoneIndex: config.milestoneIndex, stepId: config.stepId, amount: config.g, deadline: config.reclaimAt,
  })) });
}
function input(configs: UnitConfig[] = [unit()], overrides: Partial<JobPolicyFields> = {}) {
  const subject = subjectBlock(Number(overrides.chainId ?? 84532n), key.address, overrides.payer ?? payer);
  const boundUnit = configs[0] ?? unit();
  const bindings: SubjectBinding[] = [{
    planUnitKey: computePlanUnitKey(0, boundUnit.milestoneIndex, boundUnit.stepId),
    requirementIdHash: word("requirement"), sourceKind: 1, propositionKind: 2, valueRef: word("value-ref"),
  }];
  // Empty-unit candidates are refused by units_count before a terms derivation is possible.
  const derivedTermsHash = configs.length === 0 ? zeroHash : termsHashFromUnits(configs);
  const policy: JobPolicyFields = {
    chainId: 84532n, factory, implementation, escrow: unrelatedEscrow, payer, operator: key.address,
    jobIdHash: word("job"), termsHash: derivedTermsHash, policyNonce: 1n,
    prePolicyRoot: prePolicyRoot(configs), unitsRoot: word("temporary-root"),
    expiry: nowSeconds + 300n, acceptedPolicyDigest: computeAcceptedPolicyDigest({
      termsHash: overrides.termsHash ?? derivedTermsHash,
      subjectBlockHash: computeSubjectBlockHash(subject), bindingsRoot: computeBindingsRoot(bindings),
    }),
    ...overrides,
  };
  if (overrides.escrow === undefined) {
    policy.escrow = predictEscrow({ factory: policy.factory, implementation: policy.implementation, salt: policySalt(policy) });
  }
  policy.unitsRoot = unitsRoot(configs.map((config) => settlementUnitId({
    chainId: policy.chainId, escrow: policy.escrow, jobIdHash: policy.jobIdHash,
    milestoneIndex: config.milestoneIndex, stepId: config.stepId,
  })));
  return { policy, units: configs, subjectBlock: subject, bindings };
}
function refreshPolicyIdentity(candidate: ReturnType<typeof input>): void {
  candidate.policy.escrow = predictEscrow({ factory: candidate.policy.factory,
    implementation: candidate.policy.implementation, salt: policySalt(candidate.policy) });
  candidate.policy.unitsRoot = unitsRoot(candidate.units.map((config) => settlementUnitId({
    chainId: candidate.policy.chainId, escrow: candidate.policy.escrow, jobIdHash: candidate.policy.jobIdHash,
    milestoneIndex: config.milestoneIndex, stepId: config.stepId,
  })));
}
function refreshAcceptedPolicy(candidate: ReturnType<typeof input>): void {
  candidate.policy.acceptedPolicyDigest = computeAcceptedPolicyDigest({ termsHash: candidate.policy.termsHash,
    subjectBlockHash: computeSubjectBlockHash(candidate.subjectBlock), bindingsRoot: computeBindingsRoot(candidate.bindings) });
  refreshPolicyIdentity(candidate);
}
function noLeak(value: unknown): void {
  const renderings = [String(value), `${value}`, JSON.stringify(value) ?? "",
    inspect(value, { depth: 5, showHidden: true }),
    inspect(value, { customInspect: false, showHidden: true, depth: 5 })];
  const hex = secret.slice(2);
  for (let index = 0; index <= hex.length - 12; index++) {
    expect(renderings.some((rendered) => rendered.includes(hex.slice(index, index + 12))),
      "a private key fragment is reachable in a rendering").toBe(false);
  }
}
async function refusal(operation: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try { await operation(); } catch (error) { caught = error; }
  expect(caught instanceof OperatorSigningError, "the signer must return its closed refusal class").toBe(true);
  const error = caught as OperatorSigningError;
  expect(error.code).toBe(code);
  expect(error.message).toBe(code);
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expect(Object.keys(error).every((field) => ["name", "code"].includes(field))).toBe(true);
  noLeak(error);
}
async function accepts(candidate: ReturnType<typeof input>, bound = key): Promise<void> {
  const signature = await bound.signJobPolicyAcceptance(candidate);
  expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  expect(await verifyTypedData({ ...jobPolicyTypedData(candidate.policy), address: bound.address, signature }))
    .toBe(true);
}

beforeEach(async () => {
  failure.enabled = false;
  failure.signCalls = 0;
  failure.principalProducer = "";
  directory = await mkdtemp(join(tmpdir(), "ph-policy-"));
  await chmod(directory, 0o700);
  secret = generatePrivateKey();
  path = join(directory, "operator.json");
  await writeFile(path, JSON.stringify({
    kind: "pcc-printhost.operator-key", version: 1, algorithm: "secp256k1", purpose: "runtime test",
    createdAt: now.toISOString(), address: privateKeyToAccount(secret).address, privateKey: secret,
  }), { mode: 0o600 });
  key = await loadOperatorKey(path, 84532, { now, clock: () => now, terms: terms() });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe("JobPolicy acceptance uses the canonical compiler bytes", () => {
  for (const chainId of [84532, 31337] as const) {
    it(`recovers over the compiler acceptanceDigest with policy.escrow as the domain on chain ${chainId}`, async () => {
      const bound = await loadOperatorKey(path, chainId, { now, clock: () => now, terms: terms(chainId) });
      const candidate = input([unit()], { chainId: BigInt(chainId) });
      const signature = await bound.signJobPolicyAcceptance(candidate);
      const digest = acceptanceDigest(domainSeparator(candidate.policy.chainId, candidate.policy.escrow),
        jobPolicyHash(candidate.policy));
      expect(hashTypedData(jobPolicyTypedData(candidate.policy))).toBe(digest);
      expect(await recoverAddress({ hash: digest, signature })).toBe(bound.address);
      expect(await verifyTypedData({ ...jobPolicyTypedData(candidate.policy), address: bound.address, signature }))
        .toBe(true);
      // The compiler's acceptance helper checks shape; viem above verifies the signature itself.
      expect(() => checkAcceptance({ expiry: candidate.policy.expiry,
        payerSignature: "0x", operatorSignature: signature }, { sender: payer, payer })).not.toThrow();
      const otherDomainDigest = acceptanceDigest(domainSeparator(candidate.policy.chainId, candidate.policy.factory),
        jobPolicyHash(candidate.policy));
      expect(await recoverAddress({ hash: otherDomainDigest, signature })).not.toBe(bound.address);
    });
  }
  it("compares operator addresses without making letter case part of their identity", async () => {
    await accepts(input([unit()], { operator: key.address.toLowerCase() as Address }));
  });
  it("refuses an operator different from the loaded EOA", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { operator: payer })), "operator_mismatch");
  });
  it("refuses a policy chain different from the bound chain", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { chainId: 31337n })), "chain_mismatch");
  });
  it("refuses an escrow that is not predicted from the complete policy identity", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { escrow: unrelatedEscrow })), "escrow_mismatch");
  });
  for (const field of ["factory", "implementation"] as const) {
    it(`refuses a different ${field} even with its matching predicted escrow`, async () => {
      await refusal(() => key.signJobPolicyAcceptance(input([unit()], { [field]: otherRecipient })),
        "deployment_mismatch");
    });
    it(`refuses the zero policy ${field}`, async () => {
      await refusal(() => key.signJobPolicyAcceptance(input([unit()], { [field]: zeroAddress })),
        "deployment_mismatch");
    });
  }
  it("refuses the zero policy escrow", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { escrow: zeroAddress })), "bad_escrow");
  });
  it("accepts deployment terms and policy addresses that differ only in letter case", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), factory: factory.toLowerCase() as Address,
        implementation: implementation.toLowerCase() as Address } });
    await accepts(input(), bound);
  });
  it("recomputes unitsRoot and refuses a different commitment", async () => {
    const candidate = input();
    candidate.policy.unitsRoot = word("wrong-units-root");
    await refusal(() => key.signJobPolicyAcceptance(candidate), "units_root_mismatch");
  });
  it("recomputes prePolicyRoot and refuses economic changes under an old commitment", async () => {
    const candidate = input();
    candidate.policy.prePolicyRoot = word("wrong-pre-policy-root");
    await refusal(() => key.signJobPolicyAcceptance(candidate), "pre_policy_root_mismatch");
  });
  it("does not allow a caller-supplied domain or verifyingContract", async () => {
    for (const extra of [{ verifyingContract: factory }, { escrow: factory },
      { domain: { verifyingContract: factory } }, { types: {} }, { primaryType: "Other" }]) {
      await refusal(() => key.signJobPolicyAcceptance({ ...input(), ...extra } as never), "bad_input");
    }
  });
});

describe("JobPolicy acceptance derives terms from its units and binds the pinned program with the spec producer", () => {
  it("signs a policy built with the spec subject, bindings and accepted-policy producers", async () => {
    const candidate = input();
    const subjectBlockHash = computeSubjectBlockHash(candidate.subjectBlock);
    const bindingsRoot = computeBindingsRoot(candidate.bindings);
    expect(candidate.subjectBlock.committedProgramHash).toBe(s2ProgramHash);
    expect(candidate.policy.termsHash).toBe(termsHashFromUnits(candidate.units));
    expect(candidate.bindings[0].planUnitKey).toBe(computePlanUnitKey(0,
      candidate.units[0].milestoneIndex, candidate.units[0].stepId));
    expect(subjectBlockHash).not.toBe(bindingsRoot);
    expect(candidate.policy.acceptedPolicyDigest).toBe(computeAcceptedPolicyDigest({
      termsHash: termsHashFromUnits(candidate.units), subjectBlockHash, bindingsRoot,
    }));
    await accepts(candidate);
    expect(failure.signCalls).toBe(1);
  });
  it("refuses a termsHash one byte off even with its recomputed digest and predicted escrow", async () => {
    const configs = [unit()];
    const candidate = input(configs, { termsHash: changedByte(termsHashFromUnits(configs)) });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses a changed termsHash before checking a stale accepted-policy digest", async () => {
    const candidate = input();
    candidate.policy.termsHash = changedByte(candidate.policy.termsHash);
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("maps a terms producer throw for duplicate milestones to bad_input before signing", async () => {
    const candidate = input([unit(), unit({}, 1)]);
    candidate.units[1] = { ...candidate.units[0] };
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
    expect(failure.signCalls).toBe(0);
  });
  it("signs units in their funded unsorted order", async () => {
    const candidate = input([unit({}, 1), unit({}, 0)]);
    await accepts(candidate);
    expect(failure.signCalls).toBe(1);
  });
  it("refuses a termsHash derived from the same two units in another order before signing", async () => {
    const configs = [unit({}, 1), unit({}, 0)];
    const candidate = input(configs, { termsHash: termsHashFromUnits([...configs].reverse()) });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses a termsHash derived with gross amount off by one before signing", async () => {
    const configs = [unit()];
    const candidate = input(configs, { termsHash: termsHashFromUnits([{ ...configs[0], g: configs[0].g + 1n }]) });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses a termsHash derived with reclaimAt off by one second before signing", async () => {
    const configs = [unit()];
    const candidate = input(configs, { termsHash: termsHashFromUnits([
      { ...configs[0], reclaimAt: configs[0].reclaimAt + 1n },
    ]) });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses a termsHash derived with another settlement token before signing", async () => {
    const configs = [unit()];
    const candidate = input(configs, { termsHash: termsHashFromUnits(configs, otherRecipient) });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses a termsHash derived with tier two while the units require tier one before signing", async () => {
    const configs = [unit()];
    const candidate = input(configs, { termsHash: termsHashFromUnits(configs, settlementToken, 2) });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses the superseded economics terms-file digest before signing", async () => {
    const candidate = input([unit()], { termsHash: supersededTermsFileDigest });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "terms_hash_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses units with mixed requiredTier even when each requestedTier agrees before signing", async () => {
    const candidate = input([unit(), unit({ requiredTier: 2, requestedTier: 2 }, 1)]);
    await refusal(() => key.signJobPolicyAcceptance(candidate), "assurance_tier_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("accepts an uppercase-hex policy termsHash (case-insensitive derivation comparison)", async () => {
    const candidate = input();
    candidate.policy.termsHash = `0x${candidate.policy.termsHash.slice(2).toUpperCase()}` as Hex;
    refreshPolicyIdentity(candidate);
    await accepts(candidate);
    expect(failure.signCalls).toBe(1);
  });
  it("accepts an uppercase-hex acceptedPolicyDigest", async () => {
    const candidate = input();
    candidate.policy.acceptedPolicyDigest = `0x${candidate.policy.acceptedPolicyDigest.slice(2).toUpperCase()}` as Hex;
    refreshPolicyIdentity(candidate);
    await accepts(candidate);
    expect(failure.signCalls).toBe(1);
  });
  it("refuses a settlement address that is another ALLOWED payout recipient", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), allowedPayoutRecipients: [payoutRecipient, otherRecipient] } });
    const candidate = input();
    candidate.subjectBlock.operatorSettlementAddress = otherRecipient.toLowerCase() as Address;
    refreshAcceptedPolicy(candidate);
    await refusal(() => bound.signJobPolicyAcceptance(candidate), "settlement_address_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses an incorrect operator principal even when its optional terms pin agrees", async () => {
    const candidate = input();
    candidate.subjectBlock.operatorPrincipal = changedByte(candidate.subjectBlock.operatorPrincipal);
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), subjectPins: { ...terms().subjectPins,
        operatorPrincipal: candidate.subjectBlock.operatorPrincipal } } });
    refreshAcceptedPolicy(candidate);
    await refusal(() => bound.signJobPolicyAcceptance(candidate), "operator_principal_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  for (const producer of ["formatOperatorPrincipalId", "principalTupleWord"]) {
    it(`maps a ${producer} throw to bad_input before signing`, async () => {
      const candidate = input();
      failure.principalProducer = producer;
      await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const field of ["committedProgramHash", "targetSystemIdentity"] as const) {
    it(`refuses a ${field} pin one byte off even with its recomputed acceptedPolicyDigest`, async () => {
      const candidate = input();
      candidate.subjectBlock[field] = changedByte(candidate.subjectBlock[field]);
      refreshAcceptedPolicy(candidate);
      await refusal(() => key.signJobPolicyAcceptance(candidate), "subject_pin_mismatch");
      expect(failure.signCalls).toBe(0);
    });
  }
  it("refuses an unpinned settlement address one byte off even with its recomputed digest", async () => {
    const candidate = input();
    candidate.subjectBlock.operatorSettlementAddress = changedByte(candidate.subjectBlock.operatorSettlementAddress);
    refreshAcceptedPolicy(candidate);
    await refusal(() => key.signJobPolicyAcceptance(candidate), "settlement_address_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("compares the settlement-address pin by value against lowercase producer input", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), subjectPins: { ...terms().subjectPins, operatorSettlementAddress: payoutRecipient } } });
    expect(input().subjectBlock.operatorSettlementAddress).not.toBe(payoutRecipient);
    await accepts(input(), bound);
  });
  it("accepts every subject field as a pin and refuses a pinned integrityGrade one integer off", async () => {
    const supplied = { ...terms(), subjectPins: subjectBlock() };
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied });
    await accepts(input(), bound);
    const candidate = input();
    candidate.subjectBlock.integrityGrade = 3;
    refreshAcceptedPolicy(candidate);
    await refusal(() => bound.signJobPolicyAcceptance(candidate), "subject_pin_mismatch");
    expect(failure.signCalls).toBe(1);
  });
  for (const integrityGrade of [2n, "2"] as const) {
    it(`compares integrityGrade by integer value for producer input of type ${typeof integrityGrade}`, async () => {
      const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
        terms: { ...terms(), subjectPins: { ...terms().subjectPins, integrityGrade: 2 } } });
      const candidate = input();
      candidate.subjectBlock.integrityGrade = integrityGrade;
      refreshAcceptedPolicy(candidate);
      await accepts(candidate, bound);
    });
  }
  it("refuses an acceptedPolicyDigest one byte off even with its matching predicted escrow", async () => {
    const candidate = input();
    candidate.policy.acceptedPolicyDigest = changedByte(candidate.policy.acceptedPolicyDigest);
    refreshPolicyIdentity(candidate);
    await refusal(() => key.signJobPolicyAcceptance(candidate), "accepted_policy_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("refuses a digest built with subjectBlockHash and bindingsRoot swapped", async () => {
    const candidate = input();
    const subjectBlockHash = computeSubjectBlockHash(candidate.subjectBlock);
    const bindingsRoot = computeBindingsRoot(candidate.bindings);
    expect(subjectBlockHash).not.toBe(bindingsRoot);
    candidate.policy.acceptedPolicyDigest = computeAcceptedPolicyDigest({
      termsHash: candidate.policy.termsHash, subjectBlockHash: bindingsRoot, bindingsRoot: subjectBlockHash,
    });
    refreshPolicyIdentity(candidate);
    await refusal(() => key.signJobPolicyAcceptance(candidate), "accepted_policy_mismatch");
    expect(failure.signCalls).toBe(0);
  });
  it("accepts an exact bindingsRoot pin and refuses a binding value one byte off under a new digest", async () => {
    const candidate = input();
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), bindingsRoot: computeBindingsRoot(candidate.bindings) } });
    await accepts(candidate, bound);
    candidate.bindings[0].valueRef = changedByte(candidate.bindings[0].valueRef);
    refreshAcceptedPolicy(candidate);
    await refusal(() => bound.signJobPolicyAcceptance(candidate), "bindings_root_mismatch");
    expect(failure.signCalls).toBe(1);
  });
  it("allows a different valid bindings set when no bindingsRoot pin was configured", async () => {
    const candidate = input();
    candidate.bindings[0].valueRef = changedByte(candidate.bindings[0].valueRef);
    refreshAcceptedPolicy(candidate);
    await accepts(candidate);
  });
  for (const [label, composition] of [
    ["nonzero schema", { compositionSchemaVersion: 1, compositionRoot: zeroHash }],
    ["nonzero root", { compositionSchemaVersion: 0, compositionRoot: changedByte(zeroHash) }],
    ["composed unit", { compositionSchemaVersion: 1, compositionRoot: word("composition") }],
  ] as const) {
    it(`refuses ${label} before signing with composition_not_supported`, async () => {
      await refusal(() => key.signJobPolicyAcceptance(input([unit(composition)])), "composition_not_supported");
      expect(failure.signCalls).toBe(0);
    });
  }
  it("refuses composition in a later unit", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit(), unit({
      compositionSchemaVersion: 1, compositionRoot: word("later-composition"),
    }, 1)])), "composition_not_supported");
    expect(failure.signCalls).toBe(0);
  });
});

describe("the signing clock belongs to the loaded key", () => {
  for (const suppliedNow of [now, new Date("2036-10-10T12:00:00.000Z")]) {
    it(`refuses caller now ${suppliedNow.getUTCFullYear()} before reading the clock or signing`, async () => {
      const clock = vi.fn(() => now);
      const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() });
      await refusal(() => bound.signJobPolicyAcceptance({ ...input(), now: suppliedNow } as never), "bad_input");
      expect(clock).not.toHaveBeenCalled();
      expect(failure.signCalls).toBe(0);
    });
  }
  it("reads its clock exactly once per signing and observes expiration between calls", async () => {
    let current = now;
    const clock = vi.fn(() => current);
    const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() });
    expect(clock).not.toHaveBeenCalled();
    await accepts(input(), bound);
    expect(clock).toHaveBeenCalledTimes(1);
    current = new Date(now.getTime() + 301_000);
    await refusal(() => bound.signJobPolicyAcceptance(input()), "acceptance_expired");
    expect(clock).toHaveBeenCalledTimes(2);
    expect(failure.signCalls).toBe(1);
  });
  it("captures the clock at load even if the options object is changed", async () => {
    const clock = vi.fn(() => now);
    const replacement = vi.fn(() => new Date("2036-10-10T12:00:00.000Z"));
    const options = { now, clock, terms: terms() };
    const bound = await loadOperatorKey(path, 84532, options);
    options.clock = replacement;
    await accepts(input(), bound);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });
  it("reads the clock once after a valid snapshot even when policy validation refuses", async () => {
    const clock = vi.fn(() => now);
    const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() });
    await refusal(() => bound.signJobPolicyAcceptance(input([unit()], { operator: payer })), "operator_mismatch");
    expect(clock).toHaveBeenCalledTimes(1);
    expect(failure.signCalls).toBe(0);
  });
  it("rejects caller now before the clock even when terms were not loaded", async () => {
    const clock = vi.fn(() => now);
    const bound = await loadOperatorKey(path, 84532, { now, clock });
    await refusal(() => bound.signJobPolicyAcceptance({ ...input(), now } as never), "bad_input");
    expect(clock).not.toHaveBeenCalled();
    expect(failure.signCalls).toBe(0);
  });
  for (const clock of [null, 1, now, "clock"]) {
    it(`refuses a non-function clock option of type ${typeof clock}`, async () => {
      await refusal(() => loadOperatorKey(path, 84532, { now, clock, terms: terms() } as never), "bad_input");
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const returned of [null, undefined, "2026-10-10", 0, new Date(Number.NaN),
    { getTime: () => now.getTime() }]) {
    it(`refuses an invalid clock result ${String(returned)} before signing`, async () => {
      const clock = vi.fn(() => returned);
      const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() } as never);
      await refusal(() => bound.signJobPolicyAcceptance(input()), "bad_input");
      expect(clock).toHaveBeenCalledTimes(1);
      expect(failure.signCalls).toBe(0);
    });
  }
  it("refuses a throwing clock without exposing its exception", async () => {
    const clock = vi.fn(() => { throw new Error(secret); });
    const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() });
    await refusal(() => bound.signJobPolicyAcceptance(input()), "bad_input");
    expect(clock).toHaveBeenCalledTimes(1);
    expect(failure.signCalls).toBe(0);
  });
  it("uses the native Date timestamp without invoking an overridden getTime", async () => {
    const date = new Date(now);
    const getTime = vi.fn(() => { throw new Error(secret); });
    Object.defineProperty(date, "getTime", { value: getTime });
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => date, terms: terms() });
    await accepts(input(), bound);
    expect(getTime).not.toHaveBeenCalled();
  });
});

describe("HostTerms enforce each acceptance boundary", () => {
  it("accepts one and maxUnits units, refuses zero and maxUnits plus one", async () => {
    await accepts(input([unit()]));
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([])), "units_count");
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({}, 1), unit({}, 2)])), "units_count");
  });
  it("accepts gross equal to minG and refuses gross one below minG", async () => {
    await accepts(input([unit({ g: terms().minG })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ g: terms().minG - 1n })])), "gross_below_min");
  });
  it("accepts each allowed requiredTier and refuses neighboring excluded tiers", async () => {
    for (const requiredTier of terms().allowedRequiredTiers) {
      await accepts(input([unit({ requiredTier, requestedTier: requiredTier })]));
    }
    for (const requiredTier of [0, 3]) {
      await refusal(() => key.signJobPolicyAcceptance(input([unit({ requiredTier, requestedTier: requiredTier })])),
        "tier_not_allowed");
    }
  });
  it("accepts reclaimAt at the lower bound and refuses one second before it", async () => {
    const bound = nowSeconds + 300n + BigInt(terms().reclaimMinSeconds);
    await accepts(input([unit({ reclaimAt: bound })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ reclaimAt: bound - 1n })])), "reclaim_too_soon");
  });
  it("accepts reclaimAt at the upper bound and refuses one second after it", async () => {
    const bound = nowSeconds + BigInt(terms().reclaimMaxSeconds);
    await accepts(input([unit({ reclaimAt: bound })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ reclaimAt: bound + 1n })])), "reclaim_too_late");
  });
  it("accepts feeBps equal to maxFeeBps and refuses one basis point above it", async () => {
    await accepts(input([unit({ feeBps: terms().maxFeeBps })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeBps: terms().maxFeeBps + 1 })])), "fee_too_high");
  });
  it("accepts an allowed fee recipient and refuses a different fee recipient", async () => {
    await accepts(input([unit({ feeRecipient })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeRecipient: otherRecipient })])),
      "fee_recipient_not_allowed");
  });
  it("accepts a lowercase fee recipient against mixed-case terms and the reverse", async () => {
    const lowercase = feeRecipient.toLowerCase() as Address;
    expect(lowercase).not.toBe(feeRecipient);
    await accepts(input([unit({ feeRecipient: lowercase })]));
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), allowedFeeRecipients: [lowercase] } });
    await accepts(input([unit({ feeRecipient })]), bound);
  });
  it("accepts the zero address only for a zero fee and refuses it for a positive fee", async () => {
    await accepts(input([unit({ feeBps: 0, feeRecipient: zeroAddress })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeBps: 1, feeRecipient: zeroAddress })])),
      "fee_recipient_not_allowed");
  });
  it("refuses the zero address with a positive fee even if terms explicitly list it", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now, terms: { ...terms(), allowedFeeRecipients: [zeroAddress] } });
    await accepts(input([unit({ feeBps: 0, feeRecipient: zeroAddress })]), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ feeBps: 1, feeRecipient: zeroAddress })])),
      "fee_recipient_not_allowed");
  });
  it("accepts payout recipients that differ from the allowed address only in letter case", async () => {
    const lowercase = payoutRecipient.toLowerCase() as Address;
    expect(lowercase).not.toBe(payoutRecipient);
    await accepts(input([unit({ payouts: [{ recipient: lowercase, amount: unit().n }] })]));
  });
  it("accepts an allowed payout recipient and refuses a recipient outside the operator's list", async () => {
    await accepts(input());
    await refusal(() => key.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: otherRecipient, amount: unit().n }],
    })])), "payout_recipient_not_allowed");
  });
  it("checks every payout recipient within a unit", async () => {
    const split = [{ recipient: payoutRecipient, amount: 1n },
      { recipient: otherRecipient, amount: unit().n - 1n }];
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), allowedPayoutRecipients: [payoutRecipient, otherRecipient] } });
    await accepts(input([unit({ payouts: split })]), bound);
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ payouts: split })])),
      "payout_recipient_not_allowed");
  });
  it("checks payout recipients in every unit", async () => {
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({
      payouts: [{ recipient: otherRecipient, amount: unit().n }],
    }, 1)])), "payout_recipient_not_allowed");
  });
  for (const offset of [-1n, 1n]) {
    it(`accepts the compiler fee and refuses f off by ${offset} base unit`, async () => {
      await accepts(input());
      await refusal(() => key.signJobPolicyAcceptance(input([unit({ f: unit().f + offset })])),
        "fee_split_mismatch");
    });
    it(`accepts the compiler net and refuses n off by ${offset} base unit`, async () => {
      await accepts(input());
      const n = unit().n + offset;
      await refusal(() => key.signJobPolicyAcceptance(input([unit({ n,
        payouts: [{ recipient: payoutRecipient, amount: n }],
      })])), "fee_split_mismatch");
    });
    it(`accepts exact payout conservation and refuses a payout sum off by ${offset} base unit`, async () => {
      await accepts(input());
      await refusal(() => key.signJobPolicyAcceptance(input([unit({
        payouts: [{ recipient: payoutRecipient, amount: unit().n + offset }],
      })])), "payout_sum_mismatch");
    });
  }
  it("uses the compiler's floored fee for gross not divisible by the fee denominator", async () => {
    const candidate = unit({ g: 10_001n });
    expect(candidate.f).toBe(50n);
    expect(candidate.n).toBe(9_951n);
    await accepts(input([candidate]));
    await refusal(() => key.signJobPolicyAcceptance(input([{ ...candidate, f: 51n, n: 9_950n,
      payouts: [{ recipient: payoutRecipient, amount: 9_950n }],
    }])), "fee_split_mismatch");
  });
  it("checks the fee split in every unit", async () => {
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({ f: unit().f + 1n }, 1)])),
      "fee_split_mismatch");
  });
  it("accepts one positive payout and refuses an empty payouts list", async () => {
    await accepts(input());
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ payouts: [] })])), "payout_sum_mismatch");
  });
  it("accepts every positive payout and refuses zero even when the sum equals n", async () => {
    const n = unit().n;
    await accepts(input([unit({ payouts: [{ recipient: payoutRecipient, amount: 1n },
      { recipient: payoutRecipient, amount: n - 1n }] })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: payoutRecipient, amount: 0n }, { recipient: payoutRecipient, amount: n }],
    })])), "payout_sum_mismatch");
  });
  it("checks payout conservation in every unit", async () => {
    await accepts(input([unit({}, 0), unit({}, 1)]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({
      payouts: [{ recipient: payoutRecipient, amount: unit().n - 1n }],
    }, 1)])), "payout_sum_mismatch");
  });
  it("checks every unit rather than only the first", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit({}, 0), unit({ g: terms().minG - 1n }, 1)])),
      "gross_below_min");
  });
  it("accepts expiry one second after now and refuses expiry at now or in the past", async () => {
    await accepts(input([unit()], { expiry: nowSeconds + 1n }));
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { expiry: nowSeconds })), "acceptance_expired");
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { expiry: nowSeconds - 1n })), "acceptance_expired");
  });
  it("accepts expiry at maxAcceptanceSeconds and refuses one second beyond it", async () => {
    const bound = nowSeconds + BigInt(terms().maxAcceptanceSeconds);
    await accepts(input([unit()], { expiry: bound }));
    await refusal(() => key.signJobPolicyAcceptance(input([unit()], { expiry: bound + 1n })), "acceptance_too_long");
  });
  it("uses the exact fractional loaded clock for expiry and the acceptance upper bound", async () => {
    const fractionalNow = new Date(now.getTime() + 500);
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => fractionalNow, terms: terms() });
    await accepts(input([unit()], { expiry: nowSeconds + 1n }), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit()], { expiry: nowSeconds })), "acceptance_expired");
    await accepts(input([unit()], { expiry: nowSeconds + BigInt(terms().maxAcceptanceSeconds) }), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit()], {
      expiry: nowSeconds + BigInt(terms().maxAcceptanceSeconds) + 1n,
    })), "acceptance_too_long");
  });
  it("measures the reclaim minimum in whole seconds from expiry despite a fractional loaded clock", async () => {
    const fractionalNow = new Date(now.getTime() + 500);
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => fractionalNow, terms: terms() });
    const lower = nowSeconds + 300n + BigInt(terms().reclaimMinSeconds);
    await accepts(input([unit({ reclaimAt: lower })]), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ reclaimAt: lower - 1n })])), "reclaim_too_soon");
  });
  it("refuses a reclaim time that passes the signing-time minimum but fails the latest-funding minimum", async () => {
    await refusal(() => key.signJobPolicyAcceptance(input([unit({
      reclaimAt: nowSeconds + BigInt(terms().reclaimMinSeconds),
    })])), "reclaim_too_soon");
  });
  it("requires loaded terms before producing an acceptance", async () => {
    const unbounded = await loadOperatorKey(path, 84532, { now, clock: () => now });
    await refusal(() => unbounded.signJobPolicyAcceptance(input()), "bad_terms");
  });
  it("snapshots HostTerms so callers cannot weaken them after loading", async () => {
    const supplied = terms();
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied });
    supplied.minG = 0n;
    supplied.allowedRequiredTiers.push(3);
    supplied.allowedFeeRecipients.push(otherRecipient);
    supplied.allowedPayoutRecipients.push(otherRecipient);
    supplied.reclaimMaxSeconds *= 2;
    supplied.maxAcceptanceSeconds *= 2;
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ g: terms().minG - 1n })])), "gross_below_min");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ requiredTier: 3, requestedTier: 3 })])), "tier_not_allowed");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({ feeRecipient: otherRecipient })])),
      "fee_recipient_not_allowed");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: otherRecipient, amount: unit().n }],
    })])), "payout_recipient_not_allowed");
  });
});

describe("HostTerms cap total pass-through across the policy", () => {
  async function capped(maxPassThrough: bigint, operatorPayoutRecipient: Address = payoutRecipient) {
    return loadOperatorKey(path, 84532, { now, clock: () => now, terms: {
      ...terms(), maxPassThrough, operatorPayoutRecipient,
      allowedPayoutRecipients: [payoutRecipient, otherRecipient],
    } });
  }
  function split(own: bigint, treasury: bigint, index = 0) {
    return unit({ g: own + treasury, feeBps: 0, feeRecipient: zeroAddress,
      payouts: [{ recipient: payoutRecipient, amount: own }, { recipient: otherRecipient, amount: treasury }],
    }, index);
  }
  it("accepts exactly 100 pass-through base units and refuses 101 from literal payouts", async () => {
    const bound = await capped(100n);
    await accepts(input([split(900n, 100n)]), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([split(899n, 101n)])), "pass_through_too_high");
  });
  it("refuses two units each under the cap when their policy total exceeds it", async () => {
    const bound = await capped(100n);
    await refusal(() => bound.signJobPolicyAcceptance(input([split(920n, 80n, 0), split(920n, 80n, 1)])),
      "pass_through_too_high");
  });
  it("allows operator-only payouts at a zero cap and refuses any treasury leg", async () => {
    const bound = await capped(0n);
    await accepts(input(), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([split(999n, 1n)])), "pass_through_too_high");
  });
  it("counts a treasury-only CARRIER unit in full against the policy cap", async () => {
    const carrier = unit({ g: 1_000n, feeBps: 0, feeRecipient: zeroAddress,
      stepId: word("CARRIER"), payouts: [{ recipient: otherRecipient, amount: 1_000n }] }, 1);
    await accepts(input([unit(), carrier]), await capped(1_000n));
    const bound = await capped(999n);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit(), carrier])), "pass_through_too_high");
  });
  it("counts mixed-case operatorPayoutRecipient as own for lowercase payouts and the reverse", async () => {
    const lowercase = payoutRecipient.toLowerCase() as Address;
    expect(lowercase).not.toBe(payoutRecipient);
    await accepts(input([unit({ payouts: [{ recipient: lowercase, amount: unit().n }] })]), await capped(0n));
    await accepts(input(), await capped(0n, lowercase));
  });
  it("sums two operator payout legs before computing pass-through", async () => {
    const bound = await capped(100n);
    await accepts(input([unit({ g: 1_000n, feeBps: 0, feeRecipient: zeroAddress,
      payouts: [{ recipient: payoutRecipient, amount: 400n }, { recipient: payoutRecipient, amount: 500n },
        { recipient: otherRecipient, amount: 100n }],
    })]), bound);
  });
  it("snapshots deployment identity, payout identity and the pass-through cap at load", async () => {
    const supplied = { ...terms(), maxPassThrough: 100n,
      allowedPayoutRecipients: [payoutRecipient, otherRecipient] };
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied });
    supplied.factory = otherRecipient;
    supplied.implementation = otherRecipient;
    supplied.operatorPayoutRecipient = otherRecipient;
    supplied.maxPassThrough = 20_000n;
    await accepts(input([split(900n, 100n)]), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([split(899n, 101n)])), "pass_through_too_high");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit()], { factory: otherRecipient })),
      "deployment_mismatch");
    await refusal(() => bound.signJobPolicyAcceptance(input([unit()], { implementation: otherRecipient })),
      "deployment_mismatch");
  });
});

describe("HostTerms bind authorization to the key's chain", () => {
  for (const chainId of [84532, 31337] as const) {
    const otherChainId = chainId === 84532 ? 31337 : 84532;
    it(`loads terms for chain ${chainId} with a key bound to chain ${chainId}`, async () => {
      const supplied = terms(chainId);
      expect(validateHostTerms(supplied).chainId).toBe(chainId);
      const bound = await loadOperatorKey(path, chainId, { now, clock: () => now, terms: supplied });
      expect(bound.address).toBe(key.address);
    });
    it(`refuses terms for chain ${chainId} with a key bound to chain ${otherChainId}`, async () => {
      await refusal(() => loadOperatorKey(path, otherChainId, { now, clock: () => now,
        terms: terms(chainId) }), "bad_terms");
    });
    it(`refuses terms for chain ${chainId} before reading a key file bound to chain ${otherChainId}`, async () => {
      await refusal(() => loadOperatorKey(join(directory, "missing-operator.json"), otherChainId,
        { now, clock: () => now, terms: terms(chainId) }), "bad_terms");
    });
  }
  for (const [label, chainId] of [["missing chainId", undefined], ["string chainId 84532", "84532"],
    ["chainId 1", 1], ["chainId 84533", 84533]] as const) {
    it(`refuses terms with ${label} at validation and key load with bad_terms`, async () => {
      const supplied: Record<string, unknown> = { ...terms() };
      if (chainId === undefined) delete supplied.chainId;
      else supplied.chainId = chainId;
      await refusal(async () => validateHostTerms(supplied as unknown as HostTerms), "bad_terms");
      await refusal(() => loadOperatorKey(path, 84532, { now, clock: () => now,
        terms: supplied as unknown as HostTerms }), "bad_terms");
    });
  }
});

describe("HostTerms loading refuses malformed authorizations", () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["superseded termsHash field", { termsHash: supersededTermsFileDigest }],
    ["zero settlement token", { settlementToken: zeroAddress }],
    ["invalid settlement token", { settlementToken: "invalid" }],
    ["short settlement token", { settlementToken: `0x${"00".repeat(19)}` }],
    ["missing committedProgramHash pin", { subjectPins: { targetSystemIdentity: word("target-system") } }],
    ["empty subjectPins", { subjectPins: {} }], ["null subjectPins", { subjectPins: null }],
    ["array subjectPins", { subjectPins: [] }],
    ["invalid committedProgramHash pin", { subjectPins: { committedProgramHash: "invalid" } }],
    ["non-bytes32 subject pin", { subjectPins: { committedProgramHash: s2ProgramHash, targetSystemIdentity: 1 } }],
    ["unknown subject pin", { subjectPins: { committedProgramHash: s2ProgramHash, unapproved: word("unapproved") } }],
    ["invalid settlement-address pin", { subjectPins: { committedProgramHash: s2ProgramHash,
      operatorSettlementAddress: "invalid" } }],
    ["settlement-address pin different from operatorPayoutRecipient", { subjectPins: {
      committedProgramHash: s2ProgramHash, operatorSettlementAddress: otherRecipient,
    } }],
    ["negative integrityGrade pin", { subjectPins: { committedProgramHash: s2ProgramHash, integrityGrade: -1 } }],
    ["fractional integrityGrade pin", { subjectPins: { committedProgramHash: s2ProgramHash, integrityGrade: 1.5 } }],
    ["integrityGrade pin above uint8", { subjectPins: { committedProgramHash: s2ProgramHash, integrityGrade: 256 } }],
    ["negative-zero integrityGrade pin", { subjectPins: { committedProgramHash: s2ProgramHash, integrityGrade: -0 } }],
    ["noncanonical integrityGrade pin", { subjectPins: { committedProgramHash: s2ProgramHash, integrityGrade: "02" } }],
    ["invalid bindingsRoot pin", { bindingsRoot: "invalid" }],
    ["undefined bindingsRoot pin", { bindingsRoot: undefined }],
    ["negative minG", { minG: -1n }], ["number minG", { minG: 1_000 }],
    ["empty tier list", { allowedRequiredTiers: [] }], ["tier above three", { allowedRequiredTiers: [4] }],
    ["negative tier", { allowedRequiredTiers: [-1] }], ["fractional tier", { allowedRequiredTiers: [1.5] }],
    ["repeated tier", { allowedRequiredTiers: [1, 1] }],
    ["negative reclaim minimum", { reclaimMinSeconds: -1 }],
    ["reclaim minimum below contract minimum", { reclaimMinSeconds: 863_999 }],
    ["reclaim maximum above contract maximum", { reclaimMaxSeconds: 31_536_001 }],
    ["zero factory", { factory: zeroAddress }], ["invalid factory", { factory: "invalid" }],
    ["zero implementation", { implementation: zeroAddress }], ["invalid implementation", { implementation: "invalid" }],
    ["operator recipient outside payout allowlist", { operatorPayoutRecipient: otherRecipient }],
    ["negative pass-through cap", { maxPassThrough: -1n }], ["number pass-through cap", { maxPassThrough: 0 }],
    ["pass-through cap above uint256", { maxPassThrough: 1n << 256n }],
    ["fractional reclaim minimum", { reclaimMinSeconds: 1.5 }],
    ["inverted reclaim window", { reclaimMaxSeconds: 864_000 - 1 }],
    ["unsafe reclaim maximum", { reclaimMaxSeconds: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative fee maximum", { maxFeeBps: -1 }], ["fractional fee maximum", { maxFeeBps: 1.5 }],
    ["fee maximum above contract maximum", { maxFeeBps: 1_001 }],
    ["invalid fee recipient", { allowedFeeRecipients: ["invalid"] }],
    ["undefined payout recipient list", { allowedPayoutRecipients: undefined }],
    ["empty payout recipient list", { allowedPayoutRecipients: [] }],
    ["non-array payout recipient list", { allowedPayoutRecipients: payoutRecipient }],
    ["invalid payout recipient", { allowedPayoutRecipients: ["invalid"] }],
    ["repeated payout recipient", { allowedPayoutRecipients: [payoutRecipient, payoutRecipient] }],
    ["repeated payout recipient in different letter case", {
      allowedPayoutRecipients: [payoutRecipient, payoutRecipient.toLowerCase()],
    }],
    ["zero maxUnits", { maxUnits: 0 }], ["too many maxUnits", { maxUnits: 17 }],
    ["fractional maxUnits", { maxUnits: 1.5 }],
    ["zero acceptance maximum", { maxAcceptanceSeconds: 0 }],
    ["negative acceptance maximum", { maxAcceptanceSeconds: -1 }],
    ["unsafe acceptance maximum", { maxAcceptanceSeconds: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const [label, change] of malformed) {
    it(`refuses ${label} at load with bad_terms`, async () => {
      await refusal(() => loadOperatorKey(path, 84532, { now, clock: () => now, terms: { ...terms(), ...change } as never }), "bad_terms");
    });
  }
  for (const field of ["allowedPayoutRecipients", "operatorPayoutRecipient", "maxPassThrough", "factory", "implementation",
    "settlementToken", "subjectPins"] as const) {
    it(`requires the ${field} authorization field at load`, async () => {
      const supplied: Partial<ReturnType<typeof terms>> = terms();
      delete supplied[field];
      await refusal(() => loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied as HostTerms }), "bad_terms");
    });
  }
  it("loads the exact contract reclaim minimum and maximum", async () => {
    await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), reclaimMinSeconds: 864_000, reclaimMaxSeconds: 31_536_000 } });
  });
  for (const variant of ["extra", "accessor", "inherited"] as const) {
    it(`refuses ${variant} HostTerms fields without inspecting their values`, async () => {
      const getter = vi.fn(() => { throw new Error(secret); });
      const supplied = variant === "inherited" ? Object.assign(Object.create({ secret }), terms()) : terms();
      if (variant === "extra") Object.defineProperty(supplied, "unapproved", { enumerable: true, value: secret });
      if (variant === "accessor") Object.defineProperty(supplied, "minG", { enumerable: true, get: getter });
      await refusal(() => loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied }), "bad_terms");
      expect(getter).not.toHaveBeenCalled();
    });
  }
  for (const variant of ["accessor", "inherited", "symbol", "non-enumerable", "proxy"] as const) {
    it(`refuses ${variant} subjectPins at validation and load without executing input code`, async () => {
      const supplied = terms();
      const getter = vi.fn(() => { throw new Error(secret); });
      if (variant === "accessor") Object.defineProperty(supplied.subjectPins, "committedProgramHash", {
        enumerable: true, get: getter,
      });
      if (variant === "inherited") Object.setPrototypeOf(supplied.subjectPins, { unapproved: secret });
      if (variant === "symbol") Object.defineProperty(supplied.subjectPins, Symbol("unapproved"), { value: secret });
      if (variant === "non-enumerable") Object.defineProperty(supplied.subjectPins, "committedProgramHash", {
        value: s2ProgramHash, enumerable: false,
      });
      if (variant === "proxy") supplied.subjectPins = new Proxy(supplied.subjectPins, { ownKeys: getter });
      await refusal(async () => validateHostTerms(supplied), "bad_terms");
      await refusal(() => loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied }), "bad_terms");
      expect(getter).not.toHaveBeenCalled();
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const variant of ["extra", "accessor", "inherited", "sparse"] as const) {
    it(`refuses ${variant} payout recipient list fields without executing a getter`, async () => {
      const supplied = terms();
      const getter = vi.fn(() => { throw new Error(secret); });
      if (variant === "extra") Object.defineProperty(supplied.allowedPayoutRecipients, "unapproved", {
        value: secret, enumerable: true,
      });
      if (variant === "accessor") Object.defineProperty(supplied.allowedPayoutRecipients, "0", {
        get: getter, enumerable: true,
      });
      if (variant === "inherited") {
        Object.setPrototypeOf(supplied.allowedPayoutRecipients, Object.create(Array.prototype));
      }
      if (variant === "sparse") supplied.allowedPayoutRecipients.length = 2;
      await refusal(() => loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied }), "bad_terms");
      expect(getter).not.toHaveBeenCalled();
    });
  }
  it("copies and freezes the payout recipient authorization list", () => {
    const supplied = terms();
    const validated = validateHostTerms(supplied);
    expect(validated.allowedPayoutRecipients).not.toBe(supplied.allowedPayoutRecipients);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.allowedPayoutRecipients)).toBe(true);
    supplied.allowedPayoutRecipients.splice(0, 1, otherRecipient);
    expect(validated.allowedPayoutRecipients).toEqual([payoutRecipient]);
    expect(() => (validated.allowedPayoutRecipients as Address[]).push(otherRecipient)).toThrow(TypeError);
  });
  it("copies and freezes subjectPins separately from the caller's terms", () => {
    const supplied = terms();
    const validated = validateHostTerms(supplied);
    expect(validated.subjectPins).not.toBe(supplied.subjectPins);
    expect(Object.isFrozen(validated.subjectPins)).toBe(true);
    supplied.subjectPins.committedProgramHash = changedByte(s2ProgramHash);
    expect(validated.subjectPins.committedProgramHash).toBe(s2ProgramHash);
    expect(() => Object.assign(validated.subjectPins, { committedProgramHash: word("replacement-program") }))
      .toThrow(TypeError);
  });
  it("snapshots settlementToken, program pins and bindingsRoot at key load", async () => {
    const candidate = input();
    const supplied = { ...terms(), bindingsRoot: computeBindingsRoot(candidate.bindings) };
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now, terms: supplied });
    supplied.settlementToken = otherRecipient;
    supplied.subjectPins.committedProgramHash = changedByte(s2ProgramHash);
    supplied.subjectPins.targetSystemIdentity = word("changed-system");
    supplied.bindingsRoot = word("changed-bindings-root");
    await accepts(candidate, bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit()], {
      termsHash: termsHashFromUnits([unit()], supplied.settlementToken),
    })),
      "terms_hash_mismatch");
    const programChanged = input();
    programChanged.subjectBlock.committedProgramHash = supplied.subjectPins.committedProgramHash;
    refreshAcceptedPolicy(programChanged);
    await refusal(() => bound.signJobPolicyAcceptance(programChanged), "subject_pin_mismatch");
    const bindingChanged = input();
    bindingChanged.bindings[0].valueRef = changedByte(bindingChanged.bindings[0].valueRef);
    refreshAcceptedPolicy(bindingChanged);
    await refusal(() => bound.signJobPolicyAcceptance(bindingChanged), "bindings_root_mismatch");
    expect(failure.signCalls).toBe(1);
  });
});

describe("JobPolicy acceptance also enforces buildUnitConfig's context-free rules", () => {
  it("accepts equal requestedTier and requiredTier and refuses a mismatched request", async () => {
    await accepts(input([unit({ requiredTier: 1, requestedTier: 1 })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ requiredTier: 1, requestedTier: 2 })])),
      "bad_input");
  });
  it("accepts the uint128 gross maximum and refuses one base unit above it", async () => {
    const maximum = unit({ g: VNEXT.MAX_GROSS });
    await accepts(input([maximum]));
    const g = VNEXT.MAX_GROSS + 1n;
    const { f, n } = computeFee(g, maximum.feeBps);
    await refusal(() => key.signJobPolicyAcceptance(input([{ ...maximum, g, f, n,
      payouts: [{ recipient: payoutRecipient, amount: n }],
    }])), "bad_input");
  });
  it("accepts the compiler minimum gross and refuses one below despite permissive HostTerms", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now, terms: { ...terms(), minG: 0n } });
    const minimum = unit({ g: VNEXT.MIN_BONDABLE_GROSS });
    await accepts(input([minimum]), bound);
    const g = VNEXT.MIN_BONDABLE_GROSS - 1n;
    const { f, n } = computeFee(g, minimum.feeBps);
    await refusal(() => bound.signJobPolicyAcceptance(input([{ ...minimum, g, f, n,
      payouts: [{ recipient: payoutRecipient, amount: n }],
    }])), "bad_input");
  });
  it("accepts the compiler payout leg limit and refuses one extra leg", async () => {
    const payouts = (count: number) => Array.from({ length: count }, (_, index) => ({
      recipient: payoutRecipient, amount: index === count - 1 ? unit().n - BigInt(count - 1) : 1n,
    }));
    await accepts(input([unit({ payouts: payouts(VNEXT.MAX_PAYOUT_LEGS_PER_UNIT) })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({
      payouts: payouts(VNEXT.MAX_PAYOUT_LEGS_PER_UNIT + 1),
    })])), "bad_input");
  });
  it("refuses the zero payout recipient even when HostTerms explicitly authorize it", async () => {
    const bound = await loadOperatorKey(path, 84532, { now, clock: () => now,
      terms: { ...terms(), allowedPayoutRecipients: [payoutRecipient, zeroAddress] } });
    await accepts(input(), bound);
    await refusal(() => bound.signJobPolicyAcceptance(input([unit({
      payouts: [{ recipient: zeroAddress, amount: unit().n }],
    })])), "bad_input");
  });
  it("accepts a zero fee with a zero recipient and refuses a nonzero recipient for that fee", async () => {
    await accepts(input([unit({ feeBps: 0, feeRecipient: zeroAddress })]));
    await refusal(() => key.signJobPolicyAcceptance(input([unit({ feeBps: 0, feeRecipient })])), "bad_input");
  });
});

describe("JobPolicy acceptance snapshots only strict data fields", () => {
  it("derives terms from the same unit snapshot before the clock mutates caller units", async () => {
    const candidate = input([unit({}, 1), unit({}, 0)]);
    const signedPolicy = { ...candidate.policy };
    const clock = vi.fn(() => {
      candidate.units.reverse();
      candidate.units[0].g += 1n;
      candidate.units[0].reclaimAt += 1n;
      candidate.units[0].requiredTier = 2;
      candidate.units[0].requestedTier = 2;
      return now;
    });
    const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() });
    const signature = await bound.signJobPolicyAcceptance(candidate);
    expect(await verifyTypedData({ ...jobPolicyTypedData(signedPolicy), address: bound.address, signature })).toBe(true);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(failure.signCalls).toBe(1);
  });
  it("derives both principal checks from the snapshot before the clock mutates payer and subject words", async () => {
    const candidate = input();
    const signedPolicy = { ...candidate.policy };
    const clock = vi.fn(() => {
      candidate.policy.payer = otherRecipient;
      candidate.subjectBlock.payer = changedByte(candidate.subjectBlock.payer);
      candidate.subjectBlock.operatorPrincipal = changedByte(candidate.subjectBlock.operatorPrincipal);
      return now;
    });
    const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() });
    const signature = await bound.signJobPolicyAcceptance(candidate);
    expect(await verifyTypedData({ ...jobPolicyTypedData(signedPolicy), address: bound.address, signature })).toBe(true);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(failure.signCalls).toBe(1);
  });
  for (const level of ["input", "policy", "unit", "payout", "units array", "payouts array",
    "subjectBlock", "binding", "bindings array"] as const) {
    for (const variant of ["extra", "accessor", "inherited"] as const) {
      it(`refuses ${variant} fields on the ${level} without executing a getter`, async () => {
        const candidate = input();
        let target: object;
        if (level === "input") target = candidate;
        else if (level === "policy") target = candidate.policy;
        else if (level === "unit") target = candidate.units[0];
        else if (level === "payout") target = candidate.units[0].payouts[0];
        else if (level === "units array") target = candidate.units;
        else if (level === "payouts array") target = candidate.units[0].payouts;
        else if (level === "subjectBlock") target = candidate.subjectBlock;
        else if (level === "binding") target = candidate.bindings[0];
        else target = candidate.bindings;
        const getter = vi.fn(() => { throw new Error(secret); });
        const fields = { input: "policy", policy: "operator", unit: "g", payout: "amount", "units array": "0",
          "payouts array": "0", subjectBlock: "committedProgramHash", binding: "valueRef", "bindings array": "0" };
        if (variant === "extra") Object.defineProperty(target, "unapproved", { value: secret, enumerable: true });
        if (variant === "accessor") Object.defineProperty(target, fields[level], { enumerable: true, get: getter });
        if (variant === "inherited") {
          const prototype = Object.create(Object.getPrototypeOf(target));
          Object.defineProperty(prototype, "unapproved", { value: secret, enumerable: true });
          Object.setPrototypeOf(target, prototype);
        }
        await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
        expect(getter).not.toHaveBeenCalled();
      });
    }
  }
  it("refuses a getter on now before using the clock", async () => {
    const candidate = input();
    const getter = vi.fn(() => { throw new Error(secret); });
    Object.defineProperty(candidate, "now", { enumerable: true, get: getter });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses missing policy fields", async () => {
    const candidate = input();
    delete (candidate.policy as Partial<JobPolicyFields>).escrow;
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
  });
  for (const field of ["subjectBlock", "bindings"] as const) {
    it(`requires the ${field} acceptance input`, async () => {
      const candidate: Partial<ReturnType<typeof input>> = input();
      delete candidate[field];
      await refusal(() => key.signJobPolicyAcceptance(candidate as never), "bad_input");
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const field of Object.keys(subjectBlock()) as (keyof SubjectBlockFields)[]) {
    it(`maps the spec producer's missing subject ${field} refusal to bad_input`, async () => {
      const candidate = input();
      delete (candidate.subjectBlock as Partial<SubjectBlockFields>)[field];
      await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
      expect(failure.signCalls).toBe(0);
    });
  }
  it("maps duplicate binding requirementIdHash admission to bad_input even across plan units", async () => {
    const candidate = input([unit(), unit({}, 1)]);
    candidate.bindings.push({ ...candidate.bindings[0], planUnitKey: computePlanUnitKey(1,
      candidate.units[1].milestoneIndex, candidate.units[1].stepId) });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
    expect(failure.signCalls).toBe(0);
  });
  for (const [label, field, value] of [
    ["invalid bytes32", "committedProgramHash", "invalid"],
    ["non-lowercase bytes32", "committedProgramHash", s2ProgramHash.toUpperCase().replace("0X", "0x")],
    ["invalid settlement address", "operatorSettlementAddress", "invalid"],
    ["integrityGrade above uint8", "integrityGrade", 256],
    ["fractional integrityGrade", "integrityGrade", 1.5],
    ["noncanonical integrityGrade", "integrityGrade", "02"],
    ["negative-zero integrityGrade", "integrityGrade", -0],
  ] as const) {
    it(`maps the spec producer's ${label} refusal to bad_input`, async () => {
      const candidate = input();
      Object.assign(candidate.subjectBlock, { [field]: value });
      await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const field of ["planUnitKey", "requirementIdHash", "sourceKind", "propositionKind", "valueRef"] as const) {
    it(`maps the spec producer's missing binding ${field} refusal to bad_input`, async () => {
      const candidate = input();
      delete (candidate.bindings[0] as Partial<SubjectBinding>)[field];
      await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const sourceKind of [256, "01", -1, -0, 1.5]) {
    it(`maps malformed binding sourceKind ${String(sourceKind)} to bad_input without exposing input`, async () => {
      const candidate = input();
      candidate.bindings[0].sourceKind = sourceKind;
      await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const level of ["subjectBlock", "binding", "bindings array"] as const) {
    it(`refuses a Proxy ${level} before inspecting its traps`, async () => {
      const candidate = input();
      const trap = vi.fn(() => { throw new Error(secret); });
      const handler = { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap };
      if (level === "subjectBlock") candidate.subjectBlock = new Proxy(candidate.subjectBlock, handler);
      if (level === "binding") candidate.bindings[0] = new Proxy(candidate.bindings[0], handler);
      if (level === "bindings array") candidate.bindings = new Proxy(candidate.bindings, handler);
      await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
      expect(trap).not.toHaveBeenCalled();
      expect(failure.signCalls).toBe(0);
    });
  }
  for (const level of ["subjectBlock", "bindings"] as const) {
    it(`captures ${level} before the signing clock can mutate caller input`, async () => {
      const candidate = input();
      const clock = vi.fn(() => {
        if (level === "subjectBlock") {
          candidate.subjectBlock.committedProgramHash = changedByte(s2ProgramHash);
          candidate.subjectBlock.operatorSettlementAddress = otherRecipient.toLowerCase() as Address;
          candidate.subjectBlock.targetSystemIdentity = word("mutated-target");
        } else {
          candidate.bindings[0].valueRef = word("mutated-value");
          candidate.bindings[0].requirementIdHash = word("mutated-requirement");
          candidate.bindings.push({ ...candidate.bindings[0] });
        }
        return now;
      });
      const bound = await loadOperatorKey(path, 84532, { now, clock, terms: terms() });
      await accepts(candidate, bound);
      expect(clock).toHaveBeenCalledTimes(1);
      expect(failure.signCalls).toBe(1);
    });
  }
  it("maps producer refusals to bad_input without printing exceptions or secret input", async () => {
    const candidate = input();
    candidate.bindings[0].valueRef = secret;
    candidate.subjectBlock.integrityGrade = secret;
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(failure.signCalls).toBe(0);
  });
  it("refuses sparse arrays", async () => {
    const candidate = input();
    candidate.units.length = 2;
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
  });
  it("refuses symbol and non-enumerable fields", async () => {
    const candidate = input();
    Object.defineProperty(candidate.policy, Symbol("unapproved"), { value: secret });
    await refusal(() => key.signJobPolicyAcceptance(candidate), "bad_input");
    const nonEnumerable = input();
    Object.defineProperty(nonEnumerable.policy, "operator", { value: key.address, enumerable: false });
    await refusal(() => key.signJobPolicyAcceptance(nonEnumerable), "bad_input");
  });
  it("refuses non-object input and invalid now values", async () => {
    for (const value of [null, undefined, [], secret, 1, true]) {
      await refusal(() => key.signJobPolicyAcceptance(value as never), "bad_input");
    }
    for (const value of ["2026-10-10", 0, new Date(Number.NaN)]) {
      await refusal(() => key.signJobPolicyAcceptance({ ...input(), now: value } as never), "bad_input");
    }
  });
  it("refuses decimal strings and unsafe integer policy fields at the signing API", async () => {
    for (const value of ["84532", 84532, -1n, (1n << 256n)]) {
      await refusal(() => key.signJobPolicyAcceptance({ ...input(), policy: { ...input().policy, chainId: value } } as never),
        "bad_integer");
    }
  });
  it("does not expose keys or input values through library signing failures or logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    failure.enabled = true;
    await refusal(() => key.signJobPolicyAcceptance(input()), "signing_failed");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    noLeak(key);
  });
});

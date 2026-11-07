import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zeroAddress, zeroHash, type Address, type Hex } from "viem";
import {
  computeAcceptedPolicyDigest, computeBindingsRoot, computeSubjectBlockHash,
  type SubjectBinding, type SubjectBlockFields,
} from "../../evidence/accepted-policy.js";
import { formatOperatorPrincipalId, principalTupleWord } from "../../evidence/principal-id.js";
import { DEFAULT_MARGIN_SECONDS, prepareFunding, type FundingExpectations } from "../../funding/prepare.js";
import { computeTermsHashV21 } from "../../funding/terms-hash-v21.js";
import type { UnitConfig } from "../../funding/vnext.js";
import { NOW, OTHER, buildFixture, makeChain, newAccount, testPins, type FixtureOptions } from "./fixture.js";

const api = () => import("../../funding/dry-run-unit.js");
const TOKEN: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const EMPTY_ROOT = "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd";
const ONE: Hex = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ZERO_FIELDS = [
  "childrenRoot", "expertSetRoot", "executorSetRoot", "expectedRecipient", "targetSystemIdentity",
  "recipeRef", "sampleManifestRef", "operatingEnvelopeHash", "expectedRouteArea", "expectedLocationHash",
  "captureNonceAnchor", "challengeAnchor",
] as const;
const publicWord = (a: Address) => principalTupleWord("operator", formatOperatorPrincipalId(84532, a));
function subjectFor(operator: Address, wallet: Address): SubjectBlockFields {
  return {
    payer: publicWord(wallet), operatorPrincipal: publicWord(operator),
    operatorSettlementAddress: operator.toLowerCase() as Address, authorizedTuplesRoot: ONE,
    committedProgramHash: zeroHash, integrityGrade: 0,
    childrenRoot: zeroHash, expertSetRoot: zeroHash, executorSetRoot: zeroHash,
    expectedRecipient: zeroHash, targetSystemIdentity: zeroHash, recipeRef: zeroHash,
    sampleManifestRef: zeroHash, operatingEnvelopeHash: zeroHash, expectedRouteArea: zeroHash,
    expectedLocationHash: zeroHash, captureNonceAnchor: zeroHash, challengeAnchor: zeroHash,
  };
}
const termsFor = (cs: readonly UnitConfig[]) => computeTermsHashV21({ token: TOKEN, assuranceTier: 1,
  milestones: cs.map((c) => ({ milestoneIndex: c.milestoneIndex, stepId: c.stepId, amount: c.g, deadline: c.reclaimAt })) });
const digestFor = (subject: SubjectBlockFields, termsHash: Hex) => computeAcceptedPolicyDigest({
  termsHash, subjectBlockHash: computeSubjectBlockHash(subject), bindingsRoot: computeBindingsRoot([]),
});

async function setup() {
  const { dryRunUnitTestnetExpectation } = await api();
  const parties = { payer: newAccount(), operator: newAccount() };
  const subject = subjectFor(parties.operator.address, parties.payer.address);
  const input = { jobId: "n145-ns6-dry-run-test", operator: parties.operator.address, fundingWallet: parties.payer.address,
    subject, bindings: [] as readonly SubjectBinding[], latestBlockTimestamp: NOW };
  const own = dryRunUnitTestnetExpectation(input);
  const options: FixtureOptions = { chainId: 84532, usdc: TOKEN, jobId: input.jobId,
    expiry: NOW + 1_200n, reclaimAt: [NOW + 7_200n], configure: (cs) => Object.assign(cs[0]!, {
      requiredTier: 1, requestedTier: 1, g: 1_000_000n, f: 0n, n: 1_000_000n,
      feeBps: 0, feeRecipient: zeroAddress, compositionSchemaVersion: 0, compositionRoot: zeroHash,
      payouts: [{ recipient: parties.operator.address, amount: 1_000_000n }],
    }) };
  const buildConfigured = async (change: FixtureOptions = {}) => {
    const merged = { ...options, ...change, configure: (cs: UnitConfig[]) => {
      options.configure!(cs); change.configure?.(cs);
    } };
    const configured = await buildFixture(merged, parties);
    const termsHash = change.termsHash ?? termsFor(configured.configs);
    return buildFixture({ ...merged, termsHash,
      acceptedPolicyDigest: change.acceptedPolicyDigest ?? digestFor(subject, termsHash) }, parties);
  };
  const fx = await buildConfigured();
  const chain = makeChain(fx);
  const prepare = () => prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
    quote: { maxTotalGross: 1_000_000n }, expect: own, pins: testPins(fx) });
  const substituted = async (change: FixtureOptions, marginSeconds?: bigint) => {
    const changed = await buildConfigured(change);
    const fake = makeChain(changed);
    const pending = prepareFunding({ payload: changed.wire(), wallet: fake.wallet(), publicClient: fake.publicClient,
      quote: { maxTotalGross: 3_000_000n }, expect: own, pins: testPins(changed), marginSeconds });
    return { pending, fake };
  };
  return { subject, input, own, fx, chain, prepare, substituted };
}

describe("N145 NS-6 dry-run unit pins", () => {
  it("pins every decided value literally and freezes nested pins", async () => {
    const { DRY_RUN_UNIT_TESTNET_V1: p } = await api();
    expect(p).toEqual({
      committedProgramHash: zeroHash, compositionSchemaVersion: 0, compositionRoot: zeroHash,
      requiredTier: 1, requestedTier: 1, feeBps: 0, feeRecipient: zeroAddress,
      g: 1_000_000n, f: 0n, n: 1_000_000n, unitCount: 1,
      chainId: 84532, usdc: TOKEN, usdcDecimals: 6, scheduleId: "vnext-testnet-short-v1",
      reclaimDelaySeconds: 7_200n, maxAcceptanceSeconds: 1_200n, reclaimSkewSeconds: 600n,
      bindings: [], bindingsRoot: EMPTY_ROOT,
      zeroSubjectFields: Object.fromEntries(ZERO_FIELDS.map((field) => [field, zeroHash])), integrityGrade: 0,
    });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.bindings)).toBe(true);
    expect(Object.isFrozen(p.zeroSubjectFields)).toBe(true);
    expect(p.bindingsRoot).toBe(computeBindingsRoot([]));
  });
  it("exports the API and window through @pcc/spec/funding", async () => {
    const direct = await api();
    const exported = await import("../../funding/index.js");
    const windows = await import("../../funding/pins.js");
    expect(exported.DRY_RUN_UNIT_TESTNET_V1).toBe(direct.DRY_RUN_UNIT_TESTNET_V1);
    expect(exported.dryRunUnitPrincipalWord).toBe(direct.dryRunUnitPrincipalWord);
    expect(exported.dryRunUnitTestnetExpectation).toBe(direct.dryRunUnitTestnetExpectation);
    expect(exported.RECLAIM_WINDOWS).toBe(windows.RECLAIM_WINDOWS);
    expect(exported.reclaimWindowFor).toBe(windows.reclaimWindowFor);
  });
  it("matches independent viem golden literals for the complete expectation and v2.1 terms", async () => {
    const { dryRunUnitTestnetExpectation, dryRunUnitPrincipalWord } = await api();
    const operator: Address = "0x1111111111111111111111111111111111111111";
    const fundingWallet: Address = "0x2222222222222222222222222222222222222222";
    const subject = { ...subjectFor(operator, fundingWallet), payer: dryRunUnitPrincipalWord(fundingWallet),
      operatorPrincipal: dryRunUnitPrincipalWord(operator) };
    expect(subject.payer).toBe("0xe7d52eb68e3fa4cc93ceb971c1023b7c110fb4b2a8e9cc2b3c11b123d49e73e1");
    expect(subject.operatorPrincipal).toBe("0x9dc007e4546d8dd00e447a142d139429ec83c3bb6909f549c23e3c6222b745fb");
    const golden: FundingExpectations = {
      jobId: "n145-ns6-golden", operator: "0x1111111111111111111111111111111111111111",
      payer: "0x2222222222222222222222222222222222222222", payees: ["0x1111111111111111111111111111111111111111"],
      maxFeeBps: 0, feeRecipients: ["0x0000000000000000000000000000000000000000"], tiers: [1],
      termsHash: { derive: "v2.1", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", assuranceTier: 1 },
      acceptedPolicyDigest: {
        subjectBlockHash: "0x3fe34ba95c62233e0b2f8c96b9d76f7f8f87a88b75faa92b129a7ef7084942d3",
        bindingsRoot: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
      },
      compositionRoots: ["0x0000000000000000000000000000000000000000000000000000000000000000"],
      compositionSchemaVersion: 0, unitCount: 1, unitGross: 1_000_000n,
      unitPayouts: [{ recipient: "0x1111111111111111111111111111111111111111", amount: 1_000_000n }],
      chainId: 84532n, earliestReclaimAt: 1_800_004_500n, latestReclaimAt: 1_800_007_800n,
    };
    expect(dryRunUnitTestnetExpectation({ jobId: "n145-ns6-golden", operator, fundingWallet, subject,
      bindings: [], latestBlockTimestamp: 1_800_000_000n })).toEqual(golden);
    expect(computeTermsHashV21({ token: TOKEN, assuranceTier: 1, milestones: [{ milestoneIndex: 0n,
      stepId: "0x3333333333333333333333333333333333333333333333333333333333333333",
      amount: 1_000_000n, deadline: 1_800_000_000n + 7_200n }] }))
      .toBe("0x23b7b4c95315521028e56549416e3c891bd819be170914c21961ac6b1d14355d");
  });
  it("matches the canonical record and leaves enough live timing slack", async () => {
    const r = JSON.parse(readFileSync(new URL(
      "../../../../contracts/deployments/vnext/base-sepolia/CANONICAL.json", import.meta.url), "utf8"));
    const { DRY_RUN_UNIT_TESTNET_V1: p } = await api();
    const { reclaimWindowFor } = await import("../../funding/pins.js");
    expect(p.chainId).toBe(r.chainId);
    expect(p.usdc.toLowerCase()).toBe(r.usdc.toLowerCase());
    expect(p.scheduleId).toBe(r.scheduleId);
    expect(p.reclaimDelaySeconds - p.maxAcceptanceSeconds - p.reclaimSkewSeconds - DEFAULT_MARGIN_SECONDS)
      .toBeGreaterThanOrEqual(reclaimWindowFor(84532n).min);
    expect(p.reclaimDelaySeconds + p.reclaimSkewSeconds).toBeLessThanOrEqual(reclaimWindowFor(84532n).max);
  });
});

describe("dry-run buyer expectation", () => {
  it("prepares its own exact unit and binds all commitments", async () => {
    const { prepare, own, input, fx, chain } = await setup();
    chain.state.block.timestamp = NOW + 60n;
    expect(own).toMatchObject({ jobId: input.jobId, operator: input.operator, payer: input.fundingWallet,
      payees: [input.operator], maxFeeBps: 0, feeRecipients: [zeroAddress], tiers: [1],
      termsHash: { derive: "v2.1", token: TOKEN, assuranceTier: 1 },
      acceptedPolicyDigest: { subjectBlockHash: computeSubjectBlockHash(input.subject), bindingsRoot: computeBindingsRoot([]) },
      compositionRoots: [zeroHash], compositionSchemaVersion: 0, unitCount: 1, unitGross: 1_000_000n,
      unitPayouts: fx.configs[0]!.payouts, chainId: 84532n, earliestReclaimAt: NOW + 4_500n, latestReclaimAt: NOW + 7_800n });
    const prepared = await prepare();
    expect(prepared.expect.payer).toBe(input.fundingWallet);
    expect(prepared.unchecked).toEqual([]);
    expect(prepared.configs).toEqual(fx.configs);
    expect(prepared.totalGross).toBe(1_000_000n);
    expect(prepared.typedData.message.termsHash).toBe(termsFor(fx.configs));
    expect(prepared.typedData.message.acceptedPolicyDigest).toBe(digestFor(input.subject, termsFor(fx.configs)));
  });
  const configChanges: Array<[string, (cs: UnitConfig[]) => void]> = [
    ...[-1n, 1n].map((delta): [string, (cs: UnitConfig[]) => void] => [`g ${delta}`, (cs) => {
      cs[0]!.g += delta; cs[0]!.n += delta; cs[0]!.payouts[0]!.amount += delta;
    }]),
    ["payout amount", (cs) => { cs[0]!.payouts[0]!.amount -= 1n; }],
    ["payout recipient", (cs) => { cs[0]!.payouts[0]!.recipient = OTHER; }],
    ["second payout leg", (cs) => {
      cs[0]!.payouts[0]!.amount -= 1n; cs[0]!.payouts.push({ recipient: OTHER, amount: 1n });
    }],
    ["feeBps 1", (cs) => {
      Object.assign(cs[0]!, { feeBps: 1, f: 100n, n: 999_900n, feeRecipient: OTHER });
      cs[0]!.payouts[0]!.amount = 999_900n;
    }],
    ["requiredTier 0", (cs) => { cs[0]!.requiredTier = 0; }],
    ["requestedTier 0", (cs) => { cs[0]!.requestedTier = 0; }],
    ["both tiers 0", (cs) => { cs[0]!.requiredTier = 0; cs[0]!.requestedTier = 0; }],
    ["compositionSchemaVersion 1", (cs) => { cs[0]!.compositionSchemaVersion = 1; }],
    ["nonzero compositionRoot", (cs) => { cs[0]!.compositionRoot = ONE; }],
    ["unitCount 2", (cs) => { cs.push({ ...cs[0]!, milestoneIndex: 1n }); }],
    ["reclaim floor -1", (cs) => { cs[0]!.reclaimAt = NOW + 4_499n; }],
    ["reclaim ceiling +1", (cs) => { cs[0]!.reclaimAt = NOW + 7_801n; }],
  ];
  it.each(configChanges)("INTENT_MISMATCH before any RPC: %s", async (_field, change) => {
    const { substituted } = await setup();
    const { pending, fake } = await substituted({ configure: change });
    await expect(pending).rejects.toMatchObject({ code: "INTENT_MISMATCH" });
    expect(fake.state.log).toEqual([]);
  });
  const subjectChanges: Array<[string, (s: SubjectBlockFields) => void]> = [
    ["committedProgramHash", (s) => { s.committedProgramHash = ONE; }],
    ...ZERO_FIELDS.map((field): [string, (s: SubjectBlockFields) => void] => [field, (s) => { s[field] = ONE; }]),
    ["integrityGrade", (s) => { s.integrityGrade = 1; }],
    ["payer", (s) => { s.payer = publicWord(OTHER); }],
    ["operatorPrincipal", (s) => { s.operatorPrincipal = publicWord(OTHER); }],
    ["operatorSettlementAddress", (s) => { s.operatorSettlementAddress = OTHER; }],
  ];
  it.each(subjectChanges)("INTENT_MISMATCH before any RPC: subject %s", async (field, change) => {
    const { input, chain } = await setup();
    const subject = { ...input.subject }; change(subject);
    const dryApi = await api();
    expect(() => dryApi.dryRunUnitTestnetExpectation({ ...input, subject })).toThrow(expect.objectContaining({
      code: "INTENT_MISMATCH", message: expect.stringContaining(field),
    }));
    expect(chain.state.log).toEqual([]);
  });
  it("INTENT_MISMATCH before any RPC: non-empty bindings", async () => {
    const { input, chain } = await setup();
    const binding: SubjectBinding = { planUnitKey: ONE, requirementIdHash: ONE,
      sourceKind: 0, propositionKind: 0, valueRef: ONE };
    const dryApi = await api();
    expect(() => dryApi.dryRunUnitTestnetExpectation({ ...input, bindings: [binding] }))
      .toThrow(expect.objectContaining({ code: "INTENT_MISMATCH" }));
    expect(chain.state.log).toEqual([]);
  });
  it("INTENT_MISMATCH before any RPC: policy carried to 8453", async () => {
    const { substituted } = await setup();
    const { pending, fake } = await substituted({ chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
    await expect(pending).rejects.toMatchObject({ code: "INTENT_MISMATCH", message: expect.stringContaining("chainId") });
    expect(fake.state.log).toEqual([]);
  });
  it.each(["jobId", "operator", "fundingWallet", "latestBlockTimestamp"] as const)(
    "BAD_EXPECTATION before any RPC: malformed %s", async (field) => {
      const { input, chain } = await setup();
      const bad = { jobId: 7, operator: "0x1234", fundingWallet: "0x1234", latestBlockTimestamp: -1n };
      const dryApi = await api();
      expect(() => dryApi.dryRunUnitTestnetExpectation({ ...input, [field]: bad[field] } as unknown as typeof input))
        .toThrow(expect.objectContaining({ code: "BAD_EXPECTATION" }));
      expect(chain.state.log).toEqual([]);
    },
  );
  it.each([7_800n, 4_500n])("accepts expectation edge %s with the live margin satisfied", async (delay) => {
    const { substituted } = await setup();
    const { pending } = await substituted({ reclaimAt: [NOW + delay] }, delay === 4_500n ? 0n : undefined);
    expect((await pending).unchecked).toEqual([]);
  });
  it.each(["checksum", "uppercase"])("accepts settlement-address %s casing through the producer retry", async (casing) => {
    const { input, own } = await setup();
    const address = casing === "checksum" ? input.operator : `0x${input.operator.slice(2).toUpperCase()}` as Address;
    const subject = Object.freeze({ ...input.subject, operatorSettlementAddress: address });
    expect((await api()).dryRunUnitTestnetExpectation({ ...input, subject })).toEqual(own);
    expect(subject.operatorSettlementAddress).toBe(address);
  });
  it("BAD_EXPECTATION before any RPC: malformed subject is mapped from the public producer", async () => {
    const { input, chain } = await setup();
    const dryApi = await api();
    expect(() => dryApi.dryRunUnitTestnetExpectation({ ...input,
      subject: { ...input.subject, committedProgramHash: "0x1234" } }))
      .toThrow(expect.objectContaining({ code: "BAD_EXPECTATION" }));
    expect(chain.state.log).toEqual([]);
  });
});

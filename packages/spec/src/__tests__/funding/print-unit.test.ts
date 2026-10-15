import { describe, expect, it } from "vitest";
import { pad, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import {
  computeAcceptedPolicyDigest, computeBindingsRoot, computePlanUnitKey, computeSubjectBlockHash,
  type SubjectBinding, type SubjectBlockFields,
} from "../../evidence/accepted-policy.js";
import { formatOperatorPrincipalId, principalTupleWord } from "../../evidence/principal-id.js";
import { prepareFunding, type FundingExpectations } from "../../funding/prepare.js";
import type { FundingRefusalCode } from "../../funding/errors.js";
import { MIN_RECLAIM_DELAY, type UnitConfig } from "../../funding/vnext.js";
import { NOW, OTHER, buildFixture, makeChain, newAccount, testExpect, testPins, type FixtureOptions } from "./fixture.js";

// Dynamic import makes each first-run test record its own red result before the API exists.
const api = () => import("../../funding/print-unit.js");
const TERMS = "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7";
const PROGRAM = "0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a";
const POSTAGE: Address = "0x6463ACd05141c1EF6583E4Fd978FC61Fff4045DC";
const WORD = "0x5c7d94f41618b47baed85a60abea9904c04ffafe43edf75dad2739b3a760ac35";
const EMPTY_ROOT = "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd";
const TOKEN: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ONE: Hex = `0x${"0".repeat(63)}1`;
const ZERO_FIELDS = [
  "childrenRoot", "expertSetRoot", "executorSetRoot", "expectedRecipient", "targetSystemIdentity",
  "recipeRef", "sampleManifestRef", "operatingEnvelopeHash", "expectedRouteArea", "expectedLocationHash",
  "captureNonceAnchor", "challengeAnchor",
] as const;
const flipBit = (h: Hex): Hex => `0x${(BigInt(h) ^ 1n).toString(16).padStart(64, "0")}`;
const publicWord = (a: Address) => principalTupleWord("operator", formatOperatorPrincipalId(84532, a));

function subjectFor(host: Address, payer: Address): SubjectBlockFields {
  return {
    payer: publicWord(payer), operatorPrincipal: publicWord(host),
    operatorSettlementAddress: host.toLowerCase() as Address,
    // Opaque on Thursday; deliberately nonzero to prove this field is not zero-pinned.
    authorizedTuplesRoot: ONE, committedProgramHash: PROGRAM, integrityGrade: 0,
    childrenRoot: zeroHash, expertSetRoot: zeroHash, executorSetRoot: zeroHash,
    expectedRecipient: zeroHash, targetSystemIdentity: zeroHash, recipeRef: zeroHash,
    sampleManifestRef: zeroHash, operatingEnvelopeHash: zeroHash, expectedRouteArea: zeroHash,
    expectedLocationHash: zeroHash, captureNonceAnchor: zeroHash, challengeAnchor: zeroHash,
  };
}

const digestFor = (subject: SubjectBlockFields) => computeAcceptedPolicyDigest({
  termsHash: TERMS, subjectBlockHash: computeSubjectBlockHash(subject), bindingsRoot: computeBindingsRoot([]),
});

async function setup() {
  const { printUnitThursdayExpectation } = await api();
  const parties = { payer: newAccount(), operator: newAccount() };
  const subject = subjectFor(parties.operator.address, parties.payer.address);
  const input = { jobId: "thursday-print-test", host: parties.operator.address,
    fundingWallet: parties.payer.address, subject, bindings: [] as readonly SubjectBinding[], latestBlockTimestamp: NOW };
  const own = printUnitThursdayExpectation(input);
  const options: FixtureOptions = {
    chainId: 84532, usdc: TOKEN, jobId: input.jobId, termsHash: TERMS,
    acceptedPolicyDigest: digestFor(subject), reclaimAt: [NOW + 1_814_400n],
    configure: (cs) => {
      const c = cs[0]!;
      Object.assign(c, { requiredTier: 1, requestedTier: 1, g: 750_000n, f: 0n, n: 750_000n,
        feeBps: 0, feeRecipient: zeroAddress, compositionSchemaVersion: 0, compositionRoot: zeroHash,
        payouts: [{ recipient: parties.operator.address, amount: 500_000n }, { recipient: POSTAGE, amount: 250_000n }] });
    },
  };
  const fx = await buildFixture(options, parties);
  const chain = makeChain(fx);
  const prepare = (expectations: FundingExpectations = own) => prepareFunding({
    payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
    quote: { maxTotalGross: 750_000n }, expect: expectations, pins: testPins(fx),
  });
  const substituted = async (change: FixtureOptions) => {
    const changed = await buildFixture({ ...options, ...change, configure: (cs) => {
      options.configure!(cs); change.configure?.(cs);
    } }, parties);
    const fake = makeChain(changed);
    const pending = prepareFunding({ payload: changed.wire(), wallet: fake.wallet(), publicClient: fake.publicClient,
      quote: { maxTotalGross: 3_000_000n }, expect: own, pins: testPins(changed) });
    return { pending, fake };
  };
  return { subject, input, own, fx, chain, prepare, substituted };
}

describe("Thursday PRINT pins and public producers", () => {
  it("pins every decided value literally and freezes nested pins", async () => {
    const { PRINT_UNIT_THURSDAY_V1: pins, RECLAIM_SKEW_SECONDS } = await api();
    expect(pins).toEqual({
      termsHash: TERMS, committedProgramHash: PROGRAM, compositionSchemaVersion: 0, compositionRoot: zeroHash,
      requiredTier: 1, requestedTier: 1, feeBps: 0, feeRecipient: zeroAddress,
      g: 750_000n, f: 0n, n: 750_000n, passThrough: 250_000n, hostPayoutAmount: 500_000n,
      passThroughRecipient: POSTAGE, unitCount: 1, chainId: 84532, usdc: TOKEN, usdcDecimals: 6,
      reclaimDelaySeconds: 1_814_400n, minReclaimDelaySeconds: 864_000n, reclaimSkewSeconds: 600n,
      bindings: [], bindingsRoot: EMPTY_ROOT,
      zeroSubjectFields: Object.fromEntries(ZERO_FIELDS.map((field) => [field, zeroHash])), integrityGrade: 0,
    });
    expect(RECLAIM_SKEW_SECONDS).toBe(600n);
    expect(Object.isFrozen(pins)).toBe(true);
    expect(Object.isFrozen(pins.zeroSubjectFields)).toBe(true);
    expect(Object.isFrozen(pins.bindings)).toBe(true);
  });
  it.each([POSTAGE, POSTAGE.toLowerCase() as Address])("reproduces economics' principal vector for %s", async (address) => {
    const { printUnitPrincipalWord } = await api();
    expect(printUnitPrincipalWord(address)).toBe(WORD);
    expect(printUnitPrincipalWord(address)).toBe(publicWord(address));
  });
  it("accepts any hex casing for a well-formed address", async () => {
    expect((await api()).printUnitPrincipalWord(`0x${POSTAGE.slice(2).toUpperCase()}`)).toBe(WORD);
  });
  it.each(["0x1234", `0x${"g".repeat(40)}`, "", null])("BAD_EXPECTATION: malformed principal address %s", async (address) => {
    const { printUnitPrincipalWord } = await api();
    const chain = makeChain(await buildFixture());
    expect(() => printUnitPrincipalWord(address as Address)).toThrow(expect.objectContaining({ code: "BAD_EXPECTATION" }));
    expect(chain.state.log).toEqual([]);
  });
  it("pins bindingsRoot using computeBindingsRoot([])", async () => {
    expect(computeBindingsRoot([])).toBe(EMPTY_ROOT);
    expect((await api()).PRINT_UNIT_THURSDAY_V1.bindingsRoot).toBe(computeBindingsRoot([]));
  });
  it("exports the API through @pcc/spec/funding", async () => {
    const direct = await api();
    const exported = await import("../../funding/index.js");
    expect(exported.PRINT_UNIT_THURSDAY_V1).toBe(direct.PRINT_UNIT_THURSDAY_V1);
    expect(exported.printUnitPrincipalWord).toBe(direct.printUnitPrincipalWord);
    expect(exported.printUnitThursdayExpectation).toBe(direct.printUnitThursdayExpectation);
    expect(exported.RECLAIM_SKEW_SECONDS).toBe(600n);
  });
});

describe("Thursday PRINT buyer expectation", () => {
  it("prepares one exact PRINT unit with no unchecked commitments", async () => {
    const { prepare, own, input, fx } = await setup();
    expect(own).toMatchObject({ jobId: input.jobId, operator: input.host, payees: [input.host, POSTAGE],
      maxFeeBps: 0, feeRecipients: [zeroAddress], tiers: [1], termsHash: TERMS,
      acceptedPolicyDigest: digestFor(input.subject), compositionRoots: [zeroHash], compositionSchemaVersion: 0,
      unitCount: 1, unitGross: 750_000n, unitPayouts: fx.configs[0]!.payouts, chainId: 84532n,
      earliestReclaimAt: NOW + MIN_RECLAIM_DELAY, latestReclaimAt: NOW + 1_814_400n + 600n });
    const prepared = await prepare();
    expect(prepared.unchecked).toEqual([]);
    expect(prepared.configs).toEqual(fx.configs);
    expect(prepared.totalGross).toBe(750_000n);
  });
  it("digest changes with the opaque field and equals accepted-policy.ts's producer", async () => {
    const { input, own } = await setup();
    const subject = { ...input.subject, authorizedTuplesRoot: flipBit(input.subject.authorizedTuplesRoot) };
    const changed = (await api()).printUnitThursdayExpectation({ ...input, subject });
    expect(changed.acceptedPolicyDigest).not.toBe(own.acceptedPolicyDigest);
    expect(changed.acceptedPolicyDigest).toBe(computeAcceptedPolicyDigest({
      termsHash: TERMS, subjectBlockHash: computeSubjectBlockHash(subject), bindingsRoot: computeBindingsRoot([]),
    }));
  });
  const subjectChanges: Array<[string, (s: SubjectBlockFields, input: Awaited<ReturnType<typeof setup>>["input"]) => void]> = [
    ["committedProgramHash", (s) => { s.committedProgramHash = flipBit(PROGRAM); }],
    ["operatorSettlementAddress", (s) => { s.operatorSettlementAddress = OTHER; }],
    ["payer", (s) => { s.payer = publicWord(OTHER); }],
    ["left-padded payer", (s, i) => { s.payer = pad(i.fundingWallet.toLowerCase() as Address, { size: 32 }); }],
    ["operatorPrincipal", (s) => { s.operatorPrincipal = publicWord(OTHER); }],
    ...ZERO_FIELDS.map((field): [string, (s: SubjectBlockFields) => void] => [field, (s) => { s[field] = ONE; }]),
    ["integrityGrade", (s) => { s.integrityGrade = 1; }],
  ];
  it.each(subjectChanges)("INTENT_MISMATCH before any RPC: subject %s", async (field, change) => {
    const { input, chain } = await setup();
    const subject = { ...input.subject }; change(subject, input);
    const apiModule = await api();
    expect(() => apiModule.printUnitThursdayExpectation({ ...input, subject })).toThrow(expect.objectContaining({
      code: "INTENT_MISMATCH", message: expect.stringContaining(field === "left-padded payer" ? "payer" : field),
    }));
    expect(chain.state.log).toEqual([]);
  });
  it("accepts address equality across casing", async () => {
    const { input } = await setup();
    const apiModule = await api();
    expect(apiModule.printUnitThursdayExpectation({ ...input, host: input.host.toLowerCase() as Address }).operator)
      .toBe(input.host.toLowerCase());
  });
  it.each(["checksum", "uppercase"])("accepts an equal subject settlement address in %s casing", async (casing) => {
    const { input, own } = await setup();
    const address = casing === "checksum" ? input.host : `0x${input.host.slice(2).toUpperCase()}` as Address;
    const subject = Object.freeze({ ...input.subject, operatorSettlementAddress: address });
    const changed = (await api()).printUnitThursdayExpectation({ ...input, subject });
    expect(changed.acceptedPolicyDigest).toBe(own.acceptedPolicyDigest);
    expect(subject.operatorSettlementAddress).toBe(address);
  });
  it("BAD_EXPECTATION before any RPC: never reads a settlement-address getter", async () => {
    const { input, chain } = await setup();
    let reads = 0;
    const subject = { ...input.subject };
    Object.defineProperty(subject, "operatorSettlementAddress", { enumerable: true, get: () => { reads++; return input.host; } });
    const { printUnitThursdayExpectation } = await api();
    expect(() => printUnitThursdayExpectation({ ...input, subject })).toThrow(expect.objectContaining({ code: "BAD_EXPECTATION" }));
    expect(reads).toBe(0);
    expect(chain.state.log).toEqual([]);
  });
  it("INTENT_MISMATCH before any RPC: bindings must be empty", async () => {
    const { input, chain } = await setup();
    const binding: SubjectBinding = { planUnitKey: computePlanUnitKey(0, 0n, ONE), requirementIdHash: ONE,
      sourceKind: 0, propositionKind: 0, valueRef: ONE };
    const apiModule = await api();
    expect(() => apiModule.printUnitThursdayExpectation({ ...input, bindings: [binding] })).toThrow(expect.objectContaining({
      code: "INTENT_MISMATCH", message: expect.stringContaining("bindings"),
    }));
    expect(chain.state.log).toEqual([]);
  });
  it.each([-1n, 1n << 256n, 12 as unknown as bigint])("BAD_EXPECTATION before any RPC: timestamp %s", async (timestamp) => {
    const { input, chain } = await setup();
    const apiModule = await api();
    expect(() => apiModule.printUnitThursdayExpectation({ ...input, latestBlockTimestamp: timestamp }))
      .toThrow(expect.objectContaining({ code: "BAD_EXPECTATION", message: expect.stringContaining("latestBlockTimestamp") }));
    expect(chain.state.log).toEqual([]);
  });

  const configChanges: Array<[string, FundingRefusalCode, (cs: UnitConfig[]) => void]> = [
    ["compositionRoot", "INTENT_MISMATCH", (cs) => { cs[0]!.compositionRoot = ONE; }],
    ["compositionSchemaVersion", "INTENT_MISMATCH", (cs) => { cs[0]!.compositionSchemaVersion = 1; }],
    ["third payee", "INTENT_MISMATCH", (cs) => {
      cs[0]!.payouts[0]!.amount -= 1n; cs[0]!.payouts = [...cs[0]!.payouts, { recipient: POSTAGE, amount: 1n }];
    }],
    ["split 400000/350000", "INTENT_MISMATCH", (cs) => {
      cs[0]!.payouts[0]!.amount = 400_000n; cs[0]!.payouts[1]!.amount = 350_000n;
    }],
    ["payees swapped", "INTENT_MISMATCH", (cs) => { cs[0]!.payouts = [...cs[0]!.payouts].reverse(); }],
    ["feeBps", "INTENT_MISMATCH", (cs) => {
      const c = cs[0]!; c.feeBps = 1; c.f = 75n; c.n -= 75n; c.feeRecipient = POSTAGE; c.payouts[0]!.amount -= 75n;
    }],
    ["feeRecipient", "FUND_ARGS_MISMATCH", (cs) => { cs[0]!.feeRecipient = OTHER; }],
    ["requiredTier", "INTENT_MISMATCH", (cs) => { cs[0]!.requiredTier = 2; }],
    ["requestedTier", "INTENT_MISMATCH", (cs) => { cs[0]!.requestedTier = 2; }],
    ["reclaim ceiling +1", "INTENT_MISMATCH", (cs) => { cs[0]!.reclaimAt = NOW + 1_814_400n + 601n; }],
    ["reclaim floor -1", "INTENT_MISMATCH", (cs) => { cs[0]!.reclaimAt = NOW + MIN_RECLAIM_DELAY - 1n; }],
    ["unitCount", "INTENT_MISMATCH", (cs) => { cs.push({ ...cs[0]!, milestoneIndex: 1n }); }],
    ["unitGross", "INTENT_MISMATCH", (cs) => {
      cs[0]!.g -= 1n; cs[0]!.n -= 1n; cs[0]!.payouts[0]!.amount -= 1n;
    }],
    ["zero-fee f", "FUND_ARGS_MISMATCH", (cs) => { cs[0]!.f = 1n; }],
    ["zero-fee n", "FUND_ARGS_MISMATCH", (cs) => { cs[0]!.n -= 1n; }],
  ];
  it.each(configChanges)("%s: coherent signed substitution refuses before any RPC", async (_field, code, change) => {
    const { substituted } = await setup();
    const { pending, fake } = await substituted({ configure: change });
    await expect(pending).rejects.toMatchObject({ code });
    expect(fake.state.log).toEqual([]);
  });
  it("INTENT_MISMATCH before any RPC: termsHash differs by one bit", async () => {
    const { substituted } = await setup();
    const { pending, fake } = await substituted({ termsHash: flipBit(TERMS) });
    await expect(pending).rejects.toMatchObject({ code: "INTENT_MISMATCH", message: expect.stringContaining("termsHash") });
    expect(fake.state.log).toEqual([]);
  });
  it("INTENT_MISMATCH before any RPC: accepted digest uses a changed subject", async () => {
    const { substituted, subject } = await setup();
    const { pending, fake } = await substituted({ acceptedPolicyDigest: digestFor({ ...subject, authorizedTuplesRoot: zeroHash }) });
    await expect(pending).rejects.toMatchObject({ code: "INTENT_MISMATCH", message: expect.stringContaining("acceptedPolicyDigest") });
    expect(fake.state.log).toEqual([]);
  });
  it("INTENT_MISMATCH before any RPC: PRINT policy carried to Base mainnet", async () => {
    const { substituted } = await setup();
    const { pending, fake } = await substituted({ chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
    await expect(pending).rejects.toMatchObject({ code: "INTENT_MISMATCH", message: expect.stringContaining("chainId") });
    expect(fake.state.log).toEqual([]);
  });
  it("accepts reclaimAt exactly at the ceiling", async () => {
    const { substituted } = await setup();
    const { pending } = await substituted({ configure: (cs) => { cs[0]!.reclaimAt = NOW + 1_814_400n + 600n; } });
    expect((await pending).unchecked).toEqual([]);
  });
  it("accepts the exact 10-day floor with zero live margin", async () => {
    const { fx, own } = await setup();
    // Rebuild the signed policy rather than mutating its committed wire configs.
    const changed = await buildFixture({ chainId: 84532, usdc: TOKEN, jobId: fx.jobId, termsHash: TERMS,
      acceptedPolicyDigest: fx.message.acceptedPolicyDigest, reclaimAt: [NOW + MIN_RECLAIM_DELAY],
      configure: (cs) => { Object.assign(cs[0]!, fx.configs[0], { reclaimAt: NOW + MIN_RECLAIM_DELAY }); },
    }, { payer: fx.payer, operator: fx.operator });
    const chain = makeChain(changed);
    expect((await prepareFunding({ payload: changed.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      quote: { maxTotalGross: 750_000n }, expect: own, pins: testPins(changed), marginSeconds: 0n })).unchecked).toEqual([]);
  });
});

describe("optional exact funding expectations", () => {
  it.each(["unitGross", "payout length", "payout recipient", "maxFeeBps"])("independently checks %s before any RPC", async (field) => {
    const fx = await buildFixture({ reclaimAt: [NOW + 30n * 86_400n] });
    const chain = makeChain(fx);
    const own: FundingExpectations = testExpect(fx);
    if (field === "unitGross") own.unitGross = 1n;
    if (field === "payout length") own.unitPayouts = [...fx.configs[0]!.payouts, { recipient: fx.operator.address, amount: 0n }];
    if (field === "payout recipient") own.unitPayouts = [{ recipient: OTHER, amount: fx.configs[0]!.n }];
    if (field === "maxFeeBps") own.maxFeeBps = 234;
    await expect(prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      quote: { maxTotalGross: fx.totalGross }, expect: own, pins: testPins(fx) })).rejects.toMatchObject({ code: "INTENT_MISMATCH" });
    expect(chain.state.log).toEqual([]);
  });
  // These tests run independently of the new PRINT module: first-run failures demonstrate the r3 shape gap.
  it.each([
    ["compositionSchemaVersion", 0], ["unitCount", 2], ["unitGross", 1_000_000n],
    ["earliestReclaimAt", NOW], ["chainId", 31337n],
  ] as const)("accepts matching optional %s", async (field, value) => {
    const fx = await buildFixture({ configure: (cs) => { for (const c of cs) {
      c.g = 1_000_000n; c.f = 23_500n; c.n = 976_500n; c.payouts[0]!.amount = c.n;
    } } });
    const chain = makeChain(fx);
    const own = { ...testExpect(fx), [field]: value };
    expect((await prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      quote: { maxTotalGross: fx.totalGross }, expect: own, pins: testPins(fx) })).unchecked).toEqual([]);
  });
  it.each([
    ["compositionSchemaVersion", 1], ["unitCount", 1], ["unitGross", 1n],
    ["earliestReclaimAt", NOW + 31n * 86_400n], ["chainId", 84532n],
  ] as const)("INTENT_MISMATCH before any RPC: isolated optional %s", async (field, value) => {
    const fx = await buildFixture(); const chain = makeChain(fx);
    await expect(prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      quote: { maxTotalGross: fx.totalGross }, expect: { ...testExpect(fx), [field]: value },
      pins: testPins(fx) })).rejects.toMatchObject({ code: "INTENT_MISMATCH", message: expect.stringContaining(field) });
    expect(chain.state.log).toEqual([]);
  });
  it("INTENT_MISMATCH before any RPC: payout recipients swapped without changing amounts", async () => {
    const { own, prepare, chain, input } = await setup();
    const payouts = [{ recipient: POSTAGE, amount: 500_000n }, { recipient: input.host, amount: 250_000n }];
    await expect(prepare({ ...own, unitPayouts: payouts })).rejects.toMatchObject({
      code: "INTENT_MISMATCH", message: expect.stringContaining("unitPayouts"),
    });
    expect(chain.state.log).toEqual([]);
  });
  const malformed = [
    ["compositionSchemaVersion", "unchecked"], ["compositionSchemaVersion", -1], ["compositionSchemaVersion", 65536],
    ["compositionSchemaVersion", 0.5], ["compositionSchemaVersion", NaN],
    ["unitCount", 0], ["unitCount", 17], ["unitCount", 1.5], ["unitCount", "1"],
    ["unitGross", -1n], ["unitGross", 1n << 256n], ["unitGross", 750000],
    ["earliestReclaimAt", -1n], ["earliestReclaimAt", 1n << 256n], ["earliestReclaimAt", "123"],
    ["chainId", 0n], ["chainId", 1n << 256n], ["chainId", 84532],
    ["unitPayouts", []], ["unitPayouts", Array(1)], ["unitPayouts", "unchecked"],
    ["unitPayouts", [{ recipient: "0x1234", amount: 1n }]],
    ["unitPayouts", [{ recipient: OTHER, amount: -1n }]],
    ["unitPayouts", [{ recipient: OTHER, amount: 1n << 256n }]],
    ["unitPayouts", [{ recipient: OTHER, amount: 1 }]],
    ["unitPayouts", [{ recipient: OTHER, amount: 1n, extra: true }]],
  ] as const;
  it.each(malformed)("BAD_EXPECTATION before any RPC: malformed %s %s", async (field, value) => {
    const fx = await buildFixture(); const chain = makeChain(fx);
    await expect(prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      quote: { maxTotalGross: fx.totalGross }, expect: { ...testExpect(fx), [field]: value } as FundingExpectations,
      pins: testPins(fx), allowUnchecked: true })).rejects.toMatchObject({ code: "BAD_EXPECTATION" });
    expect(chain.state.log).toEqual([]);
  });
  it("copies and freezes exact payouts before RPC without freezing the buyer's array", async () => {
    const { own, fx, chain } = await setup();
    const payouts = fx.configs[0]!.payouts.map((p) => ({ ...p, recipient: p.recipient.toLowerCase() as Address }));
    const pending = prepareFunding({ payload: fx.wire(), wallet: chain.wallet(), publicClient: chain.publicClient,
      quote: { maxTotalGross: 750_000n }, expect: { ...own, unitPayouts: payouts }, pins: testPins(fx) });
    payouts[0]!.amount = 1n;
    const prepared = await pending;
    expect(prepared.expect.unitPayouts![0]!.amount).toBe(500_000n);
    expect(Object.isFrozen(prepared.expect.unitPayouts![0])).toBe(true);
    expect(Object.isFrozen(payouts)).toBe(false);
  });
});

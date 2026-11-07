import { describe, expect, it } from "vitest";
import { zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeAcceptedPolicyDigest, computeBindingsRoot, computeSubjectBlockHash,
  type SubjectBlockFields,
} from "../../evidence/accepted-policy.js";
import { principalTupleWord } from "../../evidence/principal-id.js";
import { prepareFunding } from "../../funding/prepare.js";
import { printUnitThursdayExpectation } from "../../funding/print-unit.js";
import { computeMilestonesRootV21, computeTermsHashV21, type JobTermsV21 } from "../../funding/terms-hash-v21.js";
import { DAY, JOB_ID, buildFixture, makeChain, newAccount, testPins } from "./fixture.js";

// Bus #8239: LamaSu/pcc-oracle fold/thursday-20261015-r2 @23bdcc2,
// config/testnet/s2-subject-block-thursday-shape-golden.json (v2).
// EXAMPLE ONLY: task E TEST identities, no real funded unit or deployment.
// Keep these inputs literal and independent of the PRINT builder; never read tmp/.
const PRINCIPALS = {
  payer: {
    id: "eip155:84532:0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a",
    word: "0x54f869890b644226a289546d7276852783d66fdcd22d16b300bd515b33f1785f",
  },
  operator: {
    id: "eip155:84532:0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb",
    word: "0x2fa2ca73700c6990c982177315e83b6d119eecab8c1e222d821bbca2ec02caec",
  },
  kernel: {
    id: "kernel-hp-printer-golden",
    word: "0x12e00cf7161d9ede970f48c1ca026eb93a84c6a2a75d278d8940dde362cc4d6c",
  },
  device: {
    id: "ed25519:0xd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
    word: "0x000df964c6ff31189689e8b2526a06f587c77479e1313fea366f8cd1137cec2f",
  },
} as const;

const SUBJECT: SubjectBlockFields = {
  payer: "0x54f869890b644226a289546d7276852783d66fdcd22d16b300bd515b33f1785f",
  operatorPrincipal: "0x2fa2ca73700c6990c982177315e83b6d119eecab8c1e222d821bbca2ec02caec",
  operatorSettlementAddress: "0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb",
  authorizedTuplesRoot: "0xe6dbca35236d751bea6096dc49501a3d7bc266873563188b5768ba7cb16a7af5",
  expertSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  executorSetRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  expectedRecipient: "0x0000000000000000000000000000000000000000000000000000000000000000",
  targetSystemIdentity: "0x0000000000000000000000000000000000000000000000000000000000000000",
  committedProgramHash: "0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a",
  recipeRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
  sampleManifestRef: "0x0000000000000000000000000000000000000000000000000000000000000000",
  childrenRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  operatingEnvelopeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  expectedRouteArea: "0x0000000000000000000000000000000000000000000000000000000000000000",
  expectedLocationHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  captureNonceAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
  challengeAnchor: "0x0000000000000000000000000000000000000000000000000000000000000000",
  integrityGrade: 0,
};

const POLICY_BUILD_TIME = 1_792_022_400n;
const RECLAIM_DELAY_SECONDS = 1_814_400n;
const TERMS: JobTermsV21 = {
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  assuranceTier: 1,
  milestones: [{
    milestoneIndex: 0n,
    stepId: "0x5151515151515151515151515151515151515151515151515151515151515151",
    amount: 750_000n,
    deadline: 1_793_836_800n,
  }],
};
const MILESTONES_ROOT = "0x16bb1546dd13804dd874e718b41d1375d606ca1ebe6650a5db23b09a682bedc2";
const TERMS_HASH = "0x3f8dbb379a2ff55a557a24aba75661166d03898dec2b0745747b3755d69f64ae";
const SUBJECT_BLOCK_HASH = "0x4f166a59dc4e7f8f805ca04b62005a3aade04ae4202ac936c2749d6355830cdf";
const BINDINGS_ROOT = "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd";
const ACCEPTED_POLICY_DIGEST = "0x6814b378016fd7f40c1e72aa98187b14656338f002ab2774fa86d9ed9361fe23";
const HOST: Address = "0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb";
const FUNDING_WALLET: Address = "0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a";
const RETIRED_V1_ACCEPTED_POLICY_DIGEST = "0xd85ae6b3c2be54febf8a8297ed23f010019c1ba922f9784a8de24e3e59b6d7ae";
const FILE_VERSION_DIGEST = "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7";

describe("oracle Thursday-shape golden v2 (#8239): public function vectors", () => {
  it("reproduces the literal principal words", () => {
    expect(principalTupleWord("operator", PRINCIPALS.payer.id)).toBe(PRINCIPALS.payer.word);
    expect(principalTupleWord("operator", PRINCIPALS.operator.id)).toBe(PRINCIPALS.operator.word);
    expect(principalTupleWord("kernel", PRINCIPALS.kernel.id)).toBe(PRINCIPALS.kernel.word);
    expect(principalTupleWord("device", PRINCIPALS.device.id)).toBe(PRINCIPALS.device.word);
    expect(SUBJECT.payer).toBe(PRINCIPALS.payer.word);
    expect(SUBJECT.operatorPrincipal).toBe(PRINCIPALS.operator.word);
  });

  it("reproduces v2.1 milestonesRoot and DERIVED termsHash from the example terms", () => {
    expect(TERMS.milestones).toHaveLength(1);
    expect(TERMS.milestones[0]!.deadline).toBe(POLICY_BUILD_TIME + RECLAIM_DELAY_SECONDS);
    expect(computeMilestonesRootV21(TERMS.milestones)).toBe(MILESTONES_ROOT);
    expect(computeTermsHashV21(TERMS)).toBe(TERMS_HASH);
  });

  it("reproduces subjectBlockHash, empty bindingsRoot and the v2 acceptedPolicyDigest", () => {
    const subjectBlockHash = computeSubjectBlockHash(SUBJECT);
    const bindingsRoot = computeBindingsRoot([]);
    expect(subjectBlockHash).toBe(SUBJECT_BLOCK_HASH);
    expect(bindingsRoot).toBe(BINDINGS_ROOT);
    expect(computeAcceptedPolicyDigest({ termsHash: computeTermsHashV21(TERMS), subjectBlockHash, bindingsRoot }))
      .toBe(ACCEPTED_POLICY_DIGEST);
  });
});

async function buyerFixture(termsHash: Hex = TERMS_HASH, acceptedPolicyDigest: Hex = ACCEPTED_POLICY_DIGEST) {
  // Golden identities are literal principals, not randomly generated fixture identities.
  expect(PRINCIPALS.payer.id).toBe(`eip155:84532:${FUNDING_WALLET}`);
  expect(PRINCIPALS.operator.id).toBe(`eip155:84532:${HOST}`);
  // Public synthetic TEST key: 32 bytes of 0x33 reproduce the golden host. Real signature
  // recovery stays enabled. The golden gives no payer key, and prepare never signs as payer:
  // adapt the existing fixture account's address, then use an address-only wallet below.
  const operator = privateKeyToAccount(`0x${"33".repeat(32)}`);
  expect(operator.address.toLowerCase()).toBe(HOST);
  const payer = { ...newAccount(), address: FUNDING_WALLET };
  const own = printUnitThursdayExpectation({
    jobId: JOB_ID, host: HOST, fundingWallet: FUNDING_WALLET,
    subject: { ...SUBJECT }, bindings: [], latestBlockTimestamp: 1_792_022_400n,
  });
  // The golden has no deployment or policy identity. Existing buildFixture supplies
  // FACTORY, IMPLEMENTATION, policyNonce=1, and the correctly predicted escrow;
  // JOB_ID and DAY also come from fixture.ts. Expiry is one fixture day after build time.
  // Rebuild all commitments and sign each variant, so refusals test buyer intent rather
  // than an inconsistent CREATE2 address, prePolicyRoot, or operator signature.
  const fx = await buildFixture({
    chainId: 84532, usdc: TERMS.token, jobId: JOB_ID, expiry: POLICY_BUILD_TIME + DAY,
    termsHash, acceptedPolicyDigest, reclaimAt: [TERMS.milestones[0]!.deadline],
    configure: (configs) => {
      configs[0] = {
        milestoneIndex: 0n,
        stepId: "0x5151515151515151515151515151515151515151515151515151515151515151",
        requiredTier: 1, requestedTier: 1, g: 750_000n, f: 0n, n: 750_000n,
        feeBps: 0, feeRecipient: zeroAddress, reclaimAt: TERMS.milestones[0]!.deadline,
        compositionSchemaVersion: 0, compositionRoot: zeroHash,
        // The golden's terms omit payout/fee/composition fields. These are the existing
        // Thursday PRINT fixture shape from print-unit.test.ts (economics #8026).
        payouts: [
          { recipient: HOST, amount: 500_000n },
          { recipient: "0x6463ACd05141c1EF6583E4Fd978FC61Fff4045DC", amount: 250_000n },
        ],
      };
    },
  }, { payer, operator });
  const chain = makeChain(fx);
  // makeChain starts at its own NOW; the golden specifies this earlier latest-block time.
  chain.state.block.timestamp = POLICY_BUILD_TIME;
  const prepare = () => prepareFunding({
    payload: fx.wire(), wallet: chain.wallet(FUNDING_WALLET), publicClient: chain.publicClient,
    quote: { maxTotalGross: 750_000n }, pins: testPins(fx), expect: own,
  });
  return { fx, chain, own, prepare };
}

describe("oracle Thursday-shape golden v2 (#8239): buyer prepareFunding", () => {
  it("PASSES with DERIVED termsHash and prepares the exact v2 policy commitments", async () => {
    const { fx, chain, own, prepare } = await buyerFixture();
    expect(own.termsHash).toEqual({ derive: "v2.1", token: TERMS.token, assuranceTier: 1 });
    expect(own.acceptedPolicyDigest).toEqual({ subjectBlockHash: SUBJECT_BLOCK_HASH, bindingsRoot: BINDINGS_ROOT });
    expect(fx.configs).toHaveLength(1);
    expect(fx.configs.map((c) => ({ milestoneIndex: c.milestoneIndex, stepId: c.stepId, amount: c.g, deadline: c.reclaimAt })))
      .toEqual(TERMS.milestones);
    expect(fx.configs[0]!.requiredTier).toBe(TERMS.assuranceTier);
    expect(fx.configs[0]!.requestedTier).toBe(TERMS.assuranceTier);
    const prepared = await prepare();
    expect(prepared.typedData.message.termsHash).toBe(TERMS_HASH);
    expect(prepared.typedData.message.acceptedPolicyDigest).toBe(ACCEPTED_POLICY_DIGEST);
    expect(prepared.configs).toEqual(fx.configs);
    expect(prepared.unchecked).toEqual([]);
    expect(chain.state.log.some((call) => call.method === "eth_call")).toBe(true);
    expect(chain.sends()).toEqual([]);
  });

  it("refuses the RETIRED v1 acceptedPolicyDigest with INTENT_MISMATCH before any RPC", async () => {
    const { chain, prepare } = await buyerFixture(TERMS_HASH, RETIRED_V1_ACCEPTED_POLICY_DIGEST);
    await expect(prepare()).rejects.toMatchObject({
      code: "INTENT_MISMATCH", message: expect.stringContaining("acceptedPolicyDigest"),
    });
    expect(chain.state.log).toEqual([]);
  });

  it("refuses a self-consistent file-digest termsHash and digest pair before any RPC", async () => {
    const fileDigestPolicy = computeAcceptedPolicyDigest({
      termsHash: FILE_VERSION_DIGEST, subjectBlockHash: SUBJECT_BLOCK_HASH, bindingsRoot: BINDINGS_ROOT,
    });
    const { chain, prepare } = await buyerFixture(FILE_VERSION_DIGEST, fileDigestPolicy);
    await expect(prepare()).rejects.toMatchObject({
      code: "INTENT_MISMATCH", message: expect.stringContaining("termsHash"),
    });
    expect(chain.state.log).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  computeAcceptedPolicyDigest, computeBindingsRoot, computeSubjectBlockHash,
  type SubjectBlockFields,
} from "../../evidence/accepted-policy.js";
import { principalTupleWord } from "../../evidence/principal-id.js";
import { computeMilestonesRootV21, computeTermsHashV21, type JobTermsV21 } from "../../funding/terms-hash-v21.js";

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

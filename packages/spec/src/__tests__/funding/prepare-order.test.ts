import { describe, expect, it } from "vitest";
import { zeroHash } from "viem";
import { computeAcceptedPolicyDigest, computeBindingsRoot } from "../../evidence/accepted-policy.js";
import { prepareFunding, type FundingExpectations } from "../../funding/prepare.js";
import { computeTermsHashV21 } from "../../funding/terms-hash-v21.js";
import type { UnitConfig } from "../../funding/vnext.js";
import { buildFixture, makeChain, testExpect, testPins } from "./fixture.js";

describe("prepareFunding: derived terms preserve funded order", () => {
  it("derives termsHash from every unit in funded [index 1, index 0] order", async () => {
    const roots = { subjectBlockHash: zeroHash, bindingsRoot: computeBindingsRoot([]) };
    const configure = (configs: UnitConfig[]) => {
      for (const config of configs) {
        config.requiredTier = 2;
        config.requestedTier = 2;
      }
      configs.reverse();
    };
    const seed = await buildFixture({ configure });
    expect(seed.configs.map((config) => config.milestoneIndex)).toEqual([1n, 0n]);
    const milestones = seed.configs.map((config) => ({
      milestoneIndex: config.milestoneIndex,
      stepId: config.stepId,
      amount: config.g,
      deadline: config.reclaimAt,
    }));
    const termsHash = computeTermsHashV21({ token: seed.usdc, assuranceTier: 2, milestones });
    expect(termsHash).not.toBe(computeTermsHashV21({
      token: seed.usdc, assuranceTier: 2, milestones: [...milestones].reverse(),
    }));
    const acceptedPolicyDigest = computeAcceptedPolicyDigest({ termsHash, ...roots });
    const fx = await buildFixture({ configure, termsHash, acceptedPolicyDigest },
      { payer: seed.payer, operator: seed.operator });
    const chain = makeChain(fx);
    const own: FundingExpectations = {
      ...testExpect(fx),
      tiers: [2],
      termsHash: { derive: "v2.1", token: fx.usdc, assuranceTier: 2 },
      acceptedPolicyDigest: roots,
    };
    const prepared = await prepareFunding({
      payload: fx.wire(),
      wallet: chain.wallet(),
      publicClient: chain.publicClient,
      quote: { maxTotalGross: fx.totalGross },
      pins: testPins(fx),
      expect: own,
    });
    expect(prepared.configs.map((config) => ({
      milestoneIndex: config.milestoneIndex,
      stepId: config.stepId,
      amount: config.g,
      deadline: config.reclaimAt,
    }))).toEqual(milestones);
    expect(prepared.typedData.message.termsHash).toBe(termsHash);
    expect(prepared.typedData.message.acceptedPolicyDigest).toBe(acceptedPolicyDigest);
    expect(chain.sends()).toEqual([]);
  });
});

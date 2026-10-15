import { describe, expect, it } from "vitest";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { computeMilestonesRoot, computeTermsHash, TERMS_DOMAIN } from "../src/terms-hash.js";

const golden = {
  token: "0x00000000000000000000000000000000000005dc" as Address,
  assuranceTier: 2,
  // Funded order is deliberately unsorted; deadlines differ per milestone.
  milestones: [
    { milestoneIndex: 1n, stepId: keccak256(toBytes("golden-step-1")), amount: 600000n, deadline: 2000500000n },
    { milestoneIndex: 0n, stepId: keccak256(toBytes("golden-step-0")), amount: 400000n, deadline: 2000000000n },
  ],
};
const goldenTermsHash = "0x2cb7a79e45cbb5b78b61dbbcc182b2f27ac7991b055a66ef58457459dc2f4fe6";

describe("CanonicalJobTermsV1 v2.1 terms hash", () => {
  it("matches the ratified Aug 6 golden, including its unsorted funded order", () => {
    expect(TERMS_DOMAIN).toBe("0xaf4cf568beb02a9dca015909829c12f5eb22b355111bdf85603e98da8a43c141");
    expect(computeMilestonesRoot(golden.milestones)).toBe(
      "0xf7147855908c6b7e33a27556c9662c07c15ca6ef4b6bfbccbc8d634634409388",
    );
    expect(computeTermsHash(golden)).toBe(goldenTermsHash);
  });

  it("matches the Thursday-shape example, computed with pcc-oracle terms-hash.ts @87bc14e", () => {
    const example = {
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
      assuranceTier: 1,
      milestones: [{
        milestoneIndex: 0n,
        stepId: keccak256(toBytes("print")),
        amount: 750000n,
        deadline: 1762264800n,
      }],
    };
    expect(example.milestones[0]!.stepId).toBe("0x6e923edb1ef64a833d131ac69c8684eccd0a01702a18fa08ddcdef24e280c86d");
    expect(computeMilestonesRoot(example.milestones)).toBe(
      "0x62c118dce940ca35560aa9ae0f8c10ce5f9aefad8cbeee4688c461f71169fa5e",
    );
    expect(computeTermsHash(example)).toBe(
      "0xd32288250071cdf1a37138661a852920ae72ccb8a2b423edeade4474858ee1e1",
    );
  });

  const mutations = [
    ["reorder", { ...golden, milestones: [...golden.milestones].reverse() }],
    ["milestoneIndex", { ...golden, milestones: [{ ...golden.milestones[0]!, milestoneIndex: 2n }, golden.milestones[1]!] }],
    ["amount", { ...golden, milestones: [{ ...golden.milestones[0]!, amount: 600001n }, golden.milestones[1]!] }],
    ["stepId", { ...golden, milestones: [{ ...golden.milestones[0]!, stepId: keccak256(toBytes("different-step")) }, golden.milestones[1]!] }],
    ["per-milestone deadline", { ...golden, milestones: [{ ...golden.milestones[0]!, deadline: 2000500001n }, golden.milestones[1]!] }],
    ["assuranceTier", { ...golden, assuranceTier: 1 }],
    ["token", { ...golden, token: "0x00000000000000000000000000000000000005dd" as Address }],
  ] as const;
  it.each(mutations)("changes termsHash when %s changes", (_name, input) => {
    expect(computeTermsHash(input)).not.toBe(goldenTermsHash);
  });

  it("accepts exact unsigned integer boundaries without truncation", () => {
    expect(() => computeTermsHash({ ...golden, assuranceTier: 255n, milestones: [{
      milestoneIndex: (1n << 256n) - 1n,
      stepId: golden.milestones[0]!.stepId,
      amount: (1n << 256n) - 1n,
      deadline: (1n << 64n) - 1n,
    }] })).not.toThrow();
    expect(() => computeTermsHash({ ...golden, assuranceTier: 0, milestones: [{
      milestoneIndex: 0, stepId: golden.milestones[0]!.stepId, amount: 0, deadline: 0,
    }] })).not.toThrow();
  });

  it.each([
    ["deadline", 1n << 64n],
    ["amount", 1n << 256n],
    ["milestoneIndex", 1n << 256n],
    ["deadline", -1n],
    ["amount", -1n],
    ["milestoneIndex", -1n],
    ["deadline", 1.5],
    ["amount", Number.MAX_SAFE_INTEGER + 1],
    ["milestoneIndex", Number.NaN],
    ["deadline", Number.POSITIVE_INFINITY],
  ] as const)("refuses out-of-range or non-integer %s (%s)", (field, value) => {
    expect(() => computeTermsHash({
      ...golden, milestones: [{ ...golden.milestones[0]!, [field]: value }],
    })).toThrow();
  });

  it.each([256, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("refuses invalid uint8 tier %s", (assuranceTier) => {
    expect(() => computeTermsHash({ ...golden, assuranceTier })).toThrow();
  });

  it("refuses an empty milestone list in both producers", () => {
    expect(() => computeMilestonesRoot([])).toThrow();
    expect(() => computeTermsHash({ ...golden, milestones: [] })).toThrow();
  });

  it.each(["0x", "0x1234", `0x${"gg".repeat(20)}`, `0x${"00".repeat(21)}`])("refuses malformed token %s", (token) => {
    expect(() => computeTermsHash({ ...golden, token: token as Address })).toThrow();
  });

  it.each(["0x", `0x${"ab".repeat(31)}`, `0x${"ab".repeat(33)}`, `0x${"gg".repeat(32)}`])("refuses malformed stepId %s", (stepId) => {
    expect(() => computeTermsHash({
      ...golden, milestones: [{ ...golden.milestones[0]!, stepId: stepId as Hex }],
    })).toThrow();
  });

  it("refuses duplicate milestone identities without deduplication", () => {
    expect(() => computeMilestonesRoot([golden.milestones[0]!, { ...golden.milestones[0]!, amount: 1n }])).toThrow();
  });

  it("accepts safe number inputs with the same result as bigint inputs", () => {
    expect(computeTermsHash({ ...golden, milestones: golden.milestones.map((milestone) => ({
      ...milestone,
      milestoneIndex: Number(milestone.milestoneIndex),
      amount: Number(milestone.amount),
      deadline: Number(milestone.deadline),
    })) })).toBe(goldenTermsHash);
  });
});

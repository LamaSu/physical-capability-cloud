import { describe, expect, it } from "vitest";
import { keccak256, stringToHex, type Address, type Hex } from "viem";

// Keep the first run executable before the carried-copy producer exists.
const api = () => import("../../funding/terms-hash-v21.js");
const TOKEN: Address = "0x00000000000000000000000000000000000005dc";
const GOLDEN_ROOT = "0xf7147855908c6b7e33a27556c9662c07c15ca6ef4b6bfbccbc8d634634409388";
const GOLDEN_HASH = "0x2cb7a79e45cbb5b78b61dbbcc182b2f27ac7991b055a66ef58457459dc2f4fe6";
const step = (id: string) => keccak256(stringToHex(id));
const milestones = () => [
  { milestoneIndex: 1n, stepId: step("golden-step-1"), amount: 600_000n, deadline: 2_000_500_000n },
  { milestoneIndex: 0n, stepId: step("golden-step-0"), amount: 400_000n, deadline: 2_000_000_000n },
];
const terms = () => ({ token: TOKEN, assuranceTier: 2, milestones: milestones() });

describe("carried v2.1 termsHash producer", () => {
  it("reproduces all three Aug-6 GOLDEN values in funded unsorted order", async () => {
    const { TERMS_DOMAIN_V1, computeMilestonesRootV21, computeTermsHashV21 } = await api();
    expect(TERMS_DOMAIN_V1).toBe("0xaf4cf568beb02a9dca015909829c12f5eb22b355111bdf85603e98da8a43c141");
    expect(computeMilestonesRootV21(milestones())).toBe(GOLDEN_ROOT);
    expect(computeTermsHashV21(terms())).toBe(GOLDEN_HASH);
  });

  const mutations: Array<[string, (t: ReturnType<typeof terms>) => void]> = [
    ["reorder", (t) => { t.milestones.reverse(); }],
    ["milestoneIndex", (t) => { t.milestones[0]!.milestoneIndex += 1n; }],
    ["amount", (t) => { t.milestones[0]!.amount += 1n; }],
    ["stepId", (t) => { t.milestones[0]!.stepId = step("different-step"); }],
    ["one milestone deadline", (t) => { t.milestones[0]!.deadline += 1n; }],
    ["assuranceTier", (t) => { t.assuranceTier = 1; }],
    ["token", (t) => { t.token = "0x00000000000000000000000000000000000005dd"; }],
  ];
  it.each(mutations)("negative parity: %s changes termsHash", async (_name, mutate) => {
    const { computeTermsHashV21 } = await api();
    const changed = terms(); mutate(changed);
    expect(computeTermsHashV21(changed)).not.toBe(GOLDEN_HASH);
  });

  it("accepts the uint64 deadline maximum without truncation", async () => {
    const { computeTermsHashV21 } = await api();
    const changed = terms(); changed.milestones[0]!.deadline = (1n << 64n) - 1n;
    expect(computeTermsHashV21(changed)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeTermsHashV21(changed)).not.toBe(GOLDEN_HASH);
  });

  const invalidMilestones: Array<[string, unknown]> = [
    ["no milestones", []],
    ["duplicate (milestoneIndex, stepId)", [milestones()[0], milestones()[0]]],
    ["case-insensitive duplicate pair", [milestones()[0], { ...milestones()[0], stepId: `0x${milestones()[0]!.stepId.slice(2).toUpperCase()}` }]],
    ["deadline 2^64", [{ ...milestones()[0], deadline: 1n << 64n }]],
    ["negative deadline", [{ ...milestones()[0], deadline: -1n }]],
    ["non-bigint deadline", [{ ...milestones()[0], deadline: 2_000_500_000 }]],
    ["negative amount", [{ ...milestones()[0], amount: -1n }]],
    ["number amount", [{ ...milestones()[0], amount: 600_000 }]],
    ["decimal-string amount", [{ ...milestones()[0], amount: "600000" }]],
    ["uint256 overflow amount", [{ ...milestones()[0], amount: 1n << 256n }]],
    ["negative milestoneIndex", [{ ...milestones()[0], milestoneIndex: -1n }]],
    ["non-bigint milestoneIndex", [{ ...milestones()[0], milestoneIndex: 1 }]],
    ["uint256 overflow milestoneIndex", [{ ...milestones()[0], milestoneIndex: 1n << 256n }]],
    ["short stepId", [{ ...milestones()[0], stepId: "0x1234" }]],
    ["malformed stepId", [{ ...milestones()[0], stepId: `0x${"g".repeat(64)}` }]],
    ["null milestones", null],
    ["sparse milestones", Array(1)],
    ["null milestone", [null]],
  ];
  it.each(invalidMilestones)("typed refusal from both producers: %s", async (_name, invalid) => {
    const { computeMilestonesRootV21, computeTermsHashV21, TermsHashV21Error } = await api();
    expect(() => computeMilestonesRootV21(invalid as never)).toThrow(TermsHashV21Error);
    expect(() => computeTermsHashV21({ ...terms(), milestones: invalid as never })).toThrow(TermsHashV21Error);
  });

  it("permits a repeated index or step independently; uniqueness is the pair", async () => {
    const { computeTermsHashV21 } = await api();
    const repeatedIndex = terms(); repeatedIndex.milestones[1]!.milestoneIndex = 1n;
    const repeatedStep = terms(); repeatedStep.milestones[1]!.stepId = repeatedStep.milestones[0]!.stepId;
    expect(computeTermsHashV21(repeatedIndex)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeTermsHashV21(repeatedStep)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each([4, 1.5, -1, NaN, "2", 2n])("typed refusal: assuranceTier %s", async (assuranceTier) => {
    const { computeTermsHashV21, TermsHashV21Error } = await api();
    expect(() => computeTermsHashV21({ ...terms(), assuranceTier: assuranceTier as never })).toThrow(TermsHashV21Error);
  });
  it.each(["0x1234", `0x${"g".repeat(40)}`, "", null])("typed refusal: malformed token %s", async (token) => {
    const { computeTermsHashV21, TermsHashV21Error } = await api();
    expect(() => computeTermsHashV21({ ...terms(), token: token as Address })).toThrow(TermsHashV21Error);
  });
  it("accepts a well-formed token and stepId in either hex casing", async () => {
    const { computeTermsHashV21 } = await api();
    const upper = terms();
    upper.token = `0x${TOKEN.slice(2).toUpperCase()}` as Address;
    for (const milestone of upper.milestones) milestone.stepId = `0x${milestone.stepId.slice(2).toUpperCase()}` as Hex;
    expect(computeTermsHashV21(upper)).toBe(GOLDEN_HASH);
  });
  it("does not mutate or freeze caller-owned milestone objects", async () => {
    const { computeTermsHashV21 } = await api();
    const source = terms(); const snapshot = structuredClone(source);
    computeTermsHashV21(source);
    expect(source).toEqual(snapshot);
    expect(Object.isFrozen(source.milestones)).toBe(false);
    expect(Object.isFrozen(source.milestones[0])).toBe(false);
  });
});

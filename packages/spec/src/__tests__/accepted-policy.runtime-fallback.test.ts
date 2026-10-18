/**
 * Isolated test for the runtime-unavailable path in evidence/accepted-policy.ts:
 * where the host cannot give `util.types.isProxy` (via `process.getBuiltinModule`),
 * every exported function must throw `AcceptedPolicyDigestInputError("runtime", ...)`
 * rather than silently treating an unreadable "is this a Proxy?" as "no". This file
 * never statically imports accepted-policy.ts (only dynamically, after stubbing),
 * so it cannot collide with the real module already cached for the other test file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

describe("accepted-policy: runtime without util.types.isProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("throws a typed runtime error instead of silently accepting input", async () => {
    const realProcess = globalThis.process;
    vi.resetModules();
    vi.stubGlobal("process", { ...realProcess, getBuiltinModule: undefined });

    const mod = await import("../evidence/accepted-policy.js");
    expect(() =>
      mod.computeSubjectBlockHash({
        payer: `0x${"11".repeat(32)}`,
        operatorPrincipal: `0x${"22".repeat(32)}`,
        operatorSettlementAddress: `0x${"33".repeat(20)}`,
        authorizedTuplesRoot: `0x${"44".repeat(32)}`,
        expertSetRoot: `0x${"55".repeat(32)}`,
        executorSetRoot: `0x${"66".repeat(32)}`,
        expectedRecipient: `0x${"77".repeat(32)}`,
        targetSystemIdentity: `0x${"88".repeat(32)}`,
        committedProgramHash: `0x${"99".repeat(32)}`,
        recipeRef: `0x${"aa".repeat(32)}`,
        sampleManifestRef: `0x${"bb".repeat(32)}`,
        childrenRoot: `0x${"cc".repeat(32)}`,
        operatingEnvelopeHash: `0x${"dd".repeat(32)}`,
        expectedRouteArea: `0x${"ee".repeat(32)}`,
        expectedLocationHash: `0x${"ff".repeat(32)}`,
        captureNonceAnchor: `0x${"00".repeat(32)}`,
        challengeAnchor: `0x${"01".repeat(32)}`,
        integrityGrade: 1,
      } as Parameters<typeof mod.computeSubjectBlockHash>[0]),
    ).toThrowError(/util\.types\.isProxy/);
  });

  it.each([
    "computeMilestonesRoot([])",
    "computeMilestonesRoot([valid milestone])",
    "computeTermsHash(Thursday-shape golden v2 terms)",
    "computeAuthorizedTuplesRoot([])",
    "computeAuthorizedTuplesRoot([valid tuple])",
    "canonicalAuthorizedTuples([])",
    "canonicalAuthorizedTuples([valid tuple])",
  ] as const)("%s throws AcceptedPolicyDigestInputError with field runtime", async (scenario) => {
    const realProcess = globalThis.process;
    vi.resetModules();
    vi.stubGlobal("process", { ...realProcess, getBuiltinModule: undefined });

    const mod = await import("../evidence/accepted-policy.js");
    const milestone = {
      milestoneIndex: 0,
      stepId: `0x${"51".repeat(32)}` as const,
      amount: 750000,
      deadline: 1793836800,
    };
    // Same operator/kernel/device tuple shape as the round-1 public producer tests.
    const tuple = [
      "0x2fa2ca73700c6990c982177315e83b6d119eecab8c1e222d821bbca2ec02caec",
      "0x12e00cf7161d9ede970f48c1ca026eb93a84c6a2a75d278d8940dde362cc4d6c",
      "0x000df964c6ff31189689e8b2526a06f587c77479e1313fea366f8cd1137cec2f",
    ] as const;
    const producers = {
      "computeMilestonesRoot([])": () => mod.computeMilestonesRoot([]),
      "computeMilestonesRoot([valid milestone])": () => mod.computeMilestonesRoot([milestone]),
      // Oracle-published terms inputs, bus #8239.
      "computeTermsHash(Thursday-shape golden v2 terms)": () => mod.computeTermsHash({
        token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
        assuranceTier: 1,
        milestones: [milestone],
      }),
      "computeAuthorizedTuplesRoot([])": () => mod.computeAuthorizedTuplesRoot([]),
      "computeAuthorizedTuplesRoot([valid tuple])": () => mod.computeAuthorizedTuplesRoot([tuple]),
      "canonicalAuthorizedTuples([])": () => mod.canonicalAuthorizedTuples([]),
      "canonicalAuthorizedTuples([valid tuple])": () => mod.canonicalAuthorizedTuples([tuple]),
    };

    let error: unknown;
    try {
      producers[scenario]();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(mod.AcceptedPolicyDigestInputError);
    expect(error).toHaveProperty("field", "runtime");
  });
});

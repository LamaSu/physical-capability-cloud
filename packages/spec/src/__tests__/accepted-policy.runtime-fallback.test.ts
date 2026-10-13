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
});

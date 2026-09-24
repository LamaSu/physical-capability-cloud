/**
 * Unit tests for the assurance-ceiling rule (WP-C, MUST-CLOSE 5).
 *
 *   authorizedAssuranceCeiling(k) = 0 without a proven signing key,
 *     else min(3, getMaxAllowedTier(effectiveReputation(k), k.totalJobsCompleted ?? 0))
 *   normalizeClaim(x)            = integer in 0..3, else 0
 *   effectiveMaxAssuranceTier(k) = min(normalizeClaim(k.maxAssuranceTier), ceiling(k))
 */

import { describe, expect, it } from "vitest";
import {
  authorizedAssuranceCeiling,
  buildAssuranceCeilingMap,
  ceilingFor,
  clampAssuranceTiers,
  effectiveMaxAssuranceTier,
  hasProvenSigningKey,
  isAssuranceTier,
  normalizeClaim,
} from "../services/assurance-ceiling.js";
import { isKernelOwner, requestActor } from "../services/kernel-ownership.js";

const ED25519_KEY = `0x${"ab".repeat(32)}`;
const EVM_ADDRESS = "0x1234567890abcdef1234567890ABCDEF12345678";

/** A kernel with a proven Ed25519 signer and the given track record. */
function signed(overrides: Record<string, unknown> = {}) {
  return {
    id: "k-signed",
    signingKeyAlgorithm: "ed25519",
    signingKeyPublicKey: ED25519_KEY,
    signingAddress: null,
    reputation: 0,
    reputationUpdatedAt: null,
    totalJobsCompleted: 0,
    maxAssuranceTier: 3,
    ...overrides,
  };
}

describe("normalizeClaim / isAssuranceTier", () => {
  it("keeps integers 0..3", () => {
    for (const t of [0, 1, 2, 3]) expect(normalizeClaim(t)).toBe(t);
  });

  it.each([
    ["5", 5],
    ["-1", -1],
    ["2.5", 2.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ['"3" (string)', "3"],
    ["null", null],
    ["undefined", undefined],
    ["object", { tier: 3 }],
  ])("normalizes %s to 0 (never the old default of 2)", (_label, value) => {
    expect(normalizeClaim(value)).toBe(0);
    expect(isAssuranceTier(value)).toBe(false);
  });
});

describe("hasProvenSigningKey", () => {
  it("accepts a well-formed ed25519 key under the ed25519 tag", () => {
    expect(hasProvenSigningKey(signed())).toBe(true);
  });

  it("accepts a secp256k1 address, tagged or legacy-untagged", () => {
    expect(hasProvenSigningKey({ signingKeyAlgorithm: "secp256k1", signingAddress: EVM_ADDRESS })).toBe(true);
    expect(hasProvenSigningKey({ signingKeyAlgorithm: null, signingAddress: EVM_ADDRESS })).toBe(true);
  });

  it("rejects a kernel with no signing identity", () => {
    expect(hasProvenSigningKey({})).toBe(false);
    expect(
      hasProvenSigningKey({ signingKeyAlgorithm: null, signingKeyPublicKey: null, signingAddress: null }),
    ).toBe(false);
    expect(hasProvenSigningKey(null)).toBe(false);
  });

  it("rejects malformed or ambiguous identities (fail closed)", () => {
    // ed25519 tag without a key, or with a malformed key
    expect(hasProvenSigningKey({ signingKeyAlgorithm: "ed25519" })).toBe(false);
    expect(hasProvenSigningKey({ signingKeyAlgorithm: "ed25519", signingKeyPublicKey: "0xabc" })).toBe(false);
    // ed25519 tag with only an address: the tagged key is absent
    expect(hasProvenSigningKey({ signingKeyAlgorithm: "ed25519", signingAddress: EVM_ADDRESS })).toBe(false);
    // unknown algorithm tag
    expect(
      hasProvenSigningKey({ signingKeyAlgorithm: "rsa", signingKeyPublicKey: ED25519_KEY, signingAddress: EVM_ADDRESS }),
    ).toBe(false);
    // malformed address
    expect(hasProvenSigningKey({ signingAddress: "0xnot-an-address" })).toBe(false);
  });
});

describe("authorizedAssuranceCeiling", () => {
  it("is 0 without a proven signing key, whatever the reputation", () => {
    expect(
      authorizedAssuranceCeiling({ reputation: 1000, totalJobsCompleted: 500, reputationUpdatedAt: null }),
    ).toBe(0);
  });

  it("is 0 for a missing kernel", () => {
    expect(authorizedAssuranceCeiling(undefined)).toBe(0);
    expect(authorizedAssuranceCeiling(null)).toBe(0);
  });

  it("is 1 for a proven signer with a fresh (zero) track record", () => {
    expect(authorizedAssuranceCeiling(signed())).toBe(1);
  });

  it("follows ReputationService tier gates: tier 2 needs >=5 jobs and rep >=300", () => {
    expect(authorizedAssuranceCeiling(signed({ reputation: 300, totalJobsCompleted: 20 }))).toBe(2);
    expect(authorizedAssuranceCeiling(signed({ reputation: 299, totalJobsCompleted: 20 }))).toBe(1);
    // 4 jobs is below the tier-2 job gate even with a high score
    expect(authorizedAssuranceCeiling(signed({ reputation: 900, totalJobsCompleted: 4 }))).toBe(1);
  });

  it("reaches 3 only with >=20 jobs and rep >=600", () => {
    expect(authorizedAssuranceCeiling(signed({ reputation: 600, totalJobsCompleted: 20 }))).toBe(3);
    expect(authorizedAssuranceCeiling(signed({ reputation: 599, totalJobsCompleted: 20 }))).toBe(2);
  });

  it("applies reputation decay (a long-idle operator loses its tier)", () => {
    const longAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    expect(
      authorizedAssuranceCeiling(signed({ reputation: 900, totalJobsCompleted: 50, reputationUpdatedAt: longAgo })),
    ).toBe(1);
  });

  it("reads garbage reputation / job counts as 0 (fail closed)", () => {
    expect(
      authorizedAssuranceCeiling(signed({ reputation: Number.NaN, totalJobsCompleted: Number.POSITIVE_INFINITY })),
    ).toBe(1);
    expect(authorizedAssuranceCeiling(signed({ reputation: "900" as unknown, totalJobsCompleted: -5 }))).toBe(1);
  });
});

describe("effectiveMaxAssuranceTier", () => {
  it("caps the claim at the ceiling (tier-3 claim, no signer -> 0)", () => {
    expect(effectiveMaxAssuranceTier({ maxAssuranceTier: 3 })).toBe(0);
  });

  it("caps the claim at the ceiling (tier-3 claim, fresh signer -> 1)", () => {
    expect(effectiveMaxAssuranceTier(signed({ maxAssuranceTier: 3 }))).toBe(1);
  });

  it("honours a claim BELOW the ceiling", () => {
    expect(
      effectiveMaxAssuranceTier(signed({ maxAssuranceTier: 1, reputation: 900, totalJobsCompleted: 50 })),
    ).toBe(1);
  });

  it("a malformed claim is 0 even on a fully-trusted kernel", () => {
    const trusted = { reputation: 900, totalJobsCompleted: 50 };
    expect(effectiveMaxAssuranceTier(signed({ ...trusted, maxAssuranceTier: 5 }))).toBe(0);
    expect(effectiveMaxAssuranceTier(signed({ ...trusted, maxAssuranceTier: "3" }))).toBe(0);
    expect(effectiveMaxAssuranceTier(signed({ ...trusted, maxAssuranceTier: undefined }))).toBe(0);
  });

  it("a missing kernel is 0", () => {
    expect(effectiveMaxAssuranceTier(undefined)).toBe(0);
  });
});

describe("clampAssuranceTiers", () => {
  it("drops tiers above the ceiling", () => {
    expect(clampAssuranceTiers([0, 1, 2, 3], 1)).toEqual([0, 1]);
  });

  it("returns [0] when nothing survives", () => {
    expect(clampAssuranceTiers([2, 3], 1)).toEqual([0]);
    expect(clampAssuranceTiers([0, 1, 2, 3], 0)).toEqual([0]);
    expect(clampAssuranceTiers([], 3)).toEqual([0]);
  });

  it("drops invalid values and duplicates, keeping order", () => {
    expect(clampAssuranceTiers([2, "3", 2.5, -1, 9, 1, 2, null], 3)).toEqual([2, 1]);
  });

  it("treats a non-array as no claim", () => {
    expect(clampAssuranceTiers(undefined, 3)).toEqual([0]);
    expect(clampAssuranceTiers("0,1,2", 3)).toEqual([0]);
  });

  it("treats an invalid ceiling as 0", () => {
    expect(clampAssuranceTiers([0, 1, 2], 7)).toEqual([0]);
    expect(clampAssuranceTiers([0, 1, 2], undefined)).toEqual([0]);
  });
});

describe("buildAssuranceCeilingMap / ceilingFor", () => {
  it("maps each kernel once and treats unknown ids as 0", () => {
    const map = buildAssuranceCeilingMap([
      signed({ id: "a", reputation: 900, totalJobsCompleted: 50 }),
      { id: "b", reputation: 900, totalJobsCompleted: 50 },
      undefined,
    ]);
    expect(ceilingFor(map, "a")).toBe(3);
    expect(ceilingFor(map, "b")).toBe(0);
    expect(ceilingFor(map, "missing")).toBe(0);
  });
});

describe("kernel ownership helpers", () => {
  it("only the recorded owner owns a kernel", () => {
    expect(isKernelOwner({ operatorAddress: "op-1" }, "op-1")).toBe(true);
    expect(isKernelOwner({ operatorAddress: "op-1" }, "op-2")).toBe(false);
  });

  it("nobody owns a legacy placeholder row, and a missing actor owns nothing", () => {
    expect(isKernelOwner({ operatorAddress: "" }, "")).toBe(false);
    expect(
      isKernelOwner(
        { operatorAddress: "0x0000000000000000000000000000000000000000" },
        "0x0000000000000000000000000000000000000000",
      ),
    ).toBe(false);
    expect(isKernelOwner({ operatorAddress: "op-1" }, undefined)).toBe(false);
    expect(isKernelOwner(undefined, "op-1")).toBe(false);
  });

  it("requestActor reads operatorId ?? userId and ignores non-strings", () => {
    expect(requestActor({ operatorId: "op-1", userId: "0xabc" })).toBe("op-1");
    expect(requestActor({ userId: "0xabc" })).toBe("0xabc");
    expect(requestActor({})).toBeUndefined();
    expect(requestActor({ operatorId: 42 })).toBeUndefined();
  });
});

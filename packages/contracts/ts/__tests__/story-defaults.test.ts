/**
 * Tests for story-defaults.ts — revenue split profiles and distribution math.
 *
 * Covers:
 *   - All 3 pre-built split profiles sum to exactly 100%
 *   - buildSplitsForJob maps roles to addresses correctly
 *   - calculateDistribution produces correct amounts
 *   - Edge cases: missing addresses, zero amounts, non-numeric amounts
 */

import { describe, it, expect } from "vitest";
import {
  SPLIT_PROFILES,
  buildSplitsForJob,
  calculateDistribution,
  validateSplitTotal,
  type RevenueSplitProfile,
} from "../story-defaults.js";

// ---------------------------------------------------------------------------
// SPLIT_PROFILES — basic structure
// ---------------------------------------------------------------------------

describe("SPLIT_PROFILES — structure", () => {
  it("exports the 5 canonical profiles (legacy + ADR-12)", () => {
    expect(Object.keys(SPLIT_PROFILES).sort()).toEqual(
      [
        "community",
        "contributorEconomicsMinimal",
        "contributorEconomicsWithAi",
        "multiStep",
        "singleStep",
      ].sort(),
    );
  });

  it("each profile has name, description, and non-empty splits array", () => {
    for (const [key, profile] of Object.entries(SPLIT_PROFILES)) {
      expect(profile.name, `${key}.name`).toBeTruthy();
      expect(profile.description, `${key}.description`).toBeTruthy();
      expect(Array.isArray(profile.splits), `${key}.splits is array`).toBe(true);
      expect(profile.splits.length, `${key} has splits`).toBeGreaterThan(0);
    }
  });

  it("each split entry has role, percentage, and label", () => {
    for (const [key, profile] of Object.entries(SPLIT_PROFILES)) {
      for (const split of profile.splits) {
        expect(split.role, `${key} split role`).toBeTruthy();
        expect(typeof split.percentage, `${key} split percentage type`).toBe("number");
        expect(split.label, `${key} split label`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// SPLIT_PROFILES — each sums to 100%
// ---------------------------------------------------------------------------

describe("SPLIT_PROFILES — sums to 100%", () => {
  it("singleStep splits sum to 100", () => {
    const { valid, total } = validateSplitTotal(SPLIT_PROFILES.singleStep);
    expect(total).toBe(100);
    expect(valid).toBe(true);
  });

  it("multiStep splits sum to 100", () => {
    const { valid, total } = validateSplitTotal(SPLIT_PROFILES.multiStep);
    expect(total).toBe(100);
    expect(valid).toBe(true);
  });

  it("community splits sum to 100", () => {
    const { valid, total } = validateSplitTotal(SPLIT_PROFILES.community);
    expect(total).toBe(100);
    expect(valid).toBe(true);
  });

  it("contributorEconomicsMinimal splits sum to 100", () => {
    const { valid, total } = validateSplitTotal(SPLIT_PROFILES.contributorEconomicsMinimal);
    expect(total).toBe(100);
    expect(valid).toBe(true);
  });

  it("contributorEconomicsWithAi splits sum to 100", () => {
    const { valid, total } = validateSplitTotal(SPLIT_PROFILES.contributorEconomicsWithAi);
    expect(total).toBe(100);
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New ADR-12 profiles — role membership
// ---------------------------------------------------------------------------

describe("SPLIT_PROFILES — ADR-12 role membership", () => {
  it("contributorEconomicsMinimal uses the new ContributorRole taxonomy", () => {
    const roles = SPLIT_PROFILES.contributorEconomicsMinimal.splits.map((s) => s.role);
    expect(roles).toContain("operator");
    expect(roles).toContain("verifier");
    expect(roles).toContain("protocol-author");
    expect(roles).toContain("integrator");
    expect(roles).toContain("network-treasury");
    // No legacy roles
    expect(roles).not.toContain("designer");
    expect(roles).not.toContain("network");
  });

  it("contributorEconomicsMinimal operator percentage is 92", () => {
    const op = SPLIT_PROFILES.contributorEconomicsMinimal.splits.find(
      (s) => s.role === "operator",
    );
    expect(op?.percentage).toBe(92);
  });

  it("contributorEconomicsWithAi includes model-author role", () => {
    const roles = SPLIT_PROFILES.contributorEconomicsWithAi.splits.map((s) => s.role);
    expect(roles).toContain("model-author");
  });

  it("contributorEconomicsWithAi model-author percentage is 4", () => {
    const model = SPLIT_PROFILES.contributorEconomicsWithAi.splits.find(
      (s) => s.role === "model-author",
    );
    expect(model?.percentage).toBe(4);
  });

  it("contributorEconomicsWithAi operator percentage is 87 (residual)", () => {
    const op = SPLIT_PROFILES.contributorEconomicsWithAi.splits.find(
      (s) => s.role === "operator",
    );
    expect(op?.percentage).toBe(87);
  });
});

// ---------------------------------------------------------------------------
// SPLIT_PROFILES — role membership
// ---------------------------------------------------------------------------

describe("SPLIT_PROFILES — role membership", () => {
  it("singleStep contains designer, operator, verifier, network roles", () => {
    const roles = SPLIT_PROFILES.singleStep.splits.map((s) => s.role);
    expect(roles).toContain("designer");
    expect(roles).toContain("operator");
    expect(roles).toContain("verifier");
    expect(roles).toContain("network");
  });

  it("singleStep operator percentage is 70", () => {
    const op = SPLIT_PROFILES.singleStep.splits.find((s) => s.role === "operator");
    expect(op?.percentage).toBe(70);
  });

  it("singleStep designer percentage is 10", () => {
    const d = SPLIT_PROFILES.singleStep.splits.find((s) => s.role === "designer");
    expect(d?.percentage).toBe(10);
  });

  it("multiStep operator percentage is 75", () => {
    const op = SPLIT_PROFILES.multiStep.splits.find((s) => s.role === "operator");
    expect(op?.percentage).toBe(75);
  });

  it("community contains curator role", () => {
    const roles = SPLIT_PROFILES.community.splits.map((s) => s.role);
    expect(roles).toContain("curator");
  });

  it("community designer percentage is 20", () => {
    const d = SPLIT_PROFILES.community.splits.find((s) => s.role === "designer");
    expect(d?.percentage).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// buildSplitsForJob — happy path
// ---------------------------------------------------------------------------

describe("buildSplitsForJob — happy path", () => {
  const addresses = {
    designer:  "0xDesignerWallet",
    operator:  "0xOperatorWallet",
    verifier:  "0xVerifierWallet",
    network:   "0xTreasuryWallet",
  };

  it("returns 4 entries for singleStep with all addresses supplied", () => {
    const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, addresses);
    expect(splits).toHaveLength(4);
  });

  it("maps roles to addresses correctly", () => {
    const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, addresses);

    const designer = splits.find((s) => s.role === "designer");
    const operator = splits.find((s) => s.role === "operator");
    const verifier = splits.find((s) => s.role === "verifier");
    const network  = splits.find((s) => s.role === "network");

    expect(designer?.address).toBe("0xDesignerWallet");
    expect(operator?.address).toBe("0xOperatorWallet");
    expect(verifier?.address).toBe("0xVerifierWallet");
    expect(network?.address).toBe("0xTreasuryWallet");
  });

  it("preserves percentages from profile", () => {
    const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, addresses);
    const percentages = splits.map((s) => s.percentage).sort((a, b) => a - b);
    expect(percentages).toEqual([10, 10, 10, 70]);
  });

  it("preserves labels from profile", () => {
    const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, addresses);
    const operatorSplit = splits.find((s) => s.role === "operator");
    expect(operatorSplit?.label).toBe("Machine Operator");
  });

  it("works with community profile including curator", () => {
    const communityAddresses = {
      ...addresses,
      curator: "0xCuratorWallet",
    };
    const splits = buildSplitsForJob(SPLIT_PROFILES.community, communityAddresses);
    expect(splits).toHaveLength(5);

    const curator = splits.find((s) => s.role === "curator");
    expect(curator?.address).toBe("0xCuratorWallet");
    expect(curator?.percentage).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// buildSplitsForJob — missing addresses
// ---------------------------------------------------------------------------

describe("buildSplitsForJob — missing addresses", () => {
  it("omits roles with no matching address", () => {
    // Only provide designer and operator — no verifier or network
    const partial = {
      designer: "0xDesigner",
      operator: "0xOperator",
    };
    const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, partial);
    expect(splits).toHaveLength(2);
    expect(splits.every((s) => s.role === "designer" || s.role === "operator")).toBe(true);
  });

  it("returns empty array when no addresses match any role", () => {
    const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, {});
    expect(splits).toEqual([]);
  });

  it("omits roles with empty string address", () => {
    const partial = {
      designer: "0xDesigner",
      operator: "",
      verifier: "0xVerifier",
      network:  "0xTreasury",
    };
    const splits = buildSplitsForJob(SPLIT_PROFILES.singleStep, partial);
    // operator has empty string — should be excluded
    expect(splits.some((s) => s.role === "operator")).toBe(false);
    expect(splits).toHaveLength(3);
  });

  it("works with a custom profile", () => {
    const custom: RevenueSplitProfile = {
      name: "Custom",
      description: "Custom split",
      splits: [
        { role: "designer",  percentage: 30, label: "Creator" },
        { role: "assembler", percentage: 70, label: "Assembler" },
      ],
    };
    const splits = buildSplitsForJob(custom, {
      designer:  "0xCreator",
      assembler: "0xAssembler",
    });
    expect(splits).toHaveLength(2);
    expect(splits[0].address).toBe("0xCreator");
    expect(splits[1].address).toBe("0xAssembler");
  });
});

// ---------------------------------------------------------------------------
// calculateDistribution — happy path
// ---------------------------------------------------------------------------

describe("calculateDistribution — happy path", () => {
  it("correctly distributes 1000 with 10/90 split", () => {
    const dist = calculateDistribution("1000", [
      { address: "0xAlice", percentage: 10 },
      { address: "0xBob",   percentage: 90 },
    ]);
    expect(dist[0]).toEqual({ address: "0xAlice", amount: "100" });
    expect(dist[1]).toEqual({ address: "0xBob",   amount: "900" });
  });

  it("correctly distributes 1000 with singleStep split (10/70/10/10)", () => {
    const splits = [
      { address: "0xDesigner", percentage: 10 },
      { address: "0xOperator", percentage: 70 },
      { address: "0xVerifier", percentage: 10 },
      { address: "0xNetwork",  percentage: 10 },
    ];
    const dist = calculateDistribution("1000", splits);
    expect(dist[0].amount).toBe("100");   // 10% of 1000
    expect(dist[1].amount).toBe("700");   // 70% of 1000
    expect(dist[2].amount).toBe("100");   // 10% of 1000
    expect(dist[3].amount).toBe("100");   // 10% of 1000
  });

  it("handles large amounts (WEI-scale)", () => {
    // 1 ETH in wei = 1_000_000_000_000_000_000
    const dist = calculateDistribution("1000000000000000000", [
      { address: "0xA", percentage: 10 },
      { address: "0xB", percentage: 90 },
    ]);
    expect(dist[0].amount).toBe("100000000000000000");   // 0.1 ETH
    expect(dist[1].amount).toBe("900000000000000000");   // 0.9 ETH
  });

  it("returns correct amounts for community profile (20/60/5/5/10)", () => {
    const splits = [
      { address: "0xDesigner", percentage: 20 },
      { address: "0xOperator", percentage: 60 },
      { address: "0xCurator",  percentage:  5 },
      { address: "0xVerifier", percentage:  5 },
      { address: "0xNetwork",  percentage: 10 },
    ];
    const dist = calculateDistribution("1000", splits);
    expect(dist[0].amount).toBe("200");
    expect(dist[1].amount).toBe("600");
    expect(dist[2].amount).toBe("50");
    expect(dist[3].amount).toBe("50");
    expect(dist[4].amount).toBe("100");
  });
});

// ---------------------------------------------------------------------------
// calculateDistribution — edge cases
// ---------------------------------------------------------------------------

describe("calculateDistribution — edge cases", () => {
  it("returns zero amounts for zero payment", () => {
    const dist = calculateDistribution("0", [
      { address: "0xA", percentage: 50 },
      { address: "0xB", percentage: 50 },
    ]);
    expect(dist[0].amount).toBe("0");
    expect(dist[1].amount).toBe("0");
  });

  it("returns empty array for empty splits", () => {
    const dist = calculateDistribution("1000", []);
    expect(dist).toEqual([]);
  });

  it("handles non-numeric amount gracefully (returns zeros)", () => {
    const dist = calculateDistribution("not-a-number", [
      { address: "0xA", percentage: 50 },
      { address: "0xB", percentage: 50 },
    ]);
    expect(dist[0].amount).toBe("0");
    expect(dist[1].amount).toBe("0");
  });

  it("clamps percentages above 100 to 100", () => {
    const dist = calculateDistribution("1000", [
      { address: "0xA", percentage: 200 },
    ]);
    // 100% (clamped) of 1000 = 1000
    expect(dist[0].amount).toBe("1000");
  });

  it("clamps negative percentages to 0", () => {
    const dist = calculateDistribution("1000", [
      { address: "0xA", percentage: -10 },
    ]);
    expect(dist[0].amount).toBe("0");
  });

  it("works with a single split entry at 100%", () => {
    const dist = calculateDistribution("500", [
      { address: "0xSolo", percentage: 100 },
    ]);
    expect(dist[0].amount).toBe("500");
  });

  it("result array length matches splits array length", () => {
    const splits = Array.from({ length: 5 }, (_, i) => ({
      address: `0xAddr${i}`,
      percentage: 20,
    }));
    const dist = calculateDistribution("1000", splits);
    expect(dist).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// validateSplitTotal
// ---------------------------------------------------------------------------

describe("validateSplitTotal", () => {
  it("returns valid=true for a profile summing to 100", () => {
    const result = validateSplitTotal(SPLIT_PROFILES.singleStep);
    expect(result.valid).toBe(true);
    expect(result.total).toBe(100);
  });

  it("returns valid=false for a profile not summing to 100", () => {
    const bad: RevenueSplitProfile = {
      name: "Bad",
      description: "Wrong total",
      splits: [
        { role: "designer", percentage: 50, label: "D" },
        { role: "operator", percentage: 30, label: "O" },
        // total = 80, not 100
      ],
    };
    const result = validateSplitTotal(bad);
    expect(result.valid).toBe(false);
    expect(result.total).toBe(80);
  });

  it("returns valid=false for an empty profile", () => {
    const empty: RevenueSplitProfile = {
      name: "Empty",
      description: "No splits",
      splits: [],
    };
    const result = validateSplitTotal(empty);
    expect(result.valid).toBe(false);
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration — buildSplitsForJob + calculateDistribution together
// ---------------------------------------------------------------------------

describe("Integration — buildSplitsForJob + calculateDistribution", () => {
  it("full singleStep workflow: profile → resolved splits → distribution", () => {
    const addresses = {
      designer: "0xDesigner",
      operator: "0xOperator",
      verifier: "0xVerifier",
      network:  "0xTreasury",
    };

    const resolvedSplits = buildSplitsForJob(SPLIT_PROFILES.singleStep, addresses);
    const distribution = calculateDistribution("1000", resolvedSplits);

    expect(distribution).toHaveLength(4);

    const designer = distribution.find((d) => d.address === "0xDesigner");
    const operator = distribution.find((d) => d.address === "0xOperator");
    const verifier = distribution.find((d) => d.address === "0xVerifier");
    const treasury = distribution.find((d) => d.address === "0xTreasury");

    expect(designer?.amount).toBe("100");   // 10%
    expect(operator?.amount).toBe("700");   // 70%
    expect(verifier?.amount).toBe("100");   // 10%
    expect(treasury?.amount).toBe("100");   // 10%
  });

  it("full community workflow: profile → resolved splits → distribution", () => {
    const addresses = {
      designer: "0xDesigner",
      operator: "0xOperator",
      curator:  "0xCurator",
      verifier: "0xVerifier",
      network:  "0xTreasury",
    };

    const resolvedSplits = buildSplitsForJob(SPLIT_PROFILES.community, addresses);
    const distribution = calculateDistribution("10000", resolvedSplits);

    expect(distribution.find((d) => d.address === "0xDesigner")?.amount).toBe("2000"); // 20%
    expect(distribution.find((d) => d.address === "0xOperator")?.amount).toBe("6000"); // 60%
    expect(distribution.find((d) => d.address === "0xCurator")?.amount).toBe("500");   // 5%
    expect(distribution.find((d) => d.address === "0xVerifier")?.amount).toBe("500");  // 5%
    expect(distribution.find((d) => d.address === "0xTreasury")?.amount).toBe("1000"); // 10%
  });
});

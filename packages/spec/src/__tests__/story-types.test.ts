/**
 * Tests for Story Protocol types in @pcc/spec.
 * All tests are structural — they verify that the types can be constructed
 * and that TypeScript narrowing works correctly.
 */

import { describe, it, expect } from "vitest";
import type {
  StoryIPRegistration,
  StoryRoyaltySplit,
  StoryDerivativeLink,
  StoryRevenueSnapshot,
  StoryDispute,
  ContributorRole,
} from "../types/story.js";

// ── StoryIPRegistration ───────────────────────────────────────────────────────

describe("StoryIPRegistration", () => {
  it("can be constructed with all required fields", () => {
    const reg: StoryIPRegistration = {
      ipId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      nftTokenId: "42",
      licenseTermsId: "1",
      txHash: "0xabc123def456",
      capabilityId: "cap-cnc-milling-sf",
      csdUrl: "pcc://capabilities/cap-cnc-milling-sf",
      registeredAt: "2026-03-21T00:00:00.000Z",
      chain: "story-aeneid",
    };
    expect(reg.ipId).toMatch(/^0x/);
    expect(reg.chain).toBe("story-aeneid");
  });

  it("accepts story mainnet chain value", () => {
    const reg: StoryIPRegistration = {
      ipId: "0xdeadbeef",
      nftTokenId: "1",
      licenseTermsId: "2",
      txHash: "0xfeed",
      capabilityId: "cap-laser-cut",
      csdUrl: "ipfs://bafy...",
      registeredAt: new Date().toISOString(),
      chain: "story",
    };
    expect(reg.chain).toBe("story");
  });

  it("chain field is narrowed to union literal type", () => {
    const chains: StoryIPRegistration["chain"][] = ["story", "story-aeneid"];
    expect(chains).toHaveLength(2);
  });
});

// ── StoryRoyaltySplit ─────────────────────────────────────────────────────────

describe("StoryRoyaltySplit", () => {
  it("can be constructed with a splits array summing to 100", () => {
    const split: StoryRoyaltySplit = {
      ipId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      splits: [
        { address: "0x111", role: "designer",  percentage: 10, label: "CSD Author" },
        { address: "0x222", role: "operator",  percentage: 70, label: "Machine Operator" },
        { address: "0x333", role: "verifier",  percentage: 10, label: "Evidence Verifier" },
        { address: "0x444", role: "curator",   percentage: 10, label: "Network Treasury" },
      ],
      totalTokensDistributed: 100,
    };
    const total = split.splits.reduce((s, x) => s + x.percentage, 0);
    expect(total).toBe(100);
    expect(split.totalTokensDistributed).toBe(100);
  });

  it("all legacy role values still decode (backward compat)", () => {
    const roles: StoryRoyaltySplit["splits"][number]["role"][] = [
      "designer", "operator", "verifier", "assembler", "curator",
    ];
    expect(roles).toHaveLength(5);
  });

  it("all new ContributorRole values are accepted (ADR-12)", () => {
    const roles: ContributorRole[] = [
      "operator",
      "verifier",
      "insurer",
      "integrator",
      "protocol-author",
      "model-author",
      "dataset-contributor",
      "curator",
      "assembler",
      "network-treasury",
      "designer", // deprecated but still valid
    ];
    expect(roles).toHaveLength(11);
  });

  it("StoryRoyaltySplit accepts new roles in splits entries", () => {
    const split: StoryRoyaltySplit = {
      ipId: "0xip_new_roles",
      splits: [
        { address: "0x001", role: "operator",            percentage: 87, label: "Operator" },
        { address: "0x002", role: "verifier",            percentage:  3, label: "Verifier" },
        { address: "0x003", role: "protocol-author",     percentage:  2, label: "CSD Author" },
        { address: "0x004", role: "integrator",          percentage:  2, label: "Adapter Author" },
        { address: "0x005", role: "model-author",        percentage:  4, label: "Model Author" },
        { address: "0x006", role: "network-treasury",    percentage:  2, label: "Network Treasury" },
      ],
      totalTokensDistributed: 100,
    };
    const total = split.splits.reduce((s, x) => s + x.percentage, 0);
    expect(total).toBe(100);
  });

  it("split can have a single holder at 100%", () => {
    const split: StoryRoyaltySplit = {
      ipId: "0xabc",
      splits: [{ address: "0x999", role: "operator", percentage: 100, label: "Solo Operator" }],
      totalTokensDistributed: 100,
    };
    expect(split.splits[0].percentage).toBe(100);
  });
});

// ── StoryDerivativeLink ───────────────────────────────────────────────────────

describe("StoryDerivativeLink", () => {
  it("can be constructed with all required fields", () => {
    const link: StoryDerivativeLink = {
      parentIpId: "0xparent",
      childIpId: "0xchild",
      licenseTokenId: "7",
      jobId: "job-sf-001",
      evidenceBundleHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      txHash: "0xtx123",
      linkedAt: "2026-03-21T01:00:00.000Z",
    };
    expect(link.parentIpId).toBe("0xparent");
    expect(link.childIpId).toBe("0xchild");
    expect(link.jobId).toBe("job-sf-001");
  });

  it("evidenceBundleHash captures SHA-256 format", () => {
    const link: StoryDerivativeLink = {
      parentIpId: "0xA",
      childIpId: "0xB",
      licenseTokenId: "1",
      jobId: "job-2",
      evidenceBundleHash: "sha256:" + "a".repeat(64),
      txHash: "0xtx",
      linkedAt: new Date().toISOString(),
    };
    expect(link.evidenceBundleHash).toHaveLength(71); // "sha256:" + 64 chars
  });
});

// ── StoryRevenueSnapshot ──────────────────────────────────────────────────────

describe("StoryRevenueSnapshot", () => {
  it("can be constructed with token holders", () => {
    const snap: StoryRevenueSnapshot = {
      ipId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      vaultAddress: "0xvault1",
      totalRevenue: "1000000000000000000",     // 1 WIP in wei
      unclaimedRevenue: "500000000000000000",  // 0.5 WIP
      tokenHolders: [
        { address: "0x111", tokensHeld: 10, claimable: "50000000000000000" },
        { address: "0x222", tokensHeld: 70, claimable: "350000000000000000" },
        { address: "0x333", tokensHeld: 10, claimable: "50000000000000000" },
        { address: "0x444", tokensHeld: 10, claimable: "50000000000000000" },
      ],
      lastPaymentAt: "2026-03-21T00:30:00.000Z",
    };
    expect(snap.tokenHolders).toHaveLength(4);
    const totalTokens = snap.tokenHolders.reduce((s, h) => s + h.tokensHeld, 0);
    expect(totalTokens).toBe(100);
  });

  it("revenue values are stored as strings (bigint-safe)", () => {
    const snap: StoryRevenueSnapshot = {
      ipId: "0xabc",
      vaultAddress: "0xvault",
      totalRevenue: "999999999999999999999",
      unclaimedRevenue: "0",
      tokenHolders: [],
      lastPaymentAt: new Date().toISOString(),
    };
    expect(typeof snap.totalRevenue).toBe("string");
    expect(typeof snap.unclaimedRevenue).toBe("string");
  });
});

// ── StoryDispute ──────────────────────────────────────────────────────────────

describe("StoryDispute", () => {
  it("can be constructed with pending status and no resolvedAt", () => {
    const dispute: StoryDispute = {
      disputeId: "dispute-001",
      ipId: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
      initiator: "0xchallenger",
      evidenceHash: "sha256:" + "b".repeat(64),
      reason: "Evidence was fabricated",
      status: "pending",
      createdAt: "2026-03-21T02:00:00.000Z",
    };
    expect(dispute.status).toBe("pending");
    expect(dispute.resolvedAt).toBeUndefined();
  });

  it("can be constructed with resolved status and resolvedAt timestamp", () => {
    const dispute: StoryDispute = {
      disputeId: "dispute-002",
      ipId: "0xabc",
      initiator: "0xchallenger2",
      evidenceHash: "sha256:" + "c".repeat(64),
      reason: "IP ownership contested",
      status: "resolved",
      createdAt: "2026-03-20T00:00:00.000Z",
      resolvedAt: "2026-03-21T00:00:00.000Z",
    };
    expect(dispute.status).toBe("resolved");
    expect(dispute.resolvedAt).toBeDefined();
  });

  it("status is narrowed to a three-value union", () => {
    const statuses: StoryDispute["status"][] = ["pending", "resolved", "cancelled"];
    expect(statuses).toHaveLength(3);
  });
});

// ── Re-export check ───────────────────────────────────────────────────────────

describe("Story types re-exported from @pcc/spec types/index", () => {
  it("all Story type names are accessible via the barrel", async () => {
    // The real check is that TypeScript compiled without errors.
    // A runtime import confirms the barrel doesn't break at runtime.
    const specTypes = await import("../types/index.js");
    expect(specTypes).toBeDefined();
  });
});

/**
 * Tests for StoryIPService in mock mode.
 *
 * All tests run with STORY_MOCK=true (the default).
 * No real Story Protocol SDK or blockchain calls are made.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  StoryIPService,
  getStoryIPService,
  resetStoryIPService,
} from "../story-ip-service.js";

// Ensure mock mode for all tests
process.env.STORY_MOCK = "true";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CAPABILITY = {
  id: "cap-cnc-001",
  name: "CNC 3-Axis Milling",
  type: "cnc-3axis",
  kernelId: "kernel-nyc-01",
  description: "High-precision 3-axis CNC milling",
};

const DESIGNER = {
  designerAddress: "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
  designerName: "Alice Designer",
  commercialRevShare: 5,
};

const JOB_EVIDENCE = {
  jobId: "job-abc-001",
  evidenceBundleHash: "sha256:aaabbbccc111222333",
  operatorAddress: "0xCAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE",
  operatorName: "Bob Operator",
};

// ---------------------------------------------------------------------------
// registerCapabilityAsIP
// ---------------------------------------------------------------------------

describe("StoryIPService — registerCapabilityAsIP", () => {
  let svc: StoryIPService;

  beforeEach(() => {
    svc = new StoryIPService({ mock: true });
  });

  it("returns a valid StoryIPRegistration", async () => {
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);

    expect(reg.ipId).toMatch(/^0x[0-9a-f]+$/i);
    expect(reg.nftTokenId).toBeTruthy();
    expect(reg.licenseTermsId).toBeTruthy();
    expect(reg.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(reg.capabilityId).toBe(CAPABILITY.id);
    expect(reg.csdUrl).toBe(`pcc://capabilities/${CAPABILITY.id}`);
    expect(reg.registeredAt).toBeTruthy();
    expect(["story", "story-aeneid"]).toContain(reg.chain);
  });

  it("generates deterministic ipId from capabilityId", async () => {
    const reg1 = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const svc2 = new StoryIPService({ mock: true });
    const reg2 = await svc2.registerCapabilityAsIP(CAPABILITY, DESIGNER);

    expect(reg1.ipId).toBe(reg2.ipId);
    expect(reg1.txHash).toBe(reg2.txHash);
    expect(reg1.nftTokenId).toBe(reg2.nftTokenId);
    expect(reg1.licenseTermsId).toBe(reg2.licenseTermsId);
  });

  it("different capabilities produce different ipIds", async () => {
    const cap2 = { ...CAPABILITY, id: "cap-fdm-002" };
    const reg1 = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const reg2 = await svc.registerCapabilityAsIP(cap2, DESIGNER);

    expect(reg1.ipId).not.toBe(reg2.ipId);
    expect(reg1.txHash).not.toBe(reg2.txHash);
  });

  it("uses IPFS CID in csdUrl when provided", async () => {
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, {
      ...DESIGNER,
      ipfsCid: "bafybeig3k5z7i2p5f5qk3m7h2qb7h4yymncxp3g2zkzq3okzqz7a7y7mu",
    });

    expect(reg.csdUrl).toBe("ipfs://bafybeig3k5z7i2p5f5qk3m7h2qb7h4yymncxp3g2zkzq3okzqz7a7y7mu");
  });

  it("persists to in-memory registry for subsequent getIPRegistration calls", async () => {
    await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const fetched = await svc.getIPRegistration(CAPABILITY.id);

    expect(fetched).not.toBeNull();
    expect(fetched?.capabilityId).toBe(CAPABILITY.id);
  });
});

// ---------------------------------------------------------------------------
// getIPRegistration
// ---------------------------------------------------------------------------

describe("StoryIPService — getIPRegistration", () => {
  let svc: StoryIPService;

  beforeEach(() => {
    svc = new StoryIPService({ mock: true });
  });

  it("returns null for an unregistered capabilityId", async () => {
    const result = await svc.getIPRegistration("nonexistent-cap");
    expect(result).toBeNull();
  });

  it("returns the registration after registerCapabilityAsIP", async () => {
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const fetched = await svc.getIPRegistration(CAPABILITY.id);

    expect(fetched).toEqual(reg);
  });
});

// ---------------------------------------------------------------------------
// registerJobAsDerivative
// ---------------------------------------------------------------------------

describe("StoryIPService — registerJobAsDerivative", () => {
  let svc: StoryIPService;
  let parentIpId: string;

  beforeEach(async () => {
    svc = new StoryIPService({ mock: true });
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    parentIpId = reg.ipId;
  });

  it("returns a valid StoryDerivativeLink", async () => {
    const link = await svc.registerJobAsDerivative(parentIpId, JOB_EVIDENCE);

    expect(link.parentIpId).toBe(parentIpId);
    expect(link.childIpId).toMatch(/^0x[0-9a-f]+$/i);
    expect(link.licenseTokenId).toBeTruthy();
    expect(link.jobId).toBe(JOB_EVIDENCE.jobId);
    expect(link.evidenceBundleHash).toBe(JOB_EVIDENCE.evidenceBundleHash);
    expect(link.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(link.linkedAt).toBeTruthy();
  });

  it("generates deterministic childIpId from jobId + evidenceBundleHash", async () => {
    const link1 = await svc.registerJobAsDerivative(parentIpId, JOB_EVIDENCE);
    const svc2 = new StoryIPService({ mock: true });
    const reg2 = await svc2.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const link2 = await svc2.registerJobAsDerivative(reg2.ipId, JOB_EVIDENCE);

    expect(link1.childIpId).toBe(link2.childIpId);
  });

  it("accumulates multiple derivative links for the same parentIpId", async () => {
    const evidence2 = { ...JOB_EVIDENCE, jobId: "job-abc-002", evidenceBundleHash: "sha256:zzz999" };
    await svc.registerJobAsDerivative(parentIpId, JOB_EVIDENCE);
    await svc.registerJobAsDerivative(parentIpId, evidence2);

    const derivatives = await svc.getDerivatives(parentIpId);
    expect(derivatives).toHaveLength(2);
    expect(derivatives[0].jobId).toBe(JOB_EVIDENCE.jobId);
    expect(derivatives[1].jobId).toBe(evidence2.jobId);
  });
});

// ---------------------------------------------------------------------------
// getDerivatives
// ---------------------------------------------------------------------------

describe("StoryIPService — getDerivatives", () => {
  let svc: StoryIPService;

  beforeEach(() => {
    svc = new StoryIPService({ mock: true });
  });

  it("returns empty array for an IP with no derivatives", async () => {
    const result = await svc.getDerivatives("0xdeadbeef1234");
    expect(result).toEqual([]);
  });

  it("returns all registered derivatives", async () => {
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    await svc.registerJobAsDerivative(reg.ipId, JOB_EVIDENCE);
    await svc.registerJobAsDerivative(reg.ipId, {
      ...JOB_EVIDENCE,
      jobId: "job-xyz-002",
      evidenceBundleHash: "sha256:different",
    });

    const derivatives = await svc.getDerivatives(reg.ipId);
    expect(derivatives).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// distributeRoyaltyTokens
// ---------------------------------------------------------------------------

describe("StoryIPService — distributeRoyaltyTokens", () => {
  let svc: StoryIPService;
  let ipId: string;

  beforeEach(async () => {
    svc = new StoryIPService({ mock: true });
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    ipId = reg.ipId;
  });

  it("returns txHash and distributed count", async () => {
    const splits = [
      { address: "0xAAAA", role: "designer" as const, percentage: 10, label: "Designer" },
      { address: "0xBBBB", role: "operator" as const, percentage: 70, label: "Operator" },
      { address: "0xCCCC", role: "verifier" as const, percentage: 10, label: "Verifier" },
      { address: "0xDDDD", role: "curator" as const, percentage: 10, label: "Network" },
    ];

    const result = await svc.distributeRoyaltyTokens(ipId, splits);

    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.distributed).toBe(100);
  });

  it("reflects splits in subsequent revenue snapshot", async () => {
    const splits = [
      { address: "0xAAAA", role: "designer" as const, percentage: 10, label: "Designer" },
      { address: "0xBBBB", role: "operator" as const, percentage: 90, label: "Operator" },
    ];

    await svc.distributeRoyaltyTokens(ipId, splits);
    await svc.payJobRoyalty(ipId, "1000", "0xPAYER");
    const snapshot = await svc.getRevenueSnapshot(ipId);

    expect(snapshot.tokenHolders).toHaveLength(2);
    expect(snapshot.tokenHolders[0].tokensHeld).toBe(10);
    expect(snapshot.tokenHolders[1].tokensHeld).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// payJobRoyalty
// ---------------------------------------------------------------------------

describe("StoryIPService — payJobRoyalty", () => {
  let svc: StoryIPService;
  let ipId: string;

  beforeEach(async () => {
    svc = new StoryIPService({ mock: true });
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    ipId = reg.ipId;
  });

  it("returns a deterministic txHash", async () => {
    const result = await svc.payJobRoyalty(ipId, "500", "0xPAYER");
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("accumulates payments in the revenue store", async () => {
    await svc.payJobRoyalty(ipId, "300", "0xPAYER");
    await svc.payJobRoyalty(ipId, "700", "0xPAYER");

    const snapshot = await svc.getRevenueSnapshot(ipId);
    expect(snapshot.totalRevenue).toBe("1000");
  });
});

// ---------------------------------------------------------------------------
// claimRevenue
// ---------------------------------------------------------------------------

describe("StoryIPService — claimRevenue", () => {
  let svc: StoryIPService;
  let ipId: string;

  beforeEach(async () => {
    svc = new StoryIPService({ mock: true });
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    ipId = reg.ipId;
  });

  it("claims accumulated revenue and resets the vault", async () => {
    await svc.payJobRoyalty(ipId, "500", "0xPAYER");
    const claim = await svc.claimRevenue(ipId);

    expect(claim.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(claim.claimed).toBe("500");

    // Vault should be empty after claim
    const snapshot = await svc.getRevenueSnapshot(ipId);
    expect(snapshot.unclaimedRevenue).toBe("0");
  });

  it("returns zero claimed if vault is empty", async () => {
    const claim = await svc.claimRevenue(ipId);
    expect(claim.claimed).toBe("0");
  });

  it("generates different txHash for different tokenId sets", async () => {
    await svc.payJobRoyalty(ipId, "100", "0xPAYER");
    const claim1 = await svc.claimRevenue(ipId, ["tok1"]);
    await svc.payJobRoyalty(ipId, "100", "0xPAYER");
    const claim2 = await svc.claimRevenue(ipId, ["tok2"]);

    expect(claim1.txHash).not.toBe(claim2.txHash);
  });
});

// ---------------------------------------------------------------------------
// getRevenueSnapshot
// ---------------------------------------------------------------------------

describe("StoryIPService — getRevenueSnapshot", () => {
  let svc: StoryIPService;
  let ipId: string;

  beforeEach(async () => {
    svc = new StoryIPService({ mock: true });
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    ipId = reg.ipId;
  });

  it("returns a valid snapshot with zero revenue initially", async () => {
    const snapshot = await svc.getRevenueSnapshot(ipId);

    expect(snapshot.ipId).toBe(ipId);
    expect(snapshot.vaultAddress).toMatch(/^0x[0-9a-f]+$/i);
    expect(snapshot.totalRevenue).toBe("0");
    expect(snapshot.unclaimedRevenue).toBe("0");
    expect(Array.isArray(snapshot.tokenHolders)).toBe(true);
    expect(snapshot.lastPaymentAt).toBeTruthy();
  });

  it("reflects paid revenue", async () => {
    await svc.payJobRoyalty(ipId, "1000", "0xPAYER");
    const snapshot = await svc.getRevenueSnapshot(ipId);

    expect(snapshot.totalRevenue).toBe("1000");
    expect(snapshot.unclaimedRevenue).toBe("1000");
  });

  it("calculates per-holder claimable amounts proportionally", async () => {
    const splits = [
      { address: "0xAAAA", role: "designer" as const, percentage: 10, label: "Designer" },
      { address: "0xBBBB", role: "operator" as const, percentage: 90, label: "Operator" },
    ];
    await svc.distributeRoyaltyTokens(ipId, splits);
    await svc.payJobRoyalty(ipId, "1000", "0xPAYER");

    const snapshot = await svc.getRevenueSnapshot(ipId);
    expect(snapshot.tokenHolders[0].claimable).toBe("100");  // 10% of 1000
    expect(snapshot.tokenHolders[1].claimable).toBe("900");  // 90% of 1000
  });
});

// ---------------------------------------------------------------------------
// raiseDispute
// ---------------------------------------------------------------------------

describe("StoryIPService — raiseDispute", () => {
  let svc: StoryIPService;
  let ipId: string;

  beforeEach(async () => {
    svc = new StoryIPService({ mock: true });
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    ipId = reg.ipId;
  });

  it("returns a valid StoryDispute", async () => {
    const dispute = await svc.raiseDispute(ipId, {
      hash: "sha256:evidencehash111",
      reason: "The output dimensions were out of tolerance",
    });

    expect(dispute.disputeId).toBeTruthy();
    expect(dispute.ipId).toBe(ipId);
    expect(dispute.initiator).toMatch(/^0x[0-9a-f]+$/i);
    expect(dispute.evidenceHash).toBe("sha256:evidencehash111");
    expect(dispute.reason).toBe("The output dimensions were out of tolerance");
    expect(dispute.status).toBe("pending");
    expect(dispute.createdAt).toBeTruthy();
    expect(dispute.resolvedAt).toBeUndefined();
  });

  it("generates deterministic disputeId from ipId + evidenceHash", async () => {
    const d1 = await svc.raiseDispute(ipId, { hash: "sha256:same", reason: "reason" });
    const svc2 = new StoryIPService({ mock: true });
    const reg2 = await svc2.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const d2 = await svc2.raiseDispute(reg2.ipId, { hash: "sha256:same", reason: "reason" });

    expect(d1.disputeId).toBe(d2.disputeId);
  });
});

// ---------------------------------------------------------------------------
// getLineage
// ---------------------------------------------------------------------------

describe("StoryIPService — getLineage", () => {
  let svc: StoryIPService;

  beforeEach(() => {
    svc = new StoryIPService({ mock: true });
  });

  it("returns empty arrays for an IP with no lineage", async () => {
    const lineage = await svc.getLineage("0xdeadbeef");
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.descendants).toEqual([]);
  });

  it("returns descendants when job derivatives exist", async () => {
    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const link = await svc.registerJobAsDerivative(reg.ipId, JOB_EVIDENCE);

    const lineage = await svc.getLineage(reg.ipId);
    expect(lineage.descendants).toContain(link.childIpId);
    expect(lineage.ancestors).toEqual([]);
  });

  it("returns ancestors when the IP is itself a derivative", async () => {
    const parentReg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const link = await svc.registerJobAsDerivative(parentReg.ipId, JOB_EVIDENCE);

    const childLineage = await svc.getLineage(link.childIpId);
    expect(childLineage.ancestors).toContain(parentReg.ipId);
    expect(childLineage.descendants).toEqual([]);
  });

  it("includes grandchildren in descendants", async () => {
    const parentReg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const link1 = await svc.registerJobAsDerivative(parentReg.ipId, JOB_EVIDENCE);

    // Register a grandchild
    const link2 = await svc.registerJobAsDerivative(link1.childIpId, {
      ...JOB_EVIDENCE,
      jobId: "job-grandchild-001",
      evidenceBundleHash: "sha256:grandchildhash",
    });

    const lineage = await svc.getLineage(parentReg.ipId);
    expect(lineage.descendants).toContain(link1.childIpId);
    expect(lineage.descendants).toContain(link2.childIpId);
  });
});

// ---------------------------------------------------------------------------
// Singleton (getStoryIPService / resetStoryIPService)
// ---------------------------------------------------------------------------

describe("StoryIPService — singleton", () => {
  it("getStoryIPService returns the same instance each call", () => {
    resetStoryIPService();
    const svc1 = getStoryIPService();
    const svc2 = getStoryIPService();
    expect(svc1).toBe(svc2);
  });

  it("resetStoryIPService clears the singleton", () => {
    resetStoryIPService();
    const svc1 = getStoryIPService();
    resetStoryIPService();
    const svc2 = getStoryIPService();
    expect(svc1).not.toBe(svc2);
  });

  it("singleton persists mock registry state between calls", async () => {
    resetStoryIPService();
    const svc = getStoryIPService();

    const reg = await svc.registerCapabilityAsIP(CAPABILITY, DESIGNER);
    const fetched = await getStoryIPService().getIPRegistration(CAPABILITY.id);

    expect(fetched?.ipId).toBe(reg.ipId);
    resetStoryIPService();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  CapabilityCertificateService,
  RewardEngine,
  SCORE_WEIGHTS,
} from "../index.js";
import type { KernelEpochInput } from "../index.js";

// ─────────────────────────────────────────────────────────────────
// Capability Certificate Tests (mpl-core, mock mode)
// ─────────────────────────────────────────────────────────────────

describe("CapabilityCertificateService", () => {
  let service: CapabilityCertificateService;

  beforeEach(() => {
    service = new CapabilityCertificateService({ mock: true });
  });

  it("mints a certificate with correct metadata", async () => {
    const cert = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "fdm",
      assuranceTier: 2,
      metadata: {
        toleranceSpecs: { xy: "+/- 0.15mm" },
        materials: ["PLA", "PETG"],
        calibrationProofCid: "bafytest123",
        maxBuildVolume: "250x210x210 mm",
      },
    });

    expect(cert.id).toMatch(/^cnft_/);
    expect(cert.kernelDid).toBe("did:pcc:kernel:test-01");
    expect(cert.capabilityType).toBe("fdm");
    expect(cert.assuranceTier).toBe(2);
    expect(cert.soulbound).toBe(true);
    expect(cert.status).toBe("active");
    expect(cert.metadata.toleranceSpecs).toEqual({ xy: "+/- 0.15mm" });
    expect(cert.metadata.materials).toEqual(["PLA", "PETG"]);
    expect(cert.metadata.calibrationProofCid).toBe("bafytest123");
    expect(cert.metadata.maxBuildVolume).toBe("250x210x210 mm");
  });

  it("assigns Solana-specific fields (collection, leafIndex, assetId)", async () => {
    const cert = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "cnc-3axis",
      assuranceTier: 3,
      metadata: {},
    });

    expect(cert.merkleTree).toBeTruthy(); // collection address in mpl-core
    expect(typeof cert.leafIndex).toBe("number");
    expect(cert.leafIndex).toBe(0); // first mint
    expect(cert.assetId).toBeTruthy();
  });

  it("increments leafIndex for each mint", async () => {
    const c1 = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "fdm",
      assuranceTier: 1,
      metadata: {},
    });
    const c2 = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "cnc-3axis",
      assuranceTier: 2,
      metadata: {},
    });

    expect(c2.leafIndex).toBe(c1.leafIndex! + 1);
  });

  it("verifies an active certificate", async () => {
    const cert = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "fdm",
      assuranceTier: 1,
      metadata: {},
    });

    const result = service.verifyCapabilityCertificate(cert.id);
    expect(result.valid).toBe(true);
    expect(result.certificate?.id).toBe(cert.id);
  });

  it("returns invalid for non-existent certificate", () => {
    const result = service.verifyCapabilityCertificate("cnft_nonexistent");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("revokes a certificate (burns mpl-core asset in production)", async () => {
    const cert = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "fdm",
      assuranceTier: 1,
      metadata: {},
    });

    const revokeResult = await service.revokeCapabilityCertificate(cert.id);
    expect(revokeResult.revoked).toBe(true);

    const verifyResult = service.verifyCapabilityCertificate(cert.id);
    expect(verifyResult.valid).toBe(false);
    expect(verifyResult.reason).toContain("revoked");
  });

  it("cannot revoke an already revoked certificate", async () => {
    const cert = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "fdm",
      assuranceTier: 1,
      metadata: {},
    });

    await service.revokeCapabilityCertificate(cert.id);
    const secondRevoke = await service.revokeCapabilityCertificate(cert.id);
    expect(secondRevoke.revoked).toBe(false);
    expect(secondRevoke.reason).toContain("already revoked");
  });

  it("enforces soulbound via PermanentFreezeDelegate — transfer always fails", async () => {
    const cert = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test-01",
      capabilityType: "fdm",
      assuranceTier: 1,
      metadata: {},
    });

    const result = service.transferCertificate(cert.id, "did:pcc:kernel:other");
    expect(result.transferred).toBe(false);
    expect(result.reason).toContain("soulbound");
    expect(result.reason).toContain("PermanentFreezeDelegate");
  });

  it("getCertificatesForKernel returns only matching kernel certs", async () => {
    await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:a",
      capabilityType: "fdm",
      assuranceTier: 1,
      metadata: {},
    });
    await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:b",
      capabilityType: "cnc-3axis",
      assuranceTier: 2,
      metadata: {},
    });
    await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:a",
      capabilityType: "sla",
      assuranceTier: 1,
      metadata: {},
    });

    const kernelACerts = service.getCertificatesForKernel("did:pcc:kernel:a");
    expect(kernelACerts).toHaveLength(2);
    expect(kernelACerts.every((c) => c.kernelDid === "did:pcc:kernel:a")).toBe(true);
  });

  it("throws on invalid assurance tier", async () => {
    await expect(
      service.mintCapabilityCertificate({
        kernelDid: "did:pcc:kernel:test",
        capabilityType: "fdm",
        assuranceTier: 5,
        metadata: {},
      }),
    ).rejects.toThrow("assuranceTier must be 0-3");
  });

  it("throws on missing kernelDid", async () => {
    await expect(
      service.mintCapabilityCertificate({
        kernelDid: "",
        capabilityType: "fdm",
        assuranceTier: 1,
        metadata: {},
      }),
    ).rejects.toThrow("kernelDid is required");
  });

  it("listCertificates returns all and supports status filter", async () => {
    await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:a",
      capabilityType: "fdm",
      assuranceTier: 1,
      metadata: {},
    });
    const cert2 = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:b",
      capabilityType: "cnc-3axis",
      assuranceTier: 2,
      metadata: {},
    });
    await service.revokeCapabilityCertificate(cert2.id);

    expect(service.listCertificates()).toHaveLength(2);
    expect(service.listCertificates({ status: "active" })).toHaveLength(1);
    expect(service.listCertificates({ status: "revoked" })).toHaveLength(1);
  });

  it("creates a collection for certificates", async () => {
    const collectionAddr = await service.createCollection();
    expect(collectionAddr).toBeTruthy();
    expect(collectionAddr).toContain("PCCCollection");
  });

  it("fetchOnChainAsset returns cert by assetId (mock)", async () => {
    const cert = await service.mintCapabilityCertificate({
      kernelDid: "did:pcc:kernel:test",
      capabilityType: "fdm",
      assuranceTier: 0,
      metadata: {},
    });

    const asset = await service.fetchOnChainAsset(cert.assetId!);
    expect(asset).not.toBeNull();
    expect((asset as Record<string, unknown>).capabilityType).toBe("fdm");
  });
});

// ─────────────────────────────────────────────────────────────────
// Reward Engine Tests
// ─────────────────────────────────────────────────────────────────

describe("RewardEngine", () => {
  let engine: RewardEngine;

  beforeEach(() => {
    engine = new RewardEngine();
  });

  // ── Score Calculation ─────────────────────────────────────────

  it("calculates epoch scores with correct weights", () => {
    const inputs: KernelEpochInput[] = [
      {
        kernelId: "k1",
        kernelDid: "did:pcc:kernel:k1",
        jobsCompleted: 100,
        qualityScore: 1.0,
        uptimePercent: 100,
        capabilityDiversity: 5,
        scarcityBonus: 1.0,
      },
    ];

    const scores = engine.calculateEpochScores(inputs);
    expect(scores).toHaveLength(1);

    // Perfect scores across all dimensions, all normalized to 1.0
    // 1*0.4 + 1*0.25 + 1*0.15 + 1*0.1 + 1*0.1 = 1.0
    expect(scores[0].totalScore).toBeCloseTo(1.0, 5);
  });

  it("verifies weight proportions: jobs=40%, quality=25%, uptime=15%, diversity=10%, scarcity=10%", () => {
    expect(SCORE_WEIGHTS.jobsCompleted).toBe(0.4);
    expect(SCORE_WEIGHTS.qualityScore).toBe(0.25);
    expect(SCORE_WEIGHTS.uptimePercent).toBe(0.15);
    expect(SCORE_WEIGHTS.capabilityDiversity).toBe(0.1);
    expect(SCORE_WEIGHTS.scarcityBonus).toBe(0.1);

    // Weights sum to 1.0
    const sum = Object.values(SCORE_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("normalizes scores relative to the best performer", () => {
    const inputs: KernelEpochInput[] = [
      {
        kernelId: "k1",
        kernelDid: "did:pcc:kernel:k1",
        jobsCompleted: 100,
        qualityScore: 0.9,
        uptimePercent: 99,
        capabilityDiversity: 4,
        scarcityBonus: 0.5,
      },
      {
        kernelId: "k2",
        kernelDid: "did:pcc:kernel:k2",
        jobsCompleted: 50,
        qualityScore: 1.0,
        uptimePercent: 100,
        capabilityDiversity: 2,
        scarcityBonus: 0.8,
      },
    ];

    const scores = engine.calculateEpochScores(inputs);
    expect(scores).toHaveLength(2);
    expect(scores[0].totalScore).toBeGreaterThan(0);
    expect(scores[1].totalScore).toBeGreaterThan(0);
  });

  it("returns empty array for empty inputs", () => {
    const scores = engine.calculateEpochScores([]);
    expect(scores).toEqual([]);
  });

  // ── Reward Distribution ───────────────────────────────────────

  it("distributes rewards proportionally to scores", () => {
    const inputs: KernelEpochInput[] = [
      {
        kernelId: "k1",
        kernelDid: "did:pcc:kernel:k1",
        jobsCompleted: 100,
        qualityScore: 1.0,
        uptimePercent: 100,
        capabilityDiversity: 5,
        scarcityBonus: 1.0,
      },
      {
        kernelId: "k2",
        kernelDid: "did:pcc:kernel:k2",
        jobsCompleted: 50,
        qualityScore: 1.0,
        uptimePercent: 100,
        capabilityDiversity: 5,
        scarcityBonus: 1.0,
      },
    ];

    const scores = engine.calculateEpochScores(inputs);
    const distributed = engine.distributeRewards(scores, "10000");

    const r1 = parseFloat(distributed[0].rewardAmount);
    const r2 = parseFloat(distributed[1].rewardAmount);
    expect(r1).toBeGreaterThan(r2);
    expect(r1 + r2).toBeCloseTo(10000, 2);
  });

  it("handles zero pool gracefully", () => {
    const scores = engine.calculateEpochScores([
      {
        kernelId: "k1",
        kernelDid: "did:pcc:kernel:k1",
        jobsCompleted: 10,
        qualityScore: 0.5,
        uptimePercent: 50,
        capabilityDiversity: 1,
        scarcityBonus: 0,
      },
    ]);
    const distributed = engine.distributeRewards(scores, "0");
    expect(distributed[0].rewardAmount).toBe("0");
  });

  // ── Epoch Lifecycle ───────────────────────────────────────────

  it("creates an epoch with active status", () => {
    const epoch = engine.createEpoch(1, "2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z", "10000");
    expect(epoch.id).toMatch(/^epoch_/);
    expect(epoch.epochNumber).toBe(1);
    expect(epoch.status).toBe("active");
    expect(epoch.totalRewards).toBe("10000");
    expect(epoch.kernelScores).toEqual([]);
  });

  it("completes an epoch with scores and distribution", () => {
    const epoch = engine.createEpoch(1, "2026-03-01T00:00:00Z", "2026-03-31T23:59:59Z", "5000");
    const completed = engine.completeEpoch(epoch.id, [
      {
        kernelId: "k1",
        kernelDid: "did:pcc:kernel:k1",
        jobsCompleted: 20,
        qualityScore: 0.9,
        uptimePercent: 95,
        capabilityDiversity: 3,
        scarcityBonus: 0.4,
      },
    ]);

    expect(completed.status).toBe("completed");
    expect(completed.kernelScores).toHaveLength(1);
    expect(parseFloat(completed.kernelScores[0].rewardAmount)).toBeCloseTo(5000, 2);
  });

  it("throws when completing a non-existent epoch", () => {
    expect(() => engine.completeEpoch("epoch_fake", [])).toThrow("not found");
  });

  it("throws when completing an already completed epoch", () => {
    const epoch = engine.createEpoch(1, "2026-03-01", "2026-03-31", "1000");
    engine.completeEpoch(epoch.id, []);
    expect(() => engine.completeEpoch(epoch.id, [])).toThrow("already completed");
  });

  // ── Claims ────────────────────────────────────────────────────

  it("submits and settles a reward claim", () => {
    const claim = engine.submitClaim("k1", "epoch_1", "500", "solana");
    expect(claim.id).toMatch(/^claim_/);
    expect(claim.status).toBe("pending");

    const settled = engine.settleClaim(claim.id, "0xabc123");
    expect(settled.status).toBe("claimed");
    expect(settled.txHash).toBe("0xabc123");
    expect(settled.claimedAt).toBeTruthy();
  });

  it("fails a claim", () => {
    const claim = engine.submitClaim("k1", "epoch_1", "500", "base");
    const failed = engine.failClaim(claim.id);
    expect(failed.status).toBe("failed");
  });

  it("throws when settling a non-pending claim", () => {
    const claim = engine.submitClaim("k1", "epoch_1", "500", "base");
    engine.settleClaim(claim.id, "0x1");
    expect(() => engine.settleClaim(claim.id, "0x2")).toThrow("not pending");
  });

  // ── Queries ───────────────────────────────────────────────────

  it("getKernelRewardHistory returns correct history", () => {
    const epoch = engine.createEpoch(1, "2026-03-01", "2026-03-31", "1000");
    engine.completeEpoch(epoch.id, [
      {
        kernelId: "k1",
        kernelDid: "did:pcc:kernel:k1",
        jobsCompleted: 10,
        qualityScore: 0.8,
        uptimePercent: 90,
        capabilityDiversity: 2,
        scarcityBonus: 0.3,
      },
    ]);

    const history = engine.getKernelRewardHistory("k1");
    expect(history).toHaveLength(1);
    expect(history[0].epochNumber).toBe(1);
    expect(parseFloat(history[0].reward)).toBeGreaterThan(0);
  });

  it("listEpochs filters by status", () => {
    engine.createEpoch(1, "2026-01-01", "2026-01-31", "1000");
    const ep2 = engine.createEpoch(2, "2026-02-01", "2026-02-28", "2000");
    engine.completeEpoch(ep2.id, []);

    expect(engine.listEpochs({ status: "active" })).toHaveLength(1);
    expect(engine.listEpochs({ status: "completed" })).toHaveLength(1);
    expect(engine.listEpochs()).toHaveLength(2);
  });

  it("getClaimsForKernel returns only matching claims", () => {
    engine.submitClaim("k1", "epoch_1", "100", "base");
    engine.submitClaim("k2", "epoch_1", "200", "base");
    engine.submitClaim("k1", "epoch_2", "150", "solana");

    const k1Claims = engine.getClaimsForKernel("k1");
    expect(k1Claims).toHaveLength(2);
    expect(k1Claims.every((c) => c.kernelId === "k1")).toBe(true);
  });
});

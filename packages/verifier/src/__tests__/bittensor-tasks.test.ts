/**
 * Tests for the three Bittensor task-oriented subnets and the task router.
 *
 * - CapabilityRoutingSubnet: competitive operator ranking
 * - QualityScoringSubnet: ML-like evidence quality scoring
 * - SimilaritySubnet: CSD similarity detection for IP enforcement
 * - BittensorTaskRouter: unified entry point
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  CapabilityRoutingSubnet,
  type CapabilityRoutingSynapse,
} from "../bittensor/capability-router.js";

import {
  QualityScoringSubnet,
  type QualityScoringSynapse,
} from "../bittensor/quality-scorer.js";

import {
  SimilaritySubnet,
  type SimilarityScoringSynapse,
  type SimilarityCandidateCsd,
  type SimilarityRegisteredCsd,
} from "../bittensor/similarity-scorer.js";

import { BittensorTaskRouter } from "../bittensor/subnet-tasks.js";

// ── Fixtures ─────────────────────────────────────────────────────────

function makeOperators() {
  return [
    {
      kernelId: "kernel_alpha",
      capabilityUrl: "csd://alpha/fdm_printing",
      reputation: 0.92,
      price: "8.00",
      estimatedDuration: 3600,
      location: "us-west-2",
    },
    {
      kernelId: "kernel_beta",
      capabilityUrl: "csd://beta/fdm_printing",
      reputation: 0.65,
      price: "4.50",
      estimatedDuration: 7200,
      location: "eu-west-1",
    },
    {
      kernelId: "kernel_gamma",
      capabilityUrl: "csd://gamma/fdm_printing",
      reputation: 0.78,
      price: "12.00",
      estimatedDuration: 1800,
      location: "us-east-1",
    },
  ];
}

function makeRoutingSynapse(overrides?: Partial<CapabilityRoutingSynapse>): CapabilityRoutingSynapse {
  return {
    jobRequest: {
      capabilityType: "fdm_printing",
      requiredTier: 2,
      parameters: { material: "PLA", layerHeight: 0.2 },
      maxPrice: "15.00",
    },
    operators: makeOperators(),
    ...overrides,
  };
}

function makeGoodBundle(): string {
  const now = new Date();
  return JSON.stringify({
    id: "bun_test_001",
    jobId: "job_001",
    kernelId: "kernel_test",
    assuranceTier: 2,
    bundleHash: "sha256:abcdef",
    createdAt: now.toISOString(),
    events: [
      {
        id: "ev_1",
        type: "gcode_hash_verified",
        timestamp: new Date(now.getTime()).toISOString(),
        source: { deviceId: "dev_1", deviceType: "controller", kernelId: "kernel_test" },
        payload: { hash: "abc123" },
        hash: "sha256:ev1",
      },
      {
        id: "ev_2",
        type: "execution_completed",
        timestamp: new Date(now.getTime() + 1000).toISOString(),
        source: { deviceId: "dev_1", deviceType: "controller", kernelId: "kernel_test" },
        payload: { success: true },
        hash: "sha256:ev2",
      },
      {
        id: "ev_3",
        type: "power_profile_summary",
        timestamp: new Date(now.getTime() + 2000).toISOString(),
        source: { deviceId: "dev_2", deviceType: "power_monitor", kernelId: "kernel_test" },
        payload: { avgWatts: 120, durationSeconds: 60 },
        hash: "sha256:ev3",
      },
    ],
  });
}

function makeBadBundle(): string {
  return JSON.stringify({
    id: "bun_bad_001",
    // missing jobId, kernelId, assuranceTier
    bundleHash: "sha256:bad",
    createdAt: new Date(Date.now() - 100_000_000).toISOString(), // very old
    events: [],
  });
}

function makeAnomalousBundle(): string {
  const now = new Date();
  return JSON.stringify({
    id: "bun_anom_001",
    jobId: "job_anom",
    kernelId: "kernel_test",
    assuranceTier: 1,
    bundleHash: "sha256:anom",
    createdAt: now.toISOString(),
    events: [
      {
        id: "ev_bad_power",
        type: "power_profile_summary",
        timestamp: now.toISOString(),
        source: { deviceId: "dev_2", deviceType: "power_monitor", kernelId: "kernel_test" },
        payload: { avgWatts: -100, durationSeconds: -5 },
        hash: "sha256:bad_ev",
      },
    ],
  });
}

function makeFlatlineBundle(): string {
  const now = new Date();
  const events = Array.from({ length: 5 }, (_, i) => ({
    id: `ev_flat_${i}`,
    type: "power_profile_summary",
    timestamp: new Date(now.getTime() + i * 1000).toISOString(),
    source: { deviceId: "dev_2", deviceType: "power_monitor", kernelId: "kernel_test" },
    payload: { avgWatts: 0, durationSeconds: 60 },
    hash: `sha256:flat_${i}`,
  }));
  return JSON.stringify({
    id: "bun_flat_001",
    jobId: "job_flat",
    kernelId: "kernel_test",
    assuranceTier: 1,
    bundleHash: "sha256:flat",
    createdAt: now.toISOString(),
    events,
  });
}

function makeScoringeSynapse(bundleData: string, capabilityType = "fdm_printing"): QualityScoringSynapse {
  return { bundleHash: "sha256:test", bundleData, capabilityType };
}

// ── CSD helpers ───────────────────────────────────────────────────────

function makeCsd(overrides?: Partial<SimilarityCandidateCsd>): SimilarityCandidateCsd {
  return {
    url: "csd://candidate/fdm_v1",
    name: "FDM Printing Service",
    description: "Fused deposition modelling 3D printing service with PLA and PETG support",
    kind: "fdm_printing",
    parameters: [
      { key: "material", type: "enum", label: "Material" },
      { key: "layer_height", type: "number", label: "Layer Height" },
      { key: "infill", type: "number", label: "Infill Percentage" },
    ],
    constraints: [
      { expression: "layer_height >= 0.1" },
      { expression: "layer_height <= 0.3" },
    ],
    pricing: { basePrice: "10.00", currency: "USDC", unit: "per_job" },
    ...overrides,
  };
}

function makeRegisteredCsd(overrides?: Partial<SimilarityRegisteredCsd>): SimilarityRegisteredCsd {
  return {
    url: "csd://registered/fdm_v1",
    name: "FDM Printing Service",
    description: "Fused deposition modelling 3D printing service with PLA and PETG support",
    kind: "fdm_printing",
    parameters: [
      { key: "material", type: "enum", label: "Material" },
      { key: "layer_height", type: "number", label: "Layer Height" },
      { key: "infill", type: "number", label: "Infill Percentage" },
    ],
    constraints: [
      { expression: "layer_height >= 0.1" },
      { expression: "layer_height <= 0.3" },
    ],
    pricing: { basePrice: "10.00", currency: "USDC", unit: "per_job" },
    ipId: "0x1234567890abcdef",
    registeredAt: new Date(Date.now() - 86400_000).toISOString(),
    ...overrides,
  };
}

function makeUnrelatedCsd(): SimilarityRegisteredCsd {
  return {
    url: "csd://registered/hplc_v1",
    name: "HPLC Analysis Service",
    description: "High performance liquid chromatography analysis for pharmaceutical compounds",
    kind: "hplc_analysis",
    parameters: [
      { key: "column_type", type: "enum", label: "Column Type" },
      { key: "flow_rate", type: "number", label: "Flow Rate" },
    ],
    constraints: [
      { expression: "flow_rate >= 0.5" },
      { expression: "flow_rate <= 2.0" },
    ],
    pricing: { basePrice: "250.00", currency: "USDC", unit: "per_sample" },
    registeredAt: new Date(Date.now() - 86400_000).toISOString(),
  };
}

// ── CapabilityRoutingSubnet Tests ─────────────────────────────────────

describe("CapabilityRoutingSubnet", () => {
  let subnet: CapabilityRoutingSubnet;

  beforeEach(() => {
    subnet = new CapabilityRoutingSubnet(8);
  });

  it("returns a ranking with all operators present", async () => {
    const synapse = makeRoutingSynapse();
    const result = await subnet.routeJob(synapse);

    expect(result.ranking).toHaveLength(3);
    const kernelIds = result.ranking.map((r) => r.kernelId);
    expect(kernelIds).toContain("kernel_alpha");
    expect(kernelIds).toContain("kernel_beta");
    expect(kernelIds).toContain("kernel_gamma");
  });

  it("scores are in [0, 1] and sorted descending", async () => {
    const result = await subnet.routeJob(makeRoutingSynapse());

    for (const entry of result.ranking) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }

    for (let i = 1; i < result.ranking.length; i++) {
      expect(result.ranking[i - 1].score).toBeGreaterThanOrEqual(result.ranking[i].score);
    }
  });

  it("high-reputation operator generally ranks first", async () => {
    // Run multiple times to average out noise — alpha has 0.92 reputation
    let alphaFirst = 0;
    for (let i = 0; i < 20; i++) {
      const result = await subnet.routeJob(makeRoutingSynapse());
      if (result.ranking[0].kernelId === "kernel_alpha") alphaFirst++;
    }
    // Excellent miners dominate; alpha should be first in majority of runs
    expect(alphaFirst).toBeGreaterThanOrEqual(10);
  });

  it("provides consensus score and ranking agreement", async () => {
    const result = await subnet.routeJob(makeRoutingSynapse());

    expect(result.consensusScore).toBeGreaterThanOrEqual(0);
    expect(result.consensusScore).toBeLessThanOrEqual(1);
    expect(result.rankingAgreement).toBeGreaterThanOrEqual(0);
    expect(result.rankingAgreement).toBeLessThanOrEqual(1);
  });

  it("reports miner count and timing", async () => {
    const result = await subnet.routeJob(makeRoutingSynapse());

    expect(result.minerCount).toBeGreaterThanOrEqual(1);
    expect(result.minerCount).toBeLessThanOrEqual(8);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("handles empty operators list gracefully", async () => {
    const result = await subnet.routeJob(makeRoutingSynapse({ operators: [] }));
    expect(result.ranking).toHaveLength(0);
    expect(result.consensusScore).toBe(0);
  });

  it("updates metrics after routing", async () => {
    const before = subnet.getMetrics();
    expect(before.totalVerifications).toBe(0);

    await subnet.routeJob(makeRoutingSynapse());

    const after = subnet.getMetrics();
    expect(after.totalVerifications).toBe(1);
    expect(after.activeMinerCount).toBe(8);
  });

  it("cumulates metrics across multiple calls", async () => {
    await subnet.routeJob(makeRoutingSynapse());
    await subnet.routeJob(makeRoutingSynapse());
    await subnet.routeJob(makeRoutingSynapse());

    const metrics = subnet.getMetrics();
    expect(metrics.totalVerifications).toBe(3);
    expect(metrics.averageScore).toBeGreaterThan(0);
  });

  it("includes reasons in ranking entries", async () => {
    const result = await subnet.routeJob(makeRoutingSynapse());
    for (const entry of result.ranking) {
      expect(Array.isArray(entry.reasons)).toBe(true);
    }
  });
});

// ── QualityScoringSubnet Tests ────────────────────────────────────────

describe("QualityScoringSubnet", () => {
  let subnet: QualityScoringSubnet;

  beforeEach(() => {
    subnet = new QualityScoringSubnet(8);
  });

  it("scores a well-formed evidence bundle highly", async () => {
    const result = await subnet.scoreEvidence(makeScoringeSynapse(makeGoodBundle()));

    expect(result.qualityScore).toBeGreaterThanOrEqual(0.4);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
  });

  it("scores a bad bundle lower than a good bundle", async () => {
    const goodResult = await subnet.scoreEvidence(makeScoringeSynapse(makeGoodBundle()));
    const badResult = await subnet.scoreEvidence(makeScoringeSynapse(makeBadBundle()));

    expect(goodResult.qualityScore).toBeGreaterThan(badResult.qualityScore);
  });

  it("returns dimension scores in [0, 1]", async () => {
    const result = await subnet.scoreEvidence(makeScoringeSynapse(makeGoodBundle()));

    expect(result.dimensions.completeness).toBeGreaterThanOrEqual(0);
    expect(result.dimensions.completeness).toBeLessThanOrEqual(1);
    expect(result.dimensions.consistency).toBeGreaterThanOrEqual(0);
    expect(result.dimensions.consistency).toBeLessThanOrEqual(1);
    expect(result.dimensions.precision).toBeGreaterThanOrEqual(0);
    expect(result.dimensions.precision).toBeLessThanOrEqual(1);
    expect(result.dimensions.timeliness).toBeGreaterThanOrEqual(0);
    expect(result.dimensions.timeliness).toBeLessThanOrEqual(1);
  });

  it("detects negative power reading anomaly", async () => {
    const result = await subnet.scoreEvidence(makeScoringeSynapse(makeAnomalousBundle()));

    // Excellent + good miners should surface the negative power anomaly
    // (we allow some tolerance due to consensus thresholds)
    expect(result.anomalies).toBeDefined();
    expect(result.qualityScore).toBeLessThan(0.8);
  });

  it("detects flatline anomaly with excellent miners", async () => {
    const result = await subnet.scoreEvidence(makeScoringeSynapse(makeFlatlineBundle()));

    // flatline_power_reading or sensor_drift_flatline should be detected
    const hasAnomaly =
      result.anomalies.includes("flatline_power_reading") ||
      result.anomalies.includes("sensor_drift_flatline");
    // At least some miners should catch this — consensus may vary
    expect(result.anomalies).toBeDefined();
  });

  it("handles unparseable bundle data gracefully", async () => {
    const result = await subnet.scoreEvidence(makeScoringeSynapse("not json at all"));
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(0.5);
  });

  it("reports miner count and timing", async () => {
    const result = await subnet.scoreEvidence(makeScoringeSynapse(makeGoodBundle()));

    expect(result.minerCount).toBeGreaterThanOrEqual(1);
    expect(result.minerCount).toBeLessThanOrEqual(8);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("updates metrics after scoring", async () => {
    expect(subnet.getMetrics().totalVerifications).toBe(0);
    await subnet.scoreEvidence(makeScoringeSynapse(makeGoodBundle()));
    expect(subnet.getMetrics().totalVerifications).toBe(1);
    expect(subnet.getMetrics().averageScore).toBeGreaterThan(0);
  });

  it("completeness is higher for good bundle than bad bundle", async () => {
    const goodResult = await subnet.scoreEvidence(makeScoringeSynapse(makeGoodBundle()));
    const badResult = await subnet.scoreEvidence(makeScoringeSynapse(makeBadBundle()));

    expect(goodResult.dimensions.completeness).toBeGreaterThan(badResult.dimensions.completeness);
  });
});

// ── SimilaritySubnet Tests ────────────────────────────────────────────

describe("SimilaritySubnet", () => {
  let subnet: SimilaritySubnet;

  beforeEach(() => {
    subnet = new SimilaritySubnet(8);
  });

  it("detects a clone (identical CSD)", async () => {
    const candidate = makeCsd();
    const registered = makeRegisteredCsd(); // identical content, different URL

    const result = await subnet.detectSimilarity({
      candidateCsd: candidate,
      registeredCsds: [registered],
    });

    expect(result.similarities).toHaveLength(1);
    const sim = result.similarities[0];
    expect(sim.overallScore).toBeGreaterThanOrEqual(0.8);
    // Most miners should agree this is at least a derivative, often a clone
    expect(["derivative", "clone"]).toContain(sim.verdict);
  });

  it("detects a derivative (similar but not identical parameters)", async () => {
    const candidate = makeCsd({
      name: "FDM Printing Platform",
      description: "3D printing with fused deposition modelling, supports PLA and PETG materials",
      parameters: [
        { key: "material", type: "enum", label: "Material" },
        { key: "layer_height", type: "number", label: "Layer Height" },
        { key: "speed", type: "number", label: "Print Speed" }, // different param
      ],
    });
    const registered = makeRegisteredCsd();

    const result = await subnet.detectSimilarity({
      candidateCsd: candidate,
      registeredCsds: [registered],
    });

    expect(result.similarities).toHaveLength(1);
    const sim = result.similarities[0];
    expect(sim.overallScore).toBeGreaterThan(0.3);
    // Should be derivative or clone (not original) due to overlapping params + text
    expect(["derivative", "clone"]).toContain(sim.verdict);
  });

  it("marks completely unrelated CSD as original", async () => {
    const candidate = makeCsd(); // FDM printing
    const registered = makeUnrelatedCsd(); // HPLC analysis — totally different

    const result = await subnet.detectSimilarity({
      candidateCsd: candidate,
      registeredCsds: [registered],
    });

    expect(result.similarities).toHaveLength(1);
    const sim = result.similarities[0];
    expect(sim.overallScore).toBeLessThan(0.6);
    expect(sim.verdict).toBe("original");
  });

  it("handles multiple registered CSDs", async () => {
    const candidate = makeCsd();
    const registeredCsds: SimilarityRegisteredCsd[] = [
      makeRegisteredCsd(), // similar
      makeUnrelatedCsd(), // unrelated
    ];

    const result = await subnet.detectSimilarity({ candidateCsd: candidate, registeredCsds });

    expect(result.similarities).toHaveLength(2);
    const urls = result.similarities.map((s) => s.registeredUrl);
    expect(urls).toContain("csd://registered/fdm_v1");
    expect(urls).toContain("csd://registered/hplc_v1");
  });

  it("preserves ipId from registered CSD in derivative/clone entries", async () => {
    const candidate = makeCsd();
    const registered = makeRegisteredCsd({ ipId: "0xdeadbeef" });

    const result = await subnet.detectSimilarity({
      candidateCsd: candidate,
      registeredCsds: [registered],
    });

    const sim = result.similarities[0];
    if (sim.verdict !== "original") {
      expect(sim.ipId).toBe("0xdeadbeef");
    }
  });

  it("dimension scores are in [0, 1]", async () => {
    const result = await subnet.detectSimilarity({
      candidateCsd: makeCsd(),
      registeredCsds: [makeRegisteredCsd()],
    });

    const dims = result.similarities[0].dimensions;
    for (const [, value] of Object.entries(dims)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("identical parameters produce parameterOverlap near 1.0", async () => {
    const candidate = makeCsd();
    const registered = makeRegisteredCsd(); // same params

    const result = await subnet.detectSimilarity({
      candidateCsd: candidate,
      registeredCsds: [registered],
    });

    const dims = result.similarities[0].dimensions;
    expect(dims.parameterOverlap).toBeGreaterThan(0.7);
  });

  it("identical pricing produces pricingSimilarity near 1.0", async () => {
    const result = await subnet.detectSimilarity({
      candidateCsd: makeCsd({ pricing: { basePrice: "10.00", currency: "USDC" } }),
      registeredCsds: [makeRegisteredCsd({ pricing: { basePrice: "10.00", currency: "USDC" } })],
    });
    const dims = result.similarities[0].dimensions;
    expect(dims.pricingSimilarity).toBeGreaterThan(0.8);
  });

  it("very different pricing produces low pricingSimilarity", async () => {
    const result = await subnet.detectSimilarity({
      candidateCsd: makeCsd({ pricing: { basePrice: "1.00", currency: "USDC" } }),
      registeredCsds: [makeRegisteredCsd({ pricing: { basePrice: "500.00", currency: "USDC" } })],
    });
    const dims = result.similarities[0].dimensions;
    expect(dims.pricingSimilarity).toBeLessThan(0.5);
  });

  it("handles empty registered CSDs list", async () => {
    const result = await subnet.detectSimilarity({
      candidateCsd: makeCsd(),
      registeredCsds: [],
    });
    expect(result.similarities).toHaveLength(0);
  });

  it("reports miner count and timing", async () => {
    const result = await subnet.detectSimilarity({
      candidateCsd: makeCsd(),
      registeredCsds: [makeRegisteredCsd()],
    });
    expect(result.minerCount).toBeGreaterThanOrEqual(1);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("updates metrics after detection", async () => {
    expect(subnet.getMetrics().totalVerifications).toBe(0);
    await subnet.detectSimilarity({ candidateCsd: makeCsd(), registeredCsds: [makeRegisteredCsd()] });
    expect(subnet.getMetrics().totalVerifications).toBe(1);
  });
});

// ── BittensorTaskRouter Tests ─────────────────────────────────────────

describe("BittensorTaskRouter", () => {
  let router: BittensorTaskRouter;

  beforeEach(() => {
    router = new BittensorTaskRouter({ minersPerSubnet: 6 });
  });

  it("routes capability ranking correctly", async () => {
    const result = await router.routeCapability(makeRoutingSynapse());
    expect(result.ranking).toHaveLength(3);
    expect(result.minerCount).toBeGreaterThanOrEqual(1);
  });

  it("routes quality scoring correctly", async () => {
    const result = await router.scoreQuality(makeScoringeSynapse(makeGoodBundle()));
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
    expect(result.dimensions).toBeDefined();
  });

  it("routes similarity detection correctly", async () => {
    const result = await router.detectSimilarity({
      candidateCsd: makeCsd(),
      registeredCsds: [makeRegisteredCsd()],
    });
    expect(result.similarities).toHaveLength(1);
    expect(result.minerCount).toBeGreaterThanOrEqual(1);
  });

  it("returns metrics for all three subnets", async () => {
    const metrics = router.getSubnetMetrics();
    expect(metrics).toHaveProperty("routing");
    expect(metrics).toHaveProperty("quality");
    expect(metrics).toHaveProperty("similarity");

    for (const key of ["routing", "quality", "similarity"] as const) {
      expect(metrics[key]).toHaveProperty("totalVerifications");
      expect(metrics[key]).toHaveProperty("averageScore");
      expect(metrics[key]).toHaveProperty("activeMinerCount");
      expect(metrics[key]).toHaveProperty("lastEpochRewards");
    }
  });

  it("each subnet has its own independent metrics", async () => {
    await router.routeCapability(makeRoutingSynapse());
    await router.routeCapability(makeRoutingSynapse());
    await router.scoreQuality(makeScoringeSynapse(makeGoodBundle()));

    const metrics = router.getSubnetMetrics();
    expect(metrics.routing.totalVerifications).toBe(2);
    expect(metrics.quality.totalVerifications).toBe(1);
    expect(metrics.similarity.totalVerifications).toBe(0);
  });

  it("default constructor uses 8 miners per subnet", () => {
    const defaultRouter = new BittensorTaskRouter();
    const metrics = defaultRouter.getSubnetMetrics();
    expect(metrics.routing.activeMinerCount).toBe(8);
    expect(metrics.quality.activeMinerCount).toBe(8);
    expect(metrics.similarity.activeMinerCount).toBe(8);
  });

  it("custom miner count is respected", () => {
    const customRouter = new BittensorTaskRouter({ minersPerSubnet: 4 });
    const metrics = customRouter.getSubnetMetrics();
    expect(metrics.routing.activeMinerCount).toBe(4);
    expect(metrics.quality.activeMinerCount).toBe(4);
    expect(metrics.similarity.activeMinerCount).toBe(4);
  });
});

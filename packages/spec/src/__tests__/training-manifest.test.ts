/**
 * Tests for training-manifest.ts — schema validation, weightBps invariant,
 * and recursive baseModel lineage hash determinism.
 */

import { describe, it, expect } from "vitest";
import {
  TrainingManifestSchema,
  computeTrainingManifestHash,
  assertTrainingManifestIsWellFormed,
  type TrainingManifest,
  type TrainingDatasetEntry,
} from "../types/training-manifest.js";

const HASH_METHOD = "0x" + "f".repeat(64);

function makeManifest(
  datasets: TrainingDatasetEntry[],
  overrides: Partial<TrainingManifest> = {},
): TrainingManifest {
  const partial = {
    modelIpId: overrides.modelIpId ?? "ip-model-001",
    datasets,
    baseModelIpId: overrides.baseModelIpId,
    methodologyHash: overrides.methodologyHash,
    trainedAt: overrides.trainedAt ?? "2026-04-22T00:00:00.000Z",
  };
  return { ...partial, manifestHash: computeTrainingManifestHash(partial) };
}

// ── Schema validation ─────────────────────────────────────────────────

describe("TrainingManifestSchema — weightBps invariant", () => {
  it("accepts a manifest where dataset weights sum to 10000", () => {
    const m = makeManifest([
      { datasetIpId: "ip-ds-001", weightBps: 6000 },
      { datasetIpId: "ip-ds-002", weightBps: 4000 },
    ]);
    expect(() => TrainingManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects a manifest whose weights do NOT sum to 10000", () => {
    const m = makeManifest([
      { datasetIpId: "ip-ds-001", weightBps: 5000 },
      { datasetIpId: "ip-ds-002", weightBps: 4000 },
    ]);
    // computeTrainingManifestHash succeeds (it doesn't validate), but parse fails
    expect(() => TrainingManifestSchema.parse(m)).toThrow(/sum/i);
  });

  it("accepts a single 10000-bps dataset (degenerate but valid)", () => {
    const m = makeManifest([{ datasetIpId: "ip-ds-001", weightBps: 10000 }]);
    expect(() => TrainingManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects empty datasets array", () => {
    expect(() => makeManifest([])).not.toThrow(); // construction succeeds...
    expect(() =>
      TrainingManifestSchema.parse({
        modelIpId: "ip-model-001",
        datasets: [],
        trainedAt: "2026-04-22T00:00:00Z",
        manifestHash: "0x" + "0".repeat(64),
      }),
    ).toThrow();
  });

  it("accepts optional dataPointCount + baseModelIpId + methodologyHash", () => {
    const m = makeManifest(
      [
        { datasetIpId: "ip-ds-001", weightBps: 6000, dataPointCount: 50_000 },
        { datasetIpId: "ip-ds-002", weightBps: 4000, dataPointCount: 30_000 },
      ],
      { baseModelIpId: "ip-base-model", methodologyHash: HASH_METHOD },
    );
    expect(() => TrainingManifestSchema.parse(m)).not.toThrow();
    expect(m.baseModelIpId).toBe("ip-base-model");
    expect(m.methodologyHash).toBe(HASH_METHOD);
  });
});

// ── Hash determinism + recursive lineage ───────────────────────────────

describe("computeTrainingManifestHash", () => {
  it("returns a 0x-prefixed 64-hex digest", () => {
    const m = makeManifest([{ datasetIpId: "ip-ds-001", weightBps: 10000 }]);
    expect(m.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("two identical manifests yield identical hashes", () => {
    const m1 = makeManifest([
      { datasetIpId: "ip-ds-001", weightBps: 6000 },
      { datasetIpId: "ip-ds-002", weightBps: 4000 },
    ]);
    const m2 = makeManifest([
      { datasetIpId: "ip-ds-001", weightBps: 6000 },
      { datasetIpId: "ip-ds-002", weightBps: 4000 },
    ]);
    expect(m1.manifestHash).toBe(m2.manifestHash);
  });

  it("different weights yield different hashes (same datasets)", () => {
    const m1 = makeManifest([
      { datasetIpId: "ip-ds-001", weightBps: 6000 },
      { datasetIpId: "ip-ds-002", weightBps: 4000 },
    ]);
    const m2 = makeManifest([
      { datasetIpId: "ip-ds-001", weightBps: 5000 },
      { datasetIpId: "ip-ds-002", weightBps: 5000 },
    ]);
    expect(m1.manifestHash).not.toBe(m2.manifestHash);
  });

  it("different baseModelIpId values yield different hashes", () => {
    const datasets = [{ datasetIpId: "ip-ds-001", weightBps: 10000 }];
    const a = makeManifest(datasets, { baseModelIpId: "ip-base-A" });
    const b = makeManifest(datasets, { baseModelIpId: "ip-base-B" });
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  it("manifest WITH baseModelIpId vs WITHOUT yields different hashes", () => {
    const datasets = [{ datasetIpId: "ip-ds-001", weightBps: 10000 }];
    const without = makeManifest(datasets);
    const withBase = makeManifest(datasets, { baseModelIpId: "ip-base-A" });
    expect(without.manifestHash).not.toBe(withBase.manifestHash);
  });

  it("trainedAt does NOT affect hash (audit metadata only)", () => {
    const datasets = [{ datasetIpId: "ip-ds-001", weightBps: 10000 }];
    const a = computeTrainingManifestHash({
      modelIpId: "ip-model-001",
      datasets,
      trainedAt: "2026-01-01T00:00:00Z",
    });
    const b = computeTrainingManifestHash({
      modelIpId: "ip-model-001",
      datasets,
      trainedAt: "2026-12-31T23:59:59Z",
    });
    expect(a).toBe(b);
  });
});

// ── assertTrainingManifestIsWellFormed ──────────────────────────────────

describe("assertTrainingManifestIsWellFormed", () => {
  it("does not throw on weights summing to 10000", () => {
    expect(() =>
      assertTrainingManifestIsWellFormed({
        datasets: [
          { datasetIpId: "ip-ds-001", weightBps: 7000 },
          { datasetIpId: "ip-ds-002", weightBps: 3000 },
        ],
      }),
    ).not.toThrow();
  });

  it("throws when weights sum to less than 10000", () => {
    expect(() =>
      assertTrainingManifestIsWellFormed({
        datasets: [{ datasetIpId: "ip-ds-001", weightBps: 5000 }],
      }),
    ).toThrow(/sum to 10000/);
  });

  it("throws when weights sum to more than 10000", () => {
    expect(() =>
      assertTrainingManifestIsWellFormed({
        datasets: [
          { datasetIpId: "ip-ds-001", weightBps: 7000 },
          { datasetIpId: "ip-ds-002", weightBps: 4000 },
        ],
      }),
    ).toThrow(/sum to 10000/);
  });
});

/**
 * TrainingManifest — N:1 link from a ModelNFT to the DatasetNFTs that fed its
 * training run, with weights for revenue distribution.
 *
 * Wave 3c keystone: when `LicensingEngine.getRoyaltyDistributionRich` walks a
 * `CompositionManifest` and encounters an entry with role="model-author", it
 * recursively distributes the model author's bps share across the model's
 * DatasetNFT contributors, weighted by `weightBps`.
 *
 * The manifest may also reference a `baseModelIpId` to record fine-tuning
 * lineage — when present, the engine recursively descends one more level (up
 * to a depth cap) and gives the base model's contributors their own share.
 *
 * Hashing: manifestHash is sha256 over canonical {modelIpId, datasets,
 * baseModelIpId?, methodologyHash?}. Excluded: trainedAt + manifestHash itself.
 *
 * Per scout-provenance-charlie research (DROID + Octo + OXE patterns), this
 * weight-by-bps encoding is the lowest-friction way to express dataset
 * provenance: the model author publishes the manifest once, and every job
 * using the model recursively pays the data contributors at their published
 * rates (NOT renegotiated per job). Pilots — humans who supplied teleop data —
 * appear as `dataset-contributor` entries in the resolved CompositionManifest
 * downstream of this manifest.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalize } from "../util/canonical.js";

// ── TrainingDatasetEntry ──────────────────────────────────────────────

/**
 * One dataset that contributed to a model's training run.
 *
 * @property datasetIpId      Story IP Asset for the DatasetNFT.
 * @property weightBps        Dataset's share of training mix in basis points.
 *                            Sum across all datasets in a manifest must equal
 *                            10000.
 * @property dataPointCount   Optional — number of data points contributed.
 *                            NOT load-bearing for payout (weightBps is the
 *                            source of truth); useful for audit display.
 */
export const TrainingDatasetEntrySchema = z.object({
  datasetIpId: z.string().min(1),
  weightBps: z.number().int().min(0).max(10000),
  dataPointCount: z.number().int().min(0).optional(),
});
export type TrainingDatasetEntry = z.infer<typeof TrainingDatasetEntrySchema>;

// ── TrainingManifest ───────────────────────────────────────────────────

/**
 * @property modelIpId            ModelNFT this manifest is anchored to.
 * @property datasets             Ordered datasets, weights summing to 10000 bps.
 * @property baseModelIpId        If this model was fine-tuned, the parent
 *                                ModelNFT. The engine recursively distributes
 *                                that parent's share through ITS training
 *                                manifest (capped at depth 5).
 * @property methodologyHash      Optional reproducibility hash (training script,
 *                                hyperparams, etc.). Not load-bearing for payout.
 * @property trainedAt            ISO 8601 — when training completed.
 * @property manifestHash         sha256 of canonical {modelIpId, datasets,
 *                                baseModelIpId?, methodologyHash?}.
 */
export const TrainingManifestSchema = z
  .object({
    modelIpId: z.string().min(1),
    datasets: z.array(TrainingDatasetEntrySchema).min(1),
    baseModelIpId: z.string().optional(),
    methodologyHash: z.string().regex(/^0x[a-f0-9]{64}$/i).optional(),
    trainedAt: z.string(),
    manifestHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  })
  .refine(
    (m) => m.datasets.reduce((s, d) => s + d.weightBps, 0) === 10000,
    {
      message: "TrainingManifest: dataset weightBps must sum to exactly 10000",
      path: ["datasets"],
    },
  );
export type TrainingManifest = z.infer<typeof TrainingManifestSchema>;

// ── Hashing ────────────────────────────────────────────────────────────

/**
 * Compute the canonical manifestHash for a TrainingManifest. Excludes
 * `trainedAt` and the `manifestHash` field itself; only the structural
 * body (modelIpId, datasets, optional baseModelIpId/methodologyHash)
 * participates in the hash.
 */
export function computeTrainingManifestHash(
  manifest: Omit<TrainingManifest, "manifestHash"> | TrainingManifest,
): `0x${string}` {
  // Build payload with optional fields conditionally so canonical form is
  // identical for manifests that omit baseModelIpId vs. set it to undefined.
  const payload: Record<string, unknown> = {
    modelIpId: manifest.modelIpId,
    datasets: manifest.datasets,
  };
  if (manifest.baseModelIpId !== undefined) {
    payload.baseModelIpId = manifest.baseModelIpId;
  }
  if (manifest.methodologyHash !== undefined) {
    payload.methodologyHash = manifest.methodologyHash;
  }
  const canonical = canonicalize(payload);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Validate the dataset weightBps sum invariant. Throws on violation.
 * Provided as an explicit check so callers can validate independently of
 * Zod parsing (e.g., when constructing manifests programmatically).
 */
export function assertTrainingManifestIsWellFormed(
  manifest: Pick<TrainingManifest, "datasets">,
): void {
  const sum = manifest.datasets.reduce((s, d) => s + d.weightBps, 0);
  if (sum !== 10000) {
    throw new Error(
      `TrainingManifest weightBps must sum to 10000, got ${sum}`,
    );
  }
}

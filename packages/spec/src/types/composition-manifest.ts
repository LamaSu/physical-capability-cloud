/**
 * CompositionManifest — off-chain entity that anchors a capability/job to its
 * contributor cohort + their published rate schedules.
 *
 * Wave 3c keystone: this is the type the `LicensingEngine.getRoyaltyDistributionRich`
 * walks at settlement time to produce a `Payout[]` for `MilestoneEscrow.setPayoutMap`.
 *
 * Hashing: manifestHash is sha256 over canonical {capabilityIpId, entries}. The
 * publishedAt / builtAt fields are intentionally excluded — manifests are equivalent
 * iff they declare the same contributor cohort against the same capability.
 *
 * This manifest does NOT include the rate schedules themselves — only their content
 * hashes (rateScheduleHash). The full schedules are fetched separately from the
 * LicensingEngine registry by hash. This keeps manifests small + lets a single
 * schedule reference be shared across many manifests.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalize } from "../util/canonical.js";

// We must not introduce a circular dependency on story.ts — instead we narrow
// to the minimum set of role strings the on-chain Payout map cares about. The
// canonical 10-role enum lives in story.ts (ContributorRoleSchema). Mirror it
// here as a Zod schema for runtime validation; consumers can cross-reference.
//
// IMPORTANT: keep this list in sync with story.ts ContributorRole. ADR-12 §2.1.
export const CompositionRoleSchema = z.enum([
  "operator",
  "verifier",
  "insurer",
  "integrator",
  "protocol-author",
  "model-author",
  "dataset-contributor",
  "pilot",
  "curator",
  "assembler",
  "network-treasury",
  // ADR-PLR-1 (2026-05-25): PyLabRobot backend authors. Earns when a PCC
  // job runs through a registered PLR backend module. The aggregator
  // appends one CompositionEntry per author resolved off-chain from the
  // PLRBackendRegistry manifest. See packages/spec/src/types/plr-backend-registry.ts.
  "backend-author",
] as const);
export type CompositionRole = z.infer<typeof CompositionRoleSchema>;

// ── CompositionEntry ──────────────────────────────────────────────────

/**
 * One contributor in the composition. The on-chain Payout struct gets one
 * row per entry that resolves to non-zero bps (the LicensingEngine layer
 * decides whether each entry produces a payout via its rateScheduleHash
 * lookup).
 *
 * @property ipId                  Story IP Asset ID this contributor holds (CSD,
 *                                 Model, Dataset, Adapter, etc.). Used as the
 *                                 ipId field of the on-chain Payout.
 * @property role                  Canonical role string from ContributorRole enum.
 * @property contributorAddress    EVM address that receives the payout.
 * @property rateScheduleHash      Content hash of the schedule the engine
 *                                 evaluates at settlement time. The schedule
 *                                 itself lives in the engine's registry, not
 *                                 here.
 * @property groupBps              Optional weight (0..10000) for splitting a
 *                                 single role's allocation across co-authors.
 *                                 If absent, equal-split among same-(role, ipId).
 */
export const CompositionEntrySchema = z.object({
  ipId: z.string().min(1),
  role: CompositionRoleSchema,
  contributorAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  rateScheduleHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  groupBps: z.number().int().min(0).max(10000).optional(),
});
export type CompositionEntry = z.infer<typeof CompositionEntrySchema>;

// ── CompositionManifest ────────────────────────────────────────────────

/**
 * The full composition for a capability execution.
 *
 * @property capabilityIpId   Story IP Asset for the capability/CSD this manifest
 *                            is anchored to. The manifest is reusable across
 *                            many milestones of the same capability.
 * @property entries          Ordered list of contributors. Order matters:
 *                            buildPayoutMap emits Payouts in this order, and
 *                            the order is part of the manifestHash.
 * @property builtAt          ISO 8601 — when the orchestrator assembled this
 *                            manifest (for audit display only).
 * @property manifestHash     sha256 of canonical {capabilityIpId, entries}.
 *                            On-chain audit anchor (event field on splitPayout).
 */
export const CompositionManifestSchema = z.object({
  capabilityIpId: z.string().min(1),
  entries: z.array(CompositionEntrySchema),
  builtAt: z.string(),
  manifestHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
});
export type CompositionManifest = z.infer<typeof CompositionManifestSchema>;

// ── Hashing ────────────────────────────────────────────────────────────

/**
 * Compute the canonical manifestHash for a CompositionManifest. Excludes
 * `builtAt` and the `manifestHash` field itself; only the structural body
 * (capability + entries) participates.
 */
export function computeManifestHash(
  manifest: Omit<CompositionManifest, "manifestHash"> | CompositionManifest,
): `0x${string}` {
  const payload = {
    capabilityIpId: manifest.capabilityIpId,
    entries: manifest.entries,
  };
  const canonical = canonicalize(payload);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

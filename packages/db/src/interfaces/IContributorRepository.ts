/**
 * IContributorRepository — persistence contract for contributor economics.
 *
 * Surfaces four entity families:
 *   1. ContributorProfile  (one wallet × role × schedule binding)
 *   2. RateSchedule        (sealed, content-addressed payout curve)
 *   3. TrainingManifest    (model IP → dataset IP weight map)
 *   4. CompositionManifest (per-milestone payout routing intent)
 *
 * Records use plain primitive types (string/number/null) so the repository
 * remains usable from gateway code that doesn't import drizzle-orm directly.
 * Internally the implementation maps these to drizzle row shapes; the
 * `*Insert` and `*Row` types from the schema module are equivalent and may be
 * used interchangeably by callers that prefer drizzle-inferred shapes.
 */

import type {
  contributorProfiles,
  rateSchedules,
  trainingManifests,
  compositionManifests,
} from "../schema/index.js";

// ── Drizzle-inferred row / insert types (re-exported for callers) ────────────

export type ContributorProfileRow = typeof contributorProfiles.$inferSelect;
export type ContributorProfileInsert = typeof contributorProfiles.$inferInsert;
export type RateScheduleRow = typeof rateSchedules.$inferSelect;
export type RateScheduleInsert = typeof rateSchedules.$inferInsert;
export type TrainingManifestRow = typeof trainingManifests.$inferSelect;
export type TrainingManifestInsert = typeof trainingManifests.$inferInsert;
export type CompositionManifestRow = typeof compositionManifests.$inferSelect;
export type CompositionManifestInsert = typeof compositionManifests.$inferInsert;

// ── Repository-facing record types ───────────────────────────────────────────

/**
 * Plain record shape for a ContributorProfile. Mirrors ContributorProfileRow
 * but is written here so callers in @pcc/spec / @pcc/gateway can depend on
 * the interface without importing drizzle-orm.
 */
export interface ContributorProfileRecord {
  id: string;
  address: string;
  role: string;
  scheduleHash: string;
  ipId: string | null;
  contributorNftTokenId: string | null;
  metadataUri: string | null;
  registeredAt: string;
}

export interface RateScheduleRecord {
  scheduleHash: string;
  version: number;
  /**
   * Canonical JSON of `RateSegment[]`. The repository serialises the segments
   * deterministically (sorted keys, no whitespace) so the same RateSchedule
   * always lands in the same string. Repository read methods parse this back
   * into a JS array via JSON.parse.
   */
  segmentsJson: string;
  notes: string | null;
  publishedBy: string;
  publishedAt: string;
}

export interface TrainingManifestRecord {
  modelIpId: string;
  baseModelIpId: string | null;
  /** Canonical JSON of TrainingDatasetEntry[] (weights sum to 10000 bps). */
  datasetWeightsJson: string;
  methodologyHash: string | null;
  manifestHash: string;
  createdAt: string;
}

export interface CompositionManifestRecord {
  id: string;
  capabilityIpId: string;
  escrowAddress: string;
  milestoneIndex: number;
  /** Canonical JSON of CompositionEntry[]. */
  manifestJson: string;
  manifestHash: string;
  operatorResidualBps: number;
  createdAt: string;
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface IContributorRepository {
  // ── Profiles ──────────────────────────────────────────────────────────────

  /**
   * Insert or replace a contributor profile. Idempotent on `id` —
   * re-upserting with the same id replaces all non-key fields.
   */
  upsertProfile(profile: ContributorProfileRecord): void;

  /** Fetch a profile by composite id. Returns null when absent. */
  getProfile(id: string): ContributorProfileRecord | null;

  /** All profiles for a wallet, across all roles. */
  listProfilesByAddress(address: string): ContributorProfileRecord[];

  /** All profiles bound to a given role (e.g., "model-author"). */
  listProfilesByRole(role: string): ContributorProfileRecord[];

  // ── Rate schedules ────────────────────────────────────────────────────────

  /**
   * Publish a rate schedule. Idempotent: if a schedule with the same
   * `scheduleHash` already exists, the call is a no-op (sealed-and-published
   * semantics — schedules are immutable once their content hash exists).
   */
  publishSchedule(record: RateScheduleRecord): void;

  /** Returns the schedule keyed by hash, or null when absent. */
  getSchedule(scheduleHash: string): RateScheduleRecord | null;

  /** Cheap existence check — used by gates that just need a yes/no. */
  scheduleExists(scheduleHash: string): boolean;

  /** All schedules published by an address, newest first. */
  listSchedulesByPublisher(address: string): RateScheduleRecord[];

  // ── Training manifests ────────────────────────────────────────────────────

  /**
   * Set (insert-or-replace) the training manifest for a model IP. Upsert
   * semantics — re-publishing replaces the prior manifest's body. The
   * `modelIpId` is the natural primary key.
   */
  setTrainingManifest(record: TrainingManifestRecord): void;

  /** Returns the manifest for a model IP, or null when absent. */
  getTrainingManifest(modelIpId: string): TrainingManifestRecord | null;

  // ── Composition manifests ────────────────────────────────────────────────

  /**
   * Persist a CompositionManifest. Returns the assigned id (always equal to
   * the `id` field of the input record — provided by the caller, not the
   * repository, so escrow addresses + milestone indices remain naturally
   * keyable).
   */
  saveCompositionManifest(record: CompositionManifestRecord): string;

  /** Fetch a composition manifest by id. Returns null when absent. */
  getCompositionManifest(id: string): CompositionManifestRecord | null;

  /**
   * Lookup the latest manifest bound to (escrowAddress, milestoneIndex).
   * Returns null when no manifest has been recorded for that pair.
   */
  getByEscrowAndMilestone(
    escrowAddress: string,
    milestoneIndex: number,
  ): CompositionManifestRecord | null;
}

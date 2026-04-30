import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Contributor identity bound to one role. Mirrors ContributorNFT on-chain.
 *
 * A wallet can hold many ContributorProfile rows — one per (role, scheduleHash)
 * pair — because the on-chain protocol allows distinct schedules per role.
 *
 * The `id` is the composite primary key serialized as
 * `${address}:${role}:${contributorNftTokenId ?? scheduleHash}` so callers can
 * round-trip a stable identifier without needing a separate uuid table.
 */
export const contributorProfiles = sqliteTable("contributor_profiles", {
  /** Composite primary key: address + role + (tokenId or scheduleHash) */
  id: text("id").primaryKey(),
  /** Wallet address of the contributor (lowercase 0x form) */
  address: text("address").notNull(),
  /** ContributorRole enum value: integrator | protocol-author | model-author | dataset-contributor | operator | verifier | insurer | curator | assembler | network-treasury | designer */
  role: text("role").notNull(),
  /** sha256 of canonical JSON schedule — references rateSchedules.scheduleHash */
  scheduleHash: text("schedule_hash").notNull(),
  /** Story Protocol IP Asset ID (nullable — not all contributors have an IP yet) */
  ipId: text("ip_id"),
  /** ContributorNFT token ID (nullable — set after on-chain mint) */
  contributorNftTokenId: text("contributor_nft_token_id"),
  /** Optional metadata URI (ipfs:// or https://) */
  metadataUri: text("metadata_uri"),
  /** ISO 8601 timestamp */
  registeredAt: text("registered_at").notNull(),
});

/**
 * A published rate schedule, content-addressed by scheduleHash.
 *
 * Schedules are sealed at publish time. Once a (scheduleHash) row exists it is
 * immutable; bumping the schedule means publishing a new row under a new hash
 * and pointing future ContributorProfile rows at it.
 */
export const rateSchedules = sqliteTable("rate_schedules", {
  /** sha256 of canonical JSON over {version, segments} as 0x-prefixed 64-hex */
  scheduleHash: text("schedule_hash").primaryKey(),
  /** Schedule version (uint, 1-based) */
  version: integer("version").notNull(),
  /** Canonical JSON of segments[] — parsed back into RateSchedule type by repository */
  segmentsJson: text("segments_json").notNull(),
  /** Optional author rationale string */
  notes: text("notes"),
  /** Address that published it (off-chain record; on-chain is the registry) */
  publishedBy: text("published_by").notNull(),
  /** ISO 8601 timestamp */
  publishedAt: text("published_at").notNull(),
});

/**
 * Training manifest: model IP linked to N dataset IPs with weight basis points.
 *
 * Wave 3c: the LicensingEngine recursively descends through this table when
 * resolving payouts for a `model-author` entry in a CompositionManifest.
 */
export const trainingManifests = sqliteTable("training_manifests", {
  /** Model's Story IP Asset ID — primary key (one manifest per model) */
  modelIpId: text("model_ip_id").primaryKey(),
  /** Optional base model that this was fine-tuned from */
  baseModelIpId: text("base_model_ip_id"),
  /** Canonical JSON of TrainingDatasetEntry[] — weights must sum to 10000 bps */
  datasetWeightsJson: text("dataset_weights_json").notNull(),
  /** Optional reproducibility hash (training script, hyperparams) */
  methodologyHash: text("methodology_hash"),
  /** sha256 of canonical-JSON commitment for audit trail */
  manifestHash: text("manifest_hash").notNull(),
  /** ISO 8601 timestamp */
  createdAt: text("created_at").notNull(),
});

/**
 * Composition manifest: the per-milestone payout routing intent.
 * Materialized when an escrow milestone is funded with a payout map.
 *
 * The same on-chain (escrowAddress, milestoneIndex) maps to at most one
 * composition manifest — enforced by composite uniqueness via index.
 */
export const compositionManifests = sqliteTable("composition_manifests", {
  /** Unique ID (uuid) */
  id: text("id").primaryKey(),
  /** Story IP Asset for the capability/CSD this manifest is anchored to */
  capabilityIpId: text("capability_ip_id").notNull(),
  /** Escrow contract address (on-chain, lowercase 0x form) */
  escrowAddress: text("escrow_address").notNull(),
  /** Milestone index in the escrow (0-based) */
  milestoneIndex: integer("milestone_index").notNull(),
  /** Canonical JSON of the ordered list of CompositionEntry */
  manifestJson: text("manifest_json").notNull(),
  /** sha256 over canonicalized {capabilityIpId, entries} */
  manifestHash: text("manifest_hash").notNull(),
  /** Operator residual bps after summing all contributor bps (10000 - sum) */
  operatorResidualBps: integer("operator_residual_bps").notNull(),
  /** ISO 8601 timestamp */
  createdAt: text("created_at").notNull(),
});

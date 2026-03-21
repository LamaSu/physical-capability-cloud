import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Story Protocol IP registrations.
 * Each row = one CSD (or job evidence bundle) registered as a Story IP Asset.
 */
export const storyIpRegistrations = sqliteTable("story_ip_registrations", {
  /** Story IP Account address — the canonical IP Asset identifier */
  ipId: text("ip_id").primaryKey(),
  /** Token ID of the underlying NFT that backs the IP Asset */
  nftTokenId: text("nft_token_id").notNull(),
  /** PIL license terms ID attached to this IP Asset */
  licenseTermsId: text("license_terms_id").notNull(),
  /** On-chain transaction hash of the registration */
  txHash: text("tx_hash").notNull(),
  /** PCC capability ID (nullable — future: job IPs may not have a capability) */
  capabilityId: text("capability_id"),
  /** CSD URI: pcc://capabilities/<id> or ipfs://<cid> */
  csdUrl: text("csd_url"),
  /** story | story-aeneid */
  chain: text("chain").notNull().default("story-aeneid"),
  /** ISO 8601 timestamp */
  registeredAt: text("registered_at").notNull(),
});

/**
 * Derivative links between IP Assets.
 * Created when a completed job's evidence is registered as a derivative of the CSD IP.
 */
export const storyDerivativeLinks = sqliteTable("story_derivative_links", {
  id: text("id").primaryKey(),
  /** Parent IP Asset address (the CSD) */
  parentIpId: text("parent_ip_id").notNull(),
  /** Child IP Asset address (the job evidence bundle) */
  childIpId: text("child_ip_id").notNull(),
  /** Story license token used to authorise the derivative */
  licenseTokenId: text("license_token_id").notNull(),
  /** PCC job ID that produced the child IP */
  jobId: text("job_id"),
  /** SHA-256 of the evidence bundle */
  evidenceBundleHash: text("evidence_bundle_hash"),
  /** On-chain transaction hash */
  txHash: text("tx_hash").notNull(),
  /** ISO 8601 timestamp */
  linkedAt: text("linked_at").notNull(),
});

/**
 * Royalty token splits for an IP Asset.
 * 100 total tokens per IP; each row = one holder's share.
 */
export const storyRoyaltySplits = sqliteTable("story_royalty_splits", {
  id: text("id").primaryKey(),
  /** Story IP Asset address */
  ipId: text("ip_id").notNull(),
  /** Recipient wallet address */
  address: text("address").notNull(),
  /** designer | operator | verifier | assembler | curator */
  role: text("role").notNull(),
  /** Integer 1-100; all splits for the same ipId should sum to 100 */
  percentage: integer("percentage").notNull(),
  /** Human-readable label, e.g. "CSD Author" */
  label: text("label").notNull(),
});

/**
 * Revenue claim history for Story IP Vaults.
 * Each row = one claim transaction.
 */
export const storyRevenueClaims = sqliteTable("story_revenue_claims", {
  id: text("id").primaryKey(),
  /** Story IP Asset address whose vault was claimed from */
  ipId: text("ip_id").notNull(),
  /** Address that triggered the claim */
  claimerAddress: text("claimer_address").notNull(),
  /** Amount claimed (as string for bigint safety, in WIP/USDC units) */
  amount: text("amount").notNull(),
  /** On-chain transaction hash */
  txHash: text("tx_hash").notNull(),
  /** ISO 8601 timestamp */
  claimedAt: text("claimed_at").notNull(),
});

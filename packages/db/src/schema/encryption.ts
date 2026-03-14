import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { evidenceBundles } from "./evidence.js";

/** Encrypted evidence bundle (AES-256-GCM envelope) */
export const encryptedEvidenceBundles = sqliteTable("encrypted_evidence_bundles", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id),
  bundleHash: text("bundle_hash").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  encryptedAt: text("encrypted_at").notNull(),
  // IPFS archival fields
  ipfsCid: text("ipfs_cid"),
  ipfsMetadataCid: text("ipfs_metadata_cid"),
  filecoinDealId: text("filecoin_deal_id"),
  // Lit Protocol fields
  litCiphertext: text("lit_ciphertext"),
  litDataToEncryptHash: text("lit_data_to_encrypt_hash"),
  litAccessConditions: text("lit_access_conditions", { mode: "json" }).$type<object[]>(),
  litNetwork: text("lit_network"),
});

/** Per-recipient encrypted AES key (ECIES envelope) */
export const keyCapsules = sqliteTable("key_capsules", {
  id: text("id").primaryKey(),
  encryptedBundleId: text("encrypted_bundle_id").notNull().references(() => encryptedEvidenceBundles.id),
  recipientAddress: text("recipient_address").notNull(),
  encryptedKey: text("encrypted_key").notNull(),
  ephemeralPublicKey: text("ephemeral_public_key").notNull(),
  accessLevel: text("access_level").notNull(), // "full" | "selective" | "summary_only"
});

/** Access grant for evidence data */
export const accessGrants = sqliteTable("access_grants", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => evidenceBundles.id),
  grantedBy: text("granted_by").notNull(),
  grantedTo: text("granted_to").notNull(),
  capsuleId: text("capsule_id").notNull().references(() => keyCapsules.id),
  grantedAt: text("granted_at").notNull(),
  expiresAt: text("expires_at"),
  revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
});

/** On-chain commitment (Poseidon/SHA-256 hash of evidence) */
export const evidenceCommitments = sqliteTable("evidence_commitments", {
  id: text("id").primaryKey(),
  bundleHash: text("bundle_hash").notNull(),
  commitmentHash: text("commitment_hash").notNull(),
  merkleRoot: text("merkle_root"),
  merkleIndex: integer("merkle_index"),
  commitmentTimestamp: text("commitment_timestamp").notNull(),
  onChainTxHash: text("on_chain_tx_hash"),
});

/** ZK proof for dispute settlement */
export const zkProofs = sqliteTable("zk_proofs", {
  id: text("id").primaryKey(),
  proofType: text("proof_type").notNull(), // "evidence_inclusion" | "tier_compliance" | "data_integrity" | "selective_disclosure"
  commitmentId: text("commitment_id").notNull().references(() => evidenceCommitments.id),
  publicInputs: text("public_inputs", { mode: "json" }).notNull().$type<string[]>(),
  proof: text("proof").notNull(),
  verificationKey: text("verification_key").notNull(),
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  generatedAt: text("generated_at").notNull(),
});

/** Merkle tree for batching commitments */
export const commitmentTrees = sqliteTable("commitment_trees", {
  id: text("id").primaryKey(),
  root: text("root").notNull(),
  depth: integer("depth").notNull(),
  leafCount: integer("leaf_count").notNull(),
  leaves: text("leaves", { mode: "json" }).notNull().$type<string[]>(),
  createdAt: text("created_at").notNull(),
});

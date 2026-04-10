import type {
  encryptedEvidenceBundles,
  keyCapsules,
  accessGrants,
  evidenceCommitments,
  zkProofs,
  commitmentTrees,
} from "../schema/index.js";

export type EncryptedBundleRow = typeof encryptedEvidenceBundles.$inferSelect;
export type EncryptedBundleInsert = typeof encryptedEvidenceBundles.$inferInsert;
export type KeyCapsuleRow = typeof keyCapsules.$inferSelect;
export type KeyCapsuleInsert = typeof keyCapsules.$inferInsert;
export type AccessGrantRow = typeof accessGrants.$inferSelect;
export type AccessGrantInsert = typeof accessGrants.$inferInsert;
export type EvidenceCommitmentRow = typeof evidenceCommitments.$inferSelect;
export type EvidenceCommitmentInsert = typeof evidenceCommitments.$inferInsert;
export type ZkProofRow = typeof zkProofs.$inferSelect;
export type ZkProofInsert = typeof zkProofs.$inferInsert;
export type CommitmentTreeRow = typeof commitmentTrees.$inferSelect;
export type CommitmentTreeInsert = typeof commitmentTrees.$inferInsert;

export interface IEncryptionRepository {
  // Encrypted Bundles
  findEncryptedByBundleId(bundleId: string): EncryptedBundleRow | undefined;
  insertEncryptedBundle(bundle: EncryptedBundleInsert): EncryptedBundleRow | undefined;
  updateEncryptedBundle(id: string, data: Partial<EncryptedBundleInsert>): EncryptedBundleRow | undefined;
  // Key Capsules
  insertCapsule(capsule: KeyCapsuleInsert): KeyCapsuleRow | undefined;
  findCapsulesForBundle(encBundleId: string): KeyCapsuleRow[];
  // Access Grants
  insertGrant(grant: AccessGrantInsert): AccessGrantRow | undefined;
  findGrantsByAddress(address: string): AccessGrantRow[];
  revokeGrant(id: string): AccessGrantRow | undefined;
  // Commitments
  findCommitmentByBundleHash(hash: string): EvidenceCommitmentRow | undefined;
  insertCommitment(commitment: EvidenceCommitmentInsert): EvidenceCommitmentRow | undefined;
  updateCommitment(id: string, data: Partial<EvidenceCommitmentInsert>): EvidenceCommitmentRow | undefined;
  // ZK Proofs
  findProofById(id: string): ZkProofRow | undefined;
  insertProof(proof: ZkProofInsert): ZkProofRow | undefined;
  updateProofVerified(id: string, verified: boolean): ZkProofRow | undefined;
  // Commitment Trees
  findTreeById(id: string): CommitmentTreeRow | undefined;
  insertTree(tree: CommitmentTreeInsert): CommitmentTreeRow | undefined;
}

import { eq } from "drizzle-orm";
import {
  encryptedEvidenceBundles,
  keyCapsules,
  accessGrants,
  evidenceCommitments,
  zkProofs,
  commitmentTrees,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class EncryptionRepository {
  constructor(private db: StoreDB) {}

  // ── Encrypted Bundles ───────────────────────────────────────────

  findEncryptedByBundleId(bundleId: string) {
    return this.db
      .select()
      .from(encryptedEvidenceBundles)
      .where(eq(encryptedEvidenceBundles.bundleId, bundleId))
      .get();
  }

  insertEncryptedBundle(bundle: typeof encryptedEvidenceBundles.$inferInsert) {
    return this.db.insert(encryptedEvidenceBundles).values(bundle).returning().get();
  }

  updateEncryptedBundle(id: string, data: Partial<typeof encryptedEvidenceBundles.$inferInsert>) {
    return this.db
      .update(encryptedEvidenceBundles)
      .set(data)
      .where(eq(encryptedEvidenceBundles.id, id))
      .returning()
      .get();
  }

  // ── Key Capsules ──────────────────────────────────────────────

  insertCapsule(capsule: typeof keyCapsules.$inferInsert) {
    return this.db.insert(keyCapsules).values(capsule).returning().get();
  }

  findCapsulesForBundle(encBundleId: string) {
    return this.db
      .select()
      .from(keyCapsules)
      .where(eq(keyCapsules.encryptedBundleId, encBundleId))
      .all();
  }

  // ── Access Grants ─────────────────────────────────────────────

  insertGrant(grant: typeof accessGrants.$inferInsert) {
    return this.db.insert(accessGrants).values(grant).returning().get();
  }

  findGrantsByAddress(address: string) {
    return this.db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.grantedTo, address))
      .all();
  }

  revokeGrant(id: string) {
    return this.db
      .update(accessGrants)
      .set({ revoked: true })
      .where(eq(accessGrants.id, id))
      .returning()
      .get();
  }

  // ── Commitments ───────────────────────────────────────────────

  findCommitmentByBundleHash(hash: string) {
    return this.db
      .select()
      .from(evidenceCommitments)
      .where(eq(evidenceCommitments.bundleHash, hash))
      .get();
  }

  insertCommitment(commitment: typeof evidenceCommitments.$inferInsert) {
    return this.db.insert(evidenceCommitments).values(commitment).returning().get();
  }

  updateCommitment(id: string, data: Partial<typeof evidenceCommitments.$inferInsert>) {
    return this.db
      .update(evidenceCommitments)
      .set(data)
      .where(eq(evidenceCommitments.id, id))
      .returning()
      .get();
  }

  // ── ZK Proofs ─────────────────────────────────────────────────

  findProofById(id: string) {
    return this.db.select().from(zkProofs).where(eq(zkProofs.id, id)).get();
  }

  insertProof(proof: typeof zkProofs.$inferInsert) {
    return this.db.insert(zkProofs).values(proof).returning().get();
  }

  updateProofVerified(id: string, verified: boolean) {
    return this.db
      .update(zkProofs)
      .set({ verified })
      .where(eq(zkProofs.id, id))
      .returning()
      .get();
  }

  // ── Commitment Trees ──────────────────────────────────────────

  findTreeById(id: string) {
    return this.db.select().from(commitmentTrees).where(eq(commitmentTrees.id, id)).get();
  }

  insertTree(tree: typeof commitmentTrees.$inferInsert) {
    return this.db.insert(commitmentTrees).values(tree).returning().get();
  }
}

import type { StoreDB } from "../connection.js";
import {
  evidenceBundles,
  encryptedEvidenceBundles,
  keyCapsules,
  accessGrants,
  evidenceCommitments,
  zkProofs,
} from "../schema/index.js";

/**
 * Seeds encryption-related data: evidence bundles (parent), encrypted bundles,
 * key capsules, access grants, evidence commitments, and ZK proofs.
 *
 * Data mirrors what was previously hardcoded in gateway evidence-encrypted.ts.
 */
export function seedEncryption(db: StoreDB): void {
  // ── Evidence Bundles (parent records for FK) ──────────────────────

  db.insert(evidenceBundles)
    .values([
      {
        id: "bun_001",
        jobId: "job-001",
        stepId: "step-1",
        kernelId: "kernel-nyc",
        assuranceTier: 2,
        bundleHash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        kernelSignature: {
          signer: "0x1111111111111111111111111111111111111111",
          algorithm: "ECDSA-secp256k1",
          value: "0xmock_sig_bun001",
        },
        createdAt: "2026-03-10T08:30:00Z",
      },
      {
        id: "bun_002",
        jobId: "job-002",
        stepId: "step-2",
        kernelId: "kernel-sf",
        assuranceTier: 3,
        bundleHash: "sha256:f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
        kernelSignature: {
          signer: "0x2222222222222222222222222222222222222222",
          algorithm: "ECDSA-secp256k1",
          value: "0xmock_sig_bun002",
        },
        createdAt: "2026-03-10T07:50:00Z",
      },
    ])
    .run();

  // ── Encrypted Evidence Bundles ────────────────────────────────────

  db.insert(encryptedEvidenceBundles)
    .values([
      {
        id: "enc_001",
        bundleId: "bun_001",
        bundleHash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        ciphertext: "bW9ja19lbmNyeXB0ZWRfZXZpZGVuY2VfYnVuZGxlX2RhdGE=",
        iv: "bW9ja19pdl8xMjM=",
        authTag: "bW9ja19hdXRoX3RhZw==",
        encryptedAt: "2026-03-10T08:30:00Z",
      },
      {
        id: "enc_002",
        bundleId: "bun_002",
        bundleHash: "sha256:f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
        ciphertext: "bW9ja19lbmNyeXB0ZWRfYnVuZGxlXzI=",
        iv: "bW9ja19pdl80NTY=",
        authTag: "bW9ja19hdXRoX3RhZ18y",
        encryptedAt: "2026-03-10T08:10:00Z",
      },
    ])
    .run();

  // ── Key Capsules ──────────────────────────────────────────────────

  db.insert(keyCapsules)
    .values([
      {
        id: "cap_001",
        encryptedBundleId: "enc_001",
        recipientAddress: "0x1234567890abcdef1234567890abcdef12345678",
        encryptedKey: "bW9ja19lbmNyeXB0ZWRfa2V5XzE=",
        ephemeralPublicKey: "bW9ja19lcGhlbWVyYWxfMQ==",
        accessLevel: "full",
      },
      {
        id: "cap_002",
        encryptedBundleId: "enc_001",
        recipientAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
        encryptedKey: "bW9ja19lbmNyeXB0ZWRfa2V5XzI=",
        ephemeralPublicKey: "bW9ja19lcGhlbWVyYWxfMg==",
        accessLevel: "selective",
      },
      {
        id: "cap_003",
        encryptedBundleId: "enc_002",
        recipientAddress: "0x9876543210fedcba9876543210fedcba98765432",
        encryptedKey: "bW9ja19lbmNyeXB0ZWRfa2V5XzM=",
        ephemeralPublicKey: "bW9ja19lcGhlbWVyYWxfMw==",
        accessLevel: "full",
      },
    ])
    .run();

  // ── Access Grants ─────────────────────────────────────────────────

  db.insert(accessGrants)
    .values({
      id: "grant_001",
      bundleId: "bun_001",
      grantedBy: "0x1111111111111111111111111111111111111111",
      grantedTo: "0xabcdef1234567890abcdef1234567890abcdef12",
      capsuleId: "cap_002",
      grantedAt: "2026-03-10T09:00:00Z",
      expiresAt: "2026-04-10T09:00:00Z",
      revoked: false,
    })
    .run();

  // ── Evidence Commitments ──────────────────────────────────────────

  db.insert(evidenceCommitments)
    .values([
      {
        id: "commit_001",
        bundleHash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        commitmentHash: "0xposeidon_commit_a1b2c3d4e5f6",
        merkleRoot: "0xmerkle_root_batch_001",
        merkleIndex: 0,
        commitmentTimestamp: "2026-03-10T08:35:00Z",
        onChainTxHash: "0xtx_commit_001",
      },
      {
        id: "commit_002",
        bundleHash: "sha256:f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
        commitmentHash: "0xposeidon_commit_f6e5d4c3b2a1",
        merkleRoot: "0xmerkle_root_batch_001",
        merkleIndex: 1,
        commitmentTimestamp: "2026-03-10T08:15:00Z",
        onChainTxHash: "0xtx_commit_002",
      },
    ])
    .run();

  // ── ZK Proofs ─────────────────────────────────────────────────────

  db.insert(zkProofs)
    .values({
      id: "zkp_001",
      proofType: "evidence_inclusion",
      commitmentId: "commit_001",
      publicInputs: [
        "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        "0xmerkle_root_batch_001",
        "0",
      ],
      proof: "mock_groth16_proof_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      verificationKey: "mock_vk_evidence_inclusion_v1",
      verified: true,
      generatedAt: "2026-03-10T08:36:00Z",
    })
    .run();
}

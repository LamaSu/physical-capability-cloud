/**
 * Encryption & ZK proof types — cryptographic privacy and verifiable disputes.
 *
 * Evidence bundles are encrypted with AES-256-GCM, with per-recipient key
 * capsules (ECIES envelope). On-chain commitments use Poseidon/SHA-256 hashes.
 * ZK proofs allow dispute resolution without revealing raw data.
 */

import type { Address, Id, SHA256, Timestamp } from "./common.js";

/** Encrypted evidence bundle (AES-256-GCM envelope) */
export interface EncryptedEvidenceBundle {
  id: Id;
  /** Original EvidenceBundle.id */
  bundleId: Id;
  /** Original hash (verifiable without decryption) */
  bundleHash: SHA256;
  /** Base64 AES-256-GCM encrypted bundle JSON */
  ciphertext: string;
  /** Base64 initialization vector */
  iv: string;
  /** Base64 authentication tag */
  authTag: string;
  encryptedAt: Timestamp;
  /** Per-recipient encrypted AES keys */
  capsules: KeyCapsule[];
  /** IPFS content identifier for the encrypted bundle */
  ipfsCid?: string;
  /** IPFS CID for public metadata (no secrets) */
  ipfsMetadataCid?: string;
  /** Future: Filecoin storage deal ID */
  filecoinDealId?: string;

  // ── Lit Protocol fields ──────────────────────────────────────────
  /** Base64-encoded Lit Protocol ciphertext (when using Lit encryption) */
  litCiphertext?: string;
  /** Hash of the data that was encrypted (Lit integrity check) */
  litDataToEncryptHash?: string;
  /** Lit Protocol Unified Access Control Conditions */
  litAccessConditions?: object[];
  /** Lit network used for encryption (e.g. "datil-test", "datil") */
  litNetwork?: string;
}

/** Per-recipient encrypted AES key (ECIES envelope) */
export interface KeyCapsule {
  id: Id;
  recipientAddress: Address;
  /** Base64 ECIES-encrypted AES key */
  encryptedKey: string;
  /** ECIES ephemeral key */
  ephemeralPublicKey: string;
  accessLevel: "full" | "selective" | "summary_only";
}

/** Access grant for evidence data */
export interface AccessGrant {
  id: Id;
  bundleId: Id;
  /** Operator who encrypted */
  grantedBy: Address;
  /** User who can decrypt */
  grantedTo: Address;
  /** KeyCapsule reference */
  capsuleId: Id;
  grantedAt: Timestamp;
  expiresAt?: Timestamp;
  revoked: boolean;
}

/** On-chain commitment (Poseidon/SHA-256 hash of evidence) */
export interface EvidenceCommitment {
  id: Id;
  /** Hash of the original bundle */
  bundleHash: SHA256;
  /** Poseidon hash for ZK circuits (mock: SHA-256) */
  commitmentHash: SHA256;
  /** Merkle root if part of a tree */
  merkleRoot?: SHA256;
  /** Leaf index in tree */
  merkleIndex?: number;
  commitmentTimestamp: Timestamp;
  /** Transaction hash when committed on-chain */
  onChainTxHash?: string;
}

/** ZK proof for dispute settlement */
export interface ZKProof {
  id: Id;
  proofType: "evidence_inclusion" | "tier_compliance" | "data_integrity" | "selective_disclosure";
  /** Which commitment this proves */
  commitmentId: Id;
  /** Public signals */
  publicInputs: string[];
  /** Serialized proof (mock: JSON signature) */
  proof: string;
  /** Verification key (mock: public key) */
  verificationKey: string;
  verified: boolean;
  generatedAt: Timestamp;
}

/** Merkle tree for batching commitments */
export interface CommitmentTree {
  id: Id;
  root: SHA256;
  depth: number;
  leafCount: number;
  /** Ordered leaf hashes */
  leaves: SHA256[];
  createdAt: Timestamp;
}

/** ZK-enhanced dispute */
export interface ZKDispute {
  id: Id;
  /** Links to existing Dispute */
  disputeId: Id;
  /** Challenger's ZK proof */
  challengerProof?: ZKProof;
  /** Operator's counter-proof */
  operatorProof?: ZKProof;
  /** CommitmentTree used */
  commitmentTree: Id;
  status: "proof_requested" | "proof_submitted" | "proof_verified" | "proof_rejected";
}

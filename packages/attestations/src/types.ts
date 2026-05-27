/**
 * Core types for @pcc/attestations.
 * Mirrors EAS Attestation, OffChainAttestation, and Schema structures.
 */

/** A registered EAS schema. UID = keccak256(abi.encode(schema, resolver, revocable)). */
export interface AttestationSchema {
  uid: `0x${string}`;
  /** ABI-encoded field types, e.g. "address bridgeMaintainer,uint8 tier,bytes32 evidenceCID" */
  schema: string;
  /** Resolver contract address (zero address = no resolver) */
  resolver: `0x${string}`;
  /** Whether attestations under this schema can be revoked */
  revocable: boolean;
}

/** An on-chain attestation as returned by EAS.getAttestation(uid). */
export interface Attestation {
  uid: `0x${string}`;
  schema: `0x${string}`;
  /** Reference to a parent attestation (or zero hash if none) */
  refUID: `0x${string}`;
  /** Unix seconds when the attestation was created on-chain */
  time: bigint;
  /** Unix seconds when the attestation expires (0 = no expiry) */
  expirationTime: bigint;
  /** Unix seconds when the attestation was revoked (0 = not revoked) */
  revocationTime: bigint;
  /** Subject of the attestation (zero address = no specific recipient) */
  recipient: `0x${string}`;
  /** Address that signed and submitted the attestation */
  attester: `0x${string}`;
  revocable: boolean;
  /** ABI-encoded payload matching the schema definition */
  data: `0x${string}`;
}

/** An off-chain (signed) attestation. EIP-712 typed signature, free to create. */
export interface OffChainAttestation extends Omit<Attestation, "uid" | "revocationTime" | "attester"> {
  /** Computed from sig + message — deterministic */
  uid: `0x${string}`;
  /** Signer-recovered address (set by verifier; null until verified) */
  attester: `0x${string}`;
  /** EAS off-chain attestation version (current: 2) */
  version: number;
  /** Random 32-byte salt for replay protection in Version 2 */
  salt: `0x${string}`;
  /** EIP-712 typed-data signature */
  signature: {
    r: `0x${string}`;
    s: `0x${string}`;
    v: number;
  };
  /** Domain-separator inputs for verification */
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
}

/** Result returned by OffChainVerifier.verify(). */
export interface VerificationResult {
  valid: boolean;
  attester: `0x${string}` | null;
  /** Reason for failure (set only when valid=false) */
  reason?: string;
}

/** Per-chain EAS deployment record. */
export interface EASDeployment {
  chainId: number;
  chainName: string;
  eas: `0x${string}`;
  schemaRegistry: `0x${string}`;
}

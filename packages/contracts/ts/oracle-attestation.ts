/**
 * OracleAttestation — TypeScript mirror of IPCCOracle.Attestation.
 *
 * Must stay ABI-compatible with the Solidity struct:
 *   {
 *     address escrowAddress;
 *     string  jobId;
 *     bytes32 evidenceHash;
 *     uint8   tier;
 *     bool    verified;
 *     uint256 timestamp;
 *     bytes32 nonce;
 *     bytes   signature;
 *   }
 *
 * Order and names are load-bearing — viem encodes the tuple by position when
 * building calldata for submitAttestation(uint256, Attestation) and
 * release(uint256, Attestation).
 */

import type { Address, Hex } from "viem";

export interface OracleAttestation {
  /** Address of the MilestoneEscrow this attestation is bound to */
  escrowAddress: Address;
  /** Job ID this attestation covers (matches evidence.jobId) */
  jobId: string;
  /** keccak256 of the evidence bundle this attestation covers */
  evidenceHash: Hex;
  /** Assurance tier (0..3) */
  tier: number;
  /** Oracle's pass/fail verdict — must be true for settlement */
  verified: boolean;
  /** Unix timestamp (seconds) when the oracle signed */
  timestamp: bigint;
  /** Per-attestation nonce to prevent replay */
  nonce: Hex;
  /** Oracle signature over the struct (empty bytes for test-only mocks) */
  signature: Hex;
}

/** Build an attestation from individual fields, with bigint coercion. */
export function buildOracleAttestation(input: {
  escrowAddress: Address;
  jobId: string;
  evidenceHash: Hex;
  tier: number;
  verified: boolean;
  timestamp: number | bigint;
  nonce: Hex;
  signature?: Hex;
}): OracleAttestation {
  return {
    escrowAddress: input.escrowAddress,
    jobId: input.jobId,
    evidenceHash: input.evidenceHash,
    tier: input.tier,
    verified: input.verified,
    timestamp: typeof input.timestamp === "bigint"
      ? input.timestamp
      : BigInt(input.timestamp),
    nonce: input.nonce,
    signature: input.signature ?? "0x",
  };
}

/**
 * ABI-ordered tuple for viem `args` encoding.
 * Use as: args: [milestoneIndex, attestationToTuple(att)] when calling
 * submitAttestation or release directly via writeContract.
 */
export function attestationToTuple(att: OracleAttestation): readonly [
  Address,
  string,
  Hex,
  number,
  boolean,
  bigint,
  Hex,
  Hex,
] {
  return [
    att.escrowAddress,
    att.jobId,
    att.evidenceHash,
    att.tier,
    att.verified,
    att.timestamp,
    att.nonce,
    att.signature,
  ] as const;
}

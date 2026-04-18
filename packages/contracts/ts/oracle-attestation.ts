/**
 * OracleAttestation — TypeScript mirror of IPCCOracle.Attestation.
 *
 * Must stay ABI-compatible with the Solidity struct defined in
 * `packages/contracts/src/interfaces/IPCCOracle.sol`. v10 schema:
 *   {
 *     uint8   version;
 *     address escrowAddress;
 *     string  jobId;
 *     bytes32 evidenceHash;
 *     uint8   tier;
 *     bool    verified;
 *     uint256 timestamp;
 *     bytes32 nonce;
 *     bytes   extraData;
 *     bytes   signature;
 *   }
 *
 * Order and names are load-bearing — viem encodes the tuple by position when
 * building calldata for submitAttestation(uint256, Attestation) and
 * release(uint256, Attestation).
 *
 * ── Version semantics ─────────────────────────────────────────────────
 *
 * `version` is the schema tag. v1 = 1 (current). Adapters must produce
 * attestations with `version: 1` and `extraData: "0x"` unless they
 * explicitly know they are targeting a future version.
 *
 * `extraData` is a versioned escape hatch. For v1: MUST be `"0x"` or an
 * ABI-encoded blob the v1 code does not interpret. For v2+: will hold an
 * ABI-encoded extension payload that v2 code decodes.
 *
 * Attackers cannot swap `extraData` or any other field after signing
 * because the field is part of the canonical signing hash:
 *   keccak256(abi.encode(
 *     version, escrowAddress, jobId, evidenceHash,
 *     tier, verified, timestamp, nonce, extraData
 *   ))
 * i.e. every field except `signature`.
 */

import type { Address, Hex } from "viem";
import {
  ATTESTATION_SCHEMA_VERSION,
  ATTESTATION_V1_EMPTY_EXTRA_DATA,
} from "./abi/PCCProtocol.js";

export interface OracleAttestation {
  /** Schema version. Current: 1 (ATTESTATION_SCHEMA_VERSION). */
  version: number;
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
  /** Versioned extension payload. v1 MUST be "0x" or an ABI-encoded blob. */
  extraData: Hex;
  /** Oracle signature over the canonical hash (empty bytes for test-only mocks) */
  signature: Hex;
}

/**
 * Build an attestation from individual fields, with bigint coercion.
 *
 * Defaults `version` to the current schema version and `extraData` to
 * the empty payload — so existing call sites that predate the v10
 * schema bump keep working without changes.
 */
export function buildOracleAttestation(input: {
  escrowAddress: Address;
  jobId: string;
  evidenceHash: Hex;
  tier: number;
  verified: boolean;
  timestamp: number | bigint;
  nonce: Hex;
  signature?: Hex;
  /** Override schema version (rare — only for testing forward compat). */
  version?: number;
  /** Optional extension payload. Default: empty (0x) for v1. */
  extraData?: Hex;
}): OracleAttestation {
  return {
    version: input.version ?? ATTESTATION_SCHEMA_VERSION,
    escrowAddress: input.escrowAddress,
    jobId: input.jobId,
    evidenceHash: input.evidenceHash,
    tier: input.tier,
    verified: input.verified,
    timestamp:
      typeof input.timestamp === "bigint"
        ? input.timestamp
        : BigInt(input.timestamp),
    nonce: input.nonce,
    extraData: input.extraData ?? ATTESTATION_V1_EMPTY_EXTRA_DATA,
    signature: input.signature ?? "0x",
  };
}

/**
 * Runtime schema check: returns true iff the attestation carries the
 * currently supported version. Useful for gating in higher layers
 * before making an RPC call that would revert on-chain.
 */
export function isSupportedAttestationVersion(
  a: Pick<OracleAttestation, "version">,
): boolean {
  return a.version === ATTESTATION_SCHEMA_VERSION;
}

/**
 * ABI-ordered tuple for viem `args` encoding.
 * Use as: args: [milestoneIndex, attestationToTuple(att)] when calling
 * submitAttestation or release directly via writeContract.
 *
 * The tuple order is LOAD-BEARING and matches the Solidity struct field
 * declaration order: version, escrowAddress, jobId, evidenceHash, tier,
 * verified, timestamp, nonce, extraData, signature.
 */
export function attestationToTuple(att: OracleAttestation): readonly [
  number,   // version
  Address,  // escrowAddress
  string,   // jobId
  Hex,      // evidenceHash
  number,   // tier
  boolean,  // verified
  bigint,   // timestamp
  Hex,      // nonce
  Hex,      // extraData
  Hex,      // signature
] {
  return [
    att.version,
    att.escrowAddress,
    att.jobId,
    att.evidenceHash,
    att.tier,
    att.verified,
    att.timestamp,
    att.nonce,
    att.extraData,
    att.signature,
  ] as const;
}

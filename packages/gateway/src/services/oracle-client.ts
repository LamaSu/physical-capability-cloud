/**
 * PCC Oracle Client — calls the proprietary verification oracle
 * before allowing settlement.
 *
 * Configure the oracle endpoint via the PCC_ORACLE_URL env var.
 * When PCC_ORACLE_KEY is not set, falls back to mock verification
 * so dev/test environments work without the oracle running.
 */

import {
  encodeAbiParameters,
  decodeAbiParameters,
  keccak256,
  toBytes,
  type Hex,
} from "viem";

const ORACLE_URL = process.env.PCC_ORACLE_URL ?? "http://localhost:4100";
const ORACLE_KEY = process.env.PCC_ORACLE_KEY ?? "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OracleVerifyRequest {
  escrowAddress: string;
  jobId: string;
  kernelId: string;
  evidenceHash: string;
  assuranceTier: number;
  chainId: number;
}

export interface OracleAttestation {
  /** Schema version. Current: 1. Bumped only during coordinated migration. */
  version: number;
  escrowAddress: string;
  jobId: string;
  evidenceHash: string;
  tier: number;
  verified: boolean;
  timestamp: number;
  nonce: string;
  /** Versioned extension payload. v1 default: "0x" (empty). */
  extraData: string;
  signature: string;
}

export interface OracleResponse {
  result: {
    verified: boolean;
    tier: number;
    reason: string;
    checks: Record<string, boolean>;
  };
  attestation: OracleAttestation | null;
  oracle: string;
  chainId: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a job's evidence with the PCC Verification Oracle.
 *
 * If PCC_ORACLE_KEY is not set, returns a mock verification response
 * so that dev/test environments work without the oracle running.
 */
export async function verifyWithOracle(request: OracleVerifyRequest): Promise<OracleResponse> {
  if (!ORACLE_KEY) {
    console.warn("[oracle] No PCC_ORACLE_KEY set — using mock verification");
    return mockVerification(request);
  }

  // Mock escrow addresses (non-hex) can't be verified on-chain — use mock
  if (!request.escrowAddress.startsWith("0x") || request.escrowAddress.startsWith("mock")) {
    console.warn("[oracle] Non-hex escrow address — using mock verification");
    return mockVerification(request);
  }

  const res = await fetch(`${ORACLE_URL}/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-oracle-key": ORACLE_KEY,
      "User-Agent": "PCC-Gateway/1.0",
    },
    body: JSON.stringify({
      ...request,
      requestedAt: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    throw new Error(`Oracle error: ${res.status} ${await res.text()}`);
  }

  return res.json() as Promise<OracleResponse>;
}

/**
 * Check if the oracle client is configured with a real API key.
 * When false, all verifications fall back to mock.
 */
export function isOracleConfigured(): boolean {
  return ORACLE_KEY.length > 0;
}

// ---------------------------------------------------------------------------
// Mock (dev/test fallback)
// ---------------------------------------------------------------------------

function mockVerification(request: OracleVerifyRequest): OracleResponse {
  return {
    result: {
      verified: true,
      tier: request.assuranceTier,
      reason: "mock_verification",
      checks: {
        evidenceExists: true,
        hashMatches: true,
        tierMet: true,
        notReplay: true,
        identityValid: true,
      },
    },
    attestation: {
      version: 1,
      escrowAddress: request.escrowAddress,
      jobId: request.jobId,
      evidenceHash: request.evidenceHash,
      tier: request.assuranceTier,
      verified: true,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: "0x" + "0".repeat(64),
      extraData: "0x",
      signature: "0x" + "0".repeat(130),
    },
    oracle: "0x0000000000000000000000000000000000000000",
    chainId: request.chainId,
  };
}

// ---------------------------------------------------------------------------
// EAS attestation bridge (V2 path)
// ---------------------------------------------------------------------------
//
// The off-chain half of MilestoneEscrowV2's EAS gate. The authorized oracle
// attests to a `pcc.evidence.v1` schema record; MilestoneEscrowV2.submitAttestation
// later resolves that attestation by UID and re-validates the SAME ABI-encoded
// payload on-chain. These helpers produce/parse that exact payload so the
// gateway and the contract agree byte-for-byte.
//
// Field order is LOAD-BEARING — it must match MilestoneEscrowV2.sol's
//   abi.decode(a.data, (string, bytes32, bytes32, string, uint8, bool, bytes32))
//
// PRODUCTION NOTE: the live oracle mints these attestations with the EAS SDK
// (`@ethereum-attestation-service/eas-sdk` — `SchemaEncoder` + `EAS.attest()`,
// which itself uses `ethers`). The gateway only READS/encodes payloads here, so
// it stays on viem (consistent with escrow-client.ts) and pulls in no ethers at
// runtime. The SDK + ethers are declared as deps for the oracle-minting path.

/**
 * The `pcc.evidence.v1` EAS schema string. Registered out-of-band; its UID is
 * the schema the escrow gates on (PCC_EVIDENCE_SCHEMA_UID env / constructor arg).
 */
export const PCC_EVIDENCE_SCHEMA =
  "string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid, uint8 assuranceTier, bool oracleVerified, bytes32 stepId";

/** viem ABI parameters for the schema above (order matches the Solidity decode). */
const PCC_EVIDENCE_SCHEMA_PARAMS = [
  { name: "jobId", type: "string" },
  { name: "kernelId", type: "bytes32" },
  { name: "evidenceBundleHash", type: "bytes32" },
  { name: "ipfsCid", type: "string" },
  { name: "assuranceTier", type: "uint8" },
  { name: "oracleVerified", type: "bool" },
  { name: "stepId", type: "bytes32" },
] as const;

/** Decoded `pcc.evidence.v1` attestation payload. */
export interface EasEvidencePayload {
  jobId: string;
  kernelId: Hex;
  evidenceBundleHash: Hex;
  ipfsCid: string;
  assuranceTier: number;
  oracleVerified: boolean;
  stepId: Hex;
}

/** ABI-encode a `pcc.evidence.v1` payload (what the oracle attests to). */
export function encodeEasEvidencePayload(p: EasEvidencePayload): Hex {
  return encodeAbiParameters(PCC_EVIDENCE_SCHEMA_PARAMS, [
    p.jobId,
    p.kernelId,
    p.evidenceBundleHash,
    p.ipfsCid,
    p.assuranceTier,
    p.oracleVerified,
    p.stepId,
  ]);
}

/** Decode a `pcc.evidence.v1` payload (the `data` field of an EAS attestation). */
export function decodeEasEvidencePayload(data: Hex): EasEvidencePayload {
  const [jobId, kernelId, evidenceBundleHash, ipfsCid, assuranceTier, oracleVerified, stepId] =
    decodeAbiParameters(PCC_EVIDENCE_SCHEMA_PARAMS, data);
  return {
    jobId,
    kernelId,
    evidenceBundleHash,
    ipfsCid,
    assuranceTier: Number(assuranceTier),
    oracleVerified,
    stepId,
  };
}

/**
 * Convert a "sha256:<hex>" (or "0x<hex>") evidence bundle hash into a bytes32
 * hex. The on-chain milestone stores the bundle hash as bytes32; this maps the
 * gateway's string form onto it. The low 32 bytes are used (padded if short).
 */
export function bundleHashToBytes32(bundleHash: string): Hex {
  let hex = bundleHash.startsWith("sha256:") ? bundleHash.slice(7) : bundleHash;
  if (hex.startsWith("0x")) hex = hex.slice(2);
  hex = hex.slice(0, 64).padStart(64, "0");
  return `0x${hex}` as Hex;
}

/**
 * Derive a bytes32 id from a UTF-8 string, matching the contract's
 * keccak256(bytes(x)). Used for kernelId and stepId, which the escrow binds as
 * keccak256(bytes(stepIdString)) at milestone creation.
 */
export function stringToBytes32Id(value: string): Hex {
  return keccak256(toBytes(value));
}

export interface BuildEasAttestationInput {
  jobId: string;
  kernelId: string;
  stepId: string;
  evidenceBundleHash: string;
  ipfsCid: string;
  assuranceTier: number;
  oracleVerified: boolean;
  /** Escrow address the attestation is bound to (becomes the EAS recipient). */
  recipient?: string;
  /** Pre-registered `pcc.evidence.v1` schema UID, if known. */
  schemaUid?: string;
}

export interface EasAttestationMetadata {
  schema: string;
  schemaUid: string | null;
  recipient: string | null;
  payload: EasEvidencePayload;
  /** ABI-encoded payload — the exact bytes the oracle attests to / the contract decodes. */
  encoded: Hex;
}

/**
 * Build the `pcc.evidence.v1` attestation metadata for a completed job. This is
 * what the gateway hands the oracle to mint an EAS attestation, and mirrors the
 * payload MilestoneEscrowV2.submitAttestation re-validates by UID. kernelId and
 * stepId are hashed to bytes32 exactly as the contract derives them.
 */
export function buildEasAttestationMetadata(input: BuildEasAttestationInput): EasAttestationMetadata {
  const payload: EasEvidencePayload = {
    jobId: input.jobId,
    kernelId: stringToBytes32Id(input.kernelId),
    evidenceBundleHash: bundleHashToBytes32(input.evidenceBundleHash),
    ipfsCid: input.ipfsCid,
    assuranceTier: input.assuranceTier,
    oracleVerified: input.oracleVerified,
    stepId: stringToBytes32Id(input.stepId),
  };

  return {
    schema: PCC_EVIDENCE_SCHEMA,
    schemaUid: input.schemaUid ?? process.env.PCC_EVIDENCE_SCHEMA_UID ?? null,
    recipient: input.recipient ?? null,
    payload,
    encoded: encodeEasEvidencePayload(payload),
  };
}

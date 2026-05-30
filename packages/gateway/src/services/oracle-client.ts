/**
 * PCC Oracle Client — calls the proprietary verification oracle
 * before allowing settlement.
 *
 * The oracle runs on Spark at http://192.168.108.72:4100 by default.
 * When PCC_ORACLE_KEY is not set, falls back to mock verification
 * so dev/test environments work without the oracle running.
 *
 * EAS attestation bridge (implementer-bravo, eas-migration-design §4.1):
 * `attestEvidenceOnChain` makes a REAL on-chain EAS attestation carrying the
 * oracle verdict, returning the attestation UID for MilestoneEscrowV2 to read
 * and validate. Additive — the verifyWithOracle/mock path above is unchanged.
 */

import { EAS, SchemaEncoder, NO_EXPIRATION } from "@ethereum-attestation-service/eas-sdk";
import { ethers } from "ethers";
import { EAS_ADDRESS } from "@pcc/contracts";

const ORACLE_URL = process.env.PCC_ORACLE_URL ?? "http://192.168.108.72:4100";
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
  escrowAddress: string;
  jobId: string;
  evidenceHash: string;
  tier: number;
  verified: boolean;
  timestamp: number;
  nonce: string;
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
      escrowAddress: request.escrowAddress,
      jobId: request.jobId,
      evidenceHash: request.evidenceHash,
      tier: request.assuranceTier,
      verified: true,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: "0x" + "0".repeat(64),
      signature: "0x" + "0".repeat(130),
    },
    oracle: "0x0000000000000000000000000000000000000000",
    chainId: request.chainId,
  };
}

// ---------------------------------------------------------------------------
// On-chain EAS attestation producer (eas-migration-design §4.1)
// ---------------------------------------------------------------------------

/**
 * The `pcc.evidence.v1` EAS schema string. MUST match, byte-for-byte, the
 * schema registered on-chain at G1 and decoded in MilestoneEscrowV2.sol §3.3.
 * Any drift here poisons every downstream `submitAttestation` check.
 */
export const PCC_EVIDENCE_SCHEMA_STRING =
  "string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid, uint8 assuranceTier, bool oracleVerified";

export interface AttestEvidenceInput {
  /** PCC job id (matches the escrow's milestone jobIdHash lineage). */
  jobId: string;
  /** keccak256/bytes32 of the shop-kernel id. */
  kernelId: `0x${string}`;
  /** sha256/keccak of the evidence bundle (must equal the on-chain m.evidenceBundleHash). */
  evidenceBundleHash: `0x${string}`;
  /** Storacha/IPFS CID (may be empty in mock). */
  ipfsCid: string;
  /** 0-3 tier actually achieved (must be >= milestone requiredTier). */
  assuranceTier: number;
  /** Attestation recipient (the operator/payee address). */
  recipient: `0x${string}`;
}

/**
 * Make a REAL on-chain EAS attestation carrying the oracle verdict, and return
 * its UID. The gateway signer (== the oracle, == MilestoneEscrowV2.authorizedOracle)
 * pays gas and attests. MilestoneEscrowV2.submitAttestation(milestoneIndex, uid)
 * then reads `IEAS.getAttestation(uid)` and validates provenance + payload.
 *
 * Requires env: PCC_RPC_URL, PCC_GATEWAY_PRIVATE_KEY, PCC_EVIDENCE_SCHEMA_UID.
 * Gated by the caller behind `!isMockSettlement() && isWriteEnabled()`.
 */
export async function attestEvidenceOnChain(
  input: AttestEvidenceInput,
): Promise<{ uid: string }> {
  const schemaUid = process.env.PCC_EVIDENCE_SCHEMA_UID;
  if (!schemaUid) {
    throw new Error(
      "PCC_EVIDENCE_SCHEMA_UID not set — register the pcc.evidence.v1 schema (G1) " +
        "and set this env var before enabling real on-chain attestation.",
    );
  }
  const provider = new ethers.JsonRpcProvider(process.env.PCC_RPC_URL);
  const signer = new ethers.Wallet(process.env.PCC_GATEWAY_PRIVATE_KEY!, provider);
  const eas = new EAS(EAS_ADDRESS);
  eas.connect(signer);

  const encoder = new SchemaEncoder(PCC_EVIDENCE_SCHEMA_STRING);
  const data = encoder.encodeData([
    { name: "jobId", value: input.jobId, type: "string" },
    { name: "kernelId", value: input.kernelId, type: "bytes32" },
    { name: "evidenceBundleHash", value: input.evidenceBundleHash, type: "bytes32" },
    { name: "ipfsCid", value: input.ipfsCid, type: "string" },
    { name: "assuranceTier", value: input.assuranceTier, type: "uint8" },
    { name: "oracleVerified", value: true, type: "bool" },
  ]);

  const tx = await eas.attest({
    schema: schemaUid,
    data: {
      recipient: input.recipient,
      expirationTime: NO_EXPIRATION,
      revocable: true,
      data,
    },
  });
  const uid = await tx.wait(); // resolves to the new attestation UID (bytes32)
  return { uid };
}

/**
 * Delegated-attestation variant (eas-migration-design §3.5) — STUB.
 *
 * Use only when the oracle signing key must stay OFF the gateway host: the
 * oracle produces an EIP-712 `Signature` + `deadline`, the gateway relays via
 * `EAS.attestByDelegation(DelegatedAttestationRequest)` and pays gas. The
 * on-chain `attestation.attester` is still attributed to the oracle, so
 * MilestoneEscrowV2's `a.attester == authorizedOracle` check holds unchanged —
 * the escrow READ path is identical to `attestEvidenceOnChain`.
 *
 * Not wired in this wave: the recommended default is the gateway-signs path
 * above (the gateway key already IS the oracle key in the current deployment).
 * To implement: obtain an oracle-signed `EIP712AttestationRequest` from the
 * out-of-repo oracle, then call `eas.attestByDelegation({ schema, data, signature,
 * attester, deadline })` and `await tx.wait()` for the UID.
 */
export async function attestEvidenceByDelegation(
  _input: AttestEvidenceInput & {
    /** Oracle-produced EIP-712 signature over the attestation request. */
    signature: { v: number; r: string; s: string };
    /** The oracle address that signed (becomes the on-chain attester). */
    attester: `0x${string}`;
    /** Unix-seconds deadline for the delegated request. */
    deadline: bigint;
  },
): Promise<{ uid: string }> {
  throw new Error(
    "attestEvidenceByDelegation is a documented stub (eas-migration-design §3.5). " +
      "The default deployment uses attestEvidenceOnChain (gateway key == oracle key). " +
      "Wire the EAS.attestByDelegation call when key isolation is required.",
  );
}

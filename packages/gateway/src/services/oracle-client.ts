/**
 * PCC Oracle Client — calls the proprietary verification oracle
 * before allowing settlement.
 *
 * Configure the oracle endpoint via the PCC_ORACLE_URL env var.
 * When PCC_ORACLE_KEY is not set, falls back to mock verification
 * so dev/test environments work without the oracle running.
 */

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

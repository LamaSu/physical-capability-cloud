/**
 * PCC Oracle Client — calls the proprietary verification oracle
 * before allowing settlement.
 *
 * The oracle runs on Spark at http://192.168.108.72:4100 by default.
 *
 * Mode selection (PCC_ORACLE_MODE):
 *   - "real": always call the oracle. Missing key or non-hex escrow => throw.
 *   - "mock": always return mock. Dev/test only; blocked in production.
 *   - "auto": real if NODE_ENV=production, otherwise mock-on-missing-key.
 *            This is the default. In production, "auto" behaves like "real".
 *
 * Mock mode is ALWAYS rejected when NODE_ENV=production, regardless of other flags.
 * There is no silent fallback path in prod — misconfiguration surfaces as a loud error.
 */

const ORACLE_URL = process.env.PCC_ORACLE_URL ?? "http://192.168.108.72:4100";
const ORACLE_KEY = process.env.PCC_ORACLE_KEY ?? "";
const ORACLE_MODE = (process.env.PCC_ORACLE_MODE ?? "auto").toLowerCase();
const IS_PROD = process.env.NODE_ENV === "production";

type OracleMode = "real" | "mock" | "auto";

function resolveMode(): OracleMode {
  if (ORACLE_MODE !== "real" && ORACLE_MODE !== "mock" && ORACLE_MODE !== "auto") {
    throw new Error(
      `[oracle] Invalid PCC_ORACLE_MODE "${ORACLE_MODE}". Must be one of: real, mock, auto.`,
    );
  }
  if (ORACLE_MODE === "mock" && IS_PROD) {
    throw new Error(
      "[oracle] PCC_ORACLE_MODE=mock is forbidden in production. Set to 'real' and provide PCC_ORACLE_KEY.",
    );
  }
  return ORACLE_MODE as OracleMode;
}

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
 * Mode semantics:
 *   real: always call oracle; missing key or mock escrow => throw.
 *   mock: always return mock response (blocked in production).
 *   auto: prod => real; non-prod => mock if key absent, else real.
 */
export async function verifyWithOracle(request: OracleVerifyRequest): Promise<OracleResponse> {
  const mode = resolveMode();

  if (mode === "mock") {
    return mockVerification(request);
  }

  const hasHexEscrow = request.escrowAddress.startsWith("0x") && !request.escrowAddress.startsWith("mock");

  if (mode === "real") {
    if (!ORACLE_KEY) {
      throw new Error(
        "[oracle] PCC_ORACLE_MODE=real requires PCC_ORACLE_KEY. Refusing to settle without verification.",
      );
    }
    if (!hasHexEscrow) {
      throw new Error(
        `[oracle] PCC_ORACLE_MODE=real requires a real (0x...) escrow address. Got: ${request.escrowAddress}`,
      );
    }
    return callOracle(request);
  }

  // mode === "auto"
  if (IS_PROD) {
    if (!ORACLE_KEY) {
      throw new Error(
        "[oracle] Production requires PCC_ORACLE_KEY (auto mode will not fall back to mock in prod).",
      );
    }
    if (!hasHexEscrow) {
      throw new Error(
        `[oracle] Production escrow must be on-chain (0x...). Got: ${request.escrowAddress}`,
      );
    }
    return callOracle(request);
  }

  // auto + non-prod => graceful mock fallback, but loud
  if (!ORACLE_KEY) {
    console.warn("[oracle] PCC_ORACLE_MODE=auto, no PCC_ORACLE_KEY — using mock (dev only).");
    return mockVerification(request);
  }
  if (!hasHexEscrow) {
    console.warn(
      `[oracle] PCC_ORACLE_MODE=auto, non-hex escrow (${request.escrowAddress}) — using mock (dev only).`,
    );
    return mockVerification(request);
  }
  return callOracle(request);
}

async function callOracle(request: OracleVerifyRequest): Promise<OracleResponse> {
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
 */
export function isOracleConfigured(): boolean {
  return ORACLE_KEY.length > 0;
}

/**
 * Report the effective oracle mode for /api/status and diagnostics.
 */
export function getOracleMode(): { mode: OracleMode; keyPresent: boolean; prod: boolean } {
  return { mode: resolveMode(), keyPresent: ORACLE_KEY.length > 0, prod: IS_PROD };
}

// ---------------------------------------------------------------------------
// Mock (dev/test only — never reached in prod)
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

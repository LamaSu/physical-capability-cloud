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

const ORACLE_TIMEOUT_MS = Number.parseInt(process.env.PCC_ORACLE_TIMEOUT_MS ?? "10000", 10);
const ORACLE_RETRY_COUNT = Number.parseInt(process.env.PCC_ORACLE_RETRY_COUNT ?? "2", 10);
const ORACLE_RETRY_DELAY_MS = Number.parseInt(process.env.PCC_ORACLE_RETRY_DELAY_MS ?? "200", 10);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FetchRetryOptions {
  /** Per-attempt timeout in ms (default PCC_ORACLE_TIMEOUT_MS / 10s). */
  timeoutMs?: number;
  /** Retry attempts after the first (default PCC_ORACLE_RETRY_COUNT / 2). */
  retries?: number;
  /** Base backoff in ms; doubled per attempt (default PCC_ORACLE_RETRY_DELAY_MS / 200). */
  retryDelayMs?: number;
}

/**
 * `fetch` with a per-attempt AbortController timeout and retry/backoff. The
 * oracle call previously used a bare `fetch` with no timeout and no retry — a
 * slow or briefly-unavailable oracle then hung (or failed) settlement. Retries on
 * network errors, aborts (timeout), and transient HTTP (429 / 5xx); a 4xx other
 * than 429 returns immediately (deterministic, not worth retrying). Backoff is
 * exponential from `retryDelayMs`. Exported for unit testing.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? ORACLE_TIMEOUT_MS;
  const retries = opts.retries ?? ORACLE_RETRY_COUNT;
  const retryDelayMs = opts.retryDelayMs ?? ORACLE_RETRY_DELAY_MS;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = new Error(`oracle transient HTTP ${res.status}`);
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
  /**
   * V2 (EAS) path: when true, ask the oracle to MINT a real on-chain EAS
   * attestation (recipient = escrow) and return its UID in
   * `OracleResponse.easAttestation`. Default/omitted = V1 behaviour (the oracle
   * only signs the EIP-712 attestation struct, no on-chain EAS write).
   */
  mintEasAttestation?: boolean;
  /** V2: pcc.evidence.v1 schema UID the minted attestation should use. */
  schemaUid?: string;
  /**
   * V2: the milestone's on-chain stepId (bytes32, as stored on the escrow). The
   * minted EAS payload binds this so MilestoneEscrowV2.submitAttestation can
   * validate the attested stepId against the milestone. MUST be the real
   * on-chain stepId, not a placeholder — a mismatch reverts submitAttestation.
   */
  stepId?: string;
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
  /**
   * V2 (EAS) path: present only when the request set `mintEasAttestation:true`
   * AND the oracle successfully minted an on-chain EAS attestation. `easUid` is
   * the bytes32 attestation UID to pass into
   * MilestoneEscrowV2.submitAttestation(milestoneIndex, easUid). Null/absent on
   * the V1 path or if minting failed (caller falls back to non-bridged
   * settlement). The oracle server already returns this field; the gateway
   * previously discarded it at deserialization.
   */
  easAttestation?: { easUid: string; schemaUid: string } | null;
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

  const res = await fetchWithRetry(`${ORACLE_URL}/verify`, {
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

  const parsed = (await res.json()) as OracleResponse;

  // Security review (PR #157 point 3): fetchWithRetry only guards TRANSPORT; a
  // healthy-but-stale or wrong-chain oracle read can still pass it. Guard the
  // RESPONSE so settlement never rides an outdated / off-chain verification:
  //   - chainId mismatch → the oracle verified on the wrong chain. Reject.
  //   - stale attestation → verified against outdated state. Reject (configurable
  //     via PCC_ORACLE_MAX_ATTESTATION_AGE_SEC, default 300s).
  // NOTE: true block-height freshness needs the oracle to return `verifiedAtBlock`
  // (an oracle-schema change, tracked separately); these are the in-scope gates.
  if (typeof parsed.chainId === "number" && parsed.chainId !== request.chainId) {
    throw new Error(
      `oracle verified on chain ${parsed.chainId}, expected ${request.chainId} — rejecting (wrong-chain verification)`,
    );
  }
  const maxAgeSec = Number.parseInt(process.env.PCC_ORACLE_MAX_ATTESTATION_AGE_SEC ?? "300", 10);
  const ts = parsed.attestation?.timestamp;
  if (parsed.result?.verified && Number.isFinite(maxAgeSec) && typeof ts === "number" && ts > 0) {
    const ageSec = Math.floor(Date.now() / 1000) - ts;
    if (ageSec > maxAgeSec) {
      throw new Error(
        `oracle attestation is stale (${ageSec}s old > ${maxAgeSec}s max) — ` +
          `rejecting to avoid settling on outdated verification`,
      );
    }
  }

  return parsed;
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
    // V2: mirror the live oracle's behaviour — when minting is requested, return
    // a deterministic mock EAS UID so the orchestration path is exercisable in
    // dev/test without a real EAS write. A live oracle replaces this with the
    // real on-chain UID. Absent (null) on the V1 path.
    easAttestation: request.mintEasAttestation
      ? {
          easUid: "0x" + "ea".repeat(32),
          schemaUid: request.schemaUid ?? process.env.PCC_EVIDENCE_SCHEMA_UID ?? "0x" + "00".repeat(32),
        }
      : null,
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

// ---------------------------------------------------------------------------
// V2 (`oracle.evidence.v2`) — additive, gated by PCC_EVIDENCE_V2_ENABLED
// ---------------------------------------------------------------------------
//
// The V2 schema extends `pcc.evidence.v1` with two trailing fee fields the
// oracle SIGNS into the attestation payload itself:
//
//   feeBps        — uint16  fee in basis points (max 65,535 = 655.35%)
//   feeRecipient  — address PCC treasury (or future fee router)
//
// Rationale (pcc-deliberation #066 / #058): with fee in the signed payload,
// MilestoneEscrowV3 can DECODE it from the attestation and use it in
// release/_distribute instead of constructor/root state — the oracle becomes
// the sovereign source of the fee. Backwards compatibility:
//   - v1 schema string + UID is UNTOUCHED (live escrows keep their gate).
//   - v2 helpers are ADDITIVE; nothing in this file calls them yet.
//   - Live MilestoneEscrowV2 cannot decode v2 payloads (mismatched length), so
//     v2 attestations are only useful when paired with V3 escrows.
//
// Reference: pcc-oracle branch `feat/oracle-evidence-v2-fee` @ d8df8ce.

/** The `oracle.evidence.v2` EAS schema string (v1 fields + feeBps + feeRecipient). */
export const PCC_EVIDENCE_SCHEMA_V2 =
  "string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid, uint8 assuranceTier, bool oracleVerified, bytes32 stepId, uint16 feeBps, address feeRecipient";

/** viem ABI parameters for the v2 schema (order matches a future V3 Solidity decode). */
const PCC_EVIDENCE_SCHEMA_V2_PARAMS = [
  { name: "jobId", type: "string" },
  { name: "kernelId", type: "bytes32" },
  { name: "evidenceBundleHash", type: "bytes32" },
  { name: "ipfsCid", type: "string" },
  { name: "assuranceTier", type: "uint8" },
  { name: "oracleVerified", type: "bool" },
  { name: "stepId", type: "bytes32" },
  { name: "feeBps", type: "uint16" },
  { name: "feeRecipient", type: "address" },
] as const;

/** Decoded `oracle.evidence.v2` attestation payload. */
export interface EasEvidencePayloadV2 extends EasEvidencePayload {
  /** Fee in basis points (oracle-set). MilestoneEscrowV3 will cap with MAX_FEE_BPS. */
  feeBps: number;
  /** Fee recipient address (PCC treasury or fee router). */
  feeRecipient: Hex;
}

/** ABI-encode an `oracle.evidence.v2` payload (what the oracle attests to). */
export function encodeEasEvidencePayloadV2(p: EasEvidencePayloadV2): Hex {
  return encodeAbiParameters(PCC_EVIDENCE_SCHEMA_V2_PARAMS, [
    p.jobId,
    p.kernelId,
    p.evidenceBundleHash,
    p.ipfsCid,
    p.assuranceTier,
    p.oracleVerified,
    p.stepId,
    p.feeBps,
    p.feeRecipient,
  ]);
}

/** Decode an `oracle.evidence.v2` payload (the `data` field of an EAS attestation). */
export function decodeEasEvidencePayloadV2(data: Hex): EasEvidencePayloadV2 {
  const [
    jobId,
    kernelId,
    evidenceBundleHash,
    ipfsCid,
    assuranceTier,
    oracleVerified,
    stepId,
    feeBps,
    feeRecipient,
  ] = decodeAbiParameters(PCC_EVIDENCE_SCHEMA_V2_PARAMS, data);
  return {
    jobId,
    kernelId,
    evidenceBundleHash,
    ipfsCid,
    assuranceTier: Number(assuranceTier),
    oracleVerified,
    stepId,
    feeBps: Number(feeBps),
    feeRecipient,
  };
}

export interface BuildEasAttestationInputV2 extends BuildEasAttestationInput {
  /** Fee in basis points the oracle signs into the attestation. Required for V2. */
  feeBps: number;
  /** Fee recipient address the oracle signs into the attestation. Required for V2. */
  feeRecipient: string;
  /** Pre-registered `oracle.evidence.v2` schema UID, if known. */
  schemaUidV2?: string;
}

export interface EasAttestationMetadataV2 {
  schema: string;
  schemaUid: string | null;
  recipient: string | null;
  payload: EasEvidencePayloadV2;
  /** ABI-encoded payload — the exact bytes the oracle attests to / V3 decodes. */
  encoded: Hex;
  /** Always "v2" — disambiguates from `EasAttestationMetadata` at call sites. */
  schemaVersion: "v2";
}

/**
 * V2 enable flag. When false, callers should fall back to v1 (the legacy path).
 * Default: false (no behavioral change without explicit opt-in).
 */
export function isEvidenceV2Enabled(): boolean {
  const v = process.env.PCC_EVIDENCE_V2_ENABLED;
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Build the `oracle.evidence.v2` attestation metadata for a completed job.
 *
 * V2 differs from V1 by carrying `feeBps` + `feeRecipient` in the signed payload,
 * so MilestoneEscrowV3 can decode the fee from the attestation rather than
 * trusting constructor-time root state. This is purely additive — v1 is
 * untouched. The function does NOT check `isEvidenceV2Enabled()` itself; the
 * caller decides when to use v2 vs v1.
 */
export function buildEasAttestationMetadataV2(
  input: BuildEasAttestationInputV2,
): EasAttestationMetadataV2 {
  // Normalize feeRecipient to 0x-hex address (defensive).
  const feeRecipientHex = (input.feeRecipient.startsWith("0x")
    ? input.feeRecipient
    : `0x${input.feeRecipient}`) as Hex;

  const payload: EasEvidencePayloadV2 = {
    jobId: input.jobId,
    kernelId: stringToBytes32Id(input.kernelId),
    evidenceBundleHash: bundleHashToBytes32(input.evidenceBundleHash),
    ipfsCid: input.ipfsCid,
    assuranceTier: input.assuranceTier,
    oracleVerified: input.oracleVerified,
    stepId: stringToBytes32Id(input.stepId),
    feeBps: input.feeBps,
    feeRecipient: feeRecipientHex,
  };

  return {
    schema: PCC_EVIDENCE_SCHEMA_V2,
    schemaUid:
      input.schemaUidV2 ?? process.env.PCC_EVIDENCE_SCHEMA_V2_UID ?? null,
    recipient: input.recipient ?? null,
    payload,
    encoded: encodeEasEvidencePayloadV2(payload),
    schemaVersion: "v2",
  };
}

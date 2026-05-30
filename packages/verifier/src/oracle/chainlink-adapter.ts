/**
 * Chainlink Functions Adapter — Fallback oracle for evidence verification.
 *
 * In mock mode: evaluates evidence locally using the shared evaluator.
 *
 * In live mode: calls a pre-deployed ChainlinkEvidenceVerifier consumer contract
 * that submits JavaScript source code to the Chainlink Functions DON on Base Sepolia.
 * The DON nodes execute the JS, verify the evidence hash, and return a score.
 *
 * Required env vars for live mode:
 *   DEPLOYER_PRIVATE_KEY — wallet private key
 *   CHAINLINK_CONSUMER_ADDRESS — deployed ChainlinkEvidenceVerifier contract
 *   CHAINLINK_SUB_ID — funded Chainlink Functions subscription ID
 *   BASE_RPC_URL — RPC endpoint (defaults to https://sepolia.base.org)
 *
 * Chainlink Functions setup:
 *   Router: 0xf9B8fc078197181C841c296C876945aaa425B278 (Base Sepolia)
 *   DON ID: fun-base-sepolia-1
 *   Create subscription at: https://functions.chain.link/base-sepolia
 */

import { randomBytes } from "crypto";
import type { Hex } from "viem";
import type {
  VerificationOracle,
  OracleVerificationResult,
  OracleMetrics,
  OracleConfig,
  AttestationBinding,
} from "./types.js";
import { DEFAULT_ORACLE_CONFIG, buildOnChainAttestation } from "./types.js";
import { evaluateEvidence } from "./evidence-evaluator.js";

/** Mirror of uma-adapter.normalizeEvidenceHash */
function normalizeEvidenceHash(bundleHash: string): Hex {
  if (bundleHash.startsWith("0x") && bundleHash.length === 66) {
    return bundleHash as Hex;
  }
  const stripped = bundleHash.replace(/^sha256:/, "").replace(/^0x/, "");
  if (stripped.length >= 64) {
    return (`0x${stripped.slice(0, 64)}`) as Hex;
  }
  return (`0x${stripped.padStart(64, "0")}`) as Hex;
}

/**
 * JavaScript source executed by Chainlink DON nodes.
 * Receives bundleHash and requiredTier as args, performs basic verification,
 * returns a uint256 score (0-100 scaled) encoded as hex.
 */
export const CHAINLINK_DON_SOURCE = `
// PCC Evidence Verification — Chainlink Functions DON script
// args[0] = bundleHash (hex string)
// args[1] = requiredTier (number as string)
// Returns: uint256 score (0-100) encoded as bytes

const bundleHash = args[0];
const requiredTier = parseInt(args[1]);

// Validate inputs
if (!bundleHash || bundleHash.length < 8) {
  return Functions.encodeUint256(0);
}

// Tier 0: any hash is acceptable
// Tier 1: hash must be 66+ chars (0x + 64 hex)
// Tier 2+: hash must be 70+ chars (sha256: prefix)
let score = 100;

if (requiredTier >= 1 && bundleHash.length < 66) {
  score = Math.max(0, score - 40);
}

if (requiredTier >= 2 && !bundleHash.startsWith("sha256:") && !bundleHash.startsWith("0x")) {
  score = Math.max(0, score - 30);
}

// Return score as uint256
return Functions.encodeUint256(score);
`.trim();

// ── Consumer contract ABI (minimal — sendRequest + response storage) ─────────

const CONSUMER_ABI = [
  {
    name: "sendEvidenceRequest",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bundleHash", type: "bytes32" },
      { name: "requiredTier", type: "uint8" },
    ],
    outputs: [{ name: "requestId", type: "bytes32" }],
  },
  {
    name: "getLastResponse",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    name: "getLastRequestId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "responses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

export class ChainlinkOracleAdapter implements VerificationOracle {
  readonly name = "chainlink";

  private config: OracleConfig;
  private totalVerifications = 0;
  private scoreSum = 0;
  private recentResults: OracleMetrics["recentResults"] = [];
  private disabled = false;

  constructor(config: OracleConfig = DEFAULT_ORACLE_CONFIG) {
    this.config = {
      ...DEFAULT_ORACLE_CONFIG,
      ...config,
    };
  }

  isAvailable(): boolean {
    if (this.disabled) return false;
    // In live mode, require consumer address + sub ID
    if (!this.config.mock) {
      return (
        Boolean(process.env.CHAINLINK_CONSUMER_ADDRESS) &&
        Boolean(process.env.CHAINLINK_SUB_ID) &&
        Boolean(process.env.DEPLOYER_PRIVATE_KEY)
      );
    }
    return true;
  }

  /** Simulate oracle outage (for testing cascade fallback) */
  disable(): void { this.disabled = true; }
  /** Re-enable after simulated outage */
  enable(): void { this.disabled = false; }

  async submitForVerification(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    binding?: AttestationBinding,
  ): Promise<OracleVerificationResult> {
    const startTime = Date.now();

    if (this.config.mock) {
      return this.submitMock(bundleHash, bundleData, requiredTier, startTime, binding);
    }

    return this.submitLive(bundleHash, bundleData, requiredTier, startTime, binding);
  }

  private async submitMock(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    startTime: number,
    binding?: AttestationBinding,
  ): Promise<OracleVerificationResult> {
    // Evaluate evidence locally using shared evaluator
    const evaluation = evaluateEvidence(bundleHash, bundleData, requiredTier);

    // Generate a mock request ID (bytes32-like hex)
    const requestId = `0x${randomBytes(32).toString("hex")}`;

    const minScore = this.config.minScoreThreshold ?? 0.6;
    const passed = evaluation.score >= minScore && evaluation.tierCompliant;

    const result: OracleVerificationResult = {
      passed,
      score: evaluation.score,
      tierCompliant: evaluation.tierCompliant,
      defects: evaluation.defects,
      oracle: "chainlink",
      details: [
        {
          source: "chainlink_mock",
          score: evaluation.score,
          passed,
          metadata: {
            hashValid: !evaluation.defects.includes("bundle_hash_mismatch"),
            defectCount: evaluation.defects.length,
            requiredTier,
            router: this.config.chainlinkRouter ?? "0xf9B8fc078197181C841c296C876945aaa425B278",
            donId: this.config.chainlinkDonId ?? "fun-base-sepolia-1",
          },
        },
      ],
      totalTimeMs: Date.now() - startTime,
      requestId,
      attestation: binding
        ? buildOnChainAttestation({
            binding,
            evidenceHash: normalizeEvidenceHash(bundleHash),
            tier: requiredTier,
            verified: passed,
            nonce: (`0x${randomBytes(32).toString("hex")}`) as Hex,
          })
        : undefined,
    };

    this.recordResult(result);
    return result;
  }

  private async submitLive(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    startTime: number,
    binding?: AttestationBinding,
  ): Promise<OracleVerificationResult> {
    const { createPublicClient, createWalletClient, http, toBytes, pad } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const { privateKeyToAccount } = await import("viem/accounts");

    const privateKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
    if (!privateKey) {
      throw new Error("Live Chainlink mode requires DEPLOYER_PRIVATE_KEY env var");
    }

    const consumerAddress = process.env.CHAINLINK_CONSUMER_ADDRESS as `0x${string}`;
    if (!consumerAddress) {
      throw new Error(
        "Live Chainlink mode requires CHAINLINK_CONSUMER_ADDRESS env var. " +
        "Deploy ChainlinkEvidenceVerifier.sol first: npx tsx scripts/deploy-oracle-contracts.ts",
      );
    }

    const account = privateKeyToAccount(privateKey);
    const rpcUrl = this.config.rpcUrl ?? "https://sepolia.base.org";

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    // Encode bundleHash as bytes32 (pad or truncate to 32 bytes)
    const bundleHashBytes32 = pad(
      toBytes(bundleHash.startsWith("0x") ? bundleHash : `0x${Buffer.from(bundleHash).toString("hex")}`),
      { size: 32, dir: "right" },
    ) as unknown as `0x${string}`;

    // Send the evidence request to the consumer contract
    const txHash = await walletClient.writeContract({
      address: consumerAddress,
      abi: CONSUMER_ABI,
      functionName: "sendEvidenceRequest",
      args: [bundleHashBytes32, requiredTier as number],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Extract requestId from the first topic of the first log
    const requestId: string =
      receipt.logs[0]?.topics[1] ?? `0x${randomBytes(32).toString("hex")}`;

    // Poll for response (DON typically responds within 60-90 seconds)
    const maxWaitMs = 120_000;
    const pollIntervalMs = 5_000;
    const deadline = Date.now() + maxWaitMs;

    let donScore = 0;
    let responseReceived = false;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      try {
        const response = await publicClient.readContract({
          address: consumerAddress,
          abi: CONSUMER_ABI,
          functionName: "responses",
          args: [requestId as `0x${string}`],
        }) as `0x${string}`;

        if (response && response !== "0x") {
          // Parse score: response is uint256 encoded as bytes (0-100)
          const rawValue = BigInt(response);
          donScore = Number(rawValue) / 100; // Convert 0-100 → 0.0-1.0
          responseReceived = true;
          break;
        }
      } catch {
        // Not yet fulfilled — continue polling
      }
    }

    // Fall back to local evaluation for defects/tier compliance
    const evaluation = evaluateEvidence(bundleHash, bundleData, requiredTier);
    const finalScore = responseReceived ? donScore : evaluation.score;
    const minScore = this.config.minScoreThreshold ?? 0.6;
    const passed = finalScore >= minScore && evaluation.tierCompliant;

    const result: OracleVerificationResult = {
      passed,
      score: finalScore,
      tierCompliant: evaluation.tierCompliant,
      defects: evaluation.defects,
      oracle: "chainlink",
      details: [
        {
          source: responseReceived ? "chainlink_live" : "chainlink_live_timeout",
          score: finalScore,
          passed,
          metadata: {
            txHash,
            requestId,
            consumerAddress,
            responseReceived,
            donScore: responseReceived ? donScore : null,
            localScore: evaluation.score,
            router: this.config.chainlinkRouter ?? "0xf9B8fc078197181C841c296C876945aaa425B278",
            donId: this.config.chainlinkDonId ?? "fun-base-sepolia-1",
            requiredTier,
          },
        },
      ],
      totalTimeMs: Date.now() - startTime,
      requestId,
      attestation: binding
        ? buildOnChainAttestation({
            binding,
            evidenceHash: normalizeEvidenceHash(bundleHash),
            tier: requiredTier,
            verified: passed,
            signature: "0x",
          })
        : undefined,
    };

    this.recordResult(result);
    return result;
  }

  getMetrics(): OracleMetrics {
    return {
      totalVerifications: this.totalVerifications,
      averageScore: this.totalVerifications > 0 ? this.scoreSum / this.totalVerifications : 0,
      activeOracles: 1,
      primaryOracle: "chainlink",
      fallbackOracles: [],
      recentResults: [...this.recentResults],
    };
  }

  private recordResult(result: OracleVerificationResult): void {
    this.totalVerifications++;
    this.scoreSum += result.score;

    this.recentResults.unshift({
      oracle: "chainlink",
      passed: result.passed,
      score: result.score,
      timestamp: new Date().toISOString(),
    });

    if (this.recentResults.length > 10) {
      this.recentResults = this.recentResults.slice(0, 10);
    }
  }
}

/**
 * UMA Optimistic Oracle v3 Adapter — Primary oracle for evidence verification.
 *
 * In mock mode: evaluates evidence locally using the shared evaluator and
 * simulates UMA's assertion / liveness / settlement lifecycle.
 *
 * In live mode: submits an assertion to UMA OOv3 on Base Sepolia via viem,
 * encoding the evidence hash as the claim with a USDC bond.
 *
 * UMA OOv3 flow:
 *   assertTruthWithDefaults(claim, asserter) → liveness window (2hr default)
 *   → no dispute → settleAssertion() → result
 *
 * Required env vars for live mode:
 *   DEPLOYER_PRIVATE_KEY or UMA_ASSERTER_PRIVATE_KEY — wallet private key
 *   UMA_OOV3_ADDRESS — OOv3 contract address (defaults to Base Sepolia deployment)
 *   UMA_BOND_TOKEN — bond token address (defaults to Base Sepolia USDC)
 *   BASE_RPC_URL — RPC endpoint (defaults to https://sepolia.base.org)
 */

import { randomBytes } from "crypto";
import type {
  VerificationOracle,
  OracleVerificationResult,
  OracleMetrics,
  OracleConfig,
} from "./types.js";
import { DEFAULT_ORACLE_CONFIG } from "./types.js";
import { evaluateEvidence } from "./evidence-evaluator.js";

// ── UMA OOv3 ABI (minimal — only functions we call) ───────────────────────────

const OOV3_ABI = [
  {
    name: "assertTruthWithDefaults",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "claim", type: "bytes" },
      { name: "asserter", type: "address" },
    ],
    outputs: [{ name: "assertionId", type: "bytes32" }],
  },
  {
    name: "settleAssertion",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "assertionId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "getAssertion",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "assertionId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {
            name: "escalationManagerSettings",
            type: "tuple",
            components: [
              { name: "arbitrateViaEscalationManager", type: "bool" },
              { name: "discardOracle", type: "bool" },
              { name: "validateDisputers", type: "bool" },
              { name: "assertingCaller", type: "address" },
              { name: "escalationManager", type: "address" },
            ],
          },
          { name: "asserter", type: "address" },
          { name: "assertionTime", type: "uint64" },
          { name: "settled", type: "bool" },
          { name: "currency", type: "address" },
          { name: "expirationTime", type: "uint64" },
          { name: "settlementResolution", type: "bool" },
          { name: "domainId", type: "bytes32" },
          { name: "identifier", type: "bytes32" },
          { name: "bond", type: "uint256" },
          { name: "callbackRecipient", type: "address" },
          { name: "disputer", type: "address" },
        ],
      },
    ],
  },
  {
    name: "defaultLiveness",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    name: "defaultCurrency",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// ── ERC-20 ABI (for USDC approval) ───────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * UMA OOv3 contract address on Base Sepolia (84532).
 * Configurable via UMA_OOV3_ADDRESS env var.
 * Source: https://github.com/UMAprotocol/protocol/blob/master/packages/core/networks/84532.json
 */
const DEFAULT_OOV3_ADDRESS_BASE_SEPOLIA =
  "0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944";

export class UMAOracleAdapter implements VerificationOracle {
  readonly name = "uma";

  private config: Required<Pick<OracleConfig, "mock" | "livenessSeconds" | "bondAmount" | "minScoreThreshold" | "chainId" | "rpcUrl">> & OracleConfig;
  private totalVerifications = 0;
  private scoreSum = 0;
  private recentResults: OracleMetrics["recentResults"] = [];
  private disabled = false;

  constructor(config: OracleConfig = DEFAULT_ORACLE_CONFIG) {
    this.config = {
      ...DEFAULT_ORACLE_CONFIG,
      ...config,
      mock: config.mock ?? true,
      livenessSeconds: config.livenessSeconds ?? 7200,
      bondAmount: config.bondAmount ?? BigInt(500_000_000),
      minScoreThreshold: config.minScoreThreshold ?? 0.6,
    };
  }

  isAvailable(): boolean {
    if (this.disabled) return false;
    // In live mode, require a private key env var
    if (!this.config.mock) {
      const hasKey =
        Boolean(process.env.UMA_ASSERTER_PRIVATE_KEY) ||
        Boolean(process.env.DEPLOYER_PRIVATE_KEY);
      return hasKey;
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
  ): Promise<OracleVerificationResult> {
    const startTime = Date.now();

    if (this.config.mock) {
      return this.submitMock(bundleHash, bundleData, requiredTier, startTime);
    }

    return this.submitLive(bundleHash, bundleData, requiredTier, startTime);
  }

  /**
   * Settle a previously submitted assertion after the liveness window passes.
   * Only callable in live mode. Returns true if settlement succeeded.
   */
  async settleAssertion(assertionId: string): Promise<boolean> {
    if (this.config.mock) {
      // In mock mode settlement always succeeds
      return true;
    }

    const { createPublicClient, createWalletClient, http } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const { privateKeyToAccount } = await import("viem/accounts");

    const privateKey = (
      process.env.UMA_ASSERTER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY
    ) as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const rpcUrl = this.config.rpcUrl ?? "https://sepolia.base.org";
    const oovAddress = (
      this.config.umaOracleAddress ?? DEFAULT_OOV3_ADDRESS_BASE_SEPOLIA
    ) as `0x${string}`;

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    const hash = await walletClient.writeContract({
      address: oovAddress,
      abi: OOV3_ABI,
      functionName: "settleAssertion",
      args: [assertionId as `0x${string}`],
    });

    await publicClient.waitForTransactionReceipt({ hash });
    return true;
  }

  /**
   * Read on-chain assertion state. Returns the raw assertion tuple from OOv3.
   */
  async getAssertionStatus(assertionId: string): Promise<{
    settled: boolean;
    settlementResolution: boolean;
    expirationTime: bigint;
    asserter: string;
  }> {
    if (this.config.mock) {
      return {
        settled: true,
        settlementResolution: true,
        expirationTime: BigInt(Math.floor(Date.now() / 1000) + 7200),
        asserter: "0x0000000000000000000000000000000000000000",
      };
    }

    const { createPublicClient, http } = await import("viem");
    const { baseSepolia } = await import("viem/chains");

    const rpcUrl = this.config.rpcUrl ?? "https://sepolia.base.org";
    const oovAddress = (
      this.config.umaOracleAddress ?? DEFAULT_OOV3_ADDRESS_BASE_SEPOLIA
    ) as `0x${string}`;

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    const assertion = await publicClient.readContract({
      address: oovAddress,
      abi: OOV3_ABI,
      functionName: "getAssertion",
      args: [assertionId as `0x${string}`],
    }) as {
      settled: boolean;
      settlementResolution: boolean;
      expirationTime: bigint;
      asserter: string;
    };

    return {
      settled: assertion.settled,
      settlementResolution: assertion.settlementResolution,
      expirationTime: assertion.expirationTime,
      asserter: assertion.asserter,
    };
  }

  private async submitMock(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    startTime: number,
  ): Promise<OracleVerificationResult> {
    // Evaluate evidence locally using shared evaluator
    const evaluation = evaluateEvidence(bundleHash, bundleData, requiredTier);

    // Generate a mock assertion ID (bytes32-like hex)
    const assertionId = `0x${randomBytes(32).toString("hex")}`;

    const passed = evaluation.score >= (this.config.minScoreThreshold ?? 0.6) && evaluation.tierCompliant;

    const result: OracleVerificationResult = {
      passed,
      score: evaluation.score,
      tierCompliant: evaluation.tierCompliant,
      defects: evaluation.defects,
      oracle: "uma",
      details: [
        {
          source: "uma_mock",
          score: evaluation.score,
          passed,
          metadata: {
            hashValid: !evaluation.defects.includes("bundle_hash_mismatch"),
            defectCount: evaluation.defects.length,
            requiredTier,
            chainId: this.config.chainId,
          },
        },
      ],
      totalTimeMs: Date.now() - startTime,
      assertionId,
      disputeWindow: this.config.livenessSeconds,
      bondAmount: this.config.bondAmount?.toString(),
    };

    this.recordResult(result);
    return result;
  }

  private async submitLive(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    startTime: number,
  ): Promise<OracleVerificationResult> {
    // Dynamic import viem so mock mode never loads chain deps
    const { createPublicClient, createWalletClient, http, toHex } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const { privateKeyToAccount } = await import("viem/accounts");

    const privateKey = (
      process.env.UMA_ASSERTER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY
    ) as `0x${string}`;

    if (!privateKey) {
      throw new Error(
        "Live UMA mode requires UMA_ASSERTER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY env var",
      );
    }

    const account = privateKeyToAccount(privateKey);
    const rpcUrl = this.config.rpcUrl ?? "https://sepolia.base.org";
    const oovAddress = (
      this.config.umaOracleAddress ?? DEFAULT_OOV3_ADDRESS_BASE_SEPOLIA
    ) as `0x${string}`;
    const bondToken = (
      this.config.bondTokenAddress ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    ) as `0x${string}`;
    const bondAmount = this.config.bondAmount ?? BigInt(500_000_000);

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    });

    // 1. Check USDC allowance and approve if needed
    const currentAllowance = await publicClient.readContract({
      address: bondToken,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, oovAddress],
    }) as bigint;

    if (currentAllowance < bondAmount) {
      const approveHash = await walletClient.writeContract({
        address: bondToken,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [oovAddress, bondAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    // 2. Encode the evidence claim as UTF-8 bytes
    const claimText =
      `PCC Evidence: bundleHash=${bundleHash} tier=${requiredTier} timestamp=${Date.now()}`;
    const claim = toHex(new TextEncoder().encode(claimText));

    // 3. Call assertTruthWithDefaults
    const assertHash = await walletClient.writeContract({
      address: oovAddress,
      abi: OOV3_ABI,
      functionName: "assertTruthWithDefaults",
      args: [claim as `0x${string}`, account.address],
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: assertHash,
    });

    // 4. Extract assertionId from logs (first bytes32 in the AssertionMade event)
    // OOv3 emits AssertionMade(assertionId, ...)
    const assertionId: string =
      receipt.logs[0]?.topics[1] ?? `0x${"0".repeat(64)}`;

    // 5. Read liveness from on-chain defaults
    const liveness = await publicClient.readContract({
      address: oovAddress,
      abi: OOV3_ABI,
      functionName: "defaultLiveness",
      args: [],
    }) as bigint;

    // Also run local evaluation to populate score/defects
    const evaluation = evaluateEvidence(bundleHash, bundleData, requiredTier);
    const passed = evaluation.score >= (this.config.minScoreThreshold ?? 0.6) && evaluation.tierCompliant;

    const result: OracleVerificationResult = {
      passed,
      score: evaluation.score,
      tierCompliant: evaluation.tierCompliant,
      defects: evaluation.defects,
      oracle: "uma",
      details: [
        {
          source: "uma_live",
          score: evaluation.score,
          passed,
          metadata: {
            txHash: assertHash,
            assertionId,
            rpcUrl,
            chainId: this.config.chainId,
            oovAddress,
            bondToken,
            bondAmount: bondAmount.toString(),
            requiredTier,
            claimText,
          },
        },
      ],
      totalTimeMs: Date.now() - startTime,
      assertionId,
      disputeWindow: Number(liveness),
      bondAmount: bondAmount.toString(),
    };

    this.recordResult(result);
    return result;
  }

  getMetrics(): OracleMetrics {
    return {
      totalVerifications: this.totalVerifications,
      averageScore: this.totalVerifications > 0 ? this.scoreSum / this.totalVerifications : 0,
      activeOracles: 1,
      primaryOracle: "uma",
      fallbackOracles: ["chainlink", "eigenlayer"],
      recentResults: [...this.recentResults],
    };
  }

  private recordResult(result: OracleVerificationResult): void {
    this.totalVerifications++;
    this.scoreSum += result.score;

    this.recentResults.unshift({
      oracle: "uma",
      passed: result.passed,
      score: result.score,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 10 results
    if (this.recentResults.length > 10) {
      this.recentResults = this.recentResults.slice(0, 10);
    }
  }
}

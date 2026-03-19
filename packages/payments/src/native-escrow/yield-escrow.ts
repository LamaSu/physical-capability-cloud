/**
 * Yield-Bearing Escrow — earn DeFi yield on idle escrow funds.
 *
 * Inspired by ZyFAI's automated yield optimization. While funds sit in
 * milestone escrow waiting for evidence verification, they earn yield
 * through DeFi protocols (Aave, Compound, etc.). On milestone fulfillment,
 * yield is split between operator and user.
 *
 * Strategy tiers (for escrow, only conservative/moderate — no aggressive):
 *   conservative: USDC lending on Aave/Compound (2-5% APY)
 *   moderate: USDC LP on stable pools (5-10% APY, minor IL risk)
 *
 * Integration point: wraps NativeEscrowService. When funds are locked,
 * they're deposited into a yield strategy. On fulfillment, they're
 * withdrawn + yield distributed.
 */

import type { Amount } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type YieldStrategy = "conservative" | "moderate";

export interface YieldConfig {
  /** Strategy for yield generation */
  strategy: YieldStrategy;
  /** DeFi protocol to use (e.g., "aave-v3", "compound-v3", "morpho") */
  protocol: string;
  /** Chain ID where the yield protocol is deployed */
  chainId: number;
  /** Protocol contract address */
  protocolAddress: `0x${string}`;
  /** Maximum slippage in basis points (default: 50 = 0.5%) */
  maxSlippageBps?: number;
  /** Yield split: operator's share (0-1, default: 0.7) */
  operatorYieldShare?: number;
}

export interface YieldPosition {
  /** Obligation ID this yield position is for */
  obligationId: string;
  /** Principal amount deposited */
  principal: bigint;
  /** Current accrued yield */
  accruedYield: bigint;
  /** Estimated APY at time of deposit (basis points) */
  estimatedApyBps: number;
  /** Strategy used */
  strategy: YieldStrategy;
  /** Protocol used */
  protocol: string;
  /** When the position was opened */
  depositedAt: number;
  /** When the position was closed (undefined if still active) */
  withdrawnAt?: number;
  /** Whether the position is active */
  active: boolean;
}

export interface YieldDistribution {
  /** Total yield earned */
  totalYield: bigint;
  /** Operator's share of the yield */
  operatorShare: bigint;
  /** User's share of the yield */
  userShare: bigint;
  /** Protocol fee (if any) */
  protocolFee: bigint;
  /** Duration in seconds the funds were earning yield */
  durationSeconds: number;
  /** Realized APY in basis points */
  realizedApyBps: number;
}

// ---------------------------------------------------------------------------
// Yield Escrow Service
// ---------------------------------------------------------------------------

/**
 * YieldEscrowService wraps the native escrow to add yield generation.
 *
 * Production path: deposit USDC into Aave/Compound aUSDC/cUSDC pools
 * via the yield protocol contract. On withdrawal, redeem aUSDC/cUSDC
 * back to USDC + earned yield.
 *
 * Mock mode: simulates yield accrual using estimated APY.
 */
export class YieldEscrowService {
  private positions = new Map<string, YieldPosition>();
  private config: YieldConfig;

  constructor(config: YieldConfig) {
    this.config = config;
  }

  /**
   * Deposit escrowed funds into a yield strategy.
   * Called when an escrow obligation is locked.
   */
  async deposit(obligationId: string, amount: bigint): Promise<YieldPosition> {
    if (this.positions.has(obligationId)) {
      throw new Error(`Yield position already exists for obligation ${obligationId}`);
    }

    // In production: call protocol contract to deposit USDC → aUSDC/cUSDC
    const estimatedApy = this.getEstimatedApy();

    const position: YieldPosition = {
      obligationId,
      principal: amount,
      accruedYield: 0n,
      estimatedApyBps: estimatedApy,
      strategy: this.config.strategy,
      protocol: this.config.protocol,
      depositedAt: Math.floor(Date.now() / 1000),
      active: true,
    };

    this.positions.set(obligationId, position);
    return position;
  }

  /**
   * Withdraw funds + yield from the yield strategy.
   * Called when a milestone is fulfilled and funds are released.
   */
  async withdraw(obligationId: string): Promise<YieldDistribution> {
    const position = this.positions.get(obligationId);
    if (!position) throw new Error(`No yield position for obligation ${obligationId}`);
    if (!position.active) throw new Error(`Position already withdrawn`);

    const now = Math.floor(Date.now() / 1000);
    const durationSeconds = now - position.depositedAt;

    // Calculate accrued yield (mock — in production: read from protocol)
    const yieldAmount = this.calculateYield(position.principal, position.estimatedApyBps, durationSeconds);

    // Split yield
    const operatorShare = this.config.operatorYieldShare ?? 0.7;
    const operatorYield = BigInt(Math.floor(Number(yieldAmount) * operatorShare));
    const userYield = yieldAmount - operatorYield;

    // Close position
    position.active = false;
    position.withdrawnAt = now;
    position.accruedYield = yieldAmount;

    // Calculate realized APY
    const realizedApyBps = durationSeconds > 0
      ? Math.round(Number(yieldAmount * 10000n * 365n * 86400n) / (Number(position.principal) * durationSeconds))
      : 0;

    return {
      totalYield: yieldAmount,
      operatorShare: operatorYield,
      userShare: userYield,
      protocolFee: 0n, // PCC doesn't take a fee on yield
      durationSeconds,
      realizedApyBps,
    };
  }

  /**
   * Get the current yield position for an obligation.
   */
  getPosition(obligationId: string): YieldPosition | undefined {
    return this.positions.get(obligationId);
  }

  /**
   * Get all active yield positions.
   */
  getActivePositions(): YieldPosition[] {
    return [...this.positions.values()].filter(p => p.active);
  }

  /**
   * Get total value locked (principal + accrued yield across all active positions).
   */
  getTotalValueLocked(): { principal: bigint; yield: bigint; total: bigint } {
    let principal = 0n;
    let yieldTotal = 0n;

    for (const pos of this.positions.values()) {
      if (!pos.active) continue;
      principal += pos.principal;

      const now = Math.floor(Date.now() / 1000);
      const duration = now - pos.depositedAt;
      yieldTotal += this.calculateYield(pos.principal, pos.estimatedApyBps, duration);
    }

    return { principal, yield: yieldTotal, total: principal + yieldTotal };
  }

  // ── Private helpers ────────────────────────────────────────────

  private calculateYield(principal: bigint, apyBps: number, durationSeconds: number): bigint {
    // Simple interest: yield = principal * (apy / 10000) * (duration / seconds_per_year)
    const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
    const yieldFraction = (apyBps * durationSeconds) / (10000 * SECONDS_PER_YEAR);
    return BigInt(Math.floor(Number(principal) * yieldFraction));
  }

  private getEstimatedApy(): number {
    // Mock APY estimates by strategy (in basis points)
    switch (this.config.strategy) {
      case "conservative": return 350; // 3.5% APY
      case "moderate": return 700; // 7.0% APY
      default: return 350;
    }
  }
}

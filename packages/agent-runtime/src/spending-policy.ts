/**
 * Spending Policy — budget-aware spending controls for AI agents.
 *
 * Each agent has a SpendingPolicy that defines limits:
 * - Per-transaction maximum
 * - Rolling window maximum
 * - Auto-approve thresholds by intent type
 * - Human approval threshold for large amounts
 *
 * The SpendingTracker enforces these limits and tracks spend over time.
 */

/** Defines the spending constraints for an agent */
export interface SpendingPolicy {
  /** Maximum amount per single transaction (atomic units, e.g., USDC * 1e6) */
  maxPerTransaction: bigint;
  /** Maximum total spend within the rolling window */
  maxPerWindow: bigint;
  /** Rolling window duration in seconds */
  windowDuration: number;
  /** Auto-approve amounts by intent type. If the amount is below this, no approval needed. */
  autoApprove: Record<string, bigint>;
  /** Above this amount, a human must approve (0n = never require human) */
  humanApprovalThreshold: bigint;
}

/** Result of a spending authorization check */
export interface SpendCheckResult {
  allowed: boolean;
  reason?: string;
  requiresHumanApproval?: boolean;
}

/** Record of a single spend event */
export interface SpendRecord {
  intent: string;
  amount: bigint;
  timestamp: number;
  recipient: string;
  txSignature?: string;
}

/**
 * Tracks agent spending against a SpendingPolicy.
 *
 * Maintains a rolling window of spend amounts and enforces limits.
 * All amounts are in atomic units (e.g., USDC lamports = amount * 1e6).
 */
export class SpendingTracker {
  private windowSpend = 0n;
  private windowStart: number;
  private policy: SpendingPolicy;
  private history: SpendRecord[] = [];

  constructor(policy: SpendingPolicy) {
    this.policy = policy;
    this.windowStart = Date.now();
  }

  /**
   * Check whether the agent is allowed to spend a given amount for a given intent.
   * Does NOT record the spend — call recordSpend() after successful transaction.
   */
  canSpend(intent: string, amount: bigint): SpendCheckResult {
    this.refreshWindow();

    // Check per-transaction limit
    if (amount > this.policy.maxPerTransaction) {
      return {
        allowed: false,
        reason: `Amount ${amount} exceeds per-transaction limit of ${this.policy.maxPerTransaction}`,
      };
    }

    // Check window limit
    if (this.windowSpend + amount > this.policy.maxPerWindow) {
      return {
        allowed: false,
        reason: `Amount ${amount} would exceed window limit. Spent ${this.windowSpend} of ${this.policy.maxPerWindow} in current window.`,
      };
    }

    // Check human approval threshold
    if (this.policy.humanApprovalThreshold > 0n && amount > this.policy.humanApprovalThreshold) {
      return {
        allowed: false,
        requiresHumanApproval: true,
        reason: `Amount ${amount} exceeds human approval threshold of ${this.policy.humanApprovalThreshold}`,
      };
    }

    // Check auto-approve for this intent type
    const autoApproveLimit = this.policy.autoApprove[intent];
    if (autoApproveLimit !== undefined && amount > autoApproveLimit) {
      return {
        allowed: false,
        reason: `Amount ${amount} exceeds auto-approve limit of ${autoApproveLimit} for intent "${intent}"`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a successful spend. Call this AFTER the transaction succeeds.
   */
  recordSpend(intent: string, amount: bigint, recipient: string, txSignature?: string): void {
    this.refreshWindow();
    this.windowSpend += amount;
    this.history.push({
      intent,
      amount,
      timestamp: Date.now(),
      recipient,
      txSignature,
    });
  }

  /** Remaining budget in the current window */
  get remaining(): bigint {
    this.refreshWindow();
    const rem = this.policy.maxPerWindow - this.windowSpend;
    return rem > 0n ? rem : 0n;
  }

  /** Total spent in the current window */
  get spent(): bigint {
    this.refreshWindow();
    return this.windowSpend;
  }

  /** Get the full spending history */
  get spendHistory(): readonly SpendRecord[] {
    return this.history;
  }

  /** Current policy (readonly) */
  get currentPolicy(): Readonly<SpendingPolicy> {
    return this.policy;
  }

  /**
   * Update the policy (e.g., when receiving a DelegateBudgetIntent).
   */
  updatePolicy(newPolicy: SpendingPolicy): void {
    this.policy = newPolicy;
  }

  /**
   * Reset the window and spend tracking (e.g., when receiving new funding).
   */
  reset(): void {
    this.windowSpend = 0n;
    this.windowStart = Date.now();
    this.history = [];
  }

  /** Refresh the rolling window if expired */
  private refreshWindow(): void {
    const now = Date.now();
    if (now - this.windowStart > this.policy.windowDuration * 1000) {
      this.windowSpend = 0n;
      this.windowStart = now;
    }
  }
}

// ── Factory helpers ──────────────────────────────────────────

/**
 * Create a conservative spending policy suitable for a user agent.
 * Low limits, human approval for anything above $10.
 */
export function createUserAgentPolicy(): SpendingPolicy {
  return {
    maxPerTransaction: 50_000_000n,      // $50 USDC (6 decimals)
    maxPerWindow: 200_000_000n,           // $200 USDC per window
    windowDuration: 3600,                 // 1 hour window
    autoApprove: {
      request_quote: 1_000_000n,          // $1 for quotes
      x402_service: 500_000n,             // $0.50 for x402 calls
      payment_request: 10_000_000n,       // $10 for service payments
    },
    humanApprovalThreshold: 10_000_000n,  // $10 — ask human above this
  };
}

/**
 * Create a moderate spending policy suitable for a broker agent.
 * Higher limits since it coordinates multiple transactions.
 */
export function createBrokerAgentPolicy(): SpendingPolicy {
  return {
    maxPerTransaction: 500_000_000n,       // $500
    maxPerWindow: 5_000_000_000n,          // $5,000 per window
    windowDuration: 3600,                  // 1 hour window
    autoApprove: {
      request_quote: 5_000_000n,           // $5 for quotes
      x402_service: 2_000_000n,            // $2 for x402
      payment_request: 100_000_000n,       // $100 for service payments
      escrow_funding: 500_000_000n,        // $500 for escrow
    },
    humanApprovalThreshold: 500_000_000n,  // $500
  };
}

/**
 * Create a minimal spending policy suitable for a kernel agent.
 * Kernels mostly receive payments, rarely send them.
 */
export function createKernelAgentPolicy(): SpendingPolicy {
  return {
    maxPerTransaction: 10_000_000n,       // $10
    maxPerWindow: 50_000_000n,            // $50 per window
    windowDuration: 3600,                 // 1 hour
    autoApprove: {
      claim_rewards: 0n,                  // Claims have no spend
      x402_service: 1_000_000n,           // $1 for x402
    },
    humanApprovalThreshold: 10_000_000n,  // $10
  };
}

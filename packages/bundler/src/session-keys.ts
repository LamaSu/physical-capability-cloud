/**
 * Session Key Manager — scoped, time-limited keys for agent autonomy.
 *
 * A session key is a temporary keypair authorized to sign UserOps on behalf
 * of a smart account, with constraints:
 * - Allowed contracts (only specific escrow addresses)
 * - Allowed functions (only submitEvidence, depositBond, release)
 * - Max spend per session
 * - Expiry time
 *
 * This lets kernel agents submit evidence directly through the bundler
 * without requiring the gateway to proxy every write. The smart account
 * owner pre-authorizes a session key, and the agent uses it autonomously.
 *
 * Architecture:
 *   Smart Account Owner (gateway)
 *     → createSession(agentAddress, constraints)
 *       → returns SessionKey { privateKey, validUntil, constraints }
 *
 *   Agent (kernel/broker)
 *     → signs UserOps with session key
 *     → smart account validates session key on-chain
 *     → UserOp executes if constraints met
 */

import { type Address, type Hex, encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionConstraints {
  /** Contracts this session key can interact with */
  allowedContracts: Address[];
  /** Function selectors this session key can call (4-byte hex) */
  allowedSelectors?: Hex[];
  /** Max total USDC spend for the session (atomic units, 6 decimals) */
  maxSpend: bigint;
  /** Session expiry (Unix timestamp in seconds) */
  validUntil: number;
  /** Max number of UserOps this session key can submit */
  maxOps?: number;
}

export interface SessionKey {
  /** Session key ID */
  id: string;
  /** The session key's private key (held by the agent) */
  privateKey: Hex;
  /** The session key's address (registered on the smart account) */
  address: Address;
  /** Agent address this key is issued to */
  agentAddress: Address;
  /** Constraints enforced by the smart account */
  constraints: SessionConstraints;
  /** When this session was created */
  createdAt: number;
  /** Whether this session has been revoked */
  revoked: boolean;
}

export interface SessionUsage {
  /** Total USDC spent through this session */
  totalSpent: bigint;
  /** Number of UserOps submitted */
  opsUsed: number;
  /** Last activity timestamp */
  lastUsed: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SessionKeyManager {
  private sessions: Map<string, SessionKey> = new Map();
  private usage: Map<string, SessionUsage> = new Map();
  private keyCounter = 0;

  /**
   * Create a new session key for an agent.
   * The smart account owner calls this to authorize an agent.
   */
  createSession(
    agentAddress: Address,
    constraints: SessionConstraints,
  ): SessionKey {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const id = `session-${++this.keyCounter}-${Date.now().toString(36)}`;
    const session: SessionKey = {
      id,
      privateKey,
      address: account.address,
      agentAddress,
      constraints,
      createdAt: Math.floor(Date.now() / 1000),
      revoked: false,
    };

    this.sessions.set(id, session);
    this.usage.set(id, { totalSpent: 0n, opsUsed: 0, lastUsed: 0 });

    return session;
  }

  /**
   * Validate whether a session key can perform an operation.
   */
  validateOp(
    sessionId: string,
    target: Address,
    selector: Hex,
    usdcValue: bigint,
  ): { valid: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { valid: false, reason: "session_not_found" };
    if (session.revoked) return { valid: false, reason: "session_revoked" };

    const now = Math.floor(Date.now() / 1000);
    if (now > session.constraints.validUntil) {
      return { valid: false, reason: "session_expired" };
    }

    // Check allowed contracts
    const normalizedTarget = target.toLowerCase() as Address;
    const allowed = session.constraints.allowedContracts.map(
      (c) => c.toLowerCase() as Address,
    );
    if (!allowed.includes(normalizedTarget)) {
      return { valid: false, reason: "contract_not_allowed" };
    }

    // Check allowed selectors (if specified)
    if (session.constraints.allowedSelectors?.length) {
      const normalizedSelector = selector.toLowerCase() as Hex;
      const allowedSels = session.constraints.allowedSelectors.map(
        (s) => s.toLowerCase() as Hex,
      );
      if (!allowedSels.includes(normalizedSelector)) {
        return { valid: false, reason: "selector_not_allowed" };
      }
    }

    // Check spend limit
    const usage = this.usage.get(sessionId)!;
    if (usage.totalSpent + usdcValue > session.constraints.maxSpend) {
      return { valid: false, reason: "spend_limit_exceeded" };
    }

    // Check ops limit
    if (session.constraints.maxOps && usage.opsUsed >= session.constraints.maxOps) {
      return { valid: false, reason: "ops_limit_exceeded" };
    }

    return { valid: true };
  }

  /**
   * Record usage after a successful operation.
   */
  recordUsage(sessionId: string, usdcValue: bigint): void {
    const usage = this.usage.get(sessionId);
    if (!usage) return;

    usage.totalSpent += usdcValue;
    usage.opsUsed += 1;
    usage.lastUsed = Math.floor(Date.now() / 1000);
  }

  /**
   * Revoke a session key (immediate effect).
   */
  revoke(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.revoked = true;
    return true;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): SessionKey | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get usage stats for a session.
   */
  getUsage(sessionId: string): SessionUsage | undefined {
    return this.usage.get(sessionId);
  }

  /**
   * List all active (non-revoked, non-expired) sessions.
   */
  listActive(): SessionKey[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.sessions.values()].filter(
      (s) => !s.revoked && s.constraints.validUntil > now,
    );
  }

  /**
   * List all sessions for a specific agent.
   */
  listByAgent(agentAddress: Address): SessionKey[] {
    const normalized = agentAddress.toLowerCase();
    return [...this.sessions.values()].filter(
      (s) => s.agentAddress.toLowerCase() === normalized,
    );
  }

  /**
   * Clean up expired sessions.
   */
  pruneExpired(): number {
    const now = Math.floor(Date.now() / 1000);
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.constraints.validUntil < now || session.revoked) {
        this.sessions.delete(id);
        this.usage.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Get summary stats.
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalOps: number;
    totalSpent: bigint;
  } {
    const now = Math.floor(Date.now() / 1000);
    let activeSessions = 0;
    let totalOps = 0;
    let totalSpent = 0n;

    for (const [id, session] of this.sessions) {
      if (!session.revoked && session.constraints.validUntil > now) {
        activeSessions++;
      }
      const usage = this.usage.get(id);
      if (usage) {
        totalOps += usage.opsUsed;
        totalSpent += usage.totalSpent;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      totalOps,
      totalSpent,
    };
  }
}

// ---------------------------------------------------------------------------
// Common function selectors for escrow operations
// ---------------------------------------------------------------------------

/** Pre-computed 4-byte selectors for MilestoneEscrow functions */
export const ESCROW_SELECTORS = {
  fund: "0xb60d4288" as Hex,
  release: "0x37bdc99b" as Hex,
  submitEvidence: "0x5cc07076" as Hex,
  submitAttestation: "0x88d5b5e1" as Hex,
  depositBond: "0x7f578b68" as Hex,
  fileDispute: "0x7b751b9e" as Hex,
} as const;

/**
 * Helper: create constraints for a kernel agent session.
 * Kernel agents only need to submitEvidence and depositBond.
 */
export function kernelSessionConstraints(
  escrowAddresses: Address[],
  maxSpendUsdc: bigint = 100_000_000n, // $100
  durationHours = 24,
): SessionConstraints {
  return {
    allowedContracts: escrowAddresses,
    allowedSelectors: [ESCROW_SELECTORS.submitEvidence, ESCROW_SELECTORS.depositBond],
    maxSpend: maxSpendUsdc,
    validUntil: Math.floor(Date.now() / 1000) + durationHours * 3600,
    maxOps: 500,
  };
}

/**
 * Helper: create constraints for a broker agent session.
 * Brokers can release milestones and file disputes.
 */
export function brokerSessionConstraints(
  escrowAddresses: Address[],
  maxSpendUsdc: bigint = 5_000_000_000n, // $5000
  durationHours = 24,
): SessionConstraints {
  return {
    allowedContracts: escrowAddresses,
    allowedSelectors: [ESCROW_SELECTORS.release, ESCROW_SELECTORS.fileDispute],
    maxSpend: maxSpendUsdc,
    validUntil: Math.floor(Date.now() / 1000) + durationHours * 3600,
    maxOps: 200,
  };
}

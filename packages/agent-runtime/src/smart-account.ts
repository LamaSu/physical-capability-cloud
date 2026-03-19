/**
 * Smart Account — PCC-specific session module types and helpers.
 *
 * The actual ERC-4337 smart account, session key management, UserOp queue,
 * and paymaster live in @pcc/bundler. This module provides:
 *
 * 1. PCC-specific operation types (escrow.lock, evidence.submit, etc.)
 * 2. SpendingPolicy → SessionConstraints mapping
 * 3. SmartAccountManager as a convenience wrapper
 *
 * For the full implementation, see:
 * - @pcc/bundler/smart-account.ts (EOA → ERC-4337 upgrade)
 * - @pcc/bundler/session-keys.ts (SessionKeyManager with real key generation)
 * - @pcc/bundler/user-op-queue.ts (batched UserOps)
 * - @pcc/bundler/paymaster.ts (gas sponsorship)
 * - @pcc/bundler/batch-settler.ts (epoch-based settlement)
 */

import type { SpendingPolicy } from "./spending-policy.js";

// ---------------------------------------------------------------------------
// PCC-specific operation types
// ---------------------------------------------------------------------------

/** PCC kernel operations that can be authorized via session keys */
export type PccKernelOperation =
  | "escrow.lock"
  | "escrow.fulfillMilestone"
  | "evidence.submit"
  | "capability.updateStatus"
  | "sensor.reportReading"
  | "reputation.giveFeedback"
  | "identity.register"
  | "identity.setMetadata";

/** PCC session module defining allowed kernel operations */
export interface PccSessionModule {
  type: "pcc-kernel-operations";
  allowedOperations: PccKernelOperation[];
  spendingPolicy: SpendingPolicy;
}

// ---------------------------------------------------------------------------
// Smart Account Configuration
// ---------------------------------------------------------------------------

/** Configuration for deploying a smart account */
export interface SmartAccountConfig {
  owners: `0x${string}`[];
  threshold: number;
  modules: PccSessionModule[];
  salt?: bigint;
}

/** Session key config — maps to @pcc/bundler SessionConstraints */
export interface SessionKeyConfig {
  validAfter: number;
  validUntil: number;
  allowedContracts: `0x${string}`[];
  allowedFunctions: `0x${string}`[];
  maxSpendPerTx: bigint;
  maxSpendTotal: bigint;
  maxTxCount: number;
}

/** Active session key with tracking state */
export interface SessionKey {
  id: string;
  config: SessionKeyConfig;
  privateKey: `0x${string}`;
  address: `0x${string}`;
  txCount: number;
  totalSpent: bigint;
  revoked: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Function selector map for PCC operations
// ---------------------------------------------------------------------------

/** Maps PCC operations to Solidity function selectors */
export const PCC_OPERATION_SELECTORS: Record<PccKernelOperation, `0x${string}`> = {
  "escrow.lock": "0xa1b2c3d4",
  "escrow.fulfillMilestone": "0xe5f6a7b8",
  "evidence.submit": "0xc9d0e1f2",
  "capability.updateStatus": "0x3a4b5c6d",
  "sensor.reportReading": "0x7e8f9a0b",
  "reputation.giveFeedback": "0x1c2d3e4f",
  "identity.register": "0x5a6b7c8d",
  "identity.setMetadata": "0x9e0f1a2b",
};

// ---------------------------------------------------------------------------
// SmartAccountManager — convenience wrapper
// ---------------------------------------------------------------------------

/**
 * SmartAccountManager wraps session key management with PCC-specific
 * operation mapping. For the underlying ERC-4337 implementation, see
 * @pcc/bundler's SessionKeyManager.
 *
 * This class can be used standalone (mock mode) or as a bridge to the
 * bundler's SessionKeyManager.
 */
export class SmartAccountManager {
  private sessionKeys = new Map<string, SessionKey>();
  private config: SmartAccountConfig;
  private keyCounter = 0;

  constructor(config: SmartAccountConfig) {
    this.config = config;
  }

  /** Create a session key with the given constraints */
  createSessionKey(keyConfig: SessionKeyConfig): SessionKey {
    const id = `session-${++this.keyCounter}`;
    const mockAddress = `0x${"a".repeat(38)}${this.keyCounter.toString(16).padStart(2, "0")}` as `0x${string}`;
    const mockPrivateKey = `0x${"b".repeat(62)}${this.keyCounter.toString(16).padStart(2, "0")}` as `0x${string}`;

    const sessionKey: SessionKey = {
      id,
      config: keyConfig,
      privateKey: mockPrivateKey,
      address: mockAddress,
      txCount: 0,
      totalSpent: 0n,
      revoked: false,
      createdAt: Date.now(),
    };

    this.sessionKeys.set(id, sessionKey);
    return sessionKey;
  }

  /** Revoke a session key */
  revokeSessionKey(sessionKeyId: string): void {
    const key = this.sessionKeys.get(sessionKeyId);
    if (!key) throw new Error(`Session key not found: ${sessionKeyId}`);
    key.revoked = true;
  }

  /** Check if a transaction is authorized by a session key */
  authorizeTransaction(
    sessionKeyId: string,
    targetContract: `0x${string}`,
    functionSelector: `0x${string}`,
    value: bigint,
  ): { authorized: boolean; reason?: string } {
    const key = this.sessionKeys.get(sessionKeyId);
    if (!key) return { authorized: false, reason: "Session key not found" };
    if (key.revoked) return { authorized: false, reason: "Session key revoked" };

    const now = Math.floor(Date.now() / 1000);
    if (now < key.config.validAfter) return { authorized: false, reason: "Session key not yet valid" };
    if (now > key.config.validUntil) return { authorized: false, reason: "Session key expired" };

    if (!key.config.allowedContracts.includes(targetContract)) {
      return { authorized: false, reason: `Contract ${targetContract} not in allowlist` };
    }

    if (!key.config.allowedFunctions.includes(functionSelector)) {
      return { authorized: false, reason: `Function ${functionSelector} not in allowlist` };
    }

    if (value > key.config.maxSpendPerTx) {
      return { authorized: false, reason: `Amount ${value} exceeds per-tx limit ${key.config.maxSpendPerTx}` };
    }

    if (key.totalSpent + value > key.config.maxSpendTotal) {
      return { authorized: false, reason: `Total spend would exceed session limit` };
    }

    if (key.txCount >= key.config.maxTxCount) {
      return { authorized: false, reason: `Transaction count limit reached` };
    }

    return { authorized: true };
  }

  /** Record a completed transaction against a session key */
  recordTransaction(sessionKeyId: string, amount: bigint): void {
    const key = this.sessionKeys.get(sessionKeyId);
    if (!key) throw new Error(`Session key not found: ${sessionKeyId}`);
    key.txCount++;
    key.totalSpent += amount;
  }

  /** Get all active (non-revoked, non-expired) session keys */
  getActiveKeys(): SessionKey[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.sessionKeys.values()].filter(
      (k) => !k.revoked && now >= k.config.validAfter && now <= k.config.validUntil,
    );
  }

  /** Get the smart account configuration */
  getConfig(): SmartAccountConfig {
    return this.config;
  }

  /**
   * Create a session key pre-configured for PCC kernel operations.
   * Maps a PccSessionModule to session key constraints using the
   * PCC_OPERATION_SELECTORS map.
   */
  createKernelSessionKey(
    module: PccSessionModule,
    escrowContract: `0x${string}`,
    identityRegistry: `0x${string}`,
    durationSeconds: number = 86400,
  ): SessionKey {
    const now = Math.floor(Date.now() / 1000);

    return this.createSessionKey({
      validAfter: now,
      validUntil: now + durationSeconds,
      allowedContracts: [escrowContract, identityRegistry],
      allowedFunctions: module.allowedOperations.map(
        (op) => PCC_OPERATION_SELECTORS[op],
      ),
      maxSpendPerTx: module.spendingPolicy.maxPerTransaction,
      maxSpendTotal: module.spendingPolicy.maxPerWindow,
      maxTxCount: 1000,
    });
  }
}

/**
 * ERC-4337 bundler types — UserOperations, smart account config, batch settlement.
 */

import type { Address, Chain, Hex } from "viem";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BundlerConfig {
  /** Bundler RPC URL (Pimlico, Alchemy, Stackup, or self-hosted) */
  bundlerUrl: string;
  /** Paymaster RPC URL (optional — if not set, agents pay their own gas) */
  paymasterUrl?: string;
  /** Chain to use */
  chain: Chain;
  /** RPC URL for the underlying chain */
  rpcUrl?: string;
  /** EntryPoint version */
  entryPoint?: "0.6" | "0.7";
}

export interface SmartAccountConfig {
  /** EOA signer private key */
  privateKey: Hex;
  /** Smart account implementation */
  implementation?: "simple" | "kernel" | "safe";
  /** Bundler config */
  bundler: BundlerConfig;
  /** Salt nonce for counterfactual deployment */
  saltNonce?: bigint;
}

// ---------------------------------------------------------------------------
// UserOperation
// ---------------------------------------------------------------------------

export interface UserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

export interface QueuedOperation {
  id: string;
  target: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  /** Timestamp when queued */
  queuedAt: number;
  /** Value of this operation in USDC atomic units (for threshold triggers) */
  usdcValue?: bigint;
}

// ---------------------------------------------------------------------------
// Batch settlement
// ---------------------------------------------------------------------------

export interface BatchConfig {
  /** Max operations per batch (default: 50) */
  maxBatchSize: number;
  /** Max time before auto-flush in ms (default: 600_000 = 10 min) */
  maxBatchAge: number;
  /** USDC value threshold that triggers flush (default: 1_000_000_000 = $1000) */
  valueThreshold: bigint;
  /** Whether to auto-flush on cadence (default: true) */
  autoFlush: boolean;
}

export interface BatchResult {
  /** UserOperation hash from the bundler */
  userOpHash: Hex;
  /** Number of operations batched */
  operationCount: number;
  /** Operation IDs included in this batch */
  operationIds: string[];
  /** Timestamp of flush */
  flushedAt: number;
  /** Whether this was an auto-flush or manual */
  trigger: "manual" | "size" | "age" | "value";
}

export interface QueueStatus {
  /** Number of operations in the queue */
  pending: number;
  /** Total USDC value of queued operations */
  totalValue: bigint;
  /** Age of oldest operation in ms */
  oldestAge: number;
  /** Whether auto-flush is active */
  autoFlush: boolean;
}

// ---------------------------------------------------------------------------
// Paymaster
// ---------------------------------------------------------------------------

export interface PaymasterConfig {
  /** Paymaster URL (Pimlico verifying paymaster, Alchemy gas manager, etc.) */
  url: string;
  /** Paymaster policy ID (for Pimlico/Alchemy hosted paymasters) */
  policyId?: string;
  /** Sponsorship mode */
  mode: "full" | "partial" | "none";
}

export interface SponsorshipResult {
  paymasterAndData: Hex;
  /** Estimated gas savings in wei */
  gasSaved: bigint;
  /** Whether sponsorship was granted */
  sponsored: boolean;
}

// ---------------------------------------------------------------------------
// Smart account state
// ---------------------------------------------------------------------------

export interface SmartAccountState {
  /** Smart account address (counterfactual — exists before deployment) */
  address: Address;
  /** Whether the account has been deployed on-chain */
  deployed: boolean;
  /** EOA signer address */
  signerAddress: Address;
  /** Current nonce */
  nonce: bigint;
  /** Implementation type */
  implementation: "simple" | "kernel" | "safe";
}

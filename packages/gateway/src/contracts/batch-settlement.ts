/**
 * Batch Settlement Service — epoch-based settlement via ERC-4337.
 *
 * Queues escrow operations (release, evidence, attestation, etc.) and
 * flushes them as batched UserOperations through a smart account.
 *
 * Env vars:
 *   PCC_BUNDLER_URL       — Bundler RPC (e.g., Pimlico API URL)
 *   PCC_PAYMASTER_URL     — Paymaster RPC (optional — for gas sponsorship)
 *   PCC_GATEWAY_PRIVATE_KEY — Same key used by escrow-client (required)
 *   PCC_BATCH_MAX_SIZE    — Max ops per batch (default: 50)
 *   PCC_BATCH_MAX_AGE_MS  — Max age before auto-flush in ms (default: 600000)
 *   PCC_BATCH_VALUE_THRESHOLD — USDC value threshold (default: 1000000000 = $1000)
 *   PCC_BATCH_AUTO_FLUSH  — Enable auto-flush (default: true)
 */

import type { Address, Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { MilestoneEscrowABI } from "@pcc/contracts";

import type {
  SmartAccountClient as SmartAccountClientType,
  UserOpQueue as UserOpQueueType,
  BatchSettler as BatchSettlerType,
  PaymasterClient as PaymasterClientType,
  SettlementIntent,
  BatchResult,
  EpochSummary,
  QueueStatus,
} from "@pcc/bundler";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BUNDLER_URL = process.env.PCC_BUNDLER_URL;
const PAYMASTER_URL = process.env.PCC_PAYMASTER_URL;
const GATEWAY_PRIVATE_KEY = process.env.PCC_GATEWAY_PRIVATE_KEY as Hex | undefined;

const BATCH_MAX_SIZE = parseInt(process.env.PCC_BATCH_MAX_SIZE ?? "50", 10);
const BATCH_MAX_AGE = parseInt(process.env.PCC_BATCH_MAX_AGE_MS ?? "600000", 10);
const BATCH_VALUE_THRESHOLD = BigInt(process.env.PCC_BATCH_VALUE_THRESHOLD ?? "1000000000");
const BATCH_AUTO_FLUSH = process.env.PCC_BATCH_AUTO_FLUSH !== "false";

// ---------------------------------------------------------------------------
// Singleton instances (lazy-initialized)
// ---------------------------------------------------------------------------

let _smartAccount: SmartAccountClientType | undefined;
let _queue: UserOpQueueType | undefined;
let _settler: BatchSettlerType | undefined;
let _paymaster: PaymasterClientType | undefined;
let _initialized = false;

/**
 * Initialize the batch settlement service.
 * Call once at gateway startup. Fails gracefully if bundler URL is not set.
 */
export async function initBatchSettlement(): Promise<boolean> {
  if (_initialized) return true;

  if (!BUNDLER_URL || !GATEWAY_PRIVATE_KEY) {
    console.log(
      "[batch-settlement] Disabled — set PCC_BUNDLER_URL and PCC_GATEWAY_PRIVATE_KEY to enable.",
    );
    return false;
  }

  try {
    const {
      SmartAccountClient,
      UserOpQueue,
      BatchSettler,
      PaymasterClient,
    } = await import("@pcc/bundler");

    _smartAccount = new SmartAccountClient({
      privateKey: GATEWAY_PRIVATE_KEY,
      bundler: {
        bundlerUrl: BUNDLER_URL,
        paymasterUrl: PAYMASTER_URL,
        chain: baseSepolia,
      },
    });

    _queue = new UserOpQueue(_smartAccount, {
      maxBatchSize: BATCH_MAX_SIZE,
      maxBatchAge: BATCH_MAX_AGE,
      valueThreshold: BATCH_VALUE_THRESHOLD,
      autoFlush: BATCH_AUTO_FLUSH,
    });

    _settler = new BatchSettler(_queue, MilestoneEscrowABI);

    if (PAYMASTER_URL) {
      _paymaster = new PaymasterClient({
        url: PAYMASTER_URL,
        mode: "full",
      });
    }

    _initialized = true;
    console.log(
      `[batch-settlement] Initialized — smart account: ${_smartAccount.smartAccountAddress}`,
    );
    return true;
  } catch (err) {
    console.error("[batch-settlement] Failed to initialize:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check if batch settlement is available */
export function isBatchEnabled(): boolean {
  return _initialized;
}

/** Get the smart account address */
export function getSmartAccountAddress(): Address | undefined {
  return _smartAccount?.smartAccountAddress;
}

/**
 * Submit a settlement intent to the batch queue.
 * Returns the queued operation ID.
 */
export function submitSettlement(intent: SettlementIntent): string {
  if (!_settler) {
    throw new Error("Batch settlement not initialized — call initBatchSettlement() first");
  }
  return _settler.submit(intent);
}

/**
 * Manually flush all pending settlements as a batch epoch.
 */
export async function flushSettlements(): Promise<EpochSummary> {
  if (!_settler) {
    throw new Error("Batch settlement not initialized");
  }
  return _settler.settle();
}

/**
 * Get the current queue status.
 */
export function getQueueStatus(): QueueStatus & { batchEnabled: boolean } {
  if (!_queue) {
    return {
      batchEnabled: false,
      pending: 0,
      totalValue: 0n,
      oldestAge: 0,
      autoFlush: false,
    };
  }
  return {
    batchEnabled: true,
    ...(_queue.getStatus()),
  };
}

/**
 * Get epoch history.
 */
export function getEpochHistory(): readonly EpochSummary[] {
  return _settler?.getEpochHistory() ?? [];
}

/**
 * Shut down the batch settlement service (stop auto-flush timer).
 */
export function stopBatchSettlement(): void {
  _queue?.stop();
}

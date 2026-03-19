/**
 * UserOp Queue — accumulates contract calls and flushes them as batched
 * UserOperations through the smart account's executeBatch().
 *
 * This is the core throughput multiplier. Instead of:
 *   Agent → 50 separate txs → 50 blocks
 *
 * We get:
 *   Agent → 50 ops queued → 1 batched UserOp → 1 block
 *
 * Flush triggers:
 * 1. Manual flush (API call or agent decision)
 * 2. Batch size limit (default: 50 ops)
 * 3. Batch age limit (default: 10 minutes)
 * 4. Value threshold (default: $1000 USDC accumulated)
 */

import { type Hex, type Address, encodeFunctionData } from "viem";
import { SmartAccountClient } from "./smart-account.js";
import type {
  QueuedOperation,
  BatchConfig,
  BatchResult,
  QueueStatus,
} from "./types.js";

const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxBatchSize: 50,
  maxBatchAge: 600_000, // 10 minutes
  valueThreshold: 1_000_000_000n, // $1000 USDC (6 decimals)
  autoFlush: true,
};

export class UserOpQueue {
  private queue: QueuedOperation[] = [];
  private config: BatchConfig;
  private smartAccount: SmartAccountClient;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private opCounter = 0;
  private flushHistory: BatchResult[] = [];

  constructor(smartAccount: SmartAccountClient, config: Partial<BatchConfig> = {}) {
    this.smartAccount = smartAccount;
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };

    if (this.config.autoFlush) {
      this.startAutoFlush();
    }
  }

  // ── Queue operations ────────────────────────────────────────────────

  /**
   * Add a contract call to the queue. Returns the operation ID.
   * The call won't execute until the queue is flushed.
   */
  enqueue(op: Omit<QueuedOperation, "id" | "queuedAt">): string {
    const id = `op-${++this.opCounter}-${Date.now().toString(36)}`;
    const queued: QueuedOperation = {
      ...op,
      id,
      queuedAt: Date.now(),
    };
    this.queue.push(queued);

    // Check if we should auto-flush (only when autoFlush is enabled)
    if (this.config.autoFlush && this.shouldFlush()) {
      // Fire and forget — don't block the enqueue
      this.flush(this.detectTrigger()).catch((err) => {
        console.error("[bundler] Auto-flush failed:", err);
      });
    }

    return id;
  }

  /**
   * Enqueue a typed contract call with a familiar interface.
   */
  enqueueCall(
    target: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[],
    options?: { value?: bigint; usdcValue?: bigint },
  ): string {
    return this.enqueue({
      target,
      abi,
      functionName,
      args,
      value: options?.value,
      usdcValue: options?.usdcValue,
    });
  }

  // ── Flush ───────────────────────────────────────────────────────────

  /**
   * Flush the queue — encode all queued operations into a single batched
   * UserOp and submit to the bundler.
   *
   * Returns the batch result with the UserOp hash.
   */
  async flush(trigger: BatchResult["trigger"] = "manual"): Promise<BatchResult | null> {
    if (this.queue.length === 0) return null;

    // Take all operations from the queue
    const ops = this.queue.splice(0, this.config.maxBatchSize);
    const operationIds = ops.map((op) => op.id);

    // Encode each operation into calldata
    const calls = ops.map((op) => this.smartAccount.encodeOperation(op));

    // Encode as batched execute
    let callData: Hex;
    if (calls.length === 1) {
      // Single call — use execute() instead of executeBatch()
      callData = this.smartAccount.encodeExecute(
        calls[0].target,
        calls[0].value,
        calls[0].data,
      );
    } else {
      // Multiple calls — batch them
      callData = this.smartAccount.encodeBatch(calls);
    }

    // Submit to bundler
    const userOpHash = await this.smartAccount.sendUserOp(callData);

    const result: BatchResult = {
      userOpHash,
      operationCount: ops.length,
      operationIds,
      flushedAt: Date.now(),
      trigger,
    };

    this.flushHistory.push(result);

    // Keep history bounded
    if (this.flushHistory.length > 100) {
      this.flushHistory = this.flushHistory.slice(-50);
    }

    return result;
  }

  // ── Status ──────────────────────────────────────────────────────────

  /** Get current queue status */
  getStatus(): QueueStatus {
    const totalValue = this.queue.reduce(
      (sum, op) => sum + (op.usdcValue ?? 0n),
      0n,
    );

    const oldestAge = this.queue.length > 0
      ? Date.now() - this.queue[0].queuedAt
      : 0;

    return {
      pending: this.queue.length,
      totalValue,
      oldestAge,
      autoFlush: this.config.autoFlush,
    };
  }

  /** Get recent flush history */
  getHistory(): readonly BatchResult[] {
    return this.flushHistory;
  }

  /** Get a specific operation by ID */
  getOperation(id: string): QueuedOperation | undefined {
    return this.queue.find((op) => op.id === id);
  }

  /** Remove a specific operation from the queue (before it's flushed) */
  cancel(id: string): boolean {
    const idx = this.queue.findIndex((op) => op.id === id);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  /** Update batch config at runtime */
  updateConfig(config: Partial<BatchConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart auto-flush timer if needed
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.config.autoFlush) {
      this.startAutoFlush();
    }
  }

  /** Stop the auto-flush timer */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private shouldFlush(): boolean {
    if (this.queue.length >= this.config.maxBatchSize) return true;

    const totalValue = this.queue.reduce(
      (sum, op) => sum + (op.usdcValue ?? 0n),
      0n,
    );
    if (totalValue >= this.config.valueThreshold) return true;

    return false;
  }

  private detectTrigger(): BatchResult["trigger"] {
    if (this.queue.length >= this.config.maxBatchSize) return "size";

    const totalValue = this.queue.reduce(
      (sum, op) => sum + (op.usdcValue ?? 0n),
      0n,
    );
    if (totalValue >= this.config.valueThreshold) return "value";

    return "age";
  }

  private startAutoFlush(): void {
    // Check every 10 seconds for age-based flushes
    this.flushTimer = setInterval(() => {
      if (this.queue.length === 0) return;

      const oldestAge = Date.now() - this.queue[0].queuedAt;
      if (oldestAge >= this.config.maxBatchAge) {
        this.flush("age").catch((err) => {
          console.error("[bundler] Age-based auto-flush failed:", err);
        });
      }
    }, 10_000);

    // Don't keep the process alive just for the flush timer
    if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
  }
}

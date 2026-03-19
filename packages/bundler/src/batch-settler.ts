/**
 * Batch Settler — epoch-based settlement for agent swarms.
 *
 * Instead of each agent sending individual transactions, the settler
 * collects settlement intents across multiple agents and escrow contracts,
 * then flushes them in batch epochs.
 *
 * Architecture:
 *   Agent 1 ─┐
 *   Agent 2 ─┼→ BatchSettler → UserOpQueue → SmartAccount → Bundler → Chain
 *   Agent N ─┘
 *
 * Epoch triggers:
 * - Time-based: every N minutes (default: 10)
 * - Value-based: when accumulated settlement value exceeds threshold
 * - Manual: API call from gateway
 *
 * This maps to the DePIN reward epoch pattern already in @pcc/contracts.
 */

import type { Address, Hex } from "viem";
import { UserOpQueue } from "./user-op-queue.js";
import type { BatchConfig, BatchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettlementIntent {
  /** Unique intent ID (from A2A message) */
  intentId: string;
  /** Agent that requested this settlement */
  agentId: string;
  /** Escrow contract address */
  escrowAddress: Address;
  /** Operation to perform */
  operation:
    | { type: "release"; milestoneIndex: number }
    | { type: "submitEvidence"; milestoneIndex: number; evidenceHash: Hex }
    | { type: "submitAttestation"; milestoneIndex: number; attestationHash: Hex }
    | { type: "depositBond"; milestoneIndex: number }
    | { type: "fund" }
    | { type: "fileDispute"; milestoneIndex: number; bond: bigint; evidenceHash: Hex; reason: string };
  /** USDC value of this settlement (for threshold triggers) */
  usdcValue?: bigint;
}

export interface EpochSummary {
  epochId: number;
  /** Batch results from this epoch (may be multiple if > maxBatchSize) */
  batches: BatchResult[];
  /** Total intents settled */
  totalIntents: number;
  /** Intents by agent */
  byAgent: Record<string, number>;
  /** Intents by operation type */
  byOperation: Record<string, number>;
  /** Start/end timestamps */
  startedAt: number;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Settler
// ---------------------------------------------------------------------------

export class BatchSettler {
  private queue: UserOpQueue;
  private intents: Map<string, SettlementIntent> = new Map();
  private epochCounter = 0;
  private epochHistory: EpochSummary[] = [];
  private escrowAbi: readonly unknown[];

  constructor(
    queue: UserOpQueue,
    escrowAbi: readonly unknown[],
  ) {
    this.queue = queue;
    this.escrowAbi = escrowAbi;
  }

  // ── Collect intents ─────────────────────────────────────────────────

  /**
   * Submit a settlement intent. The intent is queued and will be settled
   * in the next epoch flush.
   */
  submit(intent: SettlementIntent): string {
    this.intents.set(intent.intentId, intent);

    // Encode the intent as a queued operation
    const { functionName, args } = this.encodeIntent(intent);

    return this.queue.enqueueCall(
      intent.escrowAddress,
      this.escrowAbi,
      functionName,
      args,
      { usdcValue: intent.usdcValue },
    );
  }

  /**
   * Cancel a pending settlement intent (before it's flushed).
   */
  cancel(intentId: string): boolean {
    const intent = this.intents.get(intentId);
    if (!intent) return false;
    this.intents.delete(intentId);
    return true;
  }

  // ── Epoch flush ─────────────────────────────────────────────────────

  /**
   * Flush all pending intents as a settlement epoch.
   * May produce multiple batches if intents exceed maxBatchSize.
   */
  async settle(): Promise<EpochSummary> {
    const epochId = ++this.epochCounter;
    const startedAt = Date.now();

    // Snapshot current intents
    const settlingIntents = new Map(this.intents);
    this.intents.clear();

    // Count by agent and operation
    const byAgent: Record<string, number> = {};
    const byOperation: Record<string, number> = {};
    for (const intent of settlingIntents.values()) {
      byAgent[intent.agentId] = (byAgent[intent.agentId] ?? 0) + 1;
      byOperation[intent.operation.type] = (byOperation[intent.operation.type] ?? 0) + 1;
    }

    // Flush the queue (may produce multiple batches)
    const batches: BatchResult[] = [];
    let batch = await this.queue.flush("manual");
    while (batch) {
      batches.push(batch);
      // Check if there are more ops in queue (from other sources)
      const status = this.queue.getStatus();
      if (status.pending > 0) {
        batch = await this.queue.flush("manual");
      } else {
        batch = null;
      }
    }

    const summary: EpochSummary = {
      epochId,
      batches,
      totalIntents: settlingIntents.size,
      byAgent,
      byOperation,
      startedAt,
      completedAt: Date.now(),
    };

    this.epochHistory.push(summary);

    // Keep history bounded
    if (this.epochHistory.length > 100) {
      this.epochHistory = this.epochHistory.slice(-50);
    }

    return summary;
  }

  // ── Status ──────────────────────────────────────────────────────────

  /** Get pending intent count */
  get pendingCount(): number {
    return this.intents.size;
  }

  /** Get epoch history */
  getEpochHistory(): readonly EpochSummary[] {
    return this.epochHistory;
  }

  /** Get the queue's status */
  getQueueStatus() {
    return this.queue.getStatus();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private encodeIntent(intent: SettlementIntent): {
    functionName: string;
    args: readonly unknown[];
  } {
    const op = intent.operation;
    switch (op.type) {
      case "release":
        return { functionName: "release", args: [BigInt(op.milestoneIndex)] };
      case "submitEvidence":
        return {
          functionName: "submitEvidence",
          args: [BigInt(op.milestoneIndex), op.evidenceHash],
        };
      case "submitAttestation":
        return {
          functionName: "submitAttestation",
          args: [BigInt(op.milestoneIndex), op.attestationHash],
        };
      case "depositBond":
        return { functionName: "depositBond", args: [BigInt(op.milestoneIndex)] };
      case "fund":
        return { functionName: "fund", args: [] };
      case "fileDispute":
        return {
          functionName: "fileDispute",
          args: [BigInt(op.milestoneIndex), op.bond, op.evidenceHash, op.reason],
        };
    }
  }
}

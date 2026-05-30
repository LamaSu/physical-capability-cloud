/**
 * In-process federation replicator stub.
 *
 * Phase 1: minimal adapter that conforms to the @pcc/aggregator
 * ReplicatorAdapter contract (structurally — we don't import the
 * interface here to avoid a dep cycle). It captures upsert / remove
 * events into in-memory queues + per-tool CRDT slots so the gateway
 * can flip the federation flag without losing data.
 *
 * Phase 2 will replace this with the real CDC consumer + DHT publisher;
 * the gateway-side wiring stays the same.
 *
 * Why this lives in @pcc/federation: the aggregator package only
 * defines the seam; the federation package provides the implementation.
 * This way the aggregator never depends on the federation runtime.
 */

import type { IndexedTool } from "@pcc/spec";
import {
  createGCounter,
  createTaggedFraction,
  createLWWRegister,
  gCounterIncrement,
  taggedFractionRecord,
  lwwRegisterWrite,
  type GCounterState,
  type TaggedFractionState,
  type LWWRegisterState,
} from "./crdts/index.js";
import { replicaIdFromContext, type ServerContext } from "./server.js";

/**
 * Per-tool CRDT slot held by the replicator stub. Keyed by IndexedTool.id.
 *
 * The four slots map 1:1 to the volatile-field set per scope §7.3.
 * Phase 1: in-memory only; Phase 2 persists to Postgres via @pcc/store.
 */
export interface ToolCrdtSlot {
  invocationCount: GCounterState;
  successCounts: TaggedFractionState;
  latencySums: TaggedFractionState;
  lastInvokedAt: LWWRegisterState<string>;
}

export interface PhaseOneReplicatorStats {
  /** Tools the replicator has seen at least one upsert for. */
  toolsTracked: number;
  /** Total onUpsert calls observed. */
  upsertEvents: number;
  /** Total onRemove calls observed. */
  removeEvents: number;
  /** Pending CRDT delta count (Phase 2 will flush these to peers). */
  pendingDeltas: number;
}

/**
 * Phase 1 replicator stub. Tracks CRDT slots per tool but does NOT
 * propagate cross-region — that's Phase 2's job. Phase 1 callers can
 * observe the slots locally for testing the merge pipeline.
 */
export class PhaseOneReplicator {
  private slots = new Map<string, ToolCrdtSlot>();
  private upsertCount = 0;
  private removeCount = 0;
  private pendingDeltas = 0;
  private replicaId: string;

  constructor(ctx: ServerContext) {
    this.replicaId = replicaIdFromContext(ctx);
  }

  /** ReplicatorAdapter.onUpsert — fires from the IndexedToolRegistry. */
  onUpsert(tool: IndexedTool): void {
    this.upsertCount++;
    const slot = this.getOrCreateSlot(tool.id);
    // Seed the G-Counter with the scalar invocationCount on first
    // sight; subsequent upserts are idempotent on the seed.
    if (
      tool.invocationCount > 0 &&
      Object.keys(slot.invocationCount.slots).length === 0
    ) {
      slot.invocationCount = gCounterIncrement(
        slot.invocationCount,
        this.replicaId,
        tool.invocationCount,
      );
    }
    // Mark a pending delta — Phase 2 flushes this to the peer regions.
    this.pendingDeltas++;
  }

  /** ReplicatorAdapter.onRemove — fires from the IndexedToolRegistry. */
  onRemove(id: string): void {
    this.removeCount++;
    this.slots.delete(id);
    this.pendingDeltas++;
  }

  /**
   * Record an invocation outcome. Called by the gateway's invoke
   * proxy after a successful tool call. Updates per-replica CRDT
   * slots for all four volatile fields.
   */
  recordInvocation(
    toolId: string,
    outcome: {
      success: boolean;
      latencyMs: number;
      invokedAt?: string;
    },
  ): void {
    const slot = this.getOrCreateSlot(toolId);
    slot.invocationCount = gCounterIncrement(
      slot.invocationCount,
      this.replicaId,
    );
    slot.successCounts = taggedFractionRecord(
      slot.successCounts,
      this.replicaId,
      outcome.success ? 1 : 0,
      1,
    );
    slot.latencySums = taggedFractionRecord(
      slot.latencySums,
      this.replicaId,
      outcome.latencyMs,
      1,
    );
    slot.lastInvokedAt = lwwRegisterWrite(
      slot.lastInvokedAt,
      this.replicaId,
      outcome.invokedAt ?? new Date().toISOString(),
    );
    this.pendingDeltas++;
  }

  /** Inspect the CRDT slot for a tool (Phase 1 read path). */
  getSlot(toolId: string): ToolCrdtSlot | undefined {
    return this.slots.get(toolId);
  }

  /** Number of tools with at least one CRDT slot. */
  getStats(): PhaseOneReplicatorStats {
    return {
      toolsTracked: this.slots.size,
      upsertEvents: this.upsertCount,
      removeEvents: this.removeCount,
      pendingDeltas: this.pendingDeltas,
    };
  }

  /** Phase 2 hook: would flush deltas to peer regions; Phase 1 is a no-op. */
  async start(): Promise<void> {
    // No background work in Phase 1.
  }

  async stop(): Promise<void> {
    // Nothing to clean up in Phase 1.
  }

  private getOrCreateSlot(toolId: string): ToolCrdtSlot {
    const existing = this.slots.get(toolId);
    if (existing) return existing;
    const fresh: ToolCrdtSlot = {
      invocationCount: createGCounter(),
      successCounts: createTaggedFraction(),
      latencySums: createTaggedFraction(),
      lastInvokedAt: createLWWRegister<string>(),
    };
    this.slots.set(toolId, fresh);
    return fresh;
  }
}

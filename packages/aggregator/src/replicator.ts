/**
 * Replicator adapter — pluggable hook for federation replication.
 *
 * Per scope §10.6. The aggregator's IndexedToolRegistry accepts an
 * optional ReplicatorAdapter. Default behavior (no adapter) is
 * unchanged single-region in-memory. When supplied, every `upsert` /
 * `remove` also fires the adapter, which forwards the event to the
 * federation runtime (CRDT delta emission, Postgres write-through,
 * eventual DHT publish in Phase 2).
 *
 * The interface lives in @pcc/aggregator (not @pcc/federation) so
 * @pcc/federation never has to depend on the aggregator and we avoid a
 * cycle. The federation package exposes a CONCRETE adapter that
 * conforms to this shape.
 *
 * Phase 1 (this commit): interface + no-op default. The federation
 * package's actual replicator is a stub; the gateway can opt in with
 * the env var PCC_FEDERATION_REPLICATOR=on.
 */

import type { IndexedTool } from "@pcc/spec";

/**
 * Replicator events. Both fire synchronously from inside `upsert` /
 * `remove`; the adapter is responsible for any async work (queueing,
 * batching, retries).
 *
 * Adapters MUST NOT throw — failures are theirs to log + retry. The
 * registry returns successfully regardless of replicator state so the
 * caller-facing API is unaffected by federation transport issues.
 */
export interface ReplicatorAdapter {
  /**
   * Called after a successful `IndexedToolRegistry.upsert(tool)`.
   * The tool passed in is the post-upsert state (Phase 1 federation
   * fields populated if the registry's region-context is set).
   */
  onUpsert(tool: IndexedTool): void | Promise<void>;

  /**
   * Called after a successful `IndexedToolRegistry.remove(id)`.
   * The id is the removed tool's id.
   */
  onRemove(id: string): void | Promise<void>;

  /**
   * Called during gateway boot to give the adapter a chance to load
   * peer state / open Postgres connections / start CDC consumers.
   * Optional — defaults to no-op.
   */
  start?(): Promise<void>;

  /**
   * Called during graceful shutdown.
   */
  stop?(): Promise<void>;
}

/**
 * No-op replicator used when federation is disabled. Exposed so callers
 * can be unconditional about constructing an adapter.
 */
export const NoOpReplicator: ReplicatorAdapter = {
  onUpsert(): void {},
  onRemove(): void {},
};

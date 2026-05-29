/**
 * In-memory IndexedTool registry.
 *
 * This is the Phase 1 storage backend — a simple Map<id, IndexedTool>
 * with a handful of query helpers. Phase 2+ swaps this for the DB-backed
 * implementation in @pcc/store (drizzle + sqlite) without changing the
 * public method shape.
 *
 * Why in-memory first: the gateway boots fast, the aggregator pipeline
 * is fully exercisable in tests with no DB setup, and the data shape
 * is identical to what the DB layer will store. The swap is a constructor
 * argument away.
 *
 * Thread-safety: the gateway is single-threaded Fastify; no locking
 * needed. If/when we move to workers, the registry adapter changes.
 *
 * Phase 1 federation extension (additive, backward-compatible):
 *   - Optional `replicator` adapter — when set, every upsert/remove
 *     also fires the replicator. Default no-op preserves single-region
 *     behavior.
 *   - Optional `regionContext` — when set, every upserted tool gets
 *     its regionId / meshId / namespaceId populated. Default leaves
 *     them undefined.
 *   - New `queryByNamespace()` shortcut for namespace-faceted reads.
 */

import type { IndexedTool, IndexedToolActionClass, TrustTier } from "@pcc/spec";
import { NoOpReplicator, type ReplicatorAdapter } from "./replicator.js";

/** Filter passed to `query()`. All fields are AND-combined. */
export interface RegistryQuery {
  /** Substring match (case-insensitive) on description + skills. */
  q?: string;
  /** Filter by action class. */
  actionClass?: IndexedToolActionClass;
  /** Filter by trust tier (only show tools at or above this tier). */
  minTrustTier?: TrustTier;
  /** Filter to a single skill (exact match against IndexedTool.skills[]). */
  skill?: string;
  /** Filter to a single domain (exact match against IndexedTool.domains[]). */
  domain?: string;
  /**
   * Phase 1 federation extension. Filter to a single namespace
   * (exact match). When undefined, tools from ALL namespaces are
   * returned — preserves pre-federation behavior.
   */
  namespaceId?: string;
  /** Page size. Defaults to 50, max 200. */
  limit?: number;
  /** Pagination offset. Defaults to 0. */
  offset?: number;
}

/**
 * Optional region context. When set, upserted tools get tagged with
 * the running server's (region, mesh) coordinates and a default
 * namespace. Per scope §3.3 + §11.1.
 */
export interface RegistryRegionContext {
  regionId: string;
  meshId: string;
  /** Default namespace to apply when a tool is upserted with no namespaceId. */
  defaultNamespaceId: string;
}

export interface IndexedToolRegistryOpts {
  /**
   * Optional federation replicator. When undefined, the registry
   * behaves as it did pre-federation: writes hit the in-memory Map
   * and that's it.
   */
  replicator?: ReplicatorAdapter;
  /**
   * Optional region context. When undefined, federation fields on
   * upserted tools are left as the caller passed them in (typically
   * undefined for the Phase 1 default).
   */
  regionContext?: RegistryRegionContext;
}

/** Numeric ordering for trust tiers (only used inside this module). */
const TIER_RANK: Record<TrustTier, number> = {
  QUARANTINED: -1,
  UNTRUSTED: 0,
  AUTO_INDEXED: 1,
  VERIFIED_PUBLISHER: 2,
  VERIFIED_PARTNER: 3,
  PCC_NATIVE: 4,
} as Record<TrustTier, number>;

/** In-memory IndexedTool storage. */
export class IndexedToolRegistry {
  private byId = new Map<string, IndexedTool>();
  private readonly replicator: ReplicatorAdapter;
  private readonly regionContext: RegistryRegionContext | undefined;

  constructor(opts: IndexedToolRegistryOpts = {}) {
    this.replicator = opts.replicator ?? NoOpReplicator;
    this.regionContext = opts.regionContext;
  }

  /**
   * Insert or update an IndexedTool. The id is the primary key.
   *
   * When a region context is configured, the tool's regionId / meshId
   * / namespaceId are populated from the context (caller-provided
   * values win on collision — explicit > implicit). The replicator's
   * onUpsert fires after the local write succeeds.
   */
  upsert(tool: IndexedTool): IndexedTool {
    const tagged = this.applyRegionContext(tool);
    this.byId.set(tagged.id, tagged);
    // Fire the replicator after the local write is committed. Adapters
    // are responsible for their own error handling and async work, but
    // we guard against sync throws too so a buggy adapter can't break
    // the caller-facing API.
    this.fireReplicator(() => this.replicator.onUpsert(tagged));
    return tagged;
  }

  /** Remove a tool by id. Returns true if present. */
  remove(id: string): boolean {
    const had = this.byId.delete(id);
    if (had) {
      this.fireReplicator(() => this.replicator.onRemove(id));
    }
    return had;
  }

  /**
   * Invoke a replicator hook, isolating any thrown error (sync or
   * async). Adapter failures must not impact the local upsert/remove —
   * logging is the adapter's responsibility.
   */
  private fireReplicator(fn: () => void | Promise<void>): void {
    try {
      const ret = fn();
      if (ret && typeof (ret as Promise<void>).catch === "function") {
        (ret as Promise<void>).catch(() => {});
      }
    } catch {
      // Sync throw swallowed by design.
    }
  }

  /** Total number of tools currently in the registry. */
  count(): number {
    return this.byId.size;
  }

  /** Get one tool by id. */
  get(id: string): IndexedTool | undefined {
    return this.byId.get(id);
  }

  /** Return all tools (no filter, no pagination). For tests / admin only. */
  all(): IndexedTool[] {
    return Array.from(this.byId.values());
  }

  /**
   * Query the registry.
   *
   * Phase 1: linear scan + substring matching. Returns a deterministic
   * order (by id, asc) so pagination is stable. Phase 2 swaps in Vespa /
   * pgvector hybrid search via the same shape.
   */
  query(filter: RegistryQuery = {}): IndexedTool[] {
    const q = filter.q?.toLowerCase();
    const minRank =
      filter.minTrustTier !== undefined ? TIER_RANK[filter.minTrustTier] : null;

    let results = Array.from(this.byId.values()).filter((tool) => {
      if (q) {
        const hay = (
          tool.description +
          " " +
          tool.skills.join(" ")
        ).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter.actionClass && tool.actionClass !== filter.actionClass) {
        return false;
      }
      if (minRank !== null && TIER_RANK[tool.trustTier] < minRank) {
        return false;
      }
      if (filter.skill && !tool.skills.includes(filter.skill)) return false;
      if (filter.domain && !tool.domains.includes(filter.domain)) return false;
      if (filter.namespaceId) {
        const effective =
          tool.namespaceId ?? this.regionContext?.defaultNamespaceId;
        if (effective !== filter.namespaceId) return false;
      }
      return true;
    });

    // Deterministic order for stable pagination.
    results.sort((a, b) => a.id.localeCompare(b.id));

    const offset = Math.max(0, filter.offset ?? 0);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    return results.slice(offset, offset + limit);
  }

  /**
   * Phase 1 federation extension — list tools belonging to a specific
   * namespace. Convenience over `query({ namespaceId })`.
   */
  queryByNamespace(
    namespaceId: string,
    rest: Omit<RegistryQuery, "namespaceId"> = {},
  ): IndexedTool[] {
    return this.query({ ...rest, namespaceId });
  }

  /** Clear all entries (for tests). */
  clear(): void {
    this.byId.clear();
  }

  /**
   * Apply the region context to a tool, populating regionId / meshId /
   * namespaceId if they're undefined. Caller-supplied values always
   * win. No-op when no context is configured.
   */
  private applyRegionContext(tool: IndexedTool): IndexedTool {
    if (!this.regionContext) return tool;
    return {
      ...tool,
      regionId: tool.regionId ?? this.regionContext.regionId,
      meshId: tool.meshId ?? this.regionContext.meshId,
      namespaceId: tool.namespaceId ?? this.regionContext.defaultNamespaceId,
    };
  }
}

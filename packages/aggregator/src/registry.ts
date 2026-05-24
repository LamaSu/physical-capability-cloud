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
 */

import type { IndexedTool, IndexedToolActionClass, TrustTier } from "@pcc/spec";

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
  /** Page size. Defaults to 50, max 200. */
  limit?: number;
  /** Pagination offset. Defaults to 0. */
  offset?: number;
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

  /** Insert or update an IndexedTool. The id is the primary key. */
  upsert(tool: IndexedTool): IndexedTool {
    this.byId.set(tool.id, tool);
    return tool;
  }

  /** Remove a tool by id. Returns true if present. */
  remove(id: string): boolean {
    return this.byId.delete(id);
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
      return true;
    });

    // Deterministic order for stable pagination.
    results.sort((a, b) => a.id.localeCompare(b.id));

    const offset = Math.max(0, filter.offset ?? 0);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    return results.slice(offset, offset + limit);
  }

  /** Clear all entries (for tests). */
  clear(): void {
    this.byId.clear();
  }
}

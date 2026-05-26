/**
 * Bridge that adapts IndexedToolRegistry to the @pcc/tool-index HybridRanker.
 *
 * The registry stores IndexedTool entries. The hybrid ranker operates on
 * the same spec IndexedTool shape — this bridge wires the two together
 * so the gateway routes get one ranker abstraction across both
 * @pcc/tool-index (PCC's own 218 tools) and @pcc/aggregator (the
 * federated tool catalog).
 *
 * Lifecycle: the bridge holds a HybridRanker instance, mirrors registry
 * upserts/removes into the ranker's inverted index, and rebuilds from
 * scratch on reset/seed.
 *
 * Phase 2 ships the in-memory HybridRanker. Phase 3 swaps backends via
 * the RankerBackend interface (no bridge change required).
 */

import {
  HybridRanker,
  HashFallbackProvider,
  selectEmbeddingProvider,
  type EmbeddingProvider,
  type RankedHit,
  type RankerQuery,
} from "@pcc/tool-index";
import type { IndexedTool } from "@pcc/spec";
import type { IndexedToolRegistry } from "./registry.js";

/**
 * Wrap an IndexedToolRegistry with a HybridRanker. The bridge is a separate
 * object so callers can opt in to ranker functionality without changing the
 * Registry API; the legacy `registry.query()` substring search continues
 * to work.
 */
export class RegistryRankerBridge {
  private readonly ranker: HybridRanker;

  constructor(
    private readonly registry: IndexedToolRegistry,
    provider: EmbeddingProvider = selectEmbeddingProvider(),
  ) {
    this.ranker = new HybridRanker(provider);
    // Seed from the existing registry contents.
    this.reseedFromRegistry();
  }

  /** Rebuild the ranker index from the current registry contents. */
  reseedFromRegistry(): void {
    // Fire-and-forget — reset() is synchronous-from-the-caller-viewpoint
    // (just clears + re-adds in memory). The Promise it returns has no
    // failure mode that the caller can recover from at this site.
    void this.ranker.reset(this.registry.all());
  }

  /** Mirror an upsert into the ranker. */
  async upsert(tool: IndexedTool): Promise<void> {
    this.registry.upsert(tool);
    await this.ranker.upsert(tool);
  }

  /** Mirror a remove into the ranker. */
  async remove(id: string): Promise<boolean> {
    const had = this.registry.remove(id);
    await this.ranker.remove(id);
    return had;
  }

  /** Inspect the live ranker (for tests + status endpoints). */
  get rankerInstance(): HybridRanker {
    return this.ranker;
  }

  /** Run a full hybrid rank query. Returns top-K RankedHits. */
  async rank(query: RankerQuery): Promise<RankedHit[]> {
    return this.ranker.rank(query);
  }
}

/**
 * Convenience factory that picks a sensible default provider when none is
 * supplied. Used by the gateway boot path where we don't want a hard
 * dependency on env var resolution at construction time.
 */
export function createRegistryRanker(
  registry: IndexedToolRegistry,
  provider?: EmbeddingProvider,
): RegistryRankerBridge {
  return new RegistryRankerBridge(registry, provider ?? new HashFallbackProvider());
}

/**
 * Single-region default implementation of the Region interface.
 *
 * This is what the gateway uses in Phase 1: one-region deployment with
 * everything served from the local mesh. It satisfies the Region
 * contract so the gateway code that consumes Region doesn't have to
 * branch on "is this Phase 1 or Phase 2".
 *
 * The implementation delegates discovery / resolve to a caller-provided
 * `SingleRegionBackend` — typically the existing IndexedToolRegistry
 * from @pcc/aggregator. That keeps the federation package free of
 * aggregator deps (no cycle).
 *
 * Phase 2 will provide a different impl backed by Kademlia and a
 * cross-region fan-out router.
 */

import type {
  Region,
  RegionCidLocator,
  RegionConfig,
  RegionSearchRequest,
  RegionSearchResponse,
  RegionSearchResult,
  MeshId,
} from "./types.js";

/**
 * Pluggable backend for the single-region impl. The aggregator
 * gateway provides an adapter around its IndexedToolRegistry.
 */
export interface SingleRegionBackend {
  /** Run a local search and return a flat result list. */
  localSearch(req: RegionSearchRequest): Promise<RegionSearchResult[]>;
  /** Resolve a CID locally — return null if not found. */
  localResolveCid(cid: string): Promise<{
    toolId: string;
    mesh: MeshId;
  } | null>;
}

/**
 * SingleRegion — Phase 1 default implementation.
 *
 * No cross-region traffic. `crossRegionFanoutFired` is always false;
 * `partial` is always false. The locator only ever references this
 * region.
 */
export class SingleRegion implements Region {
  readonly config: RegionConfig;
  private backend: SingleRegionBackend;
  private stopped = false;

  constructor(config: RegionConfig, backend: SingleRegionBackend) {
    this.config = config;
    this.backend = backend;
  }

  async search(request: RegionSearchRequest): Promise<RegionSearchResponse> {
    if (this.stopped) {
      throw new Error("SingleRegion is stopped");
    }
    const results = await this.backend.localSearch(request);
    return {
      region: this.config.id,
      results,
      crossRegionFanoutFired: false,
      partial: false,
    };
  }

  async resolveCid(cid: string): Promise<RegionCidLocator | null> {
    if (this.stopped) {
      throw new Error("SingleRegion is stopped");
    }
    const found = await this.backend.localResolveCid(cid);
    if (!found) return null;
    return {
      cid,
      regions: [
        {
          region: this.config.id,
          url: this.config.publicGatewayUrl,
          lastSeenAt: new Date().toISOString(),
        },
      ],
    };
  }

  async announce(_args: {
    cid: string;
    mesh: MeshId;
    skills: string[];
  }): Promise<void> {
    // No-op in Phase 1. The local registry is the source of truth;
    // there are no peers to publish to.
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

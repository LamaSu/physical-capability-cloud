/**
 * Region — typed interface for the cross-region discovery & replication
 * layer.
 *
 * Phase 1 (this commit): types + single-region default implementation
 * that satisfies the interface in-process. No cross-region traffic; all
 * lookups resolve against the local mesh. This is exactly the
 * deployment we have today (us-east-1 single-region).
 *
 * Phase 2: drop in a real Kademlia DHT (libp2p-kad-dht) per scope §10.5.
 * The interface is the seam — gateway code that consumes a `Region`
 * stays unchanged; the implementation switches.
 *
 * This module is intentionally narrow. It does NOT subsume the
 * CapabilityFacade, the IndexedToolRegistry, or the namespace ACL
 * evaluator — those stay in their respective packages and call into
 * the Region for cross-region operations.
 */

import type { ReplicaId } from "../crdts/g-counter.js";

export type RegionId = string;
export type MeshId = string;

/**
 * Region status — used by the federation gateway's `/api/federation/health`
 * endpoint and the cross-region search router.
 */
export type RegionStatus =
  | "online"
  | "degraded"
  | "offline"
  | "decommissioning";

/**
 * Region configuration — what every node in this region needs to know
 * about itself + its peers.
 *
 * Per scope §11.5; the Phase 2 implementation will load this from
 * `~/.pcc/federation-peers.json` (matching the existing identity
 * model). Phase 1 just defines the type and lets callers pass it in.
 */
export interface RegionConfig {
  /** This region's id (e.g. "us-east-1"). */
  id: RegionId;
  /** Human-friendly name. */
  displayName: string;
  /** Geolocation for caller-to-region routing (Phase 2). */
  geolocation: { lat: number; lng: number };
  /** Public gateway URL for cross-region invocations. */
  publicGatewayUrl: string;
  /**
   * True iff this region accepts NEW federation peers. False locks the
   * peer list to whatever's already in `peerRegions`.
   */
  federationOpen: boolean;
  /** Peer regions allowlisted for DHT messages (Phase 2). */
  peerRegions: RegionId[];
  /** Ed25519 public key for inter-region signature verification. */
  publicKey: string;
  /** Current status. */
  status: RegionStatus;
}

/**
 * Search request shape used by `Region.search()`. Subset of the full
 * aggregator search filter — only the fields that the region-level
 * router cares about. Full enrichment happens at the aggregator layer.
 */
export interface RegionSearchRequest {
  /** Free-text query. */
  q?: string;
  /** Dotted skill (e.g. "nlp.summarization.abstractive"). */
  skill?: string;
  /** Limit results per region. */
  limit?: number;
  /**
   * If true, the local region fans out to peer regions on cache miss.
   * If false, only the local region is queried. Defaults to true.
   */
  crossRegionFallback?: boolean;
}

/** Result entry from a region search. Schema-light per the interface contract. */
export interface RegionSearchResult {
  /** Content-addressed identifier of the matching IndexedTool. */
  cid: string;
  /** Which region returned this entry. */
  region: RegionId;
  /** Which mesh inside that region. */
  mesh: MeshId;
  /** Internal IndexedTool id within that mesh. */
  toolId: string;
  /** Relevance score 0..1. Region-local Vespa or pgvector computes this. */
  score: number;
}

/**
 * A search response from one region. Carries metadata so the caller
 * can know whether the response is partial.
 */
export interface RegionSearchResponse {
  /** Region that produced this response. */
  region: RegionId;
  /** Results, ordered by score desc. */
  results: RegionSearchResult[];
  /** True iff cross-region fallback fired (Phase 2). */
  crossRegionFanoutFired: boolean;
  /** True iff any peer region returned no data within the timeout. */
  partial: boolean;
}

/**
 * CID locator entry — returned by `Region.resolveCid()`. Lists which
 * regions have a copy of the tool record so the invocation router
 * can pick a near-region peer.
 */
export interface RegionCidLocator {
  cid: string;
  /** Regions that host this CID. */
  regions: Array<{
    region: RegionId;
    /** Public URL for the region's invoke endpoint. */
    url: string;
    /** Last-seen-alive timestamp (ISO 8601). */
    lastSeenAt: string;
  }>;
}

/**
 * Region — the federation runtime's narrow contract for cross-region
 * operations. The aggregator gateway depends on this interface, not on
 * the concrete impl.
 *
 * In Phase 1 the default implementation defers everything to the
 * local mesh. In Phase 2 a Kademlia-backed impl handles real
 * cross-region fan-out.
 */
export interface Region {
  /** This region's config. */
  readonly config: RegionConfig;

  /**
   * Run a region-scoped search. Phase 1: local mesh only. Phase 2:
   * fans out to peer regions on cache miss when crossRegionFallback
   * is true.
   */
  search(request: RegionSearchRequest): Promise<RegionSearchResponse>;

  /**
   * Resolve a CID → list of regions hosting it. Phase 1 returns just
   * the local region. Phase 2 queries the DHT.
   */
  resolveCid(cid: string): Promise<RegionCidLocator | null>;

  /**
   * Announce a tool's presence in this region. Phase 1 is a no-op
   * beyond registering the local copy. Phase 2 publishes to the DHT
   * with `R = 8` replication factor (per scope §5.3).
   */
  announce(args: {
    cid: string;
    mesh: MeshId;
    skills: string[];
  }): Promise<void>;

  /**
   * Stop the region runtime cleanly. Idempotent.
   */
  stop(): Promise<void>;
}

/**
 * Replica-id type used by the CRDTs is the same string as RegionId or
 * (RegionId + MeshId joined). Re-export for ergonomics.
 */
export type { ReplicaId };

/**
 * Region-level federation layer.
 *
 * Phase 1 exports types and a single-region default implementation.
 * Phase 2 will add a Kademlia-backed multi-region implementation.
 */

export * from "./types.js";
export { SingleRegion, type SingleRegionBackend } from "./single-region.js";

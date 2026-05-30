/**
 * @pcc/federation — Phase 1 of the 4-level federation runtime.
 *
 * SCOPE OF PHASE 1 (this package):
 *
 *   ✓ CRDT primitives (G-Counter, Tagged-Fraction, LWW-Register)
 *     for volatile-field merging across regions/meshes
 *   ✓ Mesh-level Postgres synchronous-replication configuration helpers
 *     + lag/health probes
 *   ✓ Server + Namespace types — ACL evaluator for tenant boundaries
 *   ✓ Region scaffold — typed interface + single-region default impl;
 *     full Kademlia DHT and cross-region CRDT pull deferred to Phase 2
 *
 * OUT OF SCOPE (Phase 2+):
 *
 *   ✗ Kademlia DHT for cross-region (libp2p-kad-dht)
 *   ✗ CDC consumer (Postgres logical replication → CRDT view)
 *   ✗ Multi-region rollout playbook
 *   ✗ DePIN cross-network discovery integration
 *   ✗ Deprecating @pcc/aggregator's in-memory adapter
 *
 * See ai/scoping/4-level-federation-2026-05-23.md for the full scope
 * and the Phase 2 plan.
 */

// CRDT primitives — public from "./crdts" sub-export too
export * from "./crdts/index.js";

// Mesh-level Postgres sync replication helpers
export * from "./mesh/index.js";

// Region scaffold (single-region default; full DHT in Phase 2)
export * from "./region/index.js";

// Server / Namespace / ACL types + helpers
export * from "./server.js";
export * from "./namespace.js";
export * from "./vector-clock.js";

// Phase 1 replicator stub — see Phase 2 for the real CDC + DHT pipeline.
export {
  PhaseOneReplicator,
  type ToolCrdtSlot,
  type PhaseOneReplicatorStats,
} from "./replicator-stub.js";

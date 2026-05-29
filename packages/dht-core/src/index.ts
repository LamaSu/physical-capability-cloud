/**
 * @pcc/dht-core — shared primitives for the PCC DHT family.
 *
 * Provides transport, identity, and peer-management primitives consumed
 * by:
 *
 *  - `@pcc/dht` — flood-gossip DHT for the physical-capability domain
 *  - `@pcc/federation` — Phase 1 federation runtime (CRDTs + mesh sync;
 *    Kademlia in Phase 2)
 *
 * Pure types + small wrappers. No crypto (lives in @pcc/a2a). No IO
 * beyond WebSocket transport.
 */

// Identity
export {
  createPeerIdentity,
  peerIdFromDid,
  endpointsEqual,
  sortedEndpoints,
  preferredEndpoint,
  canonicalIdentityJson,
  type PeerIdentity,
  type PeerEndpoint,
  type TransportType,
} from "./identity.js";

// Transport
export {
  CoreTransport,
  type CoreMessage,
  type CoreMessageHandler,
  type CorePeerHandler,
  type CoreTransportStats,
  type CoreTransportOpts,
} from "./transport.js";

// Peer management
export {
  PeerManager,
  type KnownPeer,
  type PeerManagerOpts,
} from "./peer-manager.js";

/**
 * @pcc/dht — Distributed capability discovery for the Physical Capability Cloud.
 *
 * Provides a gossip-based DHT over WebSocket that kernel operators run to
 * advertise capabilities and users query to find machines.
 */

// Core DHT node
export { DHTNode, type DHTNodeOpts } from "./dht-node.js";

// Announcement creation and verification
export {
  createAnnouncement,
  verifyAnnouncementSignature,
  type CreateAnnouncementOpts,
} from "./announcement.js";

// Query engine
export {
  matchesQuery,
  rankResults,
  haversineKm,
  type CapabilityQuery,
} from "./query.js";

// Announcement registry
export {
  AnnouncementRegistry,
  type StoredAnnouncement,
} from "./registry.js";

// Bootstrap node management
export {
  DEFAULT_BOOTSTRAP_NODES,
  loadBootstrapNodes,
  saveBootstrapNodes,
} from "./bootstrap.js";

// Transport layer
export {
  DHTTransport,
  type DHTMessage,
  type MessageHandler,
  type PeerHandler,
} from "./transport.js";

// Telemetry
export {
  DHTTelemetry,
  dhtTelemetry,
  type DHTMetricEvent,
  type DHTMetricEventType,
  type DHTMetrics,
} from "./telemetry.js";

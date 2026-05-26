/**
 * DHTTransport — gossip-flood transport for the capability DHT.
 *
 * Thin wrapper over @pcc/dht-core's CoreTransport, layering the
 * capability-specific DHTMessage union on top of the protocol-agnostic
 * envelope. Keeps the existing DHTNode + AnnouncementRegistry tests
 * green while letting @pcc/federation share the same underlying
 * WebSocket primitives.
 *
 * The protocol identifier is "/pcc/cap-gossip/1.0.0". Messages with a
 * different protocol id are ignored (the federation runtime will use
 * "/pcc/agg-kad/1.0.0" in Phase 2).
 */

import type { WebSocket } from "ws";
import type { PeerEndpoint, CapabilityAnnouncement } from "@pcc/spec";
import {
  CoreTransport,
  type CoreMessage,
  type CoreTransportStats,
} from "@pcc/dht-core";
import type { CapabilityQuery } from "./query.js";
import { dhtTelemetry } from "./telemetry.js";

// ── DHT Protocol Messages ──────────────────────────────────────────

/** Protocol id namespacing all gossip messages on the wire. */
export const CAP_GOSSIP_PROTOCOL = "/pcc/cap-gossip/1.0.0";

export type DHTMessage =
  | { type: "announce"; announcement: CapabilityAnnouncement; ttl: number }
  | { type: "query"; id: string; filter: CapabilityQuery }
  | { type: "query_result"; id: string; results: CapabilityAnnouncement[] }
  | { type: "peer_list"; peers: PeerEndpoint[] }
  | { type: "ping" }
  | { type: "pong"; nodeId: string; capabilities: number };

// ── Transport Class ────────────────────────────────────────────────

export type MessageHandler = (peerId: string, msg: DHTMessage) => void;
export type PeerHandler = (peerId: string) => void;

/**
 * DHTTransport keeps its old API (listen / connect / send / broadcast /
 * onMessage / onPeerConnect / onPeerDisconnect / getPeerIds / peerCount /
 * close / addSocket) so DHTNode and its 26+ existing tests are unchanged.
 * Internally it now defers to a shared CoreTransport instance.
 */
export class DHTTransport {
  private readonly core: CoreTransport;
  private messageHandlers: MessageHandler[] = [];

  constructor(core?: CoreTransport) {
    this.core = core ?? new CoreTransport({ label: "dht" });

    // Translate incoming CoreMessages into the typed DHTMessage union
    // and fan out to subscribers. Drop messages from foreign protocols
    // so a shared connection can carry both gossip and Kademlia later.
    this.core.onMessage((peerId, msg) => {
      if (msg.protocol !== CAP_GOSSIP_PROTOCOL) return;
      const payload = msg.payload as DHTMessage;
      for (const h of this.messageHandlers) h(peerId, payload);
    });

    // Re-emit telemetry hooks unchanged
    this.core.onPeerConnect((peerId) => dhtTelemetry.peerConnected(peerId));
    this.core.onPeerDisconnect((peerId) =>
      dhtTelemetry.peerDisconnected(peerId, "close"),
    );
  }

  /** Start a WebSocket server on the given port. */
  async listen(port: number): Promise<void> {
    await this.core.listen(port);
  }

  /** Connect to a remote peer by WebSocket URL. */
  async connect(url: string): Promise<string> {
    return this.core.connect(url);
  }

  /**
   * Register an externally-provided WebSocket (e.g. from a Fastify
   * websocket route). Returns the assigned peer ID.
   */
  addSocket(ws: WebSocket, peerId?: string): string {
    return this.core.adoptSocket(ws, peerId);
  }

  /** Send a message to a specific peer. */
  send(peerId: string, message: DHTMessage): void {
    this.core.send(peerId, {
      protocol: CAP_GOSSIP_PROTOCOL,
      payload: message,
    });
  }

  /** Broadcast a message to all connected peers, optionally excluding one. */
  broadcast(message: DHTMessage, exclude?: string): void {
    this.core.broadcast(
      { protocol: CAP_GOSSIP_PROTOCOL, payload: message },
      exclude,
    );
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onPeerConnect(handler: PeerHandler): void {
    this.core.onPeerConnect(handler);
  }

  onPeerDisconnect(handler: PeerHandler): void {
    this.core.onPeerDisconnect(handler);
  }

  getPeerIds(): string[] {
    return this.core.getPeerIds();
  }

  get peerCount(): number {
    return this.core.peerCount;
  }

  /** Stats from the underlying core transport (for diagnostics). */
  getStats(): CoreTransportStats {
    return this.core.getStats();
  }

  /** Shut down: close all connections and the server. */
  async close(): Promise<void> {
    await this.core.close();
  }

  /** Returns the underlying CoreTransport — for federation runtime co-mounting. */
  getCore(): CoreTransport {
    return this.core;
  }
}

// Re-export CoreMessage so downstreams that want to talk multi-protocol
// over the same connection can do so without grabbing dht-core directly.
export type { CoreMessage };

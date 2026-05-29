/**
 * Transport — WebSocket server + client for DHT-family node communication.
 *
 * Lifted from `packages/dht/src/transport.ts` (which still wraps this) so
 * the Phase 1 federation runtime (`packages/federation`) can run on the
 * same wire primitives without dragging in the gossip-specific
 * DHTMessage union. Domain protocols layer their own typed message
 * envelopes on top of `CoreMessage`.
 *
 * The flood-gossip DHT and the Kademlia federation runtime peer with
 * each other on *different* protocol namespaces; both reuse this
 * transport for the underlying frame transport.
 *
 * No telemetry here on purpose — telemetry hooks are domain-specific
 * (cap-gossip metrics vs Kademlia lookup-hop metrics), so the wrapper
 * packages install their own observers via the `onConnect` /
 * `onMessage` / `onDisconnect` hooks.
 */

import { WebSocketServer, WebSocket } from "ws";

/**
 * Wire message frame. Concrete protocols sit on top by parsing
 * `payload` against their own discriminated-union schema.
 *
 * The `protocol` field namespaces simultaneous protocols on the same
 * connection — `/pcc/cap-gossip/1.0.0` (DHT) and `/pcc/agg-kad/1.0.0`
 * (federation Kademlia, Phase 2) can both be carried over the same
 * WebSocket without colliding.
 */
export interface CoreMessage {
  /** Protocol identifier (e.g. "/pcc/cap-gossip/1.0.0"). */
  protocol: string;
  /** Opaque JSON-encodable payload. */
  payload: unknown;
}

export type CoreMessageHandler = (peerId: string, msg: CoreMessage) => void;
export type CorePeerHandler = (peerId: string) => void;

/**
 * Stats snapshot from `getStats()`. Exposed so the wrapper packages
 * can emit telemetry without poking internals.
 */
export interface CoreTransportStats {
  /** Currently-open peer connections. */
  peerCount: number;
  /** Total bytes sent since construction. */
  bytesSent: number;
  /** Total bytes received since construction. */
  bytesReceived: number;
  /** Total accepted inbound connections since construction. */
  inboundConnections: number;
  /** Total successful outbound connections since construction. */
  outboundConnections: number;
}

export interface CoreTransportOpts {
  /** Optional human-friendly tag included in default peer IDs. */
  label?: string;
}

export class CoreTransport {
  private server: WebSocketServer | null = null;
  private clients = new Map<string, WebSocket>();
  private messageHandlers: CoreMessageHandler[] = [];
  private connectHandlers: CorePeerHandler[] = [];
  private disconnectHandlers: CorePeerHandler[] = [];
  private peerCounter = 0;
  private readonly label: string;
  private bytesSent = 0;
  private bytesReceived = 0;
  private inboundConnections = 0;
  private outboundConnections = 0;

  constructor(opts: CoreTransportOpts = {}) {
    this.label = opts.label ?? "core";
  }

  /** Start a WebSocket server on the given port. Idempotent if already listening. */
  async listen(port: number): Promise<void> {
    if (this.server) return;
    return new Promise((resolve, reject) => {
      try {
        this.server = new WebSocketServer({ port });
        this.server.on("listening", () => resolve());
        this.server.on("error", (err) => reject(err));

        this.server.on("connection", (ws) => {
          const peerId = `peer_${this.label}_in_${++this.peerCounter}`;
          this.inboundConnections++;
          this.registerSocket(peerId, ws);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Dial a remote peer by WebSocket URL. */
  async connect(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(url);
        const peerId = `peer_${this.label}_out_${++this.peerCounter}`;

        ws.on("open", () => {
          this.outboundConnections++;
          this.registerSocket(peerId, ws);
          resolve(peerId);
        });
        ws.on("error", (err) => reject(err));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Adopt an externally-provided WebSocket (e.g. one from a Fastify
   * route). Returns the peer id used to address it.
   */
  adoptSocket(ws: WebSocket, peerId?: string): string {
    const id = peerId ?? `peer_${this.label}_ext_${++this.peerCounter}`;
    this.inboundConnections++;
    this.registerSocket(id, ws);
    return id;
  }

  /** Send a message to a specific peer. No-op if the peer is unknown. */
  send(peerId: string, message: CoreMessage): void {
    const ws = this.clients.get(peerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(message);
      this.bytesSent += data.length;
      ws.send(data);
    }
  }

  /** Broadcast a message, optionally excluding one peer. */
  broadcast(message: CoreMessage, exclude?: string): void {
    const data = JSON.stringify(message);
    for (const [id, ws] of this.clients) {
      if (id !== exclude && ws.readyState === WebSocket.OPEN) {
        this.bytesSent += data.length;
        ws.send(data);
      }
    }
  }

  onMessage(handler: CoreMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onPeerConnect(handler: CorePeerHandler): void {
    this.connectHandlers.push(handler);
  }

  onPeerDisconnect(handler: CorePeerHandler): void {
    this.disconnectHandlers.push(handler);
  }

  getPeerIds(): string[] {
    return Array.from(this.clients.keys());
  }

  get peerCount(): number {
    return this.clients.size;
  }

  getStats(): CoreTransportStats {
    return {
      peerCount: this.clients.size,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      inboundConnections: this.inboundConnections,
      outboundConnections: this.outboundConnections,
    };
  }

  /** Close all connections and stop the listening server. Idempotent. */
  async close(): Promise<void> {
    for (const [, ws] of this.clients) {
      ws.close();
    }
    this.clients.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  private registerSocket(peerId: string, ws: WebSocket): void {
    this.clients.set(peerId, ws);

    for (const h of this.connectHandlers) h(peerId);

    ws.on("message", (data) => {
      try {
        const str = data.toString();
        this.bytesReceived += str.length;
        const msg: CoreMessage = JSON.parse(str);
        for (const h of this.messageHandlers) h(peerId, msg);
      } catch {
        // Ignore malformed messages — domain protocols decide error policy
      }
    });

    ws.on("close", () => {
      this.clients.delete(peerId);
      for (const h of this.disconnectHandlers) h(peerId);
    });

    ws.on("error", () => {
      this.clients.delete(peerId);
    });
  }
}

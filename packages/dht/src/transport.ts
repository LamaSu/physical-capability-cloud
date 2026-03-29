/**
 * DHTTransport — WebSocket server + client for DHT node communication.
 *
 * Provides a bidirectional messaging layer: nodes connect to each other
 * over WebSocket and exchange DHTMessage objects (JSON serialised).
 */

import { WebSocketServer, WebSocket } from "ws";
import type { PeerEndpoint, CapabilityAnnouncement } from "@pcc/spec";
import type { CapabilityQuery } from "./query.js";

// ── DHT Protocol Messages ──────────────────────────────────────────

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

export class DHTTransport {
  private server: WebSocketServer | null = null;
  private clients = new Map<string, WebSocket>();
  private messageHandlers: MessageHandler[] = [];
  private connectHandlers: PeerHandler[] = [];
  private disconnectHandlers: PeerHandler[] = [];
  private peerCounter = 0;

  /** Start a WebSocket server on the given port */
  async listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = new WebSocketServer({ port });
        this.server.on("listening", () => resolve());
        this.server.on("error", (err) => reject(err));

        this.server.on("connection", (ws) => {
          const peerId = `peer_server_${++this.peerCounter}`;
          this.registerSocket(peerId, ws);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Connect to a remote peer by WebSocket URL */
  async connect(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(url);
        const peerId = `peer_client_${++this.peerCounter}`;

        ws.on("open", () => {
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
   * Register an externally-provided WebSocket (e.g. from a Fastify
   * websocket route). Returns the assigned peer ID.
   */
  addSocket(ws: WebSocket, peerId?: string): string {
    const id = peerId ?? `peer_external_${++this.peerCounter}`;
    this.registerSocket(id, ws);
    return id;
  }

  /** Send a message to a specific peer */
  send(peerId: string, message: DHTMessage): void {
    const ws = this.clients.get(peerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /** Broadcast a message to all connected peers, optionally excluding one */
  broadcast(message: DHTMessage, exclude?: string): void {
    const data = JSON.stringify(message);
    for (const [id, ws] of this.clients) {
      if (id !== exclude && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Register a handler for incoming messages */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /** Register a handler for peer connections */
  onPeerConnect(handler: PeerHandler): void {
    this.connectHandlers.push(handler);
  }

  /** Register a handler for peer disconnections */
  onPeerDisconnect(handler: PeerHandler): void {
    this.disconnectHandlers.push(handler);
  }

  /** Get the IDs of all connected peers */
  getPeerIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /** Get the count of connected peers */
  get peerCount(): number {
    return this.clients.size;
  }

  /** Shut down: close all connections and the server */
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

  // ── Internal ───────────────────────────────────────────────────────

  private registerSocket(peerId: string, ws: WebSocket): void {
    this.clients.set(peerId, ws);

    for (const h of this.connectHandlers) h(peerId);

    ws.on("message", (data) => {
      try {
        const msg: DHTMessage = JSON.parse(data.toString());
        for (const h of this.messageHandlers) h(peerId, msg);
      } catch {
        // Ignore malformed messages
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

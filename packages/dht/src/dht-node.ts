/**
 * DHTNode — core distributed hash table node for capability discovery.
 *
 * Implements a gossip-based protocol over WebSocket:
 *
 *  1. **Announce**: node broadcasts a signed CapabilityAnnouncement to all
 *     connected peers. Peers store it locally and forward (with TTL decrement)
 *     to *their* peers, forming a flood-fill propagation wave.
 *
 *  2. **Query**: node checks its local AnnouncementRegistry first, then
 *     broadcasts the query to all peers. Responses flow back along the
 *     query path. A per-query timeout bounds the wait.
 *
 *  3. **Heartbeat**: announcements expire based on TTL. Nodes re-announce
 *     periodically to keep their entry alive.
 *
 * The DHT is intentionally simple — no Kademlia routing, no CRDTs, just
 * gossip. This keeps it lightweight enough to run on operator hardware.
 */

import type { CapabilityAnnouncement, PeerIdentity, PeerEndpoint } from "@pcc/spec";
import { AnnouncementRegistry } from "./registry.js";
import { DHTTransport, type DHTMessage } from "./transport.js";
import type { CapabilityQuery } from "./query.js";
import { rankResults } from "./query.js";
import { loadBootstrapNodes } from "./bootstrap.js";

export interface DHTNodeOpts {
  identity: PeerIdentity;
  bootstrapNodes?: string[];
  /** Local WebSocket server port (0 = don't listen) */
  port?: number;
  /** Default gossip TTL (how many hops an announcement can travel) */
  defaultTTL?: number;
  /** Query timeout in ms (default 3000) */
  queryTimeoutMs?: number;
  /** Announcement TTL prune interval in ms */
  pruneIntervalMs?: number;
}

export class DHTNode {
  readonly identity: PeerIdentity;
  private registry: AnnouncementRegistry;
  private transport: DHTTransport;
  private bootstrapNodes: string[];
  private port: number;
  private defaultTTL: number;
  private queryTimeoutMs: number;
  private pendingQueries = new Map<
    string,
    { resolve: (results: CapabilityAnnouncement[]) => void; results: CapabilityAnnouncement[]; timer: ReturnType<typeof setTimeout> }
  >();
  private started = false;
  /** Track which announcements we've already seen (prevent gossip loops) */
  private seenAnnouncements = new Set<string>();

  constructor(opts: DHTNodeOpts) {
    this.identity = opts.identity;
    this.bootstrapNodes = opts.bootstrapNodes ?? loadBootstrapNodes();
    this.port = opts.port ?? 0;
    this.defaultTTL = opts.defaultTTL ?? 3;
    this.queryTimeoutMs = opts.queryTimeoutMs ?? 3000;
    this.registry = new AnnouncementRegistry({
      pruneIntervalMs: opts.pruneIntervalMs,
    });
    this.transport = new DHTTransport();

    // Wire transport events → internal handlers
    this.transport.onMessage((peerId, msg) => this.handleMessage(peerId, msg));
    this.transport.onPeerConnect((peerId) => this.handlePeerConnect(peerId));
  }

  /** Start the node: listen (if port > 0) and connect to bootstrap nodes */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.registry.startPruning();

    // Start local server
    if (this.port > 0) {
      await this.transport.listen(this.port);
    }

    // Connect to bootstrap nodes (best-effort, don't fail if unreachable)
    const connectPromises = this.bootstrapNodes.map((url) =>
      this.transport.connect(url).catch(() => {
        // Bootstrap node unreachable — not fatal
      }),
    );
    await Promise.allSettled(connectPromises);
  }

  /** Announce capabilities to the network */
  async announce(announcement: CapabilityAnnouncement): Promise<void> {
    // Store locally
    this.registry.store(announcement, 0);

    // Mark as seen (prevents re-gossip of our own announcement)
    const key = announcementKey(announcement);
    this.seenAnnouncements.add(key);

    // Broadcast to all peers
    this.transport.broadcast({
      type: "announce",
      announcement,
      ttl: this.defaultTTL,
    });
  }

  /**
   * Query the network for capabilities.
   *
   * Checks local registry first, then broadcasts to peers and collects
   * responses within the query timeout.
   */
  async query(filter: CapabilityQuery): Promise<CapabilityAnnouncement[]> {
    // Local results
    const localResults = this.registry.query(filter);

    // If we have no peers, just return local
    if (this.transport.peerCount === 0) {
      return rankResults(localResults, filter);
    }

    // Broadcast query and collect remote responses
    const queryId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const remoteResults = await new Promise<CapabilityAnnouncement[]>(
      (resolve) => {
        const timer = setTimeout(() => {
          const pending = this.pendingQueries.get(queryId);
          this.pendingQueries.delete(queryId);
          resolve(pending?.results ?? []);
        }, this.queryTimeoutMs);

        // Unref so the timer doesn't block process exit
        if (timer && typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }

        this.pendingQueries.set(queryId, { resolve, results: [], timer });

        this.transport.broadcast({ type: "query", id: queryId, filter });
      },
    );

    // Merge local + remote, deduplicate by kernelDid
    const seen = new Set<string>();
    const merged: CapabilityAnnouncement[] = [];
    for (const a of [...localResults, ...remoteResults]) {
      if (!seen.has(a.kernelDid)) {
        seen.add(a.kernelDid);
        merged.push(a);
      }
    }

    return rankResults(merged, filter);
  }

  /** Get known peer identities (from connected transport peers) */
  getPeers(): PeerIdentity[] {
    // We don't have full PeerIdentity for transport-level peers, but we
    // can return a synthetic list based on connected peer IDs.
    return this.transport.getPeerIds().map((id) => ({
      did: `did:pcc:${id}`,
      publicKey: "",
      endpoints: [],
    }));
  }

  /** Get the internal announcement registry (for stats, gateway integration) */
  getRegistry(): AnnouncementRegistry {
    return this.registry;
  }

  /** Get the internal transport (for gateway integration) */
  getTransport(): DHTTransport {
    return this.transport;
  }

  /** Stop the node: disconnect peers, stop server, clear state */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Cancel pending queries
    for (const [, pending] of this.pendingQueries) {
      clearTimeout(pending.timer);
      pending.resolve(pending.results);
    }
    this.pendingQueries.clear();

    this.registry.stopPruning();
    await this.transport.close();
    this.seenAnnouncements.clear();
  }

  /**
   * Handle an externally provided WebSocket connection (e.g. from Fastify
   * websocket route). Used by the gateway to add incoming DHT peers.
   */
  handleConnection(ws: import("ws").WebSocket): string {
    return this.transport.addSocket(ws);
  }

  // ── Internal Protocol Handlers ──────────────────────────────────────

  private handleMessage(peerId: string, msg: DHTMessage): void {
    switch (msg.type) {
      case "announce":
        this.handleAnnounce(peerId, msg);
        break;
      case "query":
        this.handleQuery(peerId, msg);
        break;
      case "query_result":
        this.handleQueryResult(msg);
        break;
      case "ping":
        this.transport.send(peerId, {
          type: "pong",
          nodeId: this.identity.did,
          capabilities: this.registry.size,
        });
        break;
      case "pong":
        // Could track peer liveness; currently no-op
        break;
      case "peer_list":
        // Could auto-connect to discovered peers; currently no-op
        break;
    }
  }

  private handleAnnounce(
    peerId: string,
    msg: Extract<DHTMessage, { type: "announce" }>,
  ): void {
    const key = announcementKey(msg.announcement);

    // Dedup: skip if we've already seen this announcement
    if (this.seenAnnouncements.has(key)) return;
    this.seenAnnouncements.add(key);

    // Evict old seen keys to prevent unbounded growth
    if (this.seenAnnouncements.size > 10_000) {
      const it = this.seenAnnouncements.values();
      for (let i = 0; i < 5_000; i++) it.next();
      // Clear the oldest half (rough LRU)
      const keep = new Set<string>();
      for (const v of this.seenAnnouncements) {
        if (keep.size >= 5_000) break;
        keep.add(v);
      }
      // Actually, just drop the oldest half by keeping only last 5000
      this.seenAnnouncements.clear();
      for (const v of keep) this.seenAnnouncements.add(v);
    }

    // Store locally
    this.registry.store(msg.announcement, this.defaultTTL - msg.ttl + 1);

    // Forward to other peers if TTL > 1
    if (msg.ttl > 1) {
      this.transport.broadcast(
        { type: "announce", announcement: msg.announcement, ttl: msg.ttl - 1 },
        peerId, // exclude the sender
      );
    }
  }

  private handleQuery(
    peerId: string,
    msg: Extract<DHTMessage, { type: "query" }>,
  ): void {
    const results = this.registry.query(msg.filter);
    this.transport.send(peerId, {
      type: "query_result",
      id: msg.id,
      results,
    });
  }

  private handleQueryResult(
    msg: Extract<DHTMessage, { type: "query_result" }>,
  ): void {
    const pending = this.pendingQueries.get(msg.id);
    if (!pending) return;
    pending.results.push(...msg.results);
  }

  private handlePeerConnect(peerId: string): void {
    // Share our announcement registry with the new peer
    const all = this.registry.getAll();
    for (const announcement of all) {
      this.transport.send(peerId, {
        type: "announce",
        announcement,
        ttl: 1, // don't re-gossip — just sync
      });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Unique key for deduplication: kernelDid + timestamp */
function announcementKey(a: CapabilityAnnouncement): string {
  return `${a.kernelDid}:${a.timestamp}`;
}

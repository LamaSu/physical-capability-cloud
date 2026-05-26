/**
 * PeerManager — known-peer registry shared by gossip + federation DHTs.
 *
 * Tracks known peers, their endpoints, last-seen times, simple RTT
 * measurements, and allowlist state. Used by:
 *
 *  - `packages/dht` to decide which peers to gossip to
 *  - `packages/federation` (Phase 1 region-scaffold) to enforce the
 *    "known regions only" rule from federation-peers.json
 *  - Phase 2 will extend this with Kademlia k-bucket placement
 *
 * Storage is in-memory only. Persistence is the wrapper's responsibility
 * (federation persists peer state to Postgres; gossip DHT keeps it
 * ephemeral). This module does not perform any IO.
 */

import type { PeerIdentity } from "./identity.js";

export interface KnownPeer {
  /** Peer's DID (canonical id). */
  did: string;
  /** Full identity record. */
  identity: PeerIdentity;
  /** Whether this peer is on the allowlist. */
  allowed: boolean;
  /** Last time we saw a message from this peer (ms epoch). */
  lastSeenMs: number;
  /** Last successful RTT in ms (undefined if never measured). */
  rttMs?: number;
  /** Number of recent connection errors (rolling). */
  errorCount: number;
  /** When the peer was first added (ms epoch). */
  addedAtMs: number;
}

export interface PeerManagerOpts {
  /** Allowlist mode: when true, peers default to NOT allowed and must be
   *  added explicitly via setAllowed(). When false (default), all peers
   *  are allowed. Federation runs in allowlist mode; gossip does not. */
  allowlistMode?: boolean;
}

export class PeerManager {
  private peers = new Map<string, KnownPeer>();
  private allowlistMode: boolean;

  constructor(opts: PeerManagerOpts = {}) {
    this.allowlistMode = opts.allowlistMode ?? false;
  }

  /**
   * Register a peer. If already known, updates the identity and lastSeen.
   * Returns the resulting KnownPeer record.
   */
  upsert(identity: PeerIdentity): KnownPeer {
    const existing = this.peers.get(identity.did);
    if (existing) {
      existing.identity = identity;
      existing.lastSeenMs = Date.now();
      return existing;
    }
    const peer: KnownPeer = {
      did: identity.did,
      identity,
      allowed: !this.allowlistMode,
      lastSeenMs: Date.now(),
      errorCount: 0,
      addedAtMs: Date.now(),
    };
    this.peers.set(identity.did, peer);
    return peer;
  }

  get(did: string): KnownPeer | undefined {
    return this.peers.get(did);
  }

  has(did: string): boolean {
    return this.peers.has(did);
  }

  remove(did: string): boolean {
    return this.peers.delete(did);
  }

  /** Mark allowed/denied. In allowlist mode this is the only way to allow. */
  setAllowed(did: string, allowed: boolean): boolean {
    const peer = this.peers.get(did);
    if (!peer) return false;
    peer.allowed = allowed;
    return true;
  }

  isAllowed(did: string): boolean {
    const peer = this.peers.get(did);
    if (!peer) return !this.allowlistMode;
    return peer.allowed;
  }

  /** Record a successful interaction with measured RTT. */
  recordRtt(did: string, rttMs: number): void {
    const peer = this.peers.get(did);
    if (!peer) return;
    peer.rttMs = rttMs;
    peer.lastSeenMs = Date.now();
    // Decay error count on success
    if (peer.errorCount > 0) peer.errorCount = Math.max(0, peer.errorCount - 1);
  }

  /** Record an error against a peer (for backoff / ejection logic). */
  recordError(did: string): void {
    const peer = this.peers.get(did);
    if (!peer) return;
    peer.errorCount++;
  }

  /** List all known peers. */
  list(): KnownPeer[] {
    return Array.from(this.peers.values());
  }

  /** List only allowed peers. */
  listAllowed(): KnownPeer[] {
    return this.list().filter((p) => p.allowed);
  }

  /** Total known-peer count. */
  size(): number {
    return this.peers.size;
  }

  /** Allowed-peer count. */
  allowedCount(): number {
    return this.listAllowed().length;
  }

  /** Clear all peers — used in tests. */
  clear(): void {
    this.peers.clear();
  }
}

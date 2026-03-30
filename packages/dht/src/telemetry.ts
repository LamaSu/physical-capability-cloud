/**
 * DHTTelemetry — structured event emitter for DHT observability.
 *
 * All DHT components (transport, registry, query, node) import the singleton
 * `dhtTelemetry` and call helper methods. The gateway (or any other consumer)
 * subscribes to the "metric" event to receive a stream of DHTMetricEvent objects.
 *
 * Intentionally dependency-light: uses only Node's built-in EventEmitter.
 */

import { EventEmitter } from "events";

// ── Event Types ────────────────────────────────────────────────────

export type DHTMetricEventType =
  | "peer_connected"
  | "peer_disconnected"
  | "announcement_received"
  | "announcement_expired"
  | "query_started"
  | "query_completed"
  | "query_timeout"
  | "gossip_forwarded"
  | "gossip_dropped"
  | "registry_pruned"
  | "node_started"
  | "node_stopped";

export interface DHTMetricEvent {
  type: DHTMetricEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ── Metrics Snapshot ───────────────────────────────────────────────

export interface DHTMetrics {
  peersConnected: number;
  peersTotal: number;
  queriesTotal: number;
  queriesSucceeded: number;
  queriesFailed: number;
  announcementsTotal: number;
  announcementsActive: number;
  gossipForwarded: number;
  gossipDropped: number;
}

// ── Telemetry Class ────────────────────────────────────────────────

export class DHTTelemetry extends EventEmitter {
  /** Rolling buffer of the last N events for the metrics endpoint */
  private recentEvents: DHTMetricEvent[] = [];
  private readonly maxRecentEvents = 200;

  private metrics: DHTMetrics = {
    peersConnected: 0,
    peersTotal: 0,
    queriesTotal: 0,
    queriesSucceeded: 0,
    queriesFailed: 0,
    announcementsTotal: 0,
    announcementsActive: 0,
    gossipForwarded: 0,
    gossipDropped: 0,
  };

  // ── Typed subscription helper ──────────────────────────────────────

  /** Subscribe to DHT metric events. */
  onMetric(listener: (data: DHTMetricEvent) => void): this {
    return this.on("metric", listener as (...args: unknown[]) => void);
  }

  /** Remove a previously registered metric listener. */
  offMetric(listener: (data: DHTMetricEvent) => void): this {
    return this.removeListener("metric", listener as (...args: unknown[]) => void);
  }

  // ── Snapshot ──────────────────────────────────────────────────────

  getMetrics(): DHTMetrics {
    return { ...this.metrics };
  }

  getRecentEvents(): DHTMetricEvent[] {
    return [...this.recentEvents];
  }

  // ── Helper Methods ────────────────────────────────────────────────

  peerConnected(peerId: string): void {
    this.metrics.peersConnected++;
    this.metrics.peersTotal++;
    this._fire("peer_connected", { peerId });
  }

  peerDisconnected(peerId: string, reason: string): void {
    this.metrics.peersConnected = Math.max(0, this.metrics.peersConnected - 1);
    this._fire("peer_disconnected", { peerId, reason });
  }

  queryStarted(filter: Record<string, unknown>): void {
    this.metrics.queriesTotal++;
    this._fire("query_started", { filter });
  }

  queryCompleted(resultCount: number, durationMs: number): void {
    this.metrics.queriesSucceeded++;
    this._fire("query_completed", { resultCount, durationMs });
  }

  queryTimeout(filter: Record<string, unknown>): void {
    this.metrics.queriesFailed++;
    this._fire("query_timeout", { filter });
  }

  announcementReceived(kernelDid: string, capabilityTypes: string[]): void {
    this.metrics.announcementsTotal++;
    this.metrics.announcementsActive++;
    this._fire("announcement_received", { kernelDid, capabilityTypes });
  }

  announcementExpired(kernelDid: string): void {
    this.metrics.announcementsActive = Math.max(
      0,
      this.metrics.announcementsActive - 1,
    );
    this._fire("announcement_expired", { kernelDid });
  }

  gossipForwarded(messageId: string, ttl: number): void {
    this.metrics.gossipForwarded++;
    this._fire("gossip_forwarded", { messageId, ttl });
  }

  gossipDropped(messageId: string, reason: string): void {
    this.metrics.gossipDropped++;
    this._fire("gossip_dropped", { messageId, reason });
  }

  registryPruned(count: number): void {
    this._fire("registry_pruned", { count });
  }

  nodeStarted(): void {
    this._fire("node_started", {});
  }

  nodeStopped(): void {
    this._fire("node_stopped", {});
  }

  // ── Internal ──────────────────────────────────────────────────────

  private _fire(type: DHTMetricEventType, data: Record<string, unknown>): void {
    const event: DHTMetricEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    // Buffer for the metrics endpoint
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }

    this.emit("metric", event);
  }
}

/** Singleton shared across the DHT package */
export const dhtTelemetry = new DHTTelemetry();

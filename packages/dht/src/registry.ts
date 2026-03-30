/**
 * AnnouncementRegistry — in-memory store for capability announcements with TTL expiry.
 *
 * Each announcement is keyed by kernelDid and stored with arrival metadata
 * (receivedAt, expiresAt, hops). A periodic prune timer evicts expired entries.
 */

import type { CapabilityAnnouncement } from "@pcc/spec";
import type { CapabilityQuery } from "./query.js";
import { matchesQuery } from "./query.js";
import { dhtTelemetry } from "./telemetry.js";

export interface StoredAnnouncement {
  announcement: CapabilityAnnouncement;
  receivedAt: number;
  expiresAt: number;
  hops: number;
}

export class AnnouncementRegistry {
  private announcements = new Map<string, StoredAnnouncement>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private pruneIntervalMs: number;

  constructor(opts?: { pruneIntervalMs?: number }) {
    this.pruneIntervalMs = opts?.pruneIntervalMs ?? 30_000;
  }

  /** Start the periodic prune timer */
  startPruning(): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => this.prune(), this.pruneIntervalMs);
    // Allow the process to exit even if the timer is still running
    if (this.expiryTimer && typeof this.expiryTimer === "object" && "unref" in this.expiryTimer) {
      this.expiryTimer.unref();
    }
  }

  /** Stop the periodic prune timer */
  stopPruning(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * Store a verified announcement. Overwrites any existing entry for the same
   * kernelDid (each kernel has at most one active announcement).
   */
  store(announcement: CapabilityAnnouncement, hops = 0): void {
    const now = Date.now();
    const ttlMs = (announcement.ttlSeconds ?? 300) * 1000;
    this.announcements.set(announcement.kernelDid, {
      announcement,
      receivedAt: now,
      expiresAt: now + ttlMs,
      hops,
    });
    dhtTelemetry.announcementReceived(
      announcement.kernelDid,
      announcement.capabilities.map((c) => c.type),
    );
  }

  /** Query announcements using a CapabilityQuery filter */
  query(filter: CapabilityQuery): CapabilityAnnouncement[] {
    this.prune(); // remove stale entries before querying
    const results: CapabilityAnnouncement[] = [];
    for (const stored of this.announcements.values()) {
      if (matchesQuery(stored.announcement, filter)) {
        results.push(stored.announcement);
      }
    }
    return results;
  }

  /** Remove expired announcements. Returns the count of pruned entries. */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, stored] of this.announcements) {
      if (stored.expiresAt <= now) {
        this.announcements.delete(key);
        dhtTelemetry.announcementExpired(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      dhtTelemetry.registryPruned(pruned);
    }
    return pruned;
  }

  /** Get all active (non-expired) announcements */
  getAll(): CapabilityAnnouncement[] {
    this.prune();
    return Array.from(this.announcements.values()).map((s) => s.announcement);
  }

  /** Get the stored entry (with metadata) for a kernelDid */
  get(kernelDid: string): StoredAnnouncement | undefined {
    return this.announcements.get(kernelDid);
  }

  /** Remove a specific announcement */
  remove(kernelDid: string): boolean {
    return this.announcements.delete(kernelDid);
  }

  /** Count of active announcements by capability type */
  stats(): Record<string, number> {
    this.prune();
    const counts: Record<string, number> = {};
    for (const stored of this.announcements.values()) {
      for (const cap of stored.announcement.capabilities) {
        counts[cap.type] = (counts[cap.type] ?? 0) + 1;
      }
    }
    return counts;
  }

  /** Total number of stored announcements */
  get size(): number {
    return this.announcements.size;
  }

  /** Clear all stored announcements */
  clear(): void {
    this.announcements.clear();
  }
}

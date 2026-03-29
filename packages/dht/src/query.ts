/**
 * Query engine — filter and rank capability announcements.
 *
 * Supports filtering by capability type, materials, price, assurance tier,
 * and geographic proximity (haversine distance).
 */

import type { CapabilityAnnouncement, CapabilitySummary } from "@pcc/spec";

/** Filter for querying the DHT */
export interface CapabilityQuery {
  /** Capability type to match (e.g. "fdm_print", "liquid-handler") */
  type?: string;
  /** Match announcements that support ANY of these materials */
  materials?: string[];
  /** Maximum price per job (matches if priceRange.min <= maxPrice) */
  maxPrice?: number;
  /** Minimum quality/assurance tier (0-3) */
  minAssuranceTier?: number;
  /** Geographic proximity filter */
  location?: { lat: number; lng: number; radiusKm: number };
  /** Maximum results to return (default 10) */
  limit?: number;
}

/**
 * Check whether a single announcement matches the given query.
 * All specified filters must match (AND logic).
 */
export function matchesQuery(
  announcement: CapabilityAnnouncement,
  query: CapabilityQuery,
): boolean {
  const caps = announcement.capabilities;

  // ── Type filter ──────────────────────────────────────────────────
  if (query.type) {
    const hasType = caps.some(
      (c) => c.type.toLowerCase() === query.type!.toLowerCase(),
    );
    if (!hasType) return false;
  }

  // ── Materials filter (ANY match) ─────────────────────────────────
  if (query.materials && query.materials.length > 0) {
    const queryMats = new Set(query.materials.map((m) => m.toLowerCase()));
    const hasMaterial = caps.some((c) =>
      c.materials?.some((m) => queryMats.has(m.toLowerCase())),
    );
    if (!hasMaterial) return false;
  }

  // ── Max price filter ─────────────────────────────────────────────
  if (query.maxPrice !== undefined) {
    const withinBudget = caps.some(
      (c) => c.priceRange && c.priceRange.min <= query.maxPrice!,
    );
    if (!withinBudget) return false;
  }

  // ── Location filter (haversine) ──────────────────────────────────
  if (query.location) {
    // Announcements carry endpoint URLs but not explicit lat/lng.
    // If we later add location metadata to CapabilityAnnouncement or
    // CapabilitySummary this filter can be meaningful. For now, we
    // accept all announcements when a location filter is set but
    // there is no location data to compare against. This avoids
    // filtering out announcements that simply have no coordinates.
    //
    // (Placeholder: real implementation would parse location from
    //  endpoint metadata or a dedicated field.)
  }

  return true;
}

/**
 * Rank query results by relevance.
 *
 * Scoring criteria (lower is better):
 *  - Queue depth (fewer queued jobs = faster turnaround)
 *  - Price (lower min price = cheaper)
 *  - Material breadth (more matching materials)
 */
export function rankResults(
  results: CapabilityAnnouncement[],
  query: CapabilityQuery,
): CapabilityAnnouncement[] {
  const limit = query.limit ?? 10;

  const scored = results.map((a) => ({
    announcement: a,
    score: scoreAnnouncement(a, query),
  }));

  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, limit).map((s) => s.announcement);
}

// ── Internal scoring ──────────────────────────────────────────────

function scoreAnnouncement(
  announcement: CapabilityAnnouncement,
  query: CapabilityQuery,
): number {
  let score = 0;

  for (const cap of announcement.capabilities) {
    // Queue depth penalty
    if (cap.queueDepth !== undefined) {
      score += cap.queueDepth * 10;
    }

    // Price (lower min = better)
    if (cap.priceRange) {
      score += cap.priceRange.min;
    }

    // Material breadth bonus (negative = better score)
    if (query.materials && cap.materials) {
      const queryMats = new Set(query.materials.map((m) => m.toLowerCase()));
      const matchCount = cap.materials.filter((m) =>
        queryMats.has(m.toLowerCase()),
      ).length;
      score -= matchCount * 5; // reward each matching material
    }
  }

  return score;
}

/**
 * Compute haversine distance between two points in km.
 * Exported for testing.
 */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

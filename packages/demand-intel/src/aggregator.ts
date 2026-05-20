/**
 * DemandAggregator — internal-only, unsigned snapshot builder.
 *
 * Reads intent.* analytics events from PCC's existing analytics_events table,
 * folds them through the three sketches, and emits a windowed DemandSnapshot
 * for internal strategic queries by PCC operators.
 *
 * This is NOT a public oracle. There are no signatures, no on-chain
 * publishing, no IPFS. Snapshots persist via materializedViews so operator
 * dashboards can read them with the same staleness contract as every other
 * materialized view.
 */

import { randomUUID } from "node:crypto";
import type {
  DemandEnvelope,
  DemandSnapshot,
  DemandSnapshotComposition,
  BudgetPercentiles,
  BudgetBand,
  UrgencyBand,
  Timestamp,
} from "@pcc/spec";
import type { IRepositories, AnalyticsEventRow } from "@pcc/store";
import { HyperLogLog } from "./sketches/hyperloglog.js";
import { TDigest } from "./sketches/tdigest.js";
import { CountMinSketch } from "./sketches/count-min-sketch.js";

const INTENT_EVENT_TYPES = [
  "intent.composite_request",
  "intent.atomic_session",
  "intent.synthetic_query",
] as const;

/** Coarse mid-point for a budget band — used to feed the T-digest */
function bandMidpoint(band: BudgetBand): number {
  switch (band) {
    case "under_100":
      return 50;
    case "100_1k":
      return 500;
    case "1k_10k":
      return 5_000;
    case "10k_100k":
      return 50_000;
    case "100k_plus":
      return 500_000;
  }
}

export interface IngestSummary {
  eventsRead: number;
  envelopesIngested: number;
  oldestTimestamp: Timestamp | null;
  newestTimestamp: Timestamp | null;
}

export interface AggregatorState {
  hll: HyperLogLog;
  budgetDigest: TDigest;
  cms: CountMinSketch;
  /** Per-composition: geographic regions sub-counter (signature -> region -> count) */
  geoBySig: Map<string, Map<string, number>>;
  /** Per-composition: budget bands sub-counter (signature -> band -> count) */
  budgetBandBySig: Map<string, Map<BudgetBand, number>>;
  /** Total envelopes that have been folded into this state */
  totalIntents: number;
  /** Oldest timestamp ingested in this batch */
  oldest: Timestamp | null;
  /** Newest timestamp ingested in this batch */
  newest: Timestamp | null;
}

function newState(): AggregatorState {
  return {
    hll: new HyperLogLog(),
    budgetDigest: new TDigest(),
    cms: new CountMinSketch(),
    geoBySig: new Map(),
    budgetBandBySig: new Map(),
    totalIntents: 0,
    oldest: null,
    newest: null,
  };
}

/** Returns true if an event row's timestamp falls in [from, to] (ISO compare) */
function inWindow(ts: string, from: Timestamp, to: Timestamp): boolean {
  return ts >= from && ts <= to;
}

/** Parse an analytics-events row's payload into a DemandEnvelope (best-effort) */
function rowToEnvelope(row: AnalyticsEventRow): DemandEnvelope | null {
  const payload = row.payload as unknown;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.id !== "string" ||
    typeof p.source !== "string" ||
    typeof p.compositionSignature !== "string" ||
    !Array.isArray(p.capabilityTypes) ||
    typeof p.summary !== "string" ||
    typeof p.budgetBand !== "string" ||
    typeof p.urgencyBand !== "string" ||
    typeof p.createdAt !== "string"
  ) {
    return null;
  }
  return p as unknown as DemandEnvelope;
}

export class DemandAggregator {
  constructor(private repos: IRepositories) {}

  /**
   * Ingest all intent events newer than `since` into a fresh state. Returns
   * both the state and a summary so callers can decide what window to
   * snapshot. Caller can also pass an explicit window upper bound.
   */
  ingestWindow(from: Timestamp, to: Timestamp): { state: AggregatorState; summary: IngestSummary } {
    const state = newState();
    let eventsRead = 0;
    let envelopesIngested = 0;

    for (const eventType of INTENT_EVENT_TYPES) {
      const rows = this.repos.analytics.findEventsByType(eventType);
      for (const row of rows) {
        eventsRead++;
        if (!inWindow(row.timestamp, from, to)) continue;
        const envelope = rowToEnvelope(row);
        if (!envelope) continue;
        this.fold(state, envelope);
        envelopesIngested++;
      }
    }

    return {
      state,
      summary: {
        eventsRead,
        envelopesIngested,
        oldestTimestamp: state.oldest,
        newestTimestamp: state.newest,
      },
    };
  }

  /**
   * Ingest all intent events since `timestamp` (inclusive) up to now. Useful
   * for incremental aggregation between cron ticks.
   */
  ingestSince(timestamp: Timestamp): { state: AggregatorState; summary: IngestSummary } {
    return this.ingestWindow(timestamp, new Date().toISOString());
  }

  /**
   * Build a snapshot for a given calendar window over the aggregated state.
   * Caller is responsible for assembling the state via `ingestWindow`.
   */
  snapshotFromState(
    state: AggregatorState,
    window: "hour" | "day",
    windowStart: Timestamp,
    windowEnd: Timestamp,
  ): DemandSnapshot {
    const top = state.cms.topK(50);
    const topCompositions: DemandSnapshotComposition[] = top.map((entry) => {
      const geo = state.geoBySig.get(entry.key) ?? new Map<string, number>();
      const geoTopN = [...geo.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([region, count]) => ({ region, count }));
      const bb = state.budgetBandBySig.get(entry.key) ?? new Map<BudgetBand, number>();
      const budgetBandTopN = [...bb.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([band, count]) => ({ band: band as string, count }));
      return {
        signature: entry.key,
        count: entry.count,
        geoTopN,
        budgetBandTopN,
      };
    });

    const budgetPercentiles: BudgetPercentiles = {
      p25: state.budgetDigest.quantile(0.25),
      p50: state.budgetDigest.quantile(0.5),
      p75: state.budgetDigest.quantile(0.75),
      p90: state.budgetDigest.quantile(0.9),
      p99: state.budgetDigest.quantile(0.99),
    };

    return {
      id: `snap-${window}-${randomUUID()}`,
      window,
      windowStart,
      windowEnd,
      topCompositions,
      uniqueRequestersApprox: state.hll.count(),
      budgetPercentiles,
      totalIntents: state.totalIntents,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Convenience: build a snapshot for the most recent window of the given
   * length. Returns a snapshot with explicit windowStart/windowEnd boundaries
   * rounded to the hour or day.
   */
  snapshot(window: "hour" | "day"): DemandSnapshot {
    const now = new Date();
    let windowEnd: Date;
    let windowStart: Date;
    if (window === "hour") {
      windowEnd = new Date(now);
      windowEnd.setMinutes(0, 0, 0);
      windowStart = new Date(windowEnd);
      windowStart.setHours(windowStart.getHours() - 1);
    } else {
      windowEnd = new Date(now);
      windowEnd.setHours(0, 0, 0, 0);
      windowStart = new Date(windowEnd);
      windowStart.setDate(windowStart.getDate() - 1);
    }
    const { state } = this.ingestWindow(
      windowStart.toISOString(),
      windowEnd.toISOString(),
    );
    return this.snapshotFromState(
      state,
      window,
      windowStart.toISOString(),
      windowEnd.toISOString(),
    );
  }

  /** Fold a single envelope into the running state */
  private fold(state: AggregatorState, envelope: DemandEnvelope): void {
    state.totalIntents++;
    state.cms.increment(envelope.compositionSignature, 1);
    if (envelope.requesterIdHash) {
      state.hll.add(envelope.requesterIdHash);
    }
    state.budgetDigest.add(bandMidpoint(envelope.budgetBand));

    if (envelope.geographicRegion) {
      let map = state.geoBySig.get(envelope.compositionSignature);
      if (!map) {
        map = new Map();
        state.geoBySig.set(envelope.compositionSignature, map);
      }
      map.set(envelope.geographicRegion, (map.get(envelope.geographicRegion) ?? 0) + 1);
    }

    let bmap = state.budgetBandBySig.get(envelope.compositionSignature);
    if (!bmap) {
      bmap = new Map<BudgetBand, number>();
      state.budgetBandBySig.set(envelope.compositionSignature, bmap);
    }
    bmap.set(envelope.budgetBand, (bmap.get(envelope.budgetBand) ?? 0) + 1);

    if (state.oldest === null || envelope.createdAt < state.oldest) {
      state.oldest = envelope.createdAt;
    }
    if (state.newest === null || envelope.createdAt > state.newest) {
      state.newest = envelope.createdAt;
    }
  }
}

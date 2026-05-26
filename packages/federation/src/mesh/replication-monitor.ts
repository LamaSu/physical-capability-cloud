/**
 * Replication health monitor for mesh-level Postgres sync replication.
 *
 * Pure-logic module — it ACCEPTS replication-state snapshots
 * (typically from a `SELECT * FROM pg_stat_replication` query) and
 * answers:
 *
 *   - which standbys are healthy
 *   - how laggy each one is
 *   - whether the mesh is currently write-degraded (no sync standby ack)
 *
 * Concrete DB-poll logic stays out of this package so that:
 *   (a) tests don't need a live Postgres
 *   (b) the gateway can plug in @pcc/store's existing pool rather than
 *       opening a new connection
 *
 * Health verdict is what gets exported to `/health` and the metric
 * scrape endpoint.
 */

import type { ReplicaId } from "../crdts/g-counter.js";

/**
 * Per-standby snapshot taken from `pg_stat_replication`. Fields
 * intentionally a subset of what Postgres returns; we only need what
 * the lag computation requires.
 */
export interface StandbyState {
  /** application_name as configured on the standby. */
  name: ReplicaId;
  /** Connection state (streaming, catchup, backup, stopping). */
  state: "streaming" | "catchup" | "backup" | "stopping" | "unknown";
  /** Sync state declared by the primary. */
  syncState: "sync" | "async" | "potential" | "quorum" | "unknown";
  /**
   * Apply-lag in bytes (pg_wal_lsn_diff(sent_lsn, replay_lsn)).
   * Lower = closer to primary. > 1MB sustained = degraded.
   */
  applyLagBytes: number;
  /**
   * Apply-lag in milliseconds (now() - reply_time). Undefined if the
   * standby hasn't sent its first reply yet.
   */
  applyLagMs: number | undefined;
}

/** Health verdict for a single standby. */
export type StandbyHealth = "healthy" | "lagging" | "stopped" | "unknown";

/** Aggregate verdict for the whole mesh. */
export interface ReplicationHealthReport {
  /** Per-standby verdict + raw state. */
  standbys: Array<{
    name: ReplicaId;
    health: StandbyHealth;
    syncState: StandbyState["syncState"];
    applyLagBytes: number;
    applyLagMs: number | undefined;
  }>;
  /**
   * True iff at least one sync-state="sync" standby is healthy. When
   * false, writes are blocked or about to block.
   */
  hasHealthySyncStandby: boolean;
  /**
   * Number of standbys in any of {sync, quorum} state — i.e. eligible
   * for write quorum.
   */
  syncCapacityCount: number;
  /**
   * Overall verdict: HEALTHY (write path open), DEGRADED (some standbys
   * lagging, writes still open via fallback), CRITICAL (no sync standby
   * — writes will block).
   */
  verdict: "HEALTHY" | "DEGRADED" | "CRITICAL";
}

export interface ReplicationMonitorThresholds {
  /** Max apply-lag bytes before a standby is marked "lagging". Default 1 MB. */
  maxApplyLagBytes?: number;
  /** Max apply-lag ms before a standby is marked "lagging". Default 5000ms. */
  maxApplyLagMs?: number;
}

const DEFAULTS: Required<ReplicationMonitorThresholds> = {
  maxApplyLagBytes: 1_048_576,
  maxApplyLagMs: 5000,
};

/**
 * Classify a single standby. Pure function over the snapshot + thresholds.
 */
export function classifyStandby(
  state: StandbyState,
  thresholds?: ReplicationMonitorThresholds,
): StandbyHealth {
  const t = { ...DEFAULTS, ...thresholds };
  if (state.state === "stopping" || state.state === "unknown") return "stopped";
  if (state.state !== "streaming") return "lagging";
  if (state.applyLagBytes > t.maxApplyLagBytes) return "lagging";
  if (state.applyLagMs !== undefined && state.applyLagMs > t.maxApplyLagMs) {
    return "lagging";
  }
  return "healthy";
}

/**
 * Build the aggregate replication health report from a list of standby
 * snapshots.
 *
 * Pre-conditions: `standbys` reflects the current view from the mesh
 * leader's pg_stat_replication. The mesh leader is responsible for
 * pulling this on each healthcheck tick.
 */
export function buildHealthReport(
  standbys: StandbyState[],
  thresholds?: ReplicationMonitorThresholds,
): ReplicationHealthReport {
  const classified = standbys.map((s) => ({
    name: s.name,
    health: classifyStandby(s, thresholds),
    syncState: s.syncState,
    applyLagBytes: s.applyLagBytes,
    applyLagMs: s.applyLagMs,
  }));

  const hasHealthySyncStandby = classified.some(
    (s) =>
      (s.syncState === "sync" || s.syncState === "quorum") &&
      s.health === "healthy",
  );
  const syncCapacityCount = classified.filter(
    (s) => s.syncState === "sync" || s.syncState === "quorum",
  ).length;

  let verdict: ReplicationHealthReport["verdict"];
  if (!hasHealthySyncStandby) {
    verdict = "CRITICAL";
  } else if (classified.some((s) => s.health !== "healthy")) {
    verdict = "DEGRADED";
  } else {
    verdict = "HEALTHY";
  }

  return {
    standbys: classified,
    hasHealthySyncStandby,
    syncCapacityCount,
    verdict,
  };
}

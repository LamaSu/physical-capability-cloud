/**
 * Mesh-level Postgres synchronous-replication helpers.
 *
 * Per scope §5.1, Phase 1 leans on Postgres' built-in sync replication
 * (instead of running our own Raft, per §14 Q3). This subpackage
 * provides:
 *
 *   - postgres-sync-config: postgresql.conf snippet generator
 *   - replication-monitor: pure-logic standby-health classifier
 *
 * No IO is performed in this package. The aggregator gateway is
 * expected to drive a `pg_stat_replication` SELECT and feed the result
 * into `buildHealthReport()`.
 */

export {
  generatePostgresSyncConfig,
  parseStandbyNames,
  DEFAULT_SYNC_TABLES,
  type PostgresSyncConfigOpts,
} from "./postgres-sync-config.js";

export {
  classifyStandby,
  buildHealthReport,
  type StandbyState,
  type StandbyHealth,
  type ReplicationHealthReport,
  type ReplicationMonitorThresholds,
} from "./replication-monitor.js";

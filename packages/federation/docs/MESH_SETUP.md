# Mesh-level Postgres synchronous replication — setup guide

This guide walks through wiring `@pcc/federation`'s Phase 1 mesh-level
Postgres synchronous replication into a real deployment. The scope
document for the broader 4-level federation lives at
`ai/scoping/4-level-federation-2026-05-23.md`; this doc covers ONLY the
operational steps for §5.1.

## Mental model

```
Region (us-east-1)
└── Mesh A (us-east-1-mesh-a)
    ├── primary  (writes go here)
    ├── sync-follower  (sync-acks writes; quorum partner)
    └── async-follower (read replica; eventual)
```

The primary's commit blocks until the sync-follower has applied the WAL
record. The primary + sync-follower form the 2-of-3 quorum that the
federation runtime depends on for serialisable writes per region.

## Steps

### 1. Provision three Postgres instances

Phase 1 supports 3-node meshes. The simplest path on Railway:

- One Postgres service named `mesh-a-primary`
- Two replicas: `mesh-a-sync` and `mesh-a-async`

(Railway's managed Postgres doesn't natively support our sync-repl
topology; for a production deployment use AWS RDS, Aurora, or a
self-managed cluster on EKS. Railway is fine for staging.)

### 2. Generate the postgresql.conf snippet

```typescript
import { generatePostgresSyncConfig } from "@pcc/federation/mesh";

const snippet = generatePostgresSyncConfig({
  standbyNames: ["mesh_a_sync", "mesh_a_async"],
  syncRequiredCount: 1, // 1-of-2 sync standbys suffice for quorum
  syncCommitTimeoutMs: 5_000,
});

// Write to disk or pass to your config-management tool of choice.
console.log(snippet);
```

This outputs the additions for `postgresql.conf`. Apply via your DB
provider's "Custom postgres conf" feature, then reload (no restart
needed for these directives — `pg_ctl reload` suffices).

### 3. Configure each standby's `recovery.conf` / `postgresql.auto.conf`

Each standby needs `primary_conninfo` pointing at the primary and
`application_name` matching one of the names listed in
`synchronous_standby_names`:

```ini
primary_conninfo = 'host=mesh-a-primary port=5432 user=replication password=...
                    application_name=mesh_a_sync'
primary_slot_name = 'mesh_a_sync_slot'
```

(Replace `mesh_a_sync` with `mesh_a_async` for the async standby.)

### 4. Verify

From the primary:

```sql
SELECT application_name, state, sync_state, sent_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS apply_lag_bytes
FROM pg_stat_replication;
```

You should see at least one row with `sync_state = 'sync'` and
`state = 'streaming'`. The Phase 1 `replication-monitor` module
classifies these rows into HEALTHY / DEGRADED / CRITICAL verdicts.

### 5. Wire health into the gateway

```typescript
import { buildHealthReport } from "@pcc/federation/mesh";

// In your /health route, after fetching pg_stat_replication rows:
const report = buildHealthReport(standbyRows);
return reply.send({
  postgres_replication: report,
});
```

When `report.verdict === "CRITICAL"`, the gateway should expose a
warning header on responses so callers know writes are about to block.

## Phase 2 — what changes

Phase 2 will add a CDC consumer (per scope §10.5) that subscribes to
each mesh's WAL via `pgoutput` and materialises a region-level CRDT
view. The standby topology described here stays the same; the CDC
consumer reads from the async-follower so it doesn't contend with the
sync-write path.

## Rollback

If the sync-follower becomes unreachable for an extended period, the
primary's writes block. To restore write availability without losing
the sync property, promote the async-follower to sync:

```sql
ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 ("mesh_a_async")';
SELECT pg_reload_conf();
```

Re-apply the original config once the original sync-follower is back.

## See also

- `packages/federation/src/mesh/postgres-sync-config.ts` — config generator
- `packages/federation/src/mesh/replication-monitor.ts` — health classifier
- `ai/scoping/4-level-federation-2026-05-23.md` §5.1 — design rationale
- Postgres docs: synchronous replication
  https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION

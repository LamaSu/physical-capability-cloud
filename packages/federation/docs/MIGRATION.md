# Phase 1 → Phase 2 migration plan

This doc walks an operator (or the next implementer-wave) through
turning the Phase 1 federation scaffold into a real multi-region
deployment. It covers what's already wired, what plug-points exist,
and the order in which to introduce the Phase 2 pieces.

Scope-doc reference: `ai/scoping/4-level-federation-2026-05-23.md`
§12.

## Phase 1 deliverables (this branch)

- **`@pcc/dht-core`** — shared WebSocket transport + identity + peer-mgr.
- **`@pcc/federation`** — CRDT primitives (G-Counter, Tagged-Fraction,
  LWW-Register, vector clock), Postgres sync-repl config + monitor,
  Namespace ACL evaluator, ServerContext, SingleRegion default, the
  PhaseOneReplicator stub.
- **`@pcc/spec`** — optional `regionId` / `meshId` / `namespaceId` /
  `volatileRefs` fields on `IndexedTool`.
- **`@pcc/aggregator`** — `ReplicatorAdapter` seam + region context on
  the `IndexedToolRegistry`.
- **`@pcc/dht`** — refactored to delegate transport to `@pcc/dht-core`.

Total: ~3,500 LOC + ~1,500 LOC tests + 2 docs. 248 tests pass
(dht-core 37 + federation 128 + aggregator-registry 28 + dht 86 -
overlap).

## What's NOT in Phase 1 (deferred to Phase 2+, ~4,300 LOC)

- **Kademlia DHT** for cross-region (`@pcc/aggregator-dht`, scope §10.4)
  — pulls in libp2p-kad-dht. Implements skill-index and CID-locator
  lookups.
- **CDC consumer** (`@pcc/federation/src/cdc-consumer.ts`, scope §10.5) —
  subscribes to each mesh's Postgres logical-replication slot, feeds
  the region-level CRDT view.
- **Region-publisher + cross-region-fetcher** (scope §10.5) — CRDT
  delta → DHT PUT; search fan-out + CID resolve over DHT.
- **Drizzle migrations** (scope §11.6) — namespaces, regions, meshes,
  indexed_tool_replicas tables. Phase 1 keeps the data in-memory.
- **Gateway routes** for `/api/aggregator/namespaces/*` (scope §11.4).
- **MCP server tools** for region / namespace discovery (scope §13.1).
- **DePIN cross-network discovery** integration.

## Phase 2 step-by-step

### Step 1 — Persist CRDT state to Postgres (≈1 week)

Today `PhaseOneReplicator` holds CRDT slots in a `Map`. Move them to a
new Drizzle table:

```sql
CREATE TABLE indexed_tool_crdt_slots (
  tool_id TEXT PRIMARY KEY,
  invocation_count JSONB NOT NULL,
  success_counts JSONB NOT NULL,
  latency_sums JSONB NOT NULL,
  last_invoked_at JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

CRDT states already serialise cleanly to JSON (we wrote them that way
for this exact reason). Replace `this.slots = new Map()` with a
@pcc/store-backed `slotStore.upsert()` / `slotStore.get()`. The
`recordInvocation()` API surface stays the same.

### Step 2 — Add the CDC consumer (≈1 week)

New file `packages/federation/src/cdc/pg-replication-consumer.ts`:

- subscribes to `wal_level=logical` via the `pg-logical-replication`
  npm package (zero-fork, audited)
- consumes WAL events for `indexed_tools` and `indexed_tool_crdt_slots`
- on each delta, applies the corresponding CRDT op to the
  region-level state held in-process

Phase 1 already exposes the `wal_level = logical` directive in
`generatePostgresSyncConfig()` so the WAL is ready for consumption.

### Step 3 — Add the Kademlia DHT (≈1 week)

New package `packages/aggregator-dht` per scope §10.4. Wrapper around
`libp2p-kad-dht` keyed on `(region:<id>:skill:<fqid>)` and
`(cid:<sha256>)`. CoreTransport from `@pcc/dht-core` is the underlying
WebSocket. Reuse the existing protocol-namespacing —
`"/pcc/agg-kad/1.0.0"` already reserved (see
`packages/dht/src/transport.ts` constant `CAP_GOSSIP_PROTOCOL`).

### Step 4 — Region-publisher + cross-region-fetcher (≈0.5 week)

New file `packages/federation/src/cross-region/publisher.ts`:

- consumes CRDT deltas from Step 2's consumer
- batches and signs with this region's Ed25519 key (already provisioned
  per `RegionConfig.publicKey`)
- PUTs to the Kademlia DHT every N seconds (N=30 default)

Symmetric `cross-region/fetcher.ts`:
- accepts a search request that missed the local region's cache
- fans out to up to 3 peer regions in parallel
- merges results by CID, applies caller filters again, ranks

### Step 5 — Replace `SingleRegion` with `MultiRegion` (≈0.5 week)

The `Region` interface is the seam. `SingleRegion` (Phase 1) becomes a
parameter switch:

```ts
const region: Region =
  config.peerRegions.length === 0
    ? new SingleRegion(config, backend)
    : new MultiRegion(config, backend, dhtClient, peerClients);
```

Gateway code (and `IndexedToolRegistry` consumers) never branch on
single-vs-multi region — the Region.search() / resolveCid() /
announce() surface stays the same.

### Step 6 — Provision eu-west-1 (≈0.5 week, ops)

- Railway env clone of `diplomatic-compassion` for `eu-west-1`
- Postgres + Postgres sync-follower (per `MESH_SETUP.md`)
- DNS: `eu-west-1.capability.network`
- `~/.pcc/federation-peers.json` updated on both sides

### Step 7 — Shadow mode + cutover (≈30 days passive)

- Deploy `MultiRegion` to us-east-1 and eu-west-1 simultaneously
- Compare cross-region search results vs region-local for 30 days
- After zero-diff window, drop the SingleRegion fallback

## What you should NOT do during Phase 2

- Do NOT change the `Region` interface in
  `packages/federation/src/region/types.ts` without a corresponding
  gateway-side review. The gateway treats it as a contract.
- Do NOT change the `ReplicatorAdapter` shape in
  `packages/aggregator/src/replicator.ts` — the in-process
  PhaseOneReplicator and Phase 2's MultiRegionReplicator must both
  conform.
- Do NOT remove the SingleRegion class — it remains the test-time
  default and the small-deployment option (federation is opt-in).
- Do NOT touch `synchronous_commit` or `synchronous_standby_names` in
  Postgres without a runbook reload. Read `MESH_SETUP.md` first.

## Rollback story

Every step has a rollback per scope §12.9:

| Step | Rollback |
|---|---|
| 1 — Postgres persistence | Drop the replicator from `IndexedToolRegistry` opts → in-memory only |
| 2 — CDC consumer | Stop the consumer process; CRDT slots accept local writes only |
| 3 — Kademlia DHT | Drop `peerRegions` from RegionConfig → SingleRegion path |
| 4 — Cross-region publisher | Disable scheduled publish; DHT becomes read-only |
| 5 — MultiRegion | Switch the Region constructor back to SingleRegion |
| 6 — Provision eu-west-1 | Empty the peer list on us-east-1; eu-west-1 becomes a standalone region |
| 7 — Cutover | Keep the in-memory adapter live as the primary; investigate the diff |

## See also

- `ai/scoping/4-level-federation-2026-05-23.md` §12 (migration plan)
- `packages/federation/docs/MESH_SETUP.md` (Postgres sync repl runbook)
- `packages/federation/src/region/types.ts` (Region interface — Phase 2 plug-in seam)
- `packages/aggregator/src/replicator.ts` (ReplicatorAdapter — Phase 2 plug-in seam)

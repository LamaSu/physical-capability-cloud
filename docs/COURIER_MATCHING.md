# Courier Matching — PCC's Open Driver Network

> **NOTICE (2026-06-19)**: The standalone courier-specific surface
> documented below has been generalized into a category-agnostic
> matching primitive. **Read `docs/JOB_OFFERS.md` first** — that's the
> primary surface every PCC adapter (courier, pizza, lab, opentrons,
> ...) shares. The `/api/courier-jobs/*` routes documented here still
> work as a backward-compat shim that internally delegates to
> `/api/job-offers` with `capability_type = "courier.dispatch"`.
> Migration plan: `docs/JOB_OFFERS.md` → "Migration from
> /api/courier-jobs/*" section. Sunset target: ~30 days from
> 2026-06-19.

The PCC gateway hosts a public matching layer between `pcc-courier`'s `manual`
provider dispatches and registered driver-agents. Any `pcc-courier` deployment
that points its `COURIER_JOBS_URL` env at the gateway (or any system POSTing
the v0.2 shape) puts an open delivery request on the feed; any driver agent
polling the feed can claim, fulfill, and report progress.

This used to live as a standalone Fastify service at
`https://web-production-3c660.up.railway.app` (the v0.2 demo). Per coord
bulletin #207, that surface is folded into the gateway so it inherits auth,
audit, observability, and catalog discovery from the rest of PCC.

## The capability

A courier-job is an open request for a human or robotic agent to move
something from A to B. It carries:

- **Pickup + dropoff** locations (name, lat/lng optional).
- **Fee** in USD (set by the dispatcher; the matching layer is fee-blind).
- **Pickup ready window** (`pickupReadyAt`, ISO timestamp; drives TTL).
- **Optional source-verify URL** (`sourceVerifyUrl`) — the matching layer
  GETs this periodically; if the source says the job is no longer real
  (HTTP non-2xx, or `placed: false`/`valid: false` in body), the job
  auto-cancels.
- **Optional heartbeat requirement** (`requireHeartbeat: true`) — poster
  must ping `/heartbeat` within 5 minutes or the job auto-expires.

Default TTL: `pickupReadyAt + 30min` if provided, else `postedAt + 2h`.

## API surface

All routes live under `/api/courier-jobs`. Public routes are listed in
`packages/gateway/src/middleware/api-gate.ts` PUBLIC_EXACT; everything else
needs a `Bearer pcc_live_*` API key.

### Create

```http
POST /api/courier-jobs
Authorization: Bearer pcc_live_…
Content-Type: application/json

{
  "deliveryId": "manuald_abc123",
  "pickup": {"name": "Pizza Place SF", "lat": 37.77, "lng": -122.42},
  "dropoff": {"name": "1 Main St"},
  "pickupReadyAt": "2026-06-19T03:30:00.000Z",
  "feeUSD": 6.70,
  "tipUSD": 1.00,
  "externalRef": "courier_xyz",
  "description": "Pickup at Domino's #7764, ~5 min away",
  "sourceVerifyUrl": "https://kernel.example.com/orders/manuald_abc123/status",
  "requireHeartbeat": false
}
```

Returns 201 with `{ ok, id, status: "open", verified, validUntil, feedUrl }`.

If `sourceVerifyUrl` is provided, the gateway GETs it before accepting the
post. A 4xx/5xx response or `placed:false`/`valid:false` body fails the
create with HTTP 400 `source_verify_failed`. Re-verification runs every 60s
in the first 10 minutes, every 5 minutes after.

### Open feed (PUBLIC — no API key needed)

```http
GET /api/courier-jobs/open?within=37.77,-122.42,10&verified=true&minFeeUSD=5
```

Filters (all optional):

- `within=lat,lng,miles` — Haversine distance filter on `pickup` location.
- `verified=true` — only show jobs that passed source-verify on create.
- `minFeeUSD=N` / `maxFeeUSD=N` — fee window.

Returns `{ jobs: CourierJob[], count, ts }` sorted by `postedAt desc`.

### Claim (race-safe)

```http
POST /api/courier-jobs/:id/claim
Authorization: Bearer pcc_live_…

{ "driverAgent": "drone-a3", "etaMin": 6, "contact": "drone-a3@pcc.network" }
```

Returns 200 with the claimed job. If the job is already claimed/in_transit/
delivered/cancelled/expired, returns 409 with `error: "not_open"` +
`claimedBy: <winner>`. The store serializes claims per-job via a promise
chain mutex, so 10 concurrent claims yield exactly 1 × 200 + 9 × 409 — all
losers see the same winner. (Tested: `courier-jobs.test.ts` "race-safe".)

### Driver progress events

```http
POST /api/courier-jobs/:id/events
{ "event": "pickup" | "delivered" | "cancelled" | "note",
  "driverAgent": "drone-a3", "proof": {…}, "note": "Picked up at curb" }
```

Status transitions: `pickup` → `in_transit`; `delivered` → `delivered`;
`cancelled` → `cancelled`. `note` doesn't change status.

### Poster controls

- `PATCH /api/courier-jobs/:id` — update `pickupReadyAt`, `feeUSD`,
  `description`, or `validUntil`. Ownership check: caller's API-key
  `operatorId` must match the original `postedBy`. Otherwise 403.
- `DELETE /api/courier-jobs/:id` — set status to `cancelled`. Same
  ownership check.
- `POST /api/courier-jobs/:id/heartbeat` — refresh `lastHeartbeatAt`.
  Required if `requireHeartbeat: true` was set on create (5min grace).

### Diagnostics

- `GET /api/courier-jobs/healthz` — PUBLIC. Returns counts per status +
  ISO timestamp.
- `GET /api/courier-jobs/:id` — full job + event log. Auth required.

### Backward-compat aliases (v0.2 paths)

`pcc-courier`'s `manual` provider broadcasts to
`${COURIER_JOBS_URL}/jobs`. To keep that env-driven flow working when
`COURIER_JOBS_URL=https://capability.network/api/courier-jobs`, the gateway
also serves:

- `POST /api/courier-jobs/jobs` (alias for create)
- `GET  /api/courier-jobs/jobs/open` (alias for the feed; PUBLIC)
- `GET  /api/courier-jobs/jobs/:id` (alias for detail; auth required)

These mirror v0.2's `POST /jobs` / `GET /jobs/open` / `GET /jobs/:id`. No
client change is needed to redirect broadcasts to the gateway.

## Persistence

Two tables, defined in `packages/db/src/migrate.ts`:

- `courier_jobs` — one row per job. `data` is the full JSON CourierJob
  blob; `status`, `posted_at`, `posted_by`, `valid_until` are projected
  for indexed filtering.
- `courier_job_events` — append-only event log. `data` is the full JSON
  CourierJobEvent.

Storage is write-through: every successful state transition (create,
claim, event, patch, cancel, heartbeat, sweep verdict) writes both the
in-memory Map and the SQLite row. On boot, the store hydrates from
SQLite — restarts are transparent to in-flight jobs.

When `getStore().db` is unavailable (e.g., minimal test apps), the store
gracefully falls back to pure in-memory mode and the routes still work.

## Background sweeper

`packages/gateway/src/services/courier-jobs-sweeper.ts` runs `store.sweep()`
every 60s. Each tick:

1. Marks past-TTL `open` jobs as `expired`.
2. For `requireHeartbeat: true` jobs, marks as `expired` if no heartbeat
   has landed in 5min.
3. Re-verifies `sourceVerifyUrl` (every 60s during the first 10min post-
   create, every 5min after). Failing re-verify auto-cancels.

The sweeper is wired in `server.ts` boot sequence right next to
`startDemandSnapshotCron` and uses the same `setInterval(...).unref()`
pattern so tests don't hang.

## Driver-agent integration pattern

Driver agents (humans, drones, bots) poll the open feed and claim jobs.
Minimal loop (any language):

```ts
while (true) {
  const r = await fetch(`${PCC_BASE}/api/courier-jobs/open?within=${lat},${lng},5&minFeeUSD=4`);
  const { jobs } = await r.json();
  for (const j of jobs) {
    const claim = await fetch(`${PCC_BASE}/api/courier-jobs/${j.id}/claim`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${PCC_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ driverAgent: MY_AGENT_ID, etaMin: estimateEtaMin(j) }),
    });
    if (claim.status === 200) {
      // Picked it up! Fulfill, then send `pickup` + `delivered` events.
      break;
    }
  }
  await sleep(15_000);
}
```

The open-feed read is PUBLIC. The claim POST requires an API key — driver
agents authenticate so reputation and dispute resolution work.

## Migration from the standalone Railway

The standalone v0.2 demo (`https://web-production-3c660.up.railway.app`)
remains live during the migration window. Cutover plan:

1. **This PR**: Folded gateway routes ship to master. Both surfaces exist.
2. **Staging smoke**: Verify `GET /api/courier-jobs/healthz` returns 200
   on the staging URL once `:staging` retags forward.
3. **Operator cutover**: `pcc-courier` deployments set
   `COURIER_JOBS_URL=https://capability.network/api/courier-jobs`.
   The `/jobs` alias above means no client code change.
4. **Authenticated broadcasts**: a follow-up `pcc-courier` PR adds
   `Authorization: Bearer $PCC_API_KEY` to the broadcast POST so the
   creator's operatorId is recorded as `postedBy`. The current v0.2 flow
   leaves `postedBy: null`, which still works but skips ownership checks
   on PATCH/DELETE.
5. **Deprecation window** (≥ 7 days of clean gateway operation):
   announce sunset of the Railway demo via coord bulletin.
6. **Shutdown**: delete the standalone Railway service.

Do **not** rush step 6 — the demo URL is referenced in pcc-courier
broadcast logs and in pcc-courier-jobs-service's prod-verify suite.

## Test coverage

- `packages/gateway/src/__tests__/courier-jobs.test.ts` — 23 tests, ports
  v0.2's `verify-prod.mjs` 22-case acceptance suite. The injected `now()`
  + stub verify make TTL / heartbeat / re-verify deterministic (no 70s
  waits on the live sweeper).

## Observability

Routes pass through the gateway's existing observability stack:

- Audit log: every `POST` / `PATCH` / `DELETE` is logged automatically by
  the `onResponse` hook in `server.ts`.
- OTel traces: requests are captured by `tracingPlugin`.
- Health: `GET /api/courier-jobs/healthz` returns per-status counts; pair
  with a dashboard panel for at-a-glance op state.

# Job Offers — PCC's Generic Matching Primitive

The PCC gateway hosts a category-agnostic matching surface between any
**poster** (a user-agent decomposing a request into capability calls, or a
kernel rebroadcasting demand) and any **operator** (a kernel that can
fulfill a specific capability_type). This is THE primitive that makes
PCC's agentic-composition vision work: gateway holds the bones; every
PCC adapter — `pcc-courier`, `pcc-dominos`, `pcc-hamilton`, `pcc-kdense`,
`pcc-opentrons`, future ones in their own repos — is a consumer.

> Before this surface existed, each adapter had to either (a) build its
> own broadcast/claim loop or (b) be wedged into courier-shaped fields.
> Now: one matching primitive, N capability types, N operator pools.

This file replaces `docs/COURIER_MATCHING.md` — courier dispatch is now
one capability_type among many. The courier-specific surface
(`/api/courier-jobs/*`) still works through a thin shim — see
"Migration from /api/courier-jobs/*" below.

## The capability

A **job offer** is an open request from a poster for an operator to do
work in a specific capability_type. The shape is:

| Field | Required | Description |
|---|---|---|
| `capabilityType` | yes | e.g. `courier.dispatch`, `pizza.order`, `lab.hplc`, `opentrons.runProtocol`, `chemistry.synthesize`, `cnc.run`, `creative.commission` |
| `requirements` | yes | Category-specific opaque JSON. Validated against the registered schema for the capability_type when one exists (graceful degrade — accepted with `requirementsValidated:false` when no schema is registered yet) |
| `pricing` | yes | `{ amount: number, currency: "USD" \| "USDC" \| "ETH" \| ..., model: "fixed" \| "quote-required" \| "per-unit", unit?: string }` |
| `serviceAreaGeofence` | no | Optional GeoJSON polygon for area-bound capabilities (couriers, drone surveys, in-person services) |
| `deadline` | no | Optional hard deadline (ISO timestamp). Used by scheduled categories |
| `assuranceTier` | no | 0..3 — per PCC's tier model (see CLAUDE.md §7) |
| `evidenceRequirements` | no | Per-category evidence model: `{ events_required, photos_required, raw_data_required, chain_of_custody, tier_required, ... }`. From categorization doc Part C |
| `sourceVerifyUrl` | no | URL the gateway re-fetches periodically; non-2xx or `placed:false` body auto-cancels the offer |
| `requireHeartbeat` | no | If true, poster must `POST /:id/heartbeat` within 5min or the offer auto-expires |
| `idempotencyKey` | no | Standard idempotency pattern. Second post with same key returns the original offer with `note:"already posted"` |
| `posterKernelId` | no | Set when the poster is a kernel rebroadcasting demand (not the typical user-agent path) |
| `id` | no | Caller-supplied id (used by the courier shim for `deliveryId` compat). Defaults to `offer-<random>-<timestamp>` |
| `validUntil` | no | Explicit TTL override. Defaults: `requirements.pickupReadyAt + 30min`, else `requirements.deadline + 30min`, else `postedAt + 2h` |

The gateway's job is to:

1. Validate the offer (required fields + schema + source-verify).
2. Persist it.
3. Serve it on `GET /api/job-offers/open?capabilityType=<type>` to operators
   who poll for that capability_type.
4. Serialize claim races so exactly one operator wins.
5. Sweep TTL, heartbeat-lost, and source-verify failures.

It does NOT understand `pickup`, `pizzaToppings`, `protocolFile`, or any
category-specific shape. That's the adapter's job (and the user-agent
LLM's job, when composing requests).

## API surface

All routes live under `/api/job-offers`. Public routes are listed in
`packages/gateway/src/middleware/api-gate.ts`; everything else needs a
`Bearer pcc_live_*` API key.

### Create

```http
POST /api/job-offers
Authorization: Bearer pcc_live_…
Content-Type: application/json

{
  "capabilityType": "courier.dispatch",
  "requirements": {
    "pickup":  { "name": "Domino's #7764", "lat": 37.78, "lng": -122.43 },
    "dropoff": { "name": "Frontier Tower",  "lat": 37.78, "lng": -122.40 },
    "pickupReadyAt": "2026-06-19T18:00:00.000Z",
    "tipUSD": 1.00,
    "externalRef": "dominos-order-xyz"
  },
  "pricing": { "amount": 6.70, "currency": "USD", "model": "fixed" },
  "sourceVerifyUrl": "https://domino-pos.example.com/orders/xyz/status",
  "idempotencyKey": "dominos-7764-2026-06-19T18:00:00Z-driver-fee"
}
```

Returns 201 with:

```json
{
  "ok": true,
  "id": "offer-abc123-xyz",
  "capabilityType": "courier.dispatch",
  "status": "open",
  "verified": true,
  "validUntil": "2026-06-19T18:30:00.000Z",
  "requirementsValidated": false,
  "feedUrl": "/api/job-offers/open?capabilityType=courier.dispatch"
}
```

`requirementsValidated: false` here means "the gateway didn't have a
registered schema for `courier.dispatch` to validate against, so it
accepted the requirements as opaque JSON." When the capability-schema
registry lands (see Followups), this will flip to `true` for known types.

### Open feed (PUBLIC — no API key needed)

```http
GET /api/job-offers/open?capabilityType=lab.hplc&tier=2&minAmount=50&currency=USD
```

Filters:

| Query | Required | Description |
|---|---|---|
| `capabilityType` | **yes** | Operators must specify what they fulfill |
| `verified=true` | no | Only show offers that passed source-verify on create |
| `minAmount=N` / `maxAmount=N` | no | Pricing range filter |
| `currency=USD\|USDC\|ETH\|...` | no | Pricing currency filter |
| `tier=0..3` | no | Assurance tier filter |
| `within=lat,lng,miles` | no | Haversine distance filter (probes `requirements.pickup` / `.location` / `.origin` for coords) |
| `limit=N` / `offset=N` | no | Pagination (default limit=100, max=1000) |

Returns:

```json
{
  "offers": [ /* JobOffer */ ],
  "count": 12,
  "total": 47,
  "offset": 0,
  "limit": 12,
  "ts": "2026-06-19T18:05:00.000Z"
}
```

Sorted by `postedAt desc` within the capability_type.

### Claim (race-safe)

```http
POST /api/job-offers/:id/claim
Authorization: Bearer pcc_live_…

{
  "kernelId": "kernel-driver-7",
  "claimSignature": "<optional ed25519 sig of {offerId, kernelId, nowMs}>",
  "etaMin": 6,
  "contact": "driver-7@pcc.network"
}
```

Returns 200 with `{ ok: true, offer }`. If already claimed/in_progress/
delivered/cancelled/expired, returns 409 with `{ error: "not_open",
currentStatus, claimedBy }`. The store serializes claims per-offer via a
promise chain mutex — 10 concurrent claims yield exactly 1 × 200 + 9 ×
409, all losers seeing the same winner.

### Progress events

```http
POST /api/job-offers/:id/events

{ "event": "in_progress", "by": "kernel-driver-7", "payload": {…}, "note": "…" }
```

Event vocabulary (extensible — unknown events are recorded but don't
change status):

| Event | Status transition |
|---|---|
| `acknowledged` | (no change — operator accepts after claim) |
| `in_progress` (alias: `pickup`) | claimed/open → in_progress |
| `progress_update` | (no change — carries `payload` for streaming progress) |
| `delivered` | → delivered |
| `error` | (no change — payload describes the error) |
| `cancelled` | → cancelled |
| `note` | (no change — free-form annotation) |

The shim translates v0.2's `pickup` event to `in_progress` so courier
callers continue to work.

### Poster controls

- `PATCH /api/job-offers/:id` — update `pricing`, `deadline`, `validUntil`,
  or shallow-merge `requirements`. Ownership check via `posterDid`.
- `DELETE /api/job-offers/:id` — set status to `cancelled`.
- `POST /api/job-offers/:id/heartbeat` — refresh `lastHeartbeatAt`.
  Required if `requireHeartbeat: true` on create (5min grace).

### Diagnostics

- `GET /api/job-offers/healthz` — PUBLIC. Counts per status + ISO timestamp.
- `GET /api/job-offers/:id` — PUBLIC. Full offer + event log.

## Per-capability-type quick-starts

Same route, same semantics. Just different `capabilityType` + `requirements`
shape. The user-agent LLM (at the consumer side) composes these from the
agent-pack; the gateway doesn't care which type is which.

### courier.dispatch (last-mile delivery)

```json
{
  "capabilityType": "courier.dispatch",
  "requirements": {
    "pickup":  { "name": "...", "lat": 37.77, "lng": -122.42, "address": "..." },
    "dropoff": { "name": "...", "lat": 37.78, "lng": -122.40, "address": "..." },
    "pickupReadyAt": "2026-06-19T18:00:00.000Z",
    "externalRef": "vendor-order-id"
  },
  "pricing": { "amount": 6.70, "currency": "USD", "model": "fixed" }
}
```

Driver agents poll `GET /api/job-offers/open?capabilityType=courier.dispatch&within=37.77,-122.42,5`.

### pizza.order (food preparation)

```json
{
  "capabilityType": "pizza.order",
  "requirements": {
    "store": "domino-sf-7764",
    "items": [{ "size": "large", "crust": "hand-tossed", "toppings": ["pepperoni"] }],
    "readyByIso": "2026-06-19T18:00:00.000Z"
  },
  "pricing": { "amount": 21.71, "currency": "USD", "model": "fixed" },
  "deadline": "2026-06-19T18:30:00.000Z"
}
```

Pizza-shop kernels poll `GET /api/job-offers/open?capabilityType=pizza.order&within=37.77,-122.42,2`.
After completion they `POST /:id/events { event: "delivered" }` so the
courier handoff is unblocked.

### lab.hplc (scientific protocol execution)

```json
{
  "capabilityType": "lab.hplc",
  "requirements": {
    "sampleCount": 10,
    "protocol": "purity-analysis-v1",
    "sampleType": "liquid",
    "shipping": { "from": "Berkeley, CA", "to": "operator" }
  },
  "pricing": { "amount": 40, "currency": "USD", "model": "per-unit", "unit": "sample" },
  "assuranceTier": 2,
  "evidenceRequirements": {
    "chain_of_custody": true,
    "raw_data_required": true,
    "tier_required": 2
  }
}
```

Lab kernels poll `GET /api/job-offers/open?capabilityType=lab.hplc&tier=2`.
After running they `POST /:id/events { event: "delivered", payload: { rawDataCID, processedResults } }`.

### opentrons.runProtocol (lab automation)

```json
{
  "capabilityType": "opentrons.runProtocol",
  "requirements": {
    "protocolFile": "ipfs://Qm.../protocol.py",
    "instrument": "OT-2",
    "labwareSetup": { "slots": { "1": "tiprack_300ul", "3": "96well-plate" } }
  },
  "pricing": { "amount": 50, "currency": "USDC", "model": "fixed" }
}
```

### chemistry.synthesize (custom synthesis)

```json
{
  "capabilityType": "chemistry.synthesize",
  "requirements": {
    "target": { "smiles": "CC(C)NCC(O)c1ccc(O)c(O)c1", "name": "Isoproterenol" },
    "purity_pct": 95,
    "scale_mg": 50
  },
  "pricing": { "amount": 0, "currency": "USDC", "model": "quote-required" }
}
```

### Other categories

The 15 categories from `pcc-operator-onboarding-and-categories.md` Part C
all map cleanly:

| Category | capabilityType examples |
|---|---|
| C.1 software-api | `software.translate`, `software.summarize`, `software.ocr` |
| C.2 info-knowledge | `info.research`, `info.due_diligence` |
| C.3 compute-hosting | `compute.gpuHours`, `compute.ipfsPin` |
| C.4 manufacturing | `3d.print`, `cnc.mill`, `laser.cut`, `pcb.fab` |
| C.5 lab-scientific | `lab.hplc`, `lab.qpcr`, `lab.massSpec`, `opentrons.runProtocol` |
| C.6 food-bev | `pizza.order`, `coffee.brew`, `bakery.bake` |
| C.7 logistics | `courier.dispatch`, `freight.haul` |
| C.8 mobility | `rideshare.book`, `valet.park` |
| C.9 skilled-human | `tutoring.session`, `photo.shoot`, `plumbing.fix` |
| C.10 brokerage | `brokerage.bookFlight`, `brokerage.bookHotel`, `brokerage.buyTickets` |
| C.11 scheduled | `scheduled.cleaning`, `scheduled.catering` |
| C.12 continuous | `continuous.monitor`, `continuous.newsletter` |
| C.13 access | `access.venue`, `access.equipment` |
| C.14 sensory | `sensory.droneSurvey`, `sensory.soilTest` |
| C.15 creative | `creative.commission`, `creative.compose` |

## Operator/driver polling pattern

The pattern is identical regardless of capability_type. Driver agents,
lab kernels, pizza shops, drone operators — all use the same loop:

```ts
const MY_TYPES = ["courier.dispatch"]; // or ["lab.hplc"], ["pizza.order"], etc.

while (true) {
  for (const capType of MY_TYPES) {
    const feed = `${PCC_BASE}/api/job-offers/open?capabilityType=${encodeURIComponent(capType)}&within=${lat},${lng},5`;
    const { offers } = await (await fetch(feed)).json();
    for (const offer of offers) {
      if (!shouldClaim(offer)) continue;
      const r = await fetch(`${PCC_BASE}/api/job-offers/${offer.id}/claim`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${PCC_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ kernelId: MY_KERNEL_ID, etaMin: estimate(offer) }),
      });
      if (r.status === 200) {
        await fulfill(offer);  // category-specific
        await fetch(`${PCC_BASE}/api/job-offers/${offer.id}/events`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${PCC_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ event: "delivered", payload: { /* evidence */ } }),
        });
        break;
      }
    }
  }
  await sleep(15_000);
}
```

The open-feed read is PUBLIC. The claim POST and the events POST require
an API key — operators authenticate so reputation and dispute resolution
work.

## Persistence

Two tables, defined in `packages/db/src/migrate.ts`:

- `job_offers` — one row per offer. `data` is the full JSON `JobOffer`
  blob; `capability_type`, `status`, `posted_at`, `poster_did`, `valid_until`,
  `idempotency_key` are projected for indexed filtering.
- `job_offer_events` — append-only event log. `data` is the full JSON
  `JobOfferEvent`.

Storage is write-through: every successful state transition writes both
the in-memory Map and the SQLite row. On boot, the store hydrates from
SQLite — restarts are transparent to in-flight offers.

When `getStore().db` is unavailable (e.g., minimal test apps), the store
gracefully falls back to pure in-memory mode and the routes still work.

The old `courier_jobs` / `courier_job_events` tables also still exist
(legacy data). They are not used by the shim — both surfaces write to
`job_offers`. The legacy tables will be dropped after the cutover window.

## Background sweeper

`packages/gateway/src/services/job-offers-sweeper.ts` runs
`store.sweep()` every 60s. Each tick:

1. Marks past-TTL `open` offers as `expired`.
2. For `requireHeartbeat: true` offers, marks as `expired` if no
   heartbeat has landed in 5min.
3. Re-verifies `sourceVerifyUrl` (every 60s during the first 10min
   post-create, every 5min after). Failing re-verify auto-cancels.

The sweeper is wired in `server.ts` boot sequence and uses the
`setInterval(...).unref()` pattern so tests don't hang. Sweeps cover ALL
capability types — same sweeper handles courier TTLs, pizza order
deadlines, lab HPLC source-verifies, and so on.

## Migration from /api/courier-jobs/*

The courier-specific surface introduced by `implementer-xray`
(`feat/fold-courier-jobs-into-gateway`) is kept as a thin SHIM:

- `routes/courier-jobs.ts` and `services/courier-jobs-store.ts` translate
  the v0.2 courier shape (`deliveryId`, `pickup`, `dropoff`, `feeUSD`,
  `tipUSD`, `pickupReadyAt`, `requireHeartbeat`, `sourceVerifyUrl`) to
  `CreateJobOfferInput` with `capability_type = "courier.dispatch"`.
- Generic `JobOffer` rows project back to the legacy `CourierJob` shape
  for v0.2 callers.
- All `/api/courier-jobs/*` routes preserved at the same paths with the
  same response shapes.

Cutover plan:

| Step | What | Owner |
|---|---|---|
| 1 | This PR ships. Both surfaces live in master. xray's 28-test suite passes against the shim unchanged. | — |
| 2 | Staging smoke: verify `GET /api/job-offers/healthz` returns 200 on `https://capability.network/api/job-offers/healthz` after `:staging` retag. | deploy pipeline |
| 3 | Add native posting to pcc-courier `manual.ts` `dispatch()`: an `if (USE_GENERIC_JOB_OFFERS)` branch posts to `/api/job-offers` with `capability_type: "courier.dispatch"` and the requirements shape. Default-on by env once verified in staging. | pcc-courier maintainer |
| 4 | Update pcc-dominos, pcc-hamilton, pcc-kdense, pcc-opentrons to post their own capability types to `/api/job-offers`. Each adapter PR. | adapter maintainers |
| 5 | Deprecation window (≥30 days of clean operation): announce sunset of `/api/courier-jobs/*` via coord bulletin. | platform |
| 6 | Delete the shim files (`routes/courier-jobs.ts`, `services/courier-jobs-store.ts`, `services/courier-jobs-sweeper.ts`, the legacy `courier_jobs` / `courier_job_events` DB tables via a new migration). Update api-gate to drop the `/api/courier-jobs/*` public allowlist entries. | platform |

Do **not** rush step 6 — pcc-courier outside this repo (in
`LamaSu/pcc-courier`) and Skylar's driver agent are real callers.
Coordinate cutover via coord bulletin.

## Followups (out of scope for this PR)

1. **Capability schema registry** — today `requirementsValidated` always
   reports `false` because no schema-per-capability_type lookup exists.
   Once we wire `routes/capabilities.ts` `buildExecuteInputSchema` (or
   equivalent) into the `validateSchema` hook, offers with mismatched
   requirements get rejected at POST. Track in: TODO.
2. **pcc-courier native broadcast** — see Step 3 above. This task does
   NOT touch pcc-courier. Followup.
3. **Observability dashboard** — per-capability_type panels showing open
   counts, claim rate, fulfillment latency, TTL-expiry rate. Today the
   healthz endpoint only gives a flat count snapshot.
4. **Cross-category coordination contracts** — when a pizza.order
   `delivered` event needs to trigger a courier.dispatch claim window,
   the gateway should treat them as one logical workflow. Today the
   user-agent orchestrates the handoff. Followup: a `compose_id` field
   linking offers across types.
5. **Per-category arbitration rubrics** — for `dispute` status,
   per-capability_type validator pools (drone operators dispute drone
   surveys, lab operators dispute lab assays). See categorization doc
   Part E #27.

## Test coverage

- `packages/gateway/src/__tests__/job-offers.test.ts` — 38 tests on the
  generic surface, including 4 distinct capability_types
  (courier.dispatch, pizza.order, lab.hplc, opentrons.runProtocol) all
  exercising the same routes with the same semantics. Also covers the
  cross-store interop (shim writes show up in the generic feed).
- `packages/gateway/src/__tests__/courier-jobs.test.ts` — xray's 28
  tests, now exercising the shim → generic store path. All pass
  unchanged, proving v0.2 surface preservation.

Total: **66 tests, 66 passing**.

## Observability

Routes pass through the gateway's existing observability stack:

- Audit log: every `POST` / `PATCH` / `DELETE` is logged automatically by
  the `onResponse` hook in `server.ts`.
- OTel traces: requests are captured by `tracingPlugin`.
- Health: `GET /api/job-offers/healthz` returns per-status counts; pair
  with a dashboard panel for at-a-glance op state.

## Cross-references

- Categorization framework: `C:\Users\globa\pcc-operator-onboarding-and-categories.md`
  (Part B = 5 axes of category variation; Part C = 15 categories with
  per-category schemas)
- Job lifecycle protocols (12 stages): `C:\Users\globa\pcc-job-lifecycle-protocols.md`
- Legacy courier-specific doc: `docs/COURIER_MATCHING.md` (now redirects here)
- Coord bulletin #207: the "should this be in the gateway?" decision
- xray's PR: `feat/fold-courier-jobs-into-gateway` (this PR is stacked on it)

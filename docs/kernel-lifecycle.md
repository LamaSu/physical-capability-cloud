# Kernel + Capability Lifecycle (TTL contract)

**Status:** shipped 2026-06-18 in `feat/ed25519-keys-and-kernel-ttl`.

Skylar's audit hole: kernel and capability announcements had no
documented TTL and no auto-refresh path. Stale rows accumulated and the
matching layer could not tell a capability registered six months ago and
never updated apart from one registered an hour ago. This document is
the contract.

## The columns

Two columns on both `shop_kernels` and `capabilities`:

- `last_heartbeat_at` — ISO timestamp of the most recent heartbeat.
- `valid_until`       — ISO timestamp after which the row stops appearing
                        in the default catalog listing.

Both are nullable for backward compatibility. Rows that pre-date the
migration are treated as "no opinion" — they keep appearing until they
get their first heartbeat (which sets both columns) or until an operator
explicitly retires them.

## TTL contract

- **Default TTL:** 24 hours from the most recent heartbeat.
- **Configurable** via `KERNEL_TTL_HOURS` env var, clamped to **[6h, 168h
  (1 week)]**. Out-of-band values fall back to default + console warn.
- **Recommended heartbeat cadence:** 1 hour. That gives a 24x safety
  margin against network blips, sleep cycles, deploy windows, etc.
- **Re-registration is allowed.** A heartbeat after `valid_until` has
  passed brings the row back from expired status. The handler reports
  `resurrected: true` in the response body and emits a
  `kernel.resurrected` lifecycle event.

## The endpoints

### `POST /api/kernels`

Initial registration. Stamps `valid_until = now + TTL` on insert so a
registered-but-never-heartbeated kernel still appears in default listings
for the first TTL window.

### `POST /api/kernels/:kernelId/heartbeat`

Required at least every 24h (default TTL). Body:

```json
{
  "status": "online",
  "capabilities": [
    { "type": "3d-printing", "name": "FDM PLA", "...": "..." }
  ]
}
```

What it does:
1. Sets `shop_kernels.last_heartbeat = now`,
   `shop_kernels.valid_until = now + TTL`.
2. If `capabilities[]` is provided, upserts each and sets its
   `capabilities.last_heartbeat_at` + `capabilities.valid_until`.
3. If `capabilities[]` is omitted, refreshes TTL on EVERY capability
   the kernel currently exposes (heartbeat-without-list = "still alive,
   nothing changed about my catalog").
4. Returns `{ acknowledged, kernelId, status, capabilitiesReceived,
   timestamp, validUntil, resurrected, sinceLastHeartbeatSec }`.

### `POST /api/capabilities/:capId/heartbeat`

Single-row refresh for clients that don't want to re-send their whole
catalog. Returns `{ acknowledged, capabilityId, kernelId, validUntil,
resurrected, timestamp }`. 404 when the capability id is unknown.

### `GET /api/capabilities` (and `by-kernel`, `by-type`)

Filter expired rows by default. The filter is runtime — it parses
`valid_until` on each read and drops rows whose timestamp has passed.

To include expired rows for debug / sweeper / migration scripts, the
facade layer accepts `ctx.includeExpired = true`. Routes don't expose
this query param today; bypass via the facade method directly. (A
public `?include_expired=true` query param is recommended for follow-up
once observability sees what shape consumers actually want.)

## The sweeper

Runs on a configurable interval inside the gateway process:

- Default 5 min (`KERNEL_SWEEP_INTERVAL_SEC`, clamped to [60, 3600]).
- Idempotent — re-running back-to-back is a no-op after pass 1.
- Flips `shop_kernels.status` from `online` → `expired` when
  `valid_until` has passed.
- Emits one `kernel.expired` event per transition. Emits
  `capability.expired` for each expired capability (capabilities don't
  have a status column today).
- Conservative: NULL or unparseable `valid_until` is LEFT ALONE.
  Corrupted columns never silently DoS the catalog.
- The interval timer is `.unref()`'d so it doesn't keep the process
  alive on its own.

## Lifecycle telemetry

`emitKernelLifecycleEvent()` writes one JSON line per event to stderr.
Dashboard collector reads stderr already; no new transport needed.

| event | fields | meaning |
|---|---|---|
| `kernel.heartbeat.received` | `kernelId, sinceLastHeartbeatSec, capabilityId?` | one beat |
| `kernel.expired` | `kernelId, lastHeartbeatAt, ageMinutes` | sweeper transition |
| `kernel.resurrected` | `kernelId, wasExpiredForMinutes` | heartbeat after expiry |
| `capability.expired` | `kernelId, capabilityId, lastHeartbeatAt` | sweeper transition |

## What the operator has to do

Run a heartbeat at most every 24h (recommended every 1h). That's it.
Everything else is gateway-side: register-time stamps initial TTL,
heartbeats extend it, the sweeper marks expired rows, the catalog filter
drops them, and resurrection is automatic if a stale operator comes
back online.

For `pcc-node` Python users this is wired into the daemon loop already.
For raw HTTP users this is the contract you build against.

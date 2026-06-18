# Address geocoding — implementation + verification notes

Branch: `fix/lane-geocode`. Scope: gateway address→{lat,lng} geocoding.
**Build + test only — no deploy, no push to prod, no GHCR/Railway/:prod changes.**

## Status: done, verified by scoped tests (mocked geocoder, no live Nominatim)

A user can now enter a street **address** and have it resolved to `{lat,lng}` at
the two seams that need real coordinates. Previously kernels/orders carried
`{lat:0,lng:0}` (or a hardcoded SF default), so delivery-distance and
location-aware matching couldn't work.

### What was built

1. **Clean-room geocode client** — `packages/gateway/src/services/geocode.ts`.
   - `geocode(address) -> {lat,lng} | null` over the **open** OpenStreetMap
     Nominatim search endpoint (`/search?format=json&q=...`). No third-party SDK,
     **no API key**.
   - Descriptive `User-Agent` (Nominatim policy requires one), per-request
     timeout via `AbortController`, in-memory success cache (negative results are
     not cached, so a transient outage can't poison an address).
   - **Fails soft**: any network error / timeout / non-200 / empty / malformed
     body returns `null`. Every caller keeps its existing fallback.
   - **Mockable seam**: `setGeocodeFetch()` injects a fake fetch; `IS_TEST` guard
     means tests never make a live call unless a fetch is injected.
   - Optional env overrides (all have defaults, none are secrets):
     `PCC_GEOCODE_URL`, `PCC_GEOCODE_USER_AGENT`, `PCC_GEOCODE_TIMEOUT_MS`.

2. **Seam 1 — kernel registration** (`facades/kernel.facade.ts`, `register()`):
   when an operator supplies `physicalAddress` (or the legacy string-form
   `location`) but no explicit `{lat,lng}`, the address is geocoded to set
   `location`. On a miss the `{0,0}` sentinel is kept (prior behaviour). When
   coords are already supplied the geocoder is never consulted.

3. **Seam 2 — buyer order path** (`routes/pizza-demo.ts`, `POST /api/demo/pizza-order`):
   when the buyer supplies only `deliveryAddress` (no `deliveryLocation`), the
   address is geocoded and the resolved point feeds the compose location filter
   (`radiusKm` around the drop point). Precedence:
   `deliveryLocation` > geocoded address > SF default.

### Tests (all green, geocoder mocked end-to-end)

- `packages/gateway/src/__tests__/geocode.test.ts` — 12 unit tests: happy path,
  User-Agent + query, caching (incl. case/whitespace-insensitive, null not
  cached), and every soft-failure (blank, non-200, empty, bad coords, throw,
  non-array), plus the test-env no-live-call guard.
- `packages/gateway/src/__tests__/geocode-wiring.test.ts` — 6 integration tests:
  kernel `physicalAddress`→coords, legacy string form, explicit-coords
  short-circuit, geocode-miss soft-fail; pizza `deliveryAddress`→coords (order
  planned at the geocoded point) and explicit-coords short-circuit.
- Regression sample run together (`geocode`, `geocode-wiring`,
  `kernel-register-data-bugs`, `pizza-observability`, `compose`) → **58 passed**.

Run: `pnpm --filter @pcc/gateway exec vitest run src/__tests__/geocode.test.ts \
  src/__tests__/geocode-wiring.test.ts` (vitest.config aliases `@pcc/*` to
source, so the scoped suite runs with zero prior build).

## Residual caveats / deliberate scoping (not gaps in the two seams above)

- **Kernel *re-registration* (upsert) branch is intentionally not geocoded.** The
  spec named creation (`POST /api/kernels`) as the seam; re-registration keeps
  the create-time `location`, and only overwrites it when an object `{lat,lng}`
  is sent. No regression — just a future enhancement if operators expect a later
  address change to re-resolve coords.
- **Capability instances** (`POST /api/capabilities`) carry their own `location`
  and are not geocoded here (out of scope). The heartbeat auto-capability insert
  still defaults capability `location` to `{0,0}` — unchanged.
- **Other buyer flows**: only the demo pizza-order path carries a delivery
  address today. `routes/requests.ts` is NL→DAG decomposition (no address), so
  there was nothing to wire there. If a future order/negotiate route accepts an
  address string, wire `geocode()` the same way.
- **Nominatim usage policy**: ≤1 req/sec + required UA. We set the UA and cache
  per process, but do **not** implement rate limiting or a persistent/shared
  cache. For production volume, point `PCC_GEOCODE_URL` at a self-hosted
  Nominatim and/or add a shared cache + limiter.
- **typecheck not run**: gateway `tsc --noEmit` can't pass locally until the
  workspace `dist/*.d.ts` are built (pre-existing, unrelated to this change — see
  `ORDER-PATH-NOTES.md`). Verified via the source-aliased vitest suite instead.
  DGX Spark was unreachable this session (`spark-check` not installed), so tests
  ran locally and scoped (single-package, low memory).

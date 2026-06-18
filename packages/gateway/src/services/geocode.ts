/**
 * Address → { lat, lng } geocoding via OpenStreetMap Nominatim.
 *
 * Clean-room client — no third-party geocoding SDK, no API key. We hit the open
 * Nominatim search endpoint directly, with the three things its usage policy and
 * our reliability budget require:
 *   1. a descriptive User-Agent (Nominatim rejects/limits anonymous clients),
 *   2. a request timeout (a hung geocode must never wedge kernel registration),
 *   3. an in-memory cache (the same shop address resolves once per process).
 *
 * Fails soft by design: any network error, timeout, non-200, malformed body, or
 * empty result resolves to `null`. Every caller already has a sensible fallback
 * (kernels keep {0,0}; the pizza demo keeps its default drop point), so a dead
 * Nominatim degrades matching quality without breaking the request path.
 *
 * Test seam: the underlying fetch is injectable via {@link setGeocodeFetch} so
 * tests run fully offline. Under vitest/NODE_ENV=test we additionally refuse to
 * make a live network call unless a fetch has been injected — this guarantees no
 * accidental live Nominatim traffic from any test that happens to register a
 * kernel or place an order.
 *
 * Config (all optional, all have defaults — NO secrets):
 *   PCC_GEOCODE_URL         override the search endpoint (e.g. a self-hosted Nominatim)
 *   PCC_GEOCODE_USER_AGENT  override the User-Agent string
 *   PCC_GEOCODE_TIMEOUT_MS  override the per-request timeout
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Minimal response surface we depend on — structurally satisfied by the global `fetch` Response. */
export interface GeocodeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injectable fetch seam (keeps the test mock tiny and avoids global stubbing). */
export type GeocodeFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<GeocodeResponse>;

const NOMINATIM_URL =
  process.env.PCC_GEOCODE_URL ?? "https://nominatim.openstreetmap.org/search";

const USER_AGENT =
  process.env.PCC_GEOCODE_USER_AGENT ??
  "physical-capability-cloud/0.1 (+https://capability.network)";

const DEFAULT_TIMEOUT_MS = Number(process.env.PCC_GEOCODE_TIMEOUT_MS ?? "5000");

const IS_TEST = !!process.env.VITEST || process.env.NODE_ENV === "test";

/** Successful-resolution cache, keyed by normalized address. Negative results are NOT
 *  cached so a transient Nominatim outage can't permanently poison an address. */
const cache = new Map<string, GeoPoint>();

/** When set, all geocoding goes through this fn instead of the global fetch. */
let injectedFetch: GeocodeFetch | null = null;

/** The global-`fetch` adapter, narrowed to {@link GeocodeFetch}. */
const globalFetch: GeocodeFetch = (url, init) =>
  (globalThis.fetch as (u: string, i: unknown) => Promise<GeocodeResponse>)(url, init);

/**
 * Resolve the fetch implementation to use, or `null` to mean "do not call the
 * network" (test env without an injected fetch, or a runtime missing `fetch`).
 */
function resolveFetch(): GeocodeFetch | null {
  if (injectedFetch) return injectedFetch;
  if (IS_TEST) return null; // never make live calls under test unless injected
  return typeof globalThis.fetch === "function" ? globalFetch : null;
}

function normalizeKey(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Geocode a freeform address to coordinates. Returns `null` when the address is
 * blank, geocoding is unavailable, or no result is found. Never throws.
 */
export async function geocode(
  address: string,
  opts?: { timeoutMs?: number },
): Promise<GeoPoint | null> {
  if (!address || !address.trim()) return null;

  const key = normalizeKey(address);
  const cached = cache.get(key);
  if (cached) return cached;

  const point = await geocodeUncached(address, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (point) cache.set(key, point);
  return point;
}

async function geocodeUncached(
  address: string,
  timeoutMs: number,
): Promise<GeoPoint | null> {
  const doFetch = resolveFetch();
  if (!doFetch) return null;

  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return null;

    const body = (await res.json()) as Array<{ lat?: string; lon?: string }> | unknown;
    if (!Array.isArray(body) || body.length === 0) return null;

    const top = body[0] as { lat?: string; lon?: string };
    const lat = Number(top?.lat);
    const lng = Number(top?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { lat, lng };
  } catch {
    // Timeout/abort, network error, or malformed JSON — all soft-fail to null.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Test seam ────────────────────────────────────────────────────────────────

/** Override the fetch used for geocoding (tests inject a canned Nominatim response). */
export function setGeocodeFetch(fn: GeocodeFetch): void {
  injectedFetch = fn;
}

/** Drop all cached resolutions. */
export function clearGeocodeCache(): void {
  cache.clear();
}

/** Restore live-fetch behaviour and clear the cache. Call in test teardown. */
export function resetGeocodeForTests(): void {
  injectedFetch = null;
  cache.clear();
}

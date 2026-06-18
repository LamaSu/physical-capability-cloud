/**
 * Unit tests for the Nominatim geocode client (services/geocode.ts).
 *
 * No live network: every test injects a fake fetch via setGeocodeFetch(). We
 * assert the happy path, the in-memory cache, and that EVERY failure mode
 * (non-200, empty body, malformed coords, thrown error, blank input) soft-fails
 * to null rather than throwing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  geocode,
  setGeocodeFetch,
  resetGeocodeForTests,
  type GeocodeFetch,
  type GeocodeResponse,
} from "../services/geocode.js";

/** Build a GeocodeResponse-shaped object from a JSON body + status. */
function jsonResponse(body: unknown, status = 200): GeocodeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** A Nominatim search hit for the given coords. */
function hit(lat: number, lon: number) {
  return [{ lat: String(lat), lon: String(lon), display_name: "somewhere" }];
}

beforeEach(() => resetGeocodeForTests());
afterEach(() => resetGeocodeForTests());

describe("geocode() — happy path", () => {
  it("resolves a real address to numeric { lat, lng }", async () => {
    setGeocodeFetch(async () => jsonResponse(hit(40.7128, -74.006)));
    const point = await geocode("350 5th Ave, New York, NY");
    expect(point).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it("sends a descriptive User-Agent and the address in the query", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const spy: GeocodeFetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return jsonResponse(hit(51.5074, -0.1278));
    };
    setGeocodeFetch(spy);

    await geocode("10 Downing St, London");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("format=json");
    expect(calls[0].url).toContain(encodeURIComponent("10 Downing St, London"));
    expect(calls[0].headers["User-Agent"]).toMatch(/physical-capability-cloud/);
  });
});

describe("geocode() — caching", () => {
  it("caches a successful resolution (second call does not re-fetch)", async () => {
    const fetchSpy = vi.fn<Parameters<GeocodeFetch>, ReturnType<GeocodeFetch>>(
      async () => jsonResponse(hit(37.7749, -122.4194)),
    );
    setGeocodeFetch(fetchSpy);

    const a = await geocode("1 Market St, San Francisco");
    const b = await geocode("1 Market St, San Francisco");

    expect(a).toEqual({ lat: 37.7749, lng: -122.4194 });
    expect(b).toEqual(a);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats the address case/whitespace-insensitively for cache hits", async () => {
    const fetchSpy = vi.fn<Parameters<GeocodeFetch>, ReturnType<GeocodeFetch>>(
      async () => jsonResponse(hit(48.8566, 2.3522)),
    );
    setGeocodeFetch(fetchSpy);

    await geocode("Eiffel Tower, Paris");
    await geocode("  eiffel   tower,   PARIS ");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a null result — a later success can still resolve", async () => {
    let attempt = 0;
    setGeocodeFetch(async () => {
      attempt += 1;
      return attempt === 1 ? jsonResponse([], 200) : jsonResponse(hit(1, 2));
    });

    const first = await geocode("flaky place");
    const second = await geocode("flaky place");

    expect(first).toBeNull();
    expect(second).toEqual({ lat: 1, lng: 2 });
  });
});

describe("geocode() — soft failures all return null", () => {
  it("returns null for a blank address without calling fetch", async () => {
    const fetchSpy = vi.fn<Parameters<GeocodeFetch>, ReturnType<GeocodeFetch>>(
      async () => jsonResponse(hit(0, 0)),
    );
    setGeocodeFetch(fetchSpy);

    expect(await geocode("")).toBeNull();
    expect(await geocode("   ")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null on a non-200 response", async () => {
    setGeocodeFetch(async () => jsonResponse({ error: "rate limited" }, 429));
    expect(await geocode("anywhere")).toBeNull();
  });

  it("returns null on an empty result array", async () => {
    setGeocodeFetch(async () => jsonResponse([], 200));
    expect(await geocode("nonexistent place 99999")).toBeNull();
  });

  it("returns null when the top hit has non-numeric coords", async () => {
    setGeocodeFetch(async () => jsonResponse([{ lat: "not-a-number", lon: "x" }]));
    expect(await geocode("garbled")).toBeNull();
  });

  it("returns null when fetch throws (network error / abort)", async () => {
    setGeocodeFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await geocode("unreachable")).toBeNull();
  });

  it("returns null when the body is not an array", async () => {
    setGeocodeFetch(async () => jsonResponse({ unexpected: "shape" }));
    expect(await geocode("weird api")).toBeNull();
  });
});

describe("geocode() — no live calls under test by default", () => {
  it("returns null when no fetch is injected (test-env guard)", async () => {
    // resetGeocodeForTests() in beforeEach cleared any injected fetch, so this
    // exercises the IS_TEST guard: no network, instant null.
    expect(await geocode("123 Anywhere St")).toBeNull();
  });
});

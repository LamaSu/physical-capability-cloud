/**
 * Wiring tests for address geocoding at the two seams that need real
 * coordinates: kernel registration and the buyer (pizza) order path.
 *
 * Geocoding is mocked end-to-end via setGeocodeFetch() — no live Nominatim
 * traffic. Each test injects a canned Nominatim hit and asserts the resolved
 * coordinates flow through the HTTP surface.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";
import { initStore, closeStore } from "../db.js";
import {
  setGeocodeFetch,
  resetGeocodeForTests,
  type GeocodeFetch,
  type GeocodeResponse,
} from "../services/geocode.js";

// ── Mock helpers ───────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): GeocodeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A geocoder that always returns the given point, counting how often it ran. */
function fixedGeocoder(lat: number, lon: number): GeocodeFetch & { calls: number } {
  const fn = (async () => {
    fn.calls += 1;
    return jsonResponse([{ lat: String(lat), lon: String(lon) }]);
  }) as GeocodeFetch & { calls: number };
  fn.calls = 0;
  return fn;
}

// ── Seam 1: kernel registration ──────────────────────────────────────────────

describe("POST /api/kernels — geocodes physicalAddress to a non-zero location", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(kernelRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  afterEach(() => resetGeocodeForTests());

  it("resolves a physicalAddress (no coords supplied) to a non-zero location", async () => {
    setGeocodeFetch(fixedGeocoder(40.7484, -73.9857)); // Empire State Building
    const id = `kernel_geo_addr_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Empire Print Co",
        operatorAddress: "0xEmpireWallet111111111111111111111111111",
        physicalAddress: "350 5th Ave, New York, NY 10118",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as {
      kernel: { location?: { lat: number; lng: number }; physicalAddress?: string };
    };
    expect(body.kernel.location).toEqual({ lat: 40.7484, lng: -73.9857 });
    // The address itself is still persisted alongside the resolved coords.
    expect(body.kernel.physicalAddress).toBe("350 5th Ave, New York, NY 10118");
  });

  it("resolves the legacy string-form `location` to coordinates", async () => {
    setGeocodeFetch(fixedGeocoder(34.0522, -118.2437)); // Los Angeles
    const id = `kernel_geo_str_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "LA Laser Works",
        operatorAddress: "0xLaWallet2222222222222222222222222222222",
        location: "Los Angeles, CA",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as {
      kernel: { location?: { lat: number; lng: number }; physicalAddress?: string };
    };
    expect(body.kernel.location).toEqual({ lat: 34.0522, lng: -118.2437 });
    expect(body.kernel.physicalAddress).toBe("Los Angeles, CA");
  });

  it("does NOT geocode when explicit { lat, lng } coords are supplied", async () => {
    const geocoder = fixedGeocoder(0, 0);
    setGeocodeFetch(geocoder);
    const id = `kernel_geo_explicit_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Coords Already Known",
        operatorAddress: "0xCoordsWallet33333333333333333333333333",
        location: { lat: 37.77, lng: -122.42 },
        physicalAddress: "123 Maker St, SF CA",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as {
      kernel: { location?: { lat: number; lng: number } };
    };
    expect(body.kernel.location).toEqual({ lat: 37.77, lng: -122.42 });
    // Coords were present, so the geocoder must never have been consulted.
    expect(geocoder.calls).toBe(0);
  });

  it("soft-fails to {0,0} when geocoding misses (address still persisted)", async () => {
    setGeocodeFetch(async () => jsonResponse([], 200)); // Nominatim found nothing
    const id = `kernel_geo_miss_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Unfindable Shop",
        operatorAddress: "0xMissWallet4444444444444444444444444444",
        physicalAddress: "asdkjfh not a real address zzz",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as {
      kernel: { location?: { lat: number; lng: number }; physicalAddress?: string };
    };
    expect(body.kernel.location).toEqual({ lat: 0, lng: 0 });
    expect(body.kernel.physicalAddress).toBe("asdkjfh not a real address zzz");
  });
});

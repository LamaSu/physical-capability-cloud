/**
 * Wiring tests for address geocoding at the two seams that need real
 * coordinates: kernel registration and the buyer (pizza) order path.
 *
 * Geocoding is mocked end-to-end via setGeocodeFetch() — no live Nominatim
 * traffic. Each test injects a canned Nominatim hit and asserts the resolved
 * coordinates flow through the HTTP surface.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";
import { pizzaDemoRoutes, _clearPizzaDemoForTests } from "../routes/pizza-demo.js";
import { _clearGraphSearchForTests, _seedGraphSearchForTests } from "../routes/graph-search.js";
import { _clearComposeForTests } from "../routes/compose.js";
import { initStore, closeStore } from "../db.js";
import type { RegisterGraphNodeInput } from "@pcc/spec";
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

// ── Seam 2: buyer order path (pizza demo) ─────────────────────────────────────

/** A graph-search node with sensible defaults; `location` pins it for proximity. */
function gnode(over: Partial<RegisterGraphNodeInput> & { capabilityId: string }): RegisterGraphNodeInput {
  return {
    capabilityId: over.capabilityId,
    capabilityType: over.capabilityType ?? over.capabilityId,
    kernelId: over.kernelId ?? `k_${over.capabilityId}`,
    operatorAddress: over.operatorAddress ?? `op_${over.capabilityId}@example.com`,
    estimatedPriceUSD: over.estimatedPriceUSD ?? 10,
    estimatedDurationMs: over.estimatedDurationMs ?? 60_000,
    assuranceTier: over.assuranceTier ?? 2,
    reputation: over.reputation ?? 500,
    available: over.available ?? true,
    inputTypes: over.inputTypes ?? [],
    outputTypes: over.outputTypes ?? [],
    location: over.location,
  };
}

describe("POST /api/demo/pizza-order — geocodes a buyer deliveryAddress", () => {
  let app: FastifyInstance;

  // NYC drop point — deliberately NOT the route's hardcoded SF default
  // ({37.77,-122.42}), so a passing assertion proves the geocoded value (not the
  // fallback) flowed through into the order.
  const NYC = { lat: 40.7128, lng: -74.006 };

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(pizzaDemoRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    _clearPizzaDemoForTests();
  });

  beforeEach(() => {
    _clearComposeForTests();
    _clearGraphSearchForTests();
    // A make-pizza -> delivered-pizza path, both anchored near NYC so the
    // compose location filter (radiusKm 25 around the delivery point) matches.
    _seedGraphSearchForTests({
      nodes: [
        gnode({
          capabilityId: "shop-roma",
          capabilityType: "make-pizza",
          outputTypes: ["make-pizza"],
          estimatedPriceUSD: 10,
          location: { lat: 40.71, lng: -74.0 },
        }),
        gnode({
          capabilityId: "driver-luigi",
          capabilityType: "deliver-pizza",
          inputTypes: ["make-pizza"],
          outputTypes: ["delivered-pizza"],
          estimatedPriceUSD: 12,
          location: { lat: 40.72, lng: -74.01 },
        }),
      ],
      edges: [
        {
          fromCapabilityId: "shop-roma",
          toCapabilityId: "driver-luigi",
          capabilityTypeFlow: "make-pizza",
        },
      ],
    });
  });

  afterEach(() => {
    _clearPizzaDemoForTests();
    resetGeocodeForTests();
  });

  it("resolves deliveryAddress (no coords) to a delivery location and plans the order", async () => {
    setGeocodeFetch(fixedGeocoder(NYC.lat, NYC.lng));

    const res = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "buyer-1",
        description: "1 margherita",
        deliveryAddress: "350 5th Ave, New York, NY",
        maxPriceUSD: 30,
      },
    });

    expect(res.statusCode).toBe(201);
    const { order } = res.json() as {
      order: { deliveryLocation: { lat: number; lng: number }; status: string; composition?: unknown };
    };
    // The buyer typed only an address; the order carries the geocoded coords.
    expect(order.deliveryLocation).toEqual(NYC);
    expect(order.status).toBe("proposed");
    expect(order.composition).toBeTruthy();
  });

  it("uses explicit deliveryLocation as-is and never calls the geocoder", async () => {
    const geocoder = fixedGeocoder(NYC.lat, NYC.lng);
    setGeocodeFetch(geocoder);

    const res = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "buyer-2",
        description: "1 pepperoni",
        deliveryAddress: "350 5th Ave, New York, NY",
        deliveryLocation: { lat: 40.73, lng: -73.99 },
        maxPriceUSD: 30,
      },
    });

    expect(res.statusCode).toBe(201);
    const { order } = res.json() as {
      order: { deliveryLocation: { lat: number; lng: number } };
    };
    expect(order.deliveryLocation).toEqual({ lat: 40.73, lng: -73.99 });
    expect(geocoder.calls).toBe(0);
  });
});

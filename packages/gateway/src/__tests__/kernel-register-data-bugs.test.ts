/**
 * Wiring tests for kernel POST data-persistence bugs.
 *
 * Covers two onboarding-audit holes from coord #133:
 *   - a8207dfa: kernel location silently DROPPED (always stored 0,0)
 *   - c6b48ca1: maxAssuranceTier silently OVERRIDDEN (always stored 2)
 *
 * Root cause for both: `KernelFacade.register()` hardcoded the values instead
 * of reading from the input body. CreateKernelInput interface also did not
 * even declare maxAssuranceTier, so TS couldn't catch the silent drop.
 */

import { describe, expect, it, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { kernelRoutes } from "../routes/kernels.js";

describe("POST /api/kernels — data persistence (coord a8207dfa + c6b48ca1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(kernelRoutes);
    await app.ready();
  });

  it("[a8207dfa] persists submitted location {lat, lng} object — not 0,0", async () => {
    const id = `kernel_test_loc_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Marios Pizzeria",
        operatorAddress: "0xMariosWallet1234567890123456789012345678",
        location: { lat: 40.71, lng: -74.0 },
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body) as { kernel: { location?: { lat: number; lng: number } } };
    expect(body.kernel.location).toBeDefined();
    expect(body.kernel.location?.lat).toBe(40.71);
    expect(body.kernel.location?.lng).toBe(-74.0);
  });

  it("[a8207dfa] persists string-form location to physicalAddress (legacy alias)", async () => {
    const id = `kernel_test_loc_str_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Daves Delivery",
        operatorAddress: "0xDavesWallet1234567890123456789012345678",
        location: "555 Main St, Brooklyn NY",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    expect(get.statusCode).toBe(200);
    const body = JSON.parse(get.body) as { kernel: { physicalAddress?: string } };
    expect(body.kernel.physicalAddress).toBe("555 Main St, Brooklyn NY");
  });

  it("[a8207dfa] persists both object location AND separate physicalAddress when both sent", async () => {
    const id = `kernel_test_both_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Demo Machine Shop",
        operatorAddress: "0xMachineShopWallet0987654321098765432109",
        location: { lat: 37.77, lng: -122.42 },
        physicalAddress: "123 Maker St, SF CA",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as { kernel: { location?: { lat: number; lng: number }; physicalAddress?: string } };
    expect(body.kernel.location?.lat).toBe(37.77);
    expect(body.kernel.location?.lng).toBe(-122.42);
    expect(body.kernel.physicalAddress).toBe("123 Maker St, SF CA");
  });

  it("[c6b48ca1] persists submitted maxAssuranceTier=1 (not silently overridden to 2)", async () => {
    const id = `kernel_test_tier1_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Tier-1 operator",
        operatorAddress: "0xTier1Wallet1234567890123456789012345678",
        maxAssuranceTier: 1,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as { kernel: { maxAssuranceTier?: number } };
    expect(body.kernel.maxAssuranceTier).toBe(1);
  });

  it("[c6b48ca1] persists submitted maxAssuranceTier=0 (the lowest tier — not silently overridden)", async () => {
    const id = `kernel_test_tier0_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Tier-0 operator",
        operatorAddress: "0xTier0Wallet1234567890123456789012345678",
        maxAssuranceTier: 0,
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as { kernel: { maxAssuranceTier?: number } };
    expect(body.kernel.maxAssuranceTier).toBe(0);
  });

  it("[c6b48ca1] defaults maxAssuranceTier=2 when omitted from input", async () => {
    const id = `kernel_test_tier_default_${Date.now()}`;
    const create = await app.inject({
      method: "POST",
      url: "/api/kernels",
      payload: {
        id,
        name: "Default-tier operator",
        operatorAddress: "0xDefaultWallet1234567890123456789012345678",
      },
    });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `/api/kernels/${id}` });
    const body = JSON.parse(get.body) as { kernel: { maxAssuranceTier?: number } };
    expect(body.kernel.maxAssuranceTier).toBe(2);
  });
});

/**
 * Tests for the ad-hoc capability negotiation + build/options path.
 *
 * Two bugs we're fixing:
 *
 *   1. POST /api/negotiate/session returns 500 universally (even for known types
 *      like `fdm`). Acceptance: returns CONFIGURING/QUOTED session, advanceable
 *      to COMMITTED.
 *
 *   2. POST /api/build/options + POST /api/build/contract fail with 500 for
 *      ad-hoc capability types (any type not in the 18 hardcoded templates).
 *      Acceptance: ad-hoc cap returns 200 with options derived from the
 *      capability's pricingModel; missing-template returns clean 4xx.
 *
 * Fixtures use the three live capabilities currently registered on
 * https://capability.network:
 *   - Demo Machine Shop   kernel_mqfmpq8u_pk81   fdm                  (known template)
 *   - Marios Pizzeria     kernel_mqfm6xuw_1151   wood-fired-pizza     (ad-hoc)
 *   - Daves Delivery      kernel_mqfm8dka_v1jw   local-courier-delivery (ad-hoc)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { negotiationRoutes } from "../routes/negotiation.js";
import { buildRoutes } from "../routes/build.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

const { shopKernels, capabilities } = schema;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: false });

  // Seed kernels + capabilities to match the live demo fixtures
  const { db } = getStore();
  const now = new Date().toISOString();

  db.insert(shopKernels).values([
    {
      id: "kernel_mqfmpq8u_pk81",
      name: "Demo Machine Shop",
      operatorAddress: "shop@demo.example",
      location: { lat: 0, lng: 0 },
      physicalAddress: "Brooklyn",
      maxAssuranceTier: 2,
      status: "online",
      lastHeartbeat: now,
      version: "0.1.0",
      createdAt: now,
    } as any,
    {
      id: "kernel_mqfm6xuw_1151",
      name: "Marios Pizzeria",
      operatorAddress: "mario@mariospizza.example",
      location: { lat: 0, lng: 0 },
      physicalAddress: "123 Mulberry St NYC",
      maxAssuranceTier: 2,
      status: "online",
      lastHeartbeat: now,
      version: "0.1.0",
      createdAt: now,
    } as any,
    {
      id: "kernel_mqfm8dka_v1jw",
      name: "Daves Delivery (mobile)",
      operatorAddress: "dave@davesdelivery.example",
      location: { lat: 0, lng: 0 },
      physicalAddress: "roams Manhattan",
      maxAssuranceTier: 2,
      status: "online",
      lastHeartbeat: now,
      version: "0.1.0",
      createdAt: now,
    } as any,
  ]).run();

  db.insert(capabilities).values([
    {
      id: "cap-kernel_mqfmpq8u_pk81-fdm",
      kernelId: "kernel_mqfmpq8u_pk81",
      type: "fdm",
      name: "FDM 3D print (PLA)",
      description: "",
      materials: ["PLA"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: 20 },
      location: { lat: 0, lng: 0 },
      createdAt: now,
    } as any,
    {
      id: "cap-kernel_mqfm6xuw_1151-wood-fired-pizza",
      kernelId: "kernel_mqfm6xuw_1151",
      type: "wood-fired-pizza",
      name: "12-inch Margherita",
      description: "",
      materials: ["dough", "mozzarella"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: 12 },
      location: { lat: 0, lng: 0 },
      createdAt: now,
    } as any,
    {
      id: "cap-kernel_mqfm8dka_v1jw-local-courier-delivery",
      kernelId: "kernel_mqfm8dka_v1jw",
      type: "local-courier-delivery",
      name: "Hot-bag car delivery <5mi",
      description: "",
      materials: [],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: 6 },
      location: { lat: 0, lng: 0 },
      createdAt: now,
    } as any,
  ]).run();

  const app = Fastify({ logger: false });
  await app.register(negotiationRoutes);
  await app.register(buildRoutes);
  await app.ready();
  return app;
}

describe("Ad-hoc capability negotiate + build/options", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  // ════════════════════════════════════════════════════════════════════
  // Task A: POST /api/negotiate/session must succeed for known fdm type
  // ════════════════════════════════════════════════════════════════════

  describe("POST /api/negotiate/session", () => {
    it("creates session for known capability type (fdm) — returns 200, not 500", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        payload: {
          userAgentId: "test-agent",
          kernelId: "kernel_mqfmpq8u_pk81",
          capabilityType: "fdm",
        },
      });

      // Print the failure body so we see the actual error if this fails
      if (res.statusCode !== 200) {
        // eslint-disable-next-line no-console
        console.error("[fdm session-create] FAILED:", res.statusCode, res.body);
      }

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.session).toBeDefined();
      expect(json.session.id).toMatch(/^sess-/);
      expect(json.session.kernelId).toBe("kernel_mqfmpq8u_pk81");
      expect(json.session.capabilityType).toBe("fdm");
      expect(["created", "configuring"]).toContain(json.session.status);
    });

    it("creates session for AD-HOC capability type (wood-fired-pizza) — returns 200, not 500", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        payload: {
          userAgentId: "test-agent",
          kernelId: "kernel_mqfm6xuw_1151",
          capabilityType: "wood-fired-pizza",
        },
      });

      if (res.statusCode !== 200) {
        // eslint-disable-next-line no-console
        console.error("[pizza session-create] FAILED:", res.statusCode, res.body);
      }

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.session).toBeDefined();
      expect(json.session.capabilityType).toBe("wood-fired-pizza");
    });

    it("returns 4xx (NOT 500) when kernel does not exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        payload: {
          userAgentId: "test-agent",
          kernelId: "kernel-does-not-exist",
          capabilityType: "fdm",
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it("returns 4xx (NOT 500) when kernel does not offer the requested capability", async () => {
      // kernel_mqfmpq8u_pk81 only has fdm — asking for pizza is wrong-kernel
      const res = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        payload: {
          userAgentId: "test-agent",
          kernelId: "kernel_mqfmpq8u_pk81",
          capabilityType: "wood-fired-pizza",
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      const json = res.json();
      expect(JSON.stringify(json)).toMatch(/capability|kernel|not.*offer|does not/i);
    });

    it("advances a session through configuring -> quoted -> reviewing -> committed for fdm", async () => {
      // Create
      const create = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        payload: {
          userAgentId: "test-agent",
          kernelId: "kernel_mqfmpq8u_pk81",
          capabilityType: "fdm",
        },
      });
      expect(create.statusCode).toBe(200);
      const sessionId = create.json().session.id;

      // Quote
      const quote = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/quote`,
      });
      if (quote.statusCode !== 200) console.error("[quote]", quote.statusCode, quote.body);
      expect(quote.statusCode).toBe(200);

      // Review
      const review = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/review`,
      });
      if (review.statusCode !== 200) console.error("[review]", review.statusCode, review.body);
      expect(review.statusCode).toBe(200);

      // Commit
      const commit = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/commit`,
      });
      if (commit.statusCode !== 200) console.error("[commit]", commit.statusCode, commit.body);
      expect(commit.statusCode).toBe(200);
      expect(commit.json().session.status).toBe("committed");
    });

    it("advances AD-HOC pizza session through full flow including commit", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/negotiate/session",
        payload: {
          userAgentId: "test-agent",
          kernelId: "kernel_mqfm6xuw_1151",
          capabilityType: "wood-fired-pizza",
          capabilityId: "cap-kernel_mqfm6xuw_1151-wood-fired-pizza",
        },
      });
      expect(create.statusCode).toBe(200);
      const sessionId = create.json().session.id;

      const quote = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/quote`,
      });
      expect(quote.statusCode).toBe(200);
      const quoteJson = quote.json();
      // Ad-hoc cap should derive baseCost from capability's pricingModel (12 USDC for pizza)
      expect(parseFloat(quoteJson.quote.basePrice)).toBeGreaterThan(0);
      expect(quoteJson.quote.currency).toBe("USDC");

      const review = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/review`,
      });
      expect(review.statusCode).toBe(200);

      const commit = await app.inject({
        method: "POST",
        url: `/api/negotiate/session/${sessionId}/commit`,
      });
      expect(commit.statusCode).toBe(200);
      expect(commit.json().session.status).toBe("committed");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Task B: POST /api/build/options must work for ad-hoc capabilities
  // ════════════════════════════════════════════════════════════════════

  describe("POST /api/build/options", () => {
    it("returns options for known capability type (fdm)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/options",
        payload: { type: "fdm" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().options).toBeDefined();
    });

    it("returns options for AD-HOC capability type (wood-fired-pizza) — derived from pricingModel", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/options",
        payload: {
          type: "wood-fired-pizza",
          capabilityId: "cap-kernel_mqfm6xuw_1151-wood-fired-pizza",
        },
      });
      if (res.statusCode !== 200) console.error("[pizza build/options]", res.statusCode, res.body);
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.options).toBeDefined();
      // Pricing comes from the capability's pricingModel (baseCost: 12, currency: USDC)
      // Options should at least include a generic-params group for ad-hoc caps
    });

    it("returns 4xx (NOT 500) for an unknown type with no matching ad-hoc capability", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/options",
        payload: { type: "totally-made-up-capability-type-xyz" },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      const json = res.json();
      // Must have a clear error message
      expect(JSON.stringify(json)).toMatch(/template|capability|not.*found|unknown/i);
    });
  });

  describe("POST /api/build/price", () => {
    it("returns price for known capability type (fdm)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/price",
        payload: { type: "fdm", selections: {} },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().pricing).toBeDefined();
    });

    it("returns price for AD-HOC capability type via pricingModel (wood-fired-pizza)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/price",
        payload: {
          type: "wood-fired-pizza",
          selections: { quantity: 1 },
          capabilityId: "cap-kernel_mqfm6xuw_1151-wood-fired-pizza",
        },
      });
      if (res.statusCode !== 200) console.error("[pizza build/price]", res.statusCode, res.body);
      expect(res.statusCode).toBe(200);
    });

    it("returns 4xx (NOT 500) for unknown ad-hoc with no matching capability", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/price",
        payload: { type: "unknown-type-no-cap", selections: {} },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  describe("POST /api/build/contract", () => {
    it("builds contract for known capability type (fdm)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/contract",
        payload: { type: "fdm", selections: {}, assuranceTier: 1 },
      });
      expect(res.statusCode).toBe(200);
    });

    it("builds contract for AD-HOC capability type via pricingModel", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/build/contract",
        payload: {
          type: "wood-fired-pizza",
          selections: { quantity: 1 },
          assuranceTier: 1,
          capabilityId: "cap-kernel_mqfm6xuw_1151-wood-fired-pizza",
        },
      });
      if (res.statusCode !== 200) console.error("[pizza build/contract]", res.statusCode, res.body);
      expect(res.statusCode).toBe(200);
    });
  });
});

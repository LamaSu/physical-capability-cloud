/**
 * Pizza demo flow tests — the vibecodenights agentic-composition demo.
 *
 * Exercises the full lifecycle the LLM user-agent drives, end to end:
 *   seed providers → pizza-order (optimizeFor) → confirm → make-pizza job
 *   → delivery job → delivered → confirm-delivery (settlement + user rep).
 * Plus GET /api/csd/by-type/make-pizza capability discovery.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  pizzaDemoRoutes,
  _clearPizzaDemoForTests,
} from "../routes/pizza-demo.js";
import { csdRoutes } from "../routes/csd.js";
import {
  _seedGraphSearchForTests,
  _clearGraphSearchForTests,
} from "../routes/graph-search.js";
import { _clearComposeForTests } from "../routes/compose.js";
import type {
  RegisterGraphNodeInput,
  RegisterGraphEdgeInput,
} from "@pcc/spec";

function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(pizzaDemoRoutes);
  void app.register(csdRoutes);
  return app;
}

function shopNode(
  slug: string,
  priceUSD: number,
  etaMin: number,
): RegisterGraphNodeInput {
  return {
    capabilityId: `cap_${slug}`,
    capabilityType: "make-pizza",
    kernelId: `k_${slug}`,
    operatorAddress: `${slug}@demo`,
    estimatedPriceUSD: priceUSD,
    estimatedDurationMs: etaMin * 60_000,
    assuranceTier: 1,
    reputation: 600,
    available: true,
    location: { lat: 37.78, lng: -122.41 }, // within the order's 25km radius
    inputTypes: [],
    outputTypes: ["pizza"],
  };
}

function driverNode(
  slug: string,
  priceUSD: number,
  etaMin: number,
): RegisterGraphNodeInput {
  return {
    capabilityId: `cap_${slug}`,
    capabilityType: "delivered-pizza",
    kernelId: `k_${slug}`,
    operatorAddress: `${slug}@demo`,
    estimatedPriceUSD: priceUSD,
    estimatedDurationMs: etaMin * 60_000,
    assuranceTier: 1,
    reputation: 600,
    available: true,
    location: { lat: 37.78, lng: -122.41 }, // within the order's 25km radius
    inputTypes: ["pizza"],
    outputTypes: ["delivered-pizza"],
  };
}

function edge(from: string, to: string): RegisterGraphEdgeInput {
  return {
    fromCapabilityId: `cap_${from}`,
    toCapabilityId: `cap_${to}`,
    capabilityTypeFlow: "pizza",
    estimatedHandoffPriceUSD: 0,
  };
}

/** 2 shops × 2 drivers, every shop→driver edge — mirrors seed-pizza-demo.ts. */
function seedProviders(): void {
  _seedGraphSearchForTests({
    nodes: [
      shopNode("shop-roma", 15, 15), // pricier, fastest cook
      shopNode("shop-slice-heaven", 12, 20), // cheapest cook
      driverNode("driver-beth", 7, 22), // pricier, fastest driver
      driverNode("driver-dana", 4, 30), // cheapest driver
    ],
    edges: [
      edge("shop-roma", "driver-beth"),
      edge("shop-roma", "driver-dana"),
      edge("shop-slice-heaven", "driver-beth"),
      edge("shop-slice-heaven", "driver-dana"),
    ],
  });
}

beforeEach(() => {
  _clearPizzaDemoForTests();
  _clearGraphSearchForTests();
  _clearComposeForTests();
});

describe("pizza demo — full agentic-composition lifecycle", () => {
  it("plans the cheapest path, runs it, and settles with user reputation", async () => {
    const app = makeApp();
    seedProviders();

    // 1. order — optimizeFor price → cheapest shop × driver.
    const orderRes = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "alex@vibecode",
        description: "1 large pepperoni, extra cheese",
        deliveryAddress: "vibecodenights venue",
        optimizeFor: "price",
      },
    });
    expect(orderRes.statusCode).toBe(201);
    const { order } = orderRes.json();
    expect(order.status).toBe("proposed");
    expect(order.composition.shop.name).toBe("shop-slice-heaven");
    expect(order.composition.driver.name).toBe("driver-dana");
    expect(order.composition.totalPriceUSD).toBe(16); // 12 + 4
    const orderId = order.orderId as string;

    // 2. confirm → make-pizza job dispatched, order awaiting_shop.
    const confirmRes = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${orderId}/confirm`,
    });
    expect(confirmRes.statusCode).toBe(200);
    const { order: confirmed, job: makeJob } = confirmRes.json();
    expect(confirmed.status).toBe("awaiting_shop");
    expect(makeJob.type).toBe("make-pizza");

    // 3. shop accepts + completes → delivery job dispatched.
    await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${makeJob.jobId}/accept`,
    });
    const completeMake = await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${makeJob.jobId}/complete`,
    });
    expect(completeMake.json().order.status).toBe("awaiting_driver");

    // 4. read order state → delivery jobId.
    const stateRes = await app.inject({
      method: "GET",
      url: `/api/demo/orders/${orderId}`,
    });
    const deliveryJobId = stateRes.json().jobs.delivery.jobId as string;

    // 5. driver accept → pickup → complete → delivered.
    await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${deliveryJobId}/accept`,
    });
    await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${deliveryJobId}/pickup`,
    });
    const deliver = await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${deliveryJobId}/complete`,
    });
    expect(deliver.json().order.status).toBe("delivered");

    // 6. confirm-delivery → settlement summary + user reputation +5.
    const cd = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${orderId}/confirm-delivery`,
    });
    expect(cd.statusCode).toBe(200);
    const cdBody = cd.json();
    expect(cdBody.settlement.shopPayoutUSD).toBe(12);
    expect(cdBody.settlement.driverPayoutUSD).toBe(4);
    expect(cdBody.settlement.pccFeeUSD).toBeCloseTo(0.38, 2); // 16 * 0.0235
    expect(cdBody.reputation.userDelta).toBe(5);

    // 7. confirm-delivery is idempotent — second call grants no extra rep.
    const cd2 = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${orderId}/confirm-delivery`,
    });
    expect(cd2.statusCode).toBe(200);
    expect(cd2.json().reputation.userDelta).toBe(0);
  });

  it("optimizeFor=speed picks a faster path than optimizeFor=price", async () => {
    const app = makeApp();
    seedProviders();

    const fast = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "u",
        description: "pizza",
        deliveryAddress: "venue",
        optimizeFor: "speed",
      },
    });
    const cheap = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "u",
        description: "pizza",
        deliveryAddress: "venue",
        optimizeFor: "price",
      },
    });

    expect(fast.statusCode).toBe(201);
    expect(cheap.statusCode).toBe(201);
    // Speed picks the fastest cook (roma) and beats the cheap path's ETA.
    expect(fast.json().order.composition.shop.name).toBe("shop-roma");
    expect(fast.json().order.composition.etaSec).toBeLessThan(
      cheap.json().order.composition.etaSec,
    );
  });

  it("returns 404 no_path_found when no providers are seeded", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "u",
        description: "pizza",
        deliveryAddress: "venue",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("confirm-delivery is 409 before the order is delivered", async () => {
    const app = makeApp();
    seedProviders();
    const { order } = (
      await app.inject({
        method: "POST",
        url: "/api/demo/pizza-order",
        payload: { userId: "u", description: "pizza", deliveryAddress: "v" },
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${order.orderId}/confirm-delivery`,
    });
    expect(res.statusCode).toBe(409);
  });

  it("GET /api/csd/by-type/make-pizza returns the parameter spec", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/csd/by-type/make-pizza",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.csds[0].url).toBe("pcc://capabilities/make-pizza/v1");
    const keys = body.csds[0].parameters.map((p: { key: string }) => p.key);
    expect(keys).toContain("size");
    expect(keys).toContain("dietary");
    // size has no default — the agent must always ask.
    const size = body.csds[0].parameters.find(
      (p: { key: string }) => p.key === "size",
    );
    expect(size.required).toBe(true);
    expect(size.defaultValue).toBeUndefined();
  });
});

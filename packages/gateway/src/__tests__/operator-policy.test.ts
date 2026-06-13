/**
 * Operator-policy tests for the pizza demo.
 *
 *   1. decideOnOffer — the pure evaluator, every mode + boundary/edge cases
 *      (the spec asks for ≥12; there are ~24 here).
 *   2. CRUD routes — PUT/GET/DELETE + validation + sanitization.
 *   3. Dispatch wiring — pizza-demo consulting policies end-to-end:
 *      auto-accept skips the queue, auto-decline re-routes to the next provider,
 *      counter-offer → approve-counter accepts at the countered price.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  decideOnOffer,
  operatorPolicyRoutes,
  defaultDemoPolicy,
  getPolicyForAssignee,
  _clearOperatorPoliciesForTests,
  _setPolicyForTests,
} from "../routes/operator-policy.js";
import {
  pizzaDemoRoutes,
  _clearPizzaDemoForTests,
} from "../routes/pizza-demo.js";
import {
  _clearGraphSearchForTests,
  _seedGraphSearchForTests,
} from "../routes/graph-search.js";
import type {
  DemoOperatorPolicy,
  DemoJobOffer,
  DemoPolicyMode,
  RegisterGraphNodeInput,
  RegisterGraphEdgeInput,
} from "@pcc/spec";

// ── builders ─────────────────────────────────────────────────────────────────

function policy(
  over: Partial<DemoOperatorPolicy> & { mode: DemoPolicyMode },
): DemoOperatorPolicy {
  return {
    policyId: "pol_test",
    ownerId: "owner",
    scope: { capabilityType: "make-pizza", assigneeSlug: "shop-test" },
    rules: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function offer(over: Partial<DemoJobOffer> = {}): DemoJobOffer {
  return {
    capabilityType: "make-pizza",
    priceUSD: 15,
    deadlineSec: 1200,
    currentConcurrent: 0,
    counterOffersSoFar: 0,
    ...over,
  };
}

// ── 1. decideOnOffer — pure evaluator ────────────────────────────────────────

describe("decideOnOffer — always-prompt", () => {
  it("prompts the human regardless of rules", () => {
    const d = decideOnOffer(
      policy({ mode: "always-prompt", rules: { minPriceUSD: 1 } }),
      offer({ priceUSD: 1000 }),
    );
    expect(d).toEqual({ kind: "prompt-human" });
  });
});

describe("decideOnOffer — auto mode", () => {
  it("auto-accepts when no rules are set", () => {
    const d = decideOnOffer(policy({ mode: "auto" }), offer());
    expect(d.kind).toBe("auto-accept");
  });

  it("auto-declines below the price floor", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { minPriceUSD: 12 } }),
      offer({ priceUSD: 8 }),
    );
    expect(d.kind).toBe("auto-decline");
    if (d.kind === "auto-decline") expect(d.reason).toMatch(/floor/i);
  });

  it("auto-accepts exactly at the price floor (boundary, >=)", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { minPriceUSD: 12 } }),
      offer({ priceUSD: 12 }),
    );
    expect(d.kind).toBe("auto-accept");
  });

  it("auto-declines at capacity (currentConcurrent >= maxConcurrent)", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { maxConcurrent: 2 } }),
      offer({ currentConcurrent: 2 }),
    );
    expect(d.kind).toBe("auto-decline");
    if (d.kind === "auto-decline") expect(d.reason).toMatch(/capacity/i);
  });

  it("auto-accepts below capacity", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { maxConcurrent: 2 } }),
      offer({ currentConcurrent: 1 }),
    );
    expect(d.kind).toBe("auto-accept");
  });

  it("auto-declines when the deadline is too tight", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { requireDeadlineMinSec: 900 } }),
      offer({ deadlineSec: 600 }),
    );
    expect(d.kind).toBe("auto-decline");
    if (d.kind === "auto-decline") expect(d.reason).toMatch(/deadline/i);
  });

  it("auto-accepts when the deadline exactly meets the minimum (boundary)", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { requireDeadlineMinSec: 900 } }),
      offer({ deadlineSec: 900 }),
    );
    expect(d.kind).toBe("auto-accept");
  });

  it("escalates to the human at/above the auto-accept ceiling", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { autoAcceptUnderUSD: 50 } }),
      offer({ priceUSD: 50 }),
    );
    expect(d).toEqual({ kind: "prompt-human" });
  });

  it("auto-accepts just under the ceiling", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { autoAcceptUnderUSD: 50 } }),
      offer({ priceUSD: 49.99 }),
    );
    expect(d.kind).toBe("auto-accept");
  });

  it("capacity gate takes precedence over the price floor", () => {
    const d = decideOnOffer(
      policy({ mode: "auto", rules: { maxConcurrent: 1, minPriceUSD: 100 } }),
      offer({ currentConcurrent: 5, priceUSD: 1 }),
    );
    expect(d.kind).toBe("auto-decline");
    if (d.kind === "auto-decline") expect(d.reason).toMatch(/capacity/i);
  });

  it("accepts within the full band [floor, ceiling)", () => {
    const p = policy({
      mode: "auto",
      rules: { minPriceUSD: 12, autoAcceptUnderUSD: 100, maxConcurrent: 3, requireDeadlineMinSec: 600 },
    });
    expect(decideOnOffer(p, offer({ priceUSD: 40, deadlineSec: 700, currentConcurrent: 1 })).kind).toBe(
      "auto-accept",
    );
  });
});

describe("decideOnOffer — negotiate mode", () => {
  it("counter-offers below the floor at offer × multiplier", () => {
    const d = decideOnOffer(
      policy({
        mode: "negotiate",
        rules: { minPriceUSD: 11 },
        negotiation: { counterPriceMultiplier: 1.5, maxCounterOffers: 3 },
      }),
      offer({ priceUSD: 10 }),
    );
    // 10 < 11 (below floor) → 10 * 1.5 = 15 (above floor) → counter 15
    expect(d).toEqual({ kind: "counter-offer", newPriceUSD: 15 });
  });

  it("floors the counter at minPriceUSD when offer × multiplier is lower", () => {
    const d = decideOnOffer(
      policy({
        mode: "negotiate",
        rules: { minPriceUSD: 20 },
        negotiation: { counterPriceMultiplier: 1.2 },
      }),
      offer({ priceUSD: 10 }),
    );
    // 10 * 1.2 = 12 < 20 → counter clamps up to the floor, 20
    expect(d).toEqual({ kind: "counter-offer", newPriceUSD: 20 });
  });

  it("uses a 1.2x default multiplier when negotiation is unset", () => {
    const d = decideOnOffer(
      policy({ mode: "negotiate", rules: { minPriceUSD: 11 } }),
      offer({ priceUSD: 10 }),
    );
    // default multiplier 1.2 → 10 * 1.2 = 12 (≥ floor 11) → counter 12
    expect(d).toEqual({ kind: "counter-offer", newPriceUSD: 12 });
  });

  it("rounds the counter price to cents", () => {
    const d = decideOnOffer(
      policy({
        mode: "negotiate",
        rules: { minPriceUSD: 11 },
        negotiation: { counterPriceMultiplier: 1.2 },
      }),
      offer({ priceUSD: 10.1 }),
    );
    // 10.1 * 1.2 = 12.119999… → round2 → 12.12
    expect(d).toEqual({ kind: "counter-offer", newPriceUSD: 12.12 });
  });

  it("auto-accepts when the offer meets the floor", () => {
    const d = decideOnOffer(
      policy({ mode: "negotiate", rules: { minPriceUSD: 12 } }),
      offer({ priceUSD: 15 }),
    );
    expect(d.kind).toBe("auto-accept");
  });

  it("auto-accepts when no floor is configured (nothing to negotiate)", () => {
    const d = decideOnOffer(policy({ mode: "negotiate" }), offer({ priceUSD: 3 }));
    expect(d.kind).toBe("auto-accept");
  });

  it("gives up (auto-decline) once maxCounterOffers is reached", () => {
    const d = decideOnOffer(
      policy({
        mode: "negotiate",
        rules: { minPriceUSD: 20 },
        negotiation: { maxCounterOffers: 2 },
      }),
      offer({ priceUSD: 10, counterOffersSoFar: 2 }),
    );
    expect(d.kind).toBe("auto-decline");
    if (d.kind === "auto-decline") expect(d.reason).toMatch(/gave up|max/i);
  });

  it("counters on the first attempt when maxCounterOffers allows it", () => {
    const d = decideOnOffer(
      policy({
        mode: "negotiate",
        rules: { minPriceUSD: 20 },
        negotiation: { maxCounterOffers: 2 },
      }),
      offer({ priceUSD: 10, counterOffersSoFar: 1 }),
    );
    expect(d.kind).toBe("counter-offer");
  });

  it("still hard-declines a too-tight deadline (gate beats negotiation)", () => {
    const d = decideOnOffer(
      policy({
        mode: "negotiate",
        rules: { minPriceUSD: 50, requireDeadlineMinSec: 900 },
      }),
      offer({ priceUSD: 10, deadlineSec: 100 }),
    );
    expect(d.kind).toBe("auto-decline");
    if (d.kind === "auto-decline") expect(d.reason).toMatch(/deadline/i);
  });

  it("escalates a high-value (≥ ceiling) offer even in negotiate mode", () => {
    const d = decideOnOffer(
      policy({
        mode: "negotiate",
        rules: { minPriceUSD: 10, autoAcceptUnderUSD: 50 },
      }),
      offer({ priceUSD: 60 }),
    );
    expect(d).toEqual({ kind: "prompt-human" });
  });
});

// ── 2. CRUD routes ───────────────────────────────────────────────────────────

function makePolicyApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(operatorPolicyRoutes);
  return app;
}

describe("operator-policy CRUD routes", () => {
  beforeEach(() => _clearOperatorPoliciesForTests());

  it("PUT then GET round-trips a policy", async () => {
    const app = makePolicyApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-roma",
      payload: { mode: "auto", rules: { minPriceUSD: 12 } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().policy.mode).toBe("auto");
    expect(put.json().policy.scope.assigneeSlug).toBe("shop-roma");

    const get = await app.inject({
      method: "GET",
      url: "/api/demo/operator-policy/shop-roma",
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().isDefault).toBe(false);
    expect(get.json().policy.rules.minPriceUSD).toBe(12);
  });

  it("GET returns the always-prompt default when none is set", async () => {
    const app = makePolicyApp();
    const get = await app.inject({
      method: "GET",
      url: "/api/demo/operator-policy/never-configured",
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().isDefault).toBe(true);
    expect(get.json().policy.mode).toBe("always-prompt");
  });

  it("PUT rejects an invalid mode with 400", async () => {
    const app = makePolicyApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-roma",
      payload: { mode: "yolo" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT sanitizes invalid/negative numeric rule fields", async () => {
    const app = makePolicyApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-roma",
      payload: {
        mode: "auto",
        rules: { minPriceUSD: -5, maxConcurrent: 2.9, autoAcceptUnderUSD: "nan" },
      },
    });
    expect(res.statusCode).toBe(200);
    const rules = res.json().policy.rules;
    expect(rules.minPriceUSD).toBeUndefined(); // negative dropped
    expect(rules.maxConcurrent).toBe(2); // floored
    expect(rules.autoAcceptUnderUSD).toBeUndefined(); // non-number dropped
  });

  it("DELETE reverts to the default", async () => {
    const app = makePolicyApp();
    await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-roma",
      payload: { mode: "auto" },
    });
    const del = await app.inject({
      method: "DELETE",
      url: "/api/demo/operator-policy/shop-roma",
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().existed).toBe(true);
    expect(del.json().policy.mode).toBe("always-prompt");

    const get = await app.inject({
      method: "GET",
      url: "/api/demo/operator-policy/shop-roma",
    });
    expect(get.json().isDefault).toBe(true);
  });

  it("defaultDemoPolicy / getPolicyForAssignee default to always-prompt", () => {
    _clearOperatorPoliciesForTests();
    expect(defaultDemoPolicy("x").mode).toBe("always-prompt");
    expect(getPolicyForAssignee("unset-slug").mode).toBe("always-prompt");
    _setPolicyForTests(
      policy({ mode: "auto", scope: { capabilityType: "make-pizza", assigneeSlug: "set-slug" } }),
    );
    expect(getPolicyForAssignee("set-slug").mode).toBe("auto");
  });
});

// ── 3. Dispatch wiring (pizza-demo consults policies) ────────────────────────

function gnode(
  over: Partial<RegisterGraphNodeInput> & { capabilityId: string; capabilityType: string },
): RegisterGraphNodeInput {
  return {
    capabilityId: over.capabilityId,
    capabilityType: over.capabilityType,
    kernelId: over.kernelId ?? `k_${over.capabilityId}`,
    estimatedPriceUSD: over.estimatedPriceUSD ?? 10,
    estimatedDurationMs: over.estimatedDurationMs ?? 900_000,
    assuranceTier: over.assuranceTier ?? 1,
    reputation: over.reputation ?? 500,
    available: over.available ?? true,
    // Co-located with the order's default delivery point so the graph-search
    // proximity filter (radius 25km) keeps every seeded node.
    location: over.location ?? { lat: 37.77, lng: -122.42 },
    inputTypes: over.inputTypes ?? [],
    outputTypes: over.outputTypes ?? [],
  };
}
function gedge(from: string, to: string): RegisterGraphEdgeInput {
  return {
    fromCapabilityId: from,
    toCapabilityId: to,
    capabilityTypeFlow: "pizza",
    estimatedHandoffPriceUSD: 0,
  };
}

/** Seed two shops + two drivers + the 4 shop→driver edges. */
function seedPizzaGraph(): void {
  _seedGraphSearchForTests({
    nodes: [
      gnode({ capabilityId: "cap_shop-cheap", capabilityType: "make-pizza", estimatedPriceUSD: 12, outputTypes: ["pizza"] }),
      gnode({ capabilityId: "cap_shop-roma", capabilityType: "make-pizza", estimatedPriceUSD: 15, outputTypes: ["pizza"] }),
      gnode({ capabilityId: "cap_driver-dana", capabilityType: "delivered-pizza", estimatedPriceUSD: 4, inputTypes: ["pizza"], outputTypes: ["delivered-pizza"] }),
      gnode({ capabilityId: "cap_driver-alex", capabilityType: "delivered-pizza", estimatedPriceUSD: 5, inputTypes: ["pizza"], outputTypes: ["delivered-pizza"] }),
    ],
    edges: [
      gedge("cap_shop-cheap", "cap_driver-dana"),
      gedge("cap_shop-cheap", "cap_driver-alex"),
      gedge("cap_shop-roma", "cap_driver-dana"),
      gedge("cap_shop-roma", "cap_driver-alex"),
    ],
  });
}

function makeDemoApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(pizzaDemoRoutes);
  void app.register(operatorPolicyRoutes);
  return app;
}

async function placeOrder(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/api/demo/pizza-order",
    payload: {
      userId: "user-1",
      description: "Margherita",
      deliveryAddress: "1 Test St",
      maxPriceUSD: 40,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().order as {
    orderId: string;
    composition: { shop: { name: string }; driver: { name: string } };
  };
}

describe("pizza-demo dispatch consults operator policies", () => {
  beforeEach(() => {
    _clearPizzaDemoForTests();
    _clearGraphSearchForTests();
    _clearOperatorPoliciesForTests();
    seedPizzaGraph();
  });

  it("default (no policy) keeps the original queued/await-human behaviour", async () => {
    const app = makeDemoApp();
    const order = await placeOrder(app);
    await app.inject({ method: "POST", url: `/api/demo/orders/${order.orderId}/confirm` });

    const got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    const body = got.json();
    expect(body.order.status).toBe("awaiting_shop");
    expect(body.jobs.makePizza.status).toBe("queued");
    expect(body.jobs.makePizza.autoHandled).toBeFalsy();
  });

  it("auto-accept skips the queue (job goes straight to accepted)", async () => {
    const app = makeDemoApp();
    const order = await placeOrder(app);
    expect(order.composition.shop.name).toBe("shop-cheap"); // cheapest path

    await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-cheap",
      payload: { mode: "auto" },
    });
    await app.inject({ method: "POST", url: `/api/demo/orders/${order.orderId}/confirm` });

    const got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    const body = got.json();
    expect(body.jobs.makePizza.status).toBe("accepted");
    expect(body.jobs.makePizza.autoHandled).toBe(true);
    expect(body.jobs.makePizza.policyMode).toBe("auto");
    expect(body.order.status).toBe("making");
  });

  it("auto-decline re-routes to the next-cheapest provider", async () => {
    const app = makeDemoApp();
    const order = await placeOrder(app);
    expect(order.composition.shop.name).toBe("shop-cheap");

    // Cheapest shop declines everything; the next shop auto-accepts.
    await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-cheap",
      payload: { mode: "auto", rules: { minPriceUSD: 100 } },
    });
    await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-roma",
      payload: { mode: "auto" },
    });
    await app.inject({ method: "POST", url: `/api/demo/orders/${order.orderId}/confirm` });

    const got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    const body = got.json();
    expect(body.order.composition.shop.name).toBe("shop-roma"); // re-routed
    expect(body.jobs.makePizza.assigneeSlug).toBe("shop-roma");
    expect(body.jobs.makePizza.status).toBe("accepted");
  });

  it("fails the order when every provider auto-declines", async () => {
    const app = makeDemoApp();
    const order = await placeOrder(app);
    for (const slug of ["shop-cheap", "shop-roma"]) {
      await app.inject({
        method: "PUT",
        url: `/api/demo/operator-policy/${slug}`,
        payload: { mode: "auto", rules: { minPriceUSD: 1000 } },
      });
    }
    await app.inject({ method: "POST", url: `/api/demo/orders/${order.orderId}/confirm` });

    const got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    expect(got.json().order.status).toBe("failed");
  });

  it("counter-offer → approve-counter accepts at the countered price", async () => {
    const app = makeDemoApp();
    const order = await placeOrder(app);
    expect(order.composition.shop.name).toBe("shop-cheap");

    // shop-cheap offered $12; floor $20, multiplier 1.5 → counter clamps to $20.
    await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-cheap",
      payload: {
        mode: "negotiate",
        rules: { minPriceUSD: 20 },
        negotiation: { counterPriceMultiplier: 1.5, maxCounterOffers: 2 },
      },
    });
    await app.inject({ method: "POST", url: `/api/demo/orders/${order.orderId}/confirm` });

    let got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    let mk = got.json().jobs.makePizza;
    expect(mk.status).toBe("negotiating");
    expect(mk.counterPriceUSD).toBe(20);
    expect(got.json().order.status).toBe("negotiating");

    const appr = await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${mk.jobId}/approve-counter`,
    });
    expect(appr.statusCode).toBe(200);

    got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    mk = got.json().jobs.makePizza;
    expect(mk.status).toBe("accepted");
    expect(mk.details.priceUSD).toBe(20);
    expect(got.json().order.status).toBe("making");
  });

  it("reject-counter re-routes to the next provider", async () => {
    const app = makeDemoApp();
    const order = await placeOrder(app);

    await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-cheap",
      payload: { mode: "negotiate", rules: { minPriceUSD: 50 } },
    });
    await app.inject({
      method: "PUT",
      url: "/api/demo/operator-policy/shop-roma",
      payload: { mode: "auto" },
    });
    await app.inject({ method: "POST", url: `/api/demo/orders/${order.orderId}/confirm` });

    let got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    const negotiatingJob = got.json().jobs.makePizza;
    expect(negotiatingJob.status).toBe("negotiating");

    const rej = await app.inject({
      method: "POST",
      url: `/api/demo/jobs/${negotiatingJob.jobId}/reject-counter`,
    });
    expect(rej.statusCode).toBe(200);

    got = await app.inject({ method: "GET", url: `/api/demo/orders/${order.orderId}` });
    expect(got.json().order.composition.shop.name).toBe("shop-roma");
    expect(got.json().jobs.makePizza.status).toBe("accepted");
  });
});

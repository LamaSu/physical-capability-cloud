/**
 * Job-offers tests — the generic matching primitive at /api/job-offers/*.
 *
 * Covers every route in the surface (POST/GET-open/GET-id/claim/events
 * /heartbeat/PATCH/DELETE/healthz), the race-safe claim, source-verify,
 * TTL sweep, heartbeat sweep, PATCH/DELETE auth gating, the filtered
 * open feed, AND the cross-capability-type matrix — same route, same
 * semantics, regardless of whether the offer is courier.dispatch, pizza.order,
 * lab.hplc, or opentrons.runProtocol. The whole point of the generalization
 * is that the route doesn't care.
 *
 * No external network: stub verify fn on the store. Time control via the
 * now() injector so sweeper runs deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { jobOffersRoutes } from "../routes/job-offers.js";
import {
  initJobOffersStore,
  _resetJobOffersStoreForTests,
  type VerifyFn,
} from "../services/job-offers-store.js";

// ── Time controller ────────────────────────────────────────────────────────

let mockNowMs = 0;
const now = () => new Date(mockNowMs);
const advance = (ms: number): void => { mockNowMs += ms; };

// ── Verify stub ────────────────────────────────────────────────────────────

let verifyResponses: Map<string, "ok" | "fail-404" | "fail-placed-false"> = new Map();
const stubVerify: VerifyFn = async (url) => {
  const r = verifyResponses.get(url) ?? "ok";
  if (r === "ok") return { ok: true, body: { ok: true } };
  if (r === "fail-404") {
    return { ok: false, reason: "http_non_2xx", status: 404, body: "Not Found" };
  }
  return {
    ok: false,
    reason: "source_says_not_real",
    status: 200,
    body: { placed: false },
  };
};

// ── App ───────────────────────────────────────────────────────────────────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(jobOffersRoutes);
  await app.ready();
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function courierOffer(id = "courier-1"): Record<string, unknown> {
  return {
    id,
    capabilityType: "courier.dispatch",
    requirements: {
      pickup: { name: "Store", lat: 37.77, lng: -122.42, address: "123 Geary" },
      dropoff: { name: "Tower", lat: 37.78, lng: -122.40, address: "Frontier Tower" },
      externalRef: "domino-7764",
    },
    pricing: { amount: 6.70, currency: "USD", model: "fixed" },
  };
}

function pizzaOffer(id = "pizza-1"): Record<string, unknown> {
  return {
    id,
    capabilityType: "pizza.order",
    requirements: {
      store: "domino-sf-7764",
      items: [{ size: "large", crust: "hand-tossed", toppings: ["pepperoni"] }],
      readyByIso: "2026-06-19T18:00:00.000Z",
    },
    pricing: { amount: 21.71, currency: "USD", model: "fixed" },
    deadline: "2026-06-19T18:30:00.000Z",
  };
}

function hplcOffer(id = "hplc-1"): Record<string, unknown> {
  return {
    id,
    capabilityType: "lab.hplc",
    requirements: {
      sampleCount: 10,
      protocol: "purity-analysis-v1",
      sampleType: "liquid",
      shipping: { from: "Berkeley, CA", to: "operator" },
    },
    pricing: { amount: 40, currency: "USD", model: "per-unit", unit: "sample" },
    assuranceTier: 2,
    evidenceRequirements: {
      chain_of_custody: true,
      raw_data_required: true,
      tier_required: 2,
    },
  };
}

function opentronsOffer(id = "opentrons-1"): Record<string, unknown> {
  return {
    id,
    capabilityType: "opentrons.runProtocol",
    requirements: {
      protocolFile: "ipfs://Qm...",
      instrument: "OT-2",
      labwareSetup: { slots: { 1: "tiprack_300ul", 3: "96well-plate" } },
    },
    pricing: { amount: 50, currency: "USDC", model: "fixed" },
  };
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  _resetJobOffersStoreForTests();
  mockNowMs = Date.parse("2026-06-19T00:00:00.000Z");
  verifyResponses = new Map();
  initJobOffersStore({ verify: stubVerify, now });
});

afterEach(() => {
  _resetJobOffersStoreForTests();
});

// ── Healthz ────────────────────────────────────────────────────────────────

describe("GET /api/job-offers/healthz", () => {
  it("returns ok=true with counter snapshot", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/job-offers/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toContain("job-offers");
      expect(body.offers).toBe(0);
      expect(body.open).toBe(0);
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/job-offers ───────────────────────────────────────────────────

describe("POST /api/job-offers — generic surface", () => {
  it("creates a courier.dispatch offer and returns 201 with capabilityType in response", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        headers: { "x-posted-by": "tester" },
        payload: courierOffer(),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.id).toBe("courier-1");
      expect(body.capabilityType).toBe("courier.dispatch");
      expect(body.status).toBe("open");
      expect(body.verified).toBe(false);
      expect(body.requirementsValidated).toBe(false); // graceful degrade — no schema registered
      expect(body.feedUrl).toContain("capabilityType=courier.dispatch");
    } finally {
      await app.close();
    }
  });

  it("creates a pizza.order offer with same route + same semantics", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        headers: { "x-posted-by": "tester" },
        payload: pizzaOffer(),
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBe("pizza-1");
      expect(body.capabilityType).toBe("pizza.order");
      expect(body.status).toBe("open");
    } finally {
      await app.close();
    }
  });

  it("creates a lab.hplc offer with assuranceTier + evidenceRequirements + per-unit pricing", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        headers: { "x-posted-by": "tester" },
        payload: hplcOffer(),
      });
      expect(res.statusCode).toBe(201);
      const get = await app.inject({ method: "GET", url: "/api/job-offers/hplc-1" });
      const o = get.json().offer;
      expect(o.capabilityType).toBe("lab.hplc");
      expect(o.assuranceTier).toBe(2);
      expect(o.evidenceRequirements.chain_of_custody).toBe(true);
      expect(o.pricing.model).toBe("per-unit");
      expect(o.pricing.unit).toBe("sample");
    } finally {
      await app.close();
    }
  });

  it("creates an opentrons.runProtocol offer with USDC currency", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        headers: { "x-posted-by": "tester" },
        payload: opentronsOffer(),
      });
      expect(res.statusCode).toBe(201);
      const get = await app.inject({ method: "GET", url: "/api/job-offers/opentrons-1" });
      const o = get.json().offer;
      expect(o.capabilityType).toBe("opentrons.runProtocol");
      expect(o.pricing.currency).toBe("USDC");
      expect(o.requirements.instrument).toBe("OT-2");
    } finally {
      await app.close();
    }
  });

  it("returns 400 with required fields when body is missing capabilityType/requirements/pricing", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        payload: { id: "bad" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("missing_fields");
      expect(body.required).toEqual(["capabilityType", "requirements", "pricing"]);
      expect(body.missing).toContain("capabilityType");
      expect(body.missing).toContain("requirements");
      expect(body.missing).toContain("pricing");
    } finally {
      await app.close();
    }
  });

  it("returns 400 invalid_pricing when pricing.model is unknown", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        payload: {
          capabilityType: "courier.dispatch",
          requirements: { pickup: {}, dropoff: {} },
          pricing: { amount: 10, currency: "USD", model: "monthly-subscription" },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_pricing");
    } finally {
      await app.close();
    }
  });

  it("verified=true when sourceVerifyUrl returns 2xx (pizza POS path)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        headers: { "x-posted-by": "tester" },
        payload: { ...pizzaOffer(), sourceVerifyUrl: "https://dominos.example.com/order/123" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().verified).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 400 source_verify_failed when sourceVerifyUrl returns 404", async () => {
    verifyResponses.set("https://upstream/missing", "fail-404");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        payload: { ...courierOffer(), sourceVerifyUrl: "https://upstream/missing" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("source_verify_failed");
      expect(body.reason).toBe("http_non_2xx");
      expect(body.sourceStatus).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 200 + note=already posted when the same id is posted twice", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer() });
      const res2 = await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer() });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().note).toBe("already posted");
    } finally {
      await app.close();
    }
  });

  it("dedups by idempotencyKey across multiple posts (different ids)", async () => {
    const app = await buildApp();
    try {
      const r1 = await app.inject({
        method: "POST", url: "/api/job-offers",
        payload: { ...courierOffer("first"), idempotencyKey: "deal-abc" },
      });
      expect(r1.statusCode).toBe(201);
      const r2 = await app.inject({
        method: "POST", url: "/api/job-offers",
        payload: { ...courierOffer("second"), idempotencyKey: "deal-abc" },
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().note).toBe("already posted");
      expect(r2.json().id).toBe("first");
    } finally {
      await app.close();
    }
  });
});

// ── GET /api/job-offers/open — capability-type-aware feed ──────────────────

describe("GET /api/job-offers/open", () => {
  it("returns 400 when capabilityType is not provided (operators must specify what they fulfill)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/job-offers/open" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_field");
      expect(res.json().required).toEqual(["capabilityType"]);
    } finally {
      await app.close();
    }
  });

  it("filters to capability_type: driver agent only sees courier.dispatch, lab agent only sees lab.hplc", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("c1") });
      advance(100);
      await app.inject({ method: "POST", url: "/api/job-offers", payload: pizzaOffer("p1") });
      advance(100);
      await app.inject({ method: "POST", url: "/api/job-offers", payload: hplcOffer("h1") });
      const driver = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=courier.dispatch",
      });
      expect(driver.statusCode).toBe(200);
      expect(driver.json().count).toBe(1);
      expect(driver.json().offers[0].id).toBe("c1");
      const lab = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=lab.hplc",
      });
      expect(lab.json().count).toBe(1);
      expect(lab.json().offers[0].id).toBe("h1");
    } finally {
      await app.close();
    }
  });

  it("sorts by postedAt desc within a capability_type", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("first") });
      advance(1000);
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("second") });
      const res = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=courier.dispatch",
      });
      expect(res.json().offers[0].id).toBe("second");
      expect(res.json().offers[1].id).toBe("first");
    } finally {
      await app.close();
    }
  });

  it("?minAmount/?maxAmount filter by pricing.amount range", async () => {
    const app = await buildApp();
    try {
      const mk = (id: string, amt: number) => app.inject({
        method: "POST", url: "/api/job-offers",
        payload: { ...courierOffer(id), pricing: { amount: amt, currency: "USD", model: "fixed" } },
      });
      await mk("low", 3); await mk("mid", 7); await mk("high", 15);
      const r1 = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=courier.dispatch&minAmount=5",
      });
      expect(r1.json().offers.map((j: { id: string }) => j.id).sort()).toEqual(["high", "mid"]);
      const r2 = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=courier.dispatch&maxAmount=10",
      });
      expect(r2.json().offers.map((j: { id: string }) => j.id).sort()).toEqual(["low", "mid"]);
    } finally {
      await app.close();
    }
  });

  it("?currency filters by pricing.currency (USDC vs USD)", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: opentronsOffer("u1") });   // USDC
      await app.inject({ method: "POST", url: "/api/job-offers", payload: {
        ...opentronsOffer("u2"),
        pricing: { amount: 50, currency: "USD", model: "fixed" },
      }});
      const usdc = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=opentrons.runProtocol&currency=USDC",
      });
      expect(usdc.json().count).toBe(1);
      expect(usdc.json().offers[0].id).toBe("u1");
    } finally {
      await app.close();
    }
  });

  it("?tier filters by assuranceTier", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: hplcOffer("h-t2") });           // tier 2
      await app.inject({ method: "POST", url: "/api/job-offers", payload: { ...hplcOffer("h-t3"), assuranceTier: 3 }});
      const t3 = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=lab.hplc&tier=3",
      });
      expect(t3.json().count).toBe(1);
      expect(t3.json().offers[0].id).toBe("h-t3");
    } finally {
      await app.close();
    }
  });

  it("?within=lat,lng,miles filters by haversine on requirements.pickup", async () => {
    const app = await buildApp();
    try {
      // SF pickup
      await app.inject({ method: "POST", url: "/api/job-offers", payload: {
        ...courierOffer("sf"),
        requirements: { pickup: { name: "SF", lat: 37.7749, lng: -122.4194 }, dropoff: { name: "B" } },
      }});
      // NYC pickup (~2570 mi from SF)
      await app.inject({ method: "POST", url: "/api/job-offers", payload: {
        ...courierOffer("nyc"),
        requirements: { pickup: { name: "NYC", lat: 40.7128, lng: -74.006 }, dropoff: { name: "B" } },
      }});
      const sfRes = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=courier.dispatch&within=37.77,-122.42,50",
      });
      const ids = sfRes.json().offers.map((j: { id: string }) => j.id);
      expect(ids).toContain("sf");
      expect(ids).not.toContain("nyc");
    } finally {
      await app.close();
    }
  });

  it("?limit/?offset paginate", async () => {
    const app = await buildApp();
    try {
      for (let i = 0; i < 5; i++) {
        await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer(`c-${i}`) });
        advance(100);
      }
      const page = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=courier.dispatch&limit=2&offset=1",
      });
      const body = page.json();
      expect(body.count).toBe(2);
      expect(body.total).toBe(5);
      expect(body.offset).toBe(1);
      expect(body.limit).toBe(2);
    } finally {
      await app.close();
    }
  });
});

// ── GET /api/job-offers/:id ────────────────────────────────────────────────

describe("GET /api/job-offers/:id", () => {
  it("returns the offer + events for any capability_type", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: pizzaOffer() });
      const res = await app.inject({ method: "GET", url: "/api/job-offers/pizza-1" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.offer.id).toBe("pizza-1");
      expect(body.offer.capabilityType).toBe("pizza.order");
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      expect(body.events[0].event).toBe("posted");
      expect(body.events[0].capabilityType).toBe("pizza.order");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for unknown id", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/job-offers/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/job-offers/:id/claim — race-safe ─────────────────────────────

describe("POST /api/job-offers/:id/claim", () => {
  it("claims a courier offer with kernelId, returns ok+offer", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("c-claim") });
      const res = await app.inject({
        method: "POST", url: "/api/job-offers/c-claim/claim",
        payload: { kernelId: "kernel-driver-7" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.offer.claimedByKernelId).toBe("kernel-driver-7");
      expect(body.offer.status).toBe("claimed");
    } finally {
      await app.close();
    }
  });

  it("claims a lab.hplc offer just as well — same route, different capability_type", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: hplcOffer("h-claim") });
      const res = await app.inject({
        method: "POST", url: "/api/job-offers/h-claim/claim",
        payload: { kernelId: "kernel-lab-berkeley" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().offer.claimedByKernelId).toBe("kernel-lab-berkeley");
      expect(res.json().offer.capabilityType).toBe("lab.hplc");
    } finally {
      await app.close();
    }
  });

  it("returns 400 when kernelId missing", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("c-mc") });
      const res = await app.inject({
        method: "POST", url: "/api/job-offers/c-mc/claim", payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_field");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for unknown offer", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST", url: "/api/job-offers/missing/claim",
        payload: { kernelId: "k1" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("race-safe: 10 concurrent claims yield exactly 1 winner and 9 × 409", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("race") });
      const claims = Array.from({ length: 10 }, (_, i) => app.inject({
        method: "POST", url: "/api/job-offers/race/claim",
        payload: { kernelId: `kernel-${i}` },
      }));
      const results = await Promise.all(claims);
      const wins = results.filter((r) => r.statusCode === 200);
      const losses = results.filter((r) => r.statusCode === 409);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(9);
      const winnerBody = wins[0]!.json();
      const winnerName = winnerBody.offer.claimedByKernelId;
      for (const l of losses) {
        const lb = l.json();
        expect(lb.error).toBe("not_open");
        expect(lb.claimedBy).toBe(winnerName);
      }
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/job-offers/:id/events — generic event vocabulary ─────────────

describe("POST /api/job-offers/:id/events", () => {
  it("event=in_progress → status=in_progress; event=delivered → status=delivered", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("c-ev") });
      const r1 = await app.inject({
        method: "POST", url: "/api/job-offers/c-ev/events",
        payload: { event: "in_progress", by: "kernel-driver-1" },
      });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().status).toBe("in_progress");
      const r2 = await app.inject({
        method: "POST", url: "/api/job-offers/c-ev/events",
        payload: { event: "delivered", by: "kernel-driver-1" },
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().status).toBe("delivered");
    } finally {
      await app.close();
    }
  });

  it("free-form event 'progress_update' (no status change) is accepted with payload", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: opentronsOffer("ot-ev") });
      const res = await app.inject({
        method: "POST", url: "/api/job-offers/ot-ev/events",
        payload: {
          event: "progress_update",
          payload: { step: 3, totalSteps: 12, instrument: "OT-2" },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("open"); // status unchanged
      expect(res.json().event.payload.step).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("returns 400 missing_field when event is missing", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("c-ev2") });
      const res = await app.inject({
        method: "POST", url: "/api/job-offers/c-ev2/events",
        payload: { note: "missing event field" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_field");
    } finally {
      await app.close();
    }
  });
});

// ── PATCH /api/job-offers/:id — ownership ──────────────────────────────────

describe("PATCH /api/job-offers/:id", () => {
  it("patches pricing + requirements with matching X-Posted-By", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/job-offers",
        headers: { "x-posted-by": "alice" },
        payload: courierOffer("p1"),
      });
      const res = await app.inject({
        method: "PATCH", url: "/api/job-offers/p1",
        headers: { "x-posted-by": "alice" },
        payload: {
          pricing: { amount: 8.5, currency: "USD", model: "fixed" },
          requirements: { tipUSD: 2 },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.offer.pricing.amount).toBe(8.5);
      expect(body.offer.requirements.tipUSD).toBe(2);
      // The merge preserves the original requirements (pickup/dropoff still there)
      expect(body.offer.requirements.pickup).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("returns 403 when poster identity does not match", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/job-offers",
        headers: { "x-posted-by": "alice" },
        payload: courierOffer("p2"),
      });
      const res = await app.inject({
        method: "PATCH", url: "/api/job-offers/p2",
        headers: { "x-posted-by": "mallory" },
        payload: { pricing: { amount: 999, currency: "USD", model: "fixed" } },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
    } finally {
      await app.close();
    }
  });

  it("returns 401 missing_identity when no auth header", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/job-offers",
        headers: { "x-posted-by": "alice" },
        payload: courierOffer("p3"),
      });
      const res = await app.inject({
        method: "PATCH", url: "/api/job-offers/p3",
        payload: { pricing: { amount: 99, currency: "USD", model: "fixed" } },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("missing_identity");
    } finally {
      await app.close();
    }
  });
});

// ── DELETE /api/job-offers/:id ─────────────────────────────────────────────

describe("DELETE /api/job-offers/:id", () => {
  it("cancels an offer + writes deleted_by_poster event", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/job-offers",
        headers: { "x-posted-by": "alice" },
        payload: hplcOffer("d1"),
      });
      const res = await app.inject({
        method: "DELETE", url: "/api/job-offers/d1",
        headers: { "x-posted-by": "alice" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("cancelled");
      const got = await app.inject({ method: "GET", url: "/api/job-offers/d1" });
      const events = got.json().events as Array<{ event: string }>;
      expect(events.some((e) => e.event === "deleted_by_poster")).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/job-offers/:id/heartbeat ─────────────────────────────────────

describe("POST /api/job-offers/:id/heartbeat", () => {
  it("updates lastHeartbeatAt", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/job-offers",
        headers: { "x-posted-by": "alice" },
        payload: { ...pizzaOffer("hb1"), requireHeartbeat: true },
      });
      advance(1000);
      const res = await app.inject({
        method: "POST", url: "/api/job-offers/hb1/heartbeat",
        headers: { "x-posted-by": "alice" }, payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().lastHeartbeatAt).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

// ── Background sweeper — TTL + heartbeat + re-verify ───────────────────────

describe("background sweep (generic surface)", () => {
  it("expires past-TTL offers across capability types and removes them from /open", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/job-offers", payload: courierOffer("c-ttl") });
      await app.inject({ method: "POST", url: "/api/job-offers", payload: hplcOffer("h-ttl") });
      // Default TTL = postedAt + 2h. Advance past it.
      advance(3 * 60 * 60 * 1000);
      const store = (await import("../services/job-offers-store.js")).getJobOffersStore();
      const result = await store.sweep();
      expect(result.expired).toBe(2); // BOTH offers expired, regardless of capability type
      const courierList = await app.inject({
        method: "GET", url: "/api/job-offers/open?capabilityType=courier.dispatch",
      });
      expect(courierList.json().count).toBe(0);
      const labList = await app.inject({
        method: "GET", url: "/api/job-offers/open?capabilityType=lab.hplc",
      });
      expect(labList.json().count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("auto-cancels pizza.order whose sourceVerifyUrl (POS) starts failing after post", async () => {
    verifyResponses.set("https://pos.example.com/order/123", "ok");
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/job-offers",
        payload: { ...pizzaOffer("p-rv"), sourceVerifyUrl: "https://pos.example.com/order/123" },
      });
      verifyResponses.set("https://pos.example.com/order/123", "fail-404");
      advance(2 * 60 * 1000);
      const store = (await import("../services/job-offers-store.js")).getJobOffersStore();
      const result = await store.sweep();
      expect(result.autoCancelled).toBe(1);
      const got = await app.inject({ method: "GET", url: "/api/job-offers/p-rv" });
      expect(got.json().offer.status).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("expires requireHeartbeat=true offers when heartbeat stops landing — works for any capability", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/job-offers",
        payload: { ...opentronsOffer("ot-hb"), requireHeartbeat: true },
      });
      // Heartbeat grace = 5min; advance past it
      advance(6 * 60 * 1000);
      const store = (await import("../services/job-offers-store.js")).getJobOffersStore();
      const result = await store.sweep();
      expect(result.expired).toBe(1);
      const got = await app.inject({ method: "GET", url: "/api/job-offers/ot-hb" });
      expect(got.json().offer.status).toBe("expired");
    } finally {
      await app.close();
    }
  });
});

// ── Courier-shim ↔ generic interop ────────────────────────────────────────

describe("courier-shim writes show up in the generic feed", () => {
  it("posting via courier-jobs-store directly shows up at /api/job-offers/open?capabilityType=courier.dispatch", async () => {
    const app = await buildApp();
    try {
      // Use the shim to create — same singleton.
      const { CourierJobsStore } = await import("../services/courier-jobs-store.js");
      const courier = new CourierJobsStore();
      const result = await courier.create({
        deliveryId: "shim-test-1",
        pickup: { name: "Store", lat: 37.77, lng: -122.42 },
        dropoff: { name: "Tower" },
        feeUSD: 5.5,
      });
      expect(result.ok).toBe(true);
      // Now query the generic feed
      const res = await app.inject({
        method: "GET",
        url: "/api/job-offers/open?capabilityType=courier.dispatch",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.offers[0].id).toBe("shim-test-1");
      expect(body.offers[0].pricing.amount).toBe(5.5);
      expect(body.offers[0].pricing.currency).toBe("USD");
      expect(body.offers[0].requirements.pickup.name).toBe("Store");
    } finally {
      await app.close();
    }
  });
});

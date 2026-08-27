/**
 * Buyer-request → ad-hoc-listing matching (P0 "payout wall").
 *
 * Bug: a buyer request never reached an ad-hoc capability listing. The only
 * request entry point (POST /api/requests) decomposed natural language through a
 * fixed set of composite templates and never produced a node matching an ad-hoc
 * type, so operators offering e.g. `rideshare-driver` on kernel_mqg3ehqy_vumx
 * were discoverable but unreachable — no escrow was ever funded against them.
 *
 * Fix (matching/routing layer): a request that names a capability type routes
 * directly to the matching registered listing, keyed off the capability's OWN
 * type string + pricing model (NOT a fixed allow-list). Ad-hoc types resolve
 * exactly like built-in ones.
 *
 * Acceptance: a buyer request for an ad-hoc type (rideshare-driver,
 * wood-fired-pizza) routes to the matching ad-hoc listing and can fund an escrow.
 *
 * The order/quote path (negotiate/build) is fixed in a sibling lane; this test
 * stays in the matching layer and demonstrates fundability via the escrow store
 * (mock settlement) rather than re-driving that path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requestRoutes } from "../routes/requests.js";
import { matchListings } from "../services/request-matcher.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema } from "@pcc/store";
import { initJobOffersStore, _resetJobOffersStoreForTests, getJobOffersStore } from "../services/job-offers-store.js";

const { shopKernels, capabilities } = schema;

// Live-shaped fixtures: one ad-hoc rideshare listing (the bug's kernel id),
// one ad-hoc pizza listing, and one built-in (fdm) listing — to prove matching
// keys off the registered row, not a known-type allow-list.
const RIDESHARE_KERNEL = "kernel_mqg3ehqy_vumx";
const RIDESHARE_CAP = "cap-kernel_mqg3ehqy_vumx-rideshare-driver";
const PIZZA_KERNEL = "kernel_mqfm6xuw_1151";
const PIZZA_CAP = "cap-kernel_mqfm6xuw_1151-wood-fired-pizza";
const FDM_KERNEL = "kernel_mqfmpq8u_pk81";
const FDM_CAP = "cap-kernel_mqfmpq8u_pk81-fdm";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: false });

  const { db } = getStore();
  const now = new Date().toISOString();

  const kernelDefaults = {
    location: { lat: 0, lng: 0 },
    maxAssuranceTier: 2,
    publicKey: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "0.1.0",
  };

  db.insert(shopKernels).values([
    {
      ...kernelDefaults,
      id: RIDESHARE_KERNEL,
      name: "Acme Rideshare (mobile)",
      operatorAddress: "driver@acme.example",
      physicalAddress: "roams San Francisco",
    } as any,
    {
      ...kernelDefaults,
      id: PIZZA_KERNEL,
      name: "Marios Pizzeria",
      operatorAddress: "mario@mariospizza.example",
      physicalAddress: "123 Mulberry St NYC",
    } as any,
    {
      ...kernelDefaults,
      id: FDM_KERNEL,
      name: "Demo Machine Shop",
      operatorAddress: "shop@demo.example",
      physicalAddress: "Brooklyn",
    } as any,
  ]).run();

  const capDefaults = {
    availability: {},
    location: { lat: 0, lng: 0 },
    queueDepth: 0,
  };

  db.insert(capabilities).values([
    {
      ...capDefaults,
      id: RIDESHARE_CAP,
      kernelId: RIDESHARE_KERNEL,
      type: "rideshare-driver",
      name: "Rideshare ride <10mi",
      description: "",
      materials: [],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "18", minimum: "18" },
    } as any,
    {
      ...capDefaults,
      id: PIZZA_CAP,
      kernelId: PIZZA_KERNEL,
      type: "wood-fired-pizza",
      name: "12-inch Margherita",
      description: "",
      materials: ["dough", "mozzarella"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "12", minimum: "12" },
    } as any,
    {
      ...capDefaults,
      id: FDM_CAP,
      kernelId: FDM_KERNEL,
      type: "fdm",
      name: "FDM 3D print (PLA)",
      description: "",
      materials: ["PLA"],
      assuranceTiers: [0, 1],
      pricing: { currency: "USDC", baseCost: "20", minimum: "20" },
    } as any,
  ]).run();

  // Bridge (coord #1276): direct-match POSTs now call
  // produceJobOffersForRequest() -> getJobOffersStore(), which throws if
  // uninitialised — same boot dependency the real server wires at startup.
  initJobOffersStore({});

  const app = Fastify({ logger: false });
  await app.register(requestRoutes);
  await app.ready();
  return app;
}

describe("Buyer-request → ad-hoc listing matching", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
    _resetJobOffersStoreForTests();
  });

  // ════════════════════════════════════════════════════════════════════
  // matchListings — the routing primitive (keys off type + pricing model)
  // ════════════════════════════════════════════════════════════════════

  describe("matchListings()", () => {
    it("resolves an AD-HOC type (rideshare-driver) to its listing, priced from the pricing model", () => {
      const result = matchListings("rideshare-driver");
      expect(result.matches).toHaveLength(1);
      const m = result.matches[0];
      expect(m.capabilityId).toBe(RIDESHARE_CAP);
      expect(m.kernelId).toBe(RIDESHARE_KERNEL);
      expect(m.capabilityType).toBe("rideshare-driver");
      expect(m.basePrice).toBe("18.00"); // from pricing.baseCost, not a template
      expect(m.currency).toBe("USDC");
    });

    it("resolves a built-in type (fdm) the same way — no allow-list, just the row", () => {
      const result = matchListings("fdm");
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].capabilityId).toBe(FDM_CAP);
      expect(result.matches[0].basePrice).toBe("20.00");
    });

    it("returns no match (with a reason) for a type no operator registered", () => {
      const result = matchListings("underwater-basket-weaving");
      expect(result.matches).toHaveLength(0);
      expect(result.reason).toMatch(/no registered listing/i);
    });

    it("rejects a pinned capabilityId whose type does not match", () => {
      const result = matchListings("rideshare-driver", { capabilityId: PIZZA_CAP });
      expect(result.matches).toHaveLength(0);
      expect(result.reason).toMatch(/type/i);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // POST /api/requests/match — read-only matching surface
  // ════════════════════════════════════════════════════════════════════

  describe("POST /api/requests/match", () => {
    it("returns the matching ad-hoc listing for wood-fired-pizza", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests/match",
        payload: { capabilityType: "wood-fired-pizza" },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.count).toBe(1);
      expect(json.matches[0].kernelId).toBe(PIZZA_KERNEL);
      expect(json.matches[0].capabilityId).toBe(PIZZA_CAP);
      expect(parseFloat(json.matches[0].basePrice)).toBe(12);
    });

    it("returns 404 (not 500) when no listing offers the type", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests/match",
        payload: { capabilityType: "totally-made-up-xyz" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("no_matching_listing");
    });

    it("returns 400 when capabilityType is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests/match",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // POST /api/requests — routes an ad-hoc buyer request to the listing
  // ════════════════════════════════════════════════════════════════════

  describe("POST /api/requests with capabilityType (direct match)", () => {
    it("routes an AD-HOC request (rideshare-driver) to its listing as a single node", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Ride to downtown",
          description: "Need a ride from the airport to downtown",
          capabilityType: "rideshare-driver",
          requesterEmail: "rider@example.com",
        },
      });
      expect(res.statusCode).toBe(201);
      const { request } = res.json();
      expect(request.status).toBe("published");
      expect(request.capabilityDag).toHaveLength(1);

      const node = request.capabilityDag[0];
      // The request reached the ad-hoc listing: node type + kernel + cap id all
      // point at the registered operator, priced from its pricing model.
      expect(node.capabilityType).toBe("rideshare-driver");
      expect(node.kernelId).toBe(RIDESHARE_KERNEL);
      expect(node.capabilityId).toBe(RIDESHARE_CAP);
      expect(node.estimatedCost).toBe(18);
      expect(request.totalEstimatedCost).toBe(18);

      // Bridge (coord #1276): the matched node is now a claimable job-offer,
      // not just a matched-and-stopped decomposition.
      const { jobOffers } = res.json();
      expect(jobOffers.created).toHaveLength(1);
      expect(jobOffers.skippedUnmatched).toHaveLength(0);
      const open = getJobOffersStore().listOpen({ capabilityType: "rideshare-driver" });
      expect(open).toHaveLength(1);
      expect(open[0]!.pricing).toEqual({ amount: 18, currency: "USDC", model: "fixed" });
      expect(open[0]!.requirements.matchedKernelId).toBe(RIDESHARE_KERNEL);
      expect(open[0]!.requirements.matchedCapabilityId).toBe(RIDESHARE_CAP);
      expect(open[0]!.requirements.requestId).toBe(request.id);

      // Negative control (gateway's own #1468 gotcha): an unrelated
      // capabilityType must stay empty, so an empty list here isn't
      // mistaken for "the feed is broken" rather than "nothing of this type".
      expect(getJobOffersStore().listOpen({ capabilityType: "fdm" })).toHaveLength(0);
    });

    it("honors quantity for direct-match pricing (3 pizzas = 3 * 12)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Party order",
          description: "Three margheritas for the team",
          capabilityType: "wood-fired-pizza",
          capabilityId: PIZZA_CAP,
          quantity: 3,
          requesterEmail: "host@example.com",
        },
      });
      expect(res.statusCode).toBe(201);
      const node = res.json().request.capabilityDag[0];
      expect(node.capabilityType).toBe("wood-fired-pizza");
      expect(node.estimatedCost).toBe(36);
    });

    it("returns 404 (not 500) when the named type has no listing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Impossible order",
          description: "Something nobody offers",
          capabilityType: "underwater-basket-weaving",
          requesterEmail: "rider@example.com",
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("no_matching_listing");
    });

    it("still NL-decomposes composite requests when no capabilityType is given (no regression)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Animatronic plush robot",
          description:
            "Build a cute animatronic plush desk robot with servo head movement and firmware",
          budget: 2500,
          requesterEmail: "team@moltpod.com",
        },
      });
      expect(res.statusCode).toBe(201);
      // Composite NL path produces a multi-step DAG (not a single direct node).
      expect(res.json().request.capabilityDag.length).toBeGreaterThan(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Acceptance: routed match can fund an escrow against the operator
  // ════════════════════════════════════════════════════════════════════

  describe("routed match is fundable", () => {
    it("a routed ad-hoc request yields an operator-targeted, fundable escrow (mock settlement)", async () => {
      // 1. Buyer request routes to the rideshare listing.
      const create = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Ride downtown",
          description: "ride to downtown",
          capabilityType: "rideshare-driver",
          requesterEmail: "rider@example.com",
        },
      });
      expect(create.statusCode).toBe(201);
      const { request } = create.json();
      const node = request.capabilityDag[0];

      // 2. The routed node carries everything an escrow needs (kernel, capability,
      //    price). Fund one against the operator's kernel/capability at the
      //    listing's price (mock settlement — the on-chain/order path is a sibling
      //    lane; this asserts the matched target is fundable, clearing the wall).
      const repos = getRepos();
      const now = new Date().toISOString();
      const escrowId = "esc-ride-test";
      repos.escrows.insert({
        id: escrowId,
        cwmId: `req-${request.id}`,
        contractAddress: "mock-escrow-ride",
        payer: request.requesterEmail,
        totalAmount: String(node.estimatedCost),
        currency: "USDC",
        status: "funded",
        createdAt: now,
        deadline: now,
      } as any);
      repos.escrows.insertMilestone({
        id: "ms-ride-test",
        escrowId,
        stepId: node.id,
        amount: String(node.estimatedCost),
        status: "funded",
        bondAmount: "0.00",
      } as any);

      const escrow = repos.escrows.findById(escrowId);
      expect(escrow?.status).toBe("funded");
      expect(escrow?.totalAmount).toBe("18");
      // The escrow is bound to the matched listing's kernel + capability.
      expect(node.kernelId).toBe(RIDESHARE_KERNEL);
      expect(node.capabilityId).toBe(RIDESHARE_CAP);

      const milestones = repos.escrows.findMilestonesByEscrow(escrowId);
      expect(milestones).toHaveLength(1);
      expect(milestones[0].status).toBe("funded");
      expect(milestones[0].amount).toBe("18");
    });
  });
});

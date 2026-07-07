/**
 * Follow-on ad-hoc buyer-path fixes (open-taxonomy residual gaps):
 *
 *   2. NL inference of ad-hoc types — a free-text request with NO capabilityType
 *      ("I want a wood-fired pizza") now reaches a single registered ad-hoc
 *      listing on the no-LLM path, instead of always falling to the generic
 *      custom_product template. Conservative + kill-switchable; declines on
 *      ambiguity so it never hijacks a genuine composite request.
 *   3. Re-decompose preserves direct-match routing — POST /api/requests/:id/decompose
 *      on a request routed to one listing re-resolves the SAME listing instead of
 *      re-templating it into a generic DAG (which dropped kernelId/capabilityId).
 *   4. Publish auto-assign — POST /api/requests/:id/publish auto-assigns direct-match
 *      nodes to their known operator (skips the bounty auction), while generic
 *      template nodes still publish as open bounties.
 *
 * Agentic decompose is forced OFF here so the deterministic inference/template
 * path is what's under test (no network, no API key).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requestRoutes } from "../routes/requests.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";

const { shopKernels, capabilities } = schema;

const RIDESHARE_KERNEL = "kernel_mqg3ehqy_vumx";
const RIDESHARE_CAP = "cap-kernel_mqg3ehqy_vumx-rideshare-driver";
const RIDESHARE_OPERATOR = "driver@acme.example";
const PIZZA_KERNEL = "kernel_mqfm6xuw_1151";
const PIZZA_CAP = "cap-kernel_mqfm6xuw_1151-wood-fired-pizza";
const PIZZA_OPERATOR = "mario@mariospizza.example";
const FDM_KERNEL = "kernel_mqfmpq8u_pk81";
const FDM_CAP = "cap-kernel_mqfmpq8u_pk81-fdm";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  // Force the deterministic (no-LLM) path so inference/template is under test.
  process.env.PCC_AGENTIC_DECOMPOSE_DISABLED = "1";
  delete process.env.PCC_NL_INFER_ADHOC_DISABLED;
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
    { ...kernelDefaults, id: RIDESHARE_KERNEL, name: "Acme Rideshare (mobile)", operatorAddress: RIDESHARE_OPERATOR, physicalAddress: "roams San Francisco" } as any,
    { ...kernelDefaults, id: PIZZA_KERNEL, name: "Marios Pizzeria", operatorAddress: PIZZA_OPERATOR, physicalAddress: "123 Mulberry St NYC" } as any,
    { ...kernelDefaults, id: FDM_KERNEL, name: "Demo Machine Shop", operatorAddress: "shop@demo.example", physicalAddress: "Brooklyn" } as any,
  ]).run();

  const capDefaults = { availability: {}, location: { lat: 0, lng: 0 }, queueDepth: 0 };

  db.insert(capabilities).values([
    { ...capDefaults, id: RIDESHARE_CAP, kernelId: RIDESHARE_KERNEL, type: "rideshare-driver", name: "Rideshare ride <10mi", description: "", materials: [], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "18", minimum: "18" } } as any,
    { ...capDefaults, id: PIZZA_CAP, kernelId: PIZZA_KERNEL, type: "wood-fired-pizza", name: "12-inch Margherita", description: "", materials: ["dough", "mozzarella"], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "12", minimum: "12" } } as any,
    { ...capDefaults, id: FDM_CAP, kernelId: FDM_KERNEL, type: "fdm", name: "FDM 3D print (PLA)", description: "", materials: ["PLA"], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "20", minimum: "20" } } as any,
  ]).run();

  const app = Fastify({ logger: false });
  await app.register(requestRoutes);
  await app.ready();
  return app;
}

describe("Ad-hoc routing extras (inference, re-decompose, publish auto-assign)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
    delete process.env.PCC_AGENTIC_DECOMPOSE_DISABLED;
    delete process.env.PCC_NL_INFER_ADHOC_DISABLED;
  });

  // ════════════════════════════════════════════════════════════════════
  // Item 2 — NL inference of an ad-hoc listing (no capabilityType given)
  // ════════════════════════════════════════════════════════════════════

  describe("NL inference (no capabilityType)", () => {
    it("infers the wood-fired-pizza listing from free text and routes to it", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Dinner",
          description: "I want a wood-fired pizza delivered for dinner tonight",
          requesterEmail: "hungry@example.com",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.inferredMatch).toBeTruthy();
      expect(body.request.capabilityDag).toHaveLength(1);
      const node = body.request.capabilityDag[0];
      expect(node.capabilityType).toBe("wood-fired-pizza");
      expect(node.kernelId).toBe(PIZZA_KERNEL);
      expect(node.capabilityId).toBe(PIZZA_CAP);
      // Inference is a guess — stays unpublished for the buyer to confirm.
      expect(body.request.status).toBe("decomposed");
    });

    it("infers the rideshare-driver listing from a ride request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Ride",
          description: "I need a rideshare driver to take me to the airport",
          requesterEmail: "rider@example.com",
        },
      });
      expect(res.statusCode).toBe(201);
      const node = res.json().request.capabilityDag[0];
      expect(node.capabilityType).toBe("rideshare-driver");
      expect(node.kernelId).toBe(RIDESHARE_KERNEL);
    });

    it("does NOT hijack a genuine composite request (falls through to a multi-step DAG)", async () => {
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
      const body = res.json();
      expect(body.inferredMatch).toBeUndefined();
      expect(body.request.capabilityDag.length).toBeGreaterThan(1);
    });

    it("declines inference when the kill switch is set, even for a clear match", async () => {
      process.env.PCC_NL_INFER_ADHOC_DISABLED = "1";
      const res = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Dinner",
          description: "I want a wood-fired pizza delivered for dinner tonight",
          requesterEmail: "hungry@example.com",
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.inferredMatch).toBeUndefined();
      // Falls to the composite template DAG instead of the single pizza node.
      expect(body.request.capabilityDag.length).toBeGreaterThan(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Item 3 — re-decompose preserves direct-match routing
  // ════════════════════════════════════════════════════════════════════

  describe("POST /api/requests/:id/decompose preserves direct-match routing", () => {
    it("re-resolves the same listing instead of re-templating (keeps kernel + capability + qty)", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Party order",
          description: "two margheritas",
          capabilityType: "wood-fired-pizza",
          capabilityId: PIZZA_CAP,
          quantity: 2,
          requesterEmail: "host@example.com",
        },
      });
      expect(create.statusCode).toBe(201);
      const requestId = create.json().request.id;
      // Sanity: created as a single direct-match node priced 2 * 12.
      expect(create.json().request.capabilityDag[0].estimatedCost).toBe(24);

      const re = await app.inject({
        method: "POST",
        url: `/api/requests/${requestId}/decompose`,
      });
      expect(re.statusCode).toBe(200);
      const dag = re.json().request.capabilityDag;
      // STILL a single routed node — not re-templated into a generic DAG.
      expect(dag).toHaveLength(1);
      expect(dag[0].capabilityType).toBe("wood-fired-pizza");
      expect(dag[0].kernelId).toBe(PIZZA_KERNEL);
      expect(dag[0].capabilityId).toBe(PIZZA_CAP);
      expect(dag[0].estimatedCost).toBe(24); // quantity 2 recovered from stored cost
    });

    it("re-decomposes a composite request through the template path (unchanged)", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Robot",
          description: "Fabricate a custom machined product with CNC and assembly",
          budget: 1000,
          requesterEmail: "maker@example.com",
        },
      });
      const requestId = create.json().request.id;
      const before = create.json().request.capabilityDag.length;
      expect(before).toBeGreaterThan(1);

      const re = await app.inject({
        method: "POST",
        url: `/api/requests/${requestId}/decompose`,
      });
      expect(re.statusCode).toBe(200);
      expect(re.json().request.capabilityDag.length).toBeGreaterThan(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Item 4 — publish auto-assigns direct-match nodes to their operator
  // ════════════════════════════════════════════════════════════════════

  describe("POST /api/requests/:id/publish auto-assign", () => {
    it("auto-assigns a direct-match node to the listing's operator (no bounty auction)", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Ride",
          description: "ride to downtown",
          capabilityType: "rideshare-driver",
          requesterEmail: "rider@example.com",
        },
      });
      const requestId = create.json().request.id;

      const pub = await app.inject({
        method: "POST",
        url: `/api/requests/${requestId}/publish`,
      });
      expect(pub.statusCode).toBe(200);
      const body = pub.json();
      expect(body.autoAssignedCount).toBe(1);
      expect(body.publishedCount).toBe(0); // no open bounty for a known operator
      expect(body.autoAssigned[0].kernelId).toBe(RIDESHARE_KERNEL);
      expect(body.autoAssigned[0].operator).toBe(RIDESHARE_OPERATOR);

      const node = body.request.capabilityDag[0];
      expect(node.status).toBe("assigned");
      expect(node.assignedOperator).toBe(RIDESHARE_OPERATOR);
      expect(node.bountyId).toBeUndefined();
    });

    it("still mints open bounties for generic composite nodes (no regression)", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/requests",
        payload: {
          title: "Robot",
          description: "Fabricate a custom machined product with CNC and assembly",
          budget: 1000,
          requesterEmail: "maker@example.com",
        },
      });
      const requestId = create.json().request.id;

      const pub = await app.inject({
        method: "POST",
        url: `/api/requests/${requestId}/publish`,
      });
      expect(pub.statusCode).toBe(200);
      const body = pub.json();
      expect(body.autoAssignedCount).toBe(0);
      expect(body.publishedCount).toBeGreaterThan(0);
      expect(body.request.capabilityDag.every((n: any) => n.status === "bidding")).toBe(true);
    });
  });
});

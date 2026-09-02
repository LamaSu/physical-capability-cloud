/**
 * GET /api/requests/:id/commitment — composition's trust surface.
 *
 * Recomputes the capabilityContractRoot (what the buyer agreed, provider-agnostic) and the compositionRoot
 * (what the fleet agreed for this run, provider-bound) from the STORED request DAG. Fail-closed: on master
 * today matched nodes carry no matchedCapabilityDigest, so the report must say exactly that (blockedOn) and
 * refuse a compositionRoot — never fabricate one — while still returning the contract root.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requestRoutes, resetRequestsStore } from "../routes/requests.js";
import { initStore, closeStore } from "../db.js";

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
});
afterAll(() => {
  closeStore();
});
beforeEach(() => {
  resetRequestsStore();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(requestRoutes);
  await app.ready();
  return app;
}

const PIZZA_REQUEST = {
  title: "Margherita pizza made and delivered",
  description: "A 12-inch margherita pizza baked in a wood-fired oven and delivered by courier to my office.",
  budget: 40,
  currency: "USDC",
  deadline: "2026-12-31T23:59:59Z",
  urgency: "standard",
  requesterEmail: "buyer@example.com",
};

describe("GET /api/requests/:id/commitment", () => {
  it("404s for an unknown request", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/requests/does-not-exist/commitment" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "request_not_found" });
    await app.close();
  });

  it("recomputes from the STORED DAG: a well-formed report with the contract root, and a fail-closed commitment that names why", async () => {
    const app = await buildApp();
    const created = await app.inject({ method: "POST", url: "/api/requests", payload: PIZZA_REQUEST });
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;

    const res = await app.inject({ method: "GET", url: `/api/requests/${id}/commitment` });
    // Fail-closed at the HTTP layer (gateway #1472 condition 1): on master nothing is committable yet, so 422,
    // never a 200 with a null root. The body still carries the full report so the reader learns WHY.
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("uncommittable");

    // Provenance (gateway #1472 condition 2): a live recompute from the stored row, and it says so.
    expect(body.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.source).toMatchObject({ kind: "stored-request-dag", requestId: id });

    expect(body.requestId).toBe(id);
    expect(body.domains).toEqual({ composition: "PCC:composition-commitment:v2", contract: "PCC:capability-contract:v2" });
    expect(body.nodeCount).toBeGreaterThan(0);
    expect(body.edgeCount).toBe(Math.max(0, body.nodeCount - 1)); // the decomposer emits a linear chain
    expect(body.legacyCompositionSignature).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.verify.corpus).toMatch(/composition-commitment\.vectors\.json$/);

    // The buyer's contract is well-defined regardless of matching state.
    expect(body.capabilityContractRoot).toMatch(/^0x[0-9a-f]{64}$/);

    // On master no node carries a matchedCapabilityDigest, so a compositionRoot MUST be refused with a reason:
    // either some nodes are unmatched, or the plan is fully matched and blocked on the digest.
    expect(body.commitment.committable).toBe(false);
    if (body.commitment.unmatchedNodes.length === 0) {
      expect(body.blockedOn).toMatch(/matchedCapabilityDigest/);
      expect(body.commitment.violations.join(" ")).toMatch(/matchedCapabilityDigest/);
    } else {
      expect(body.blockedOn).toBeUndefined();
    }
    // never a phantom root
    expect(body.commitment.compositionRoot).toBeUndefined();
    await app.close();
  });

  it("is deterministic: two reads of the same stored request yield identical roots", async () => {
    const app = await buildApp();
    const created = await app.inject({ method: "POST", url: "/api/requests", payload: PIZZA_REQUEST });
    const id = created.json().request.id as string;
    const a = (await app.inject({ method: "GET", url: `/api/requests/${id}/commitment` })).json();
    const b = (await app.inject({ method: "GET", url: `/api/requests/${id}/commitment` })).json();
    expect(b.capabilityContractRoot).toBe(a.capabilityContractRoot);
    expect(b.legacyCompositionSignature).toBe(a.legacyCompositionSignature);
    expect(b.commitment).toEqual(a.commitment);
    expect(b.source).toEqual(a.source); // same stored row -> same provenance; only as_of moves
    await app.close();
  });
});

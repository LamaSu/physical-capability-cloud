/**
 * R-06 / LO-GW-2a — the stated budget IS an authorization limit.
 *
 * The defect: `POST /api/requests` (:426-427) and `POST /api/requests/:id
 * /decompose` (:557-558) both did `request.budget = result.derivedBudget`.
 * Decomposition overwrote the requester's stated budget with whatever the
 * matched capabilities happened to cost, so a reprice silently became an
 * authorization — the request came back saying the requester had agreed to a
 * number they never saw. `packages/spec/src/types/requests.ts:107-113` already
 * documented derivedBudget as an ESTIMATE; the route treated it as authority.
 *
 * The rule these tests pin down:
 *   - `budget` is the AUTHORIZED CEILING. Set once, at creation. Immutable to
 *     every repricing path.
 *   - `derivedBudget` / the priced commitment is an ESTIMATE. It is reported,
 *     never applied.
 *   - Over the ceiling, nothing goes live: no auto-published job-offers, and
 *     `POST /:id/publish` refuses with 409 `budget_authorization_exceeded`.
 *   - The only way up is renewed acceptance — the REQUESTER raising the ceiling
 *     explicitly via `PUT /api/requests/:id`. Round 2: that PUT had no auth and
 *     no ownership check, so "renewed acceptance" was available to anyone — read
 *     `derivedBudget` off a decompose response, PUT it as the new budget,
 *     publish. The gate was real and the door beside it was open. It now
 *     requires the authenticated requester, and so does rewriting the requester
 *     identity the check reads.
 *
 * Fixture shape is borrowed from request-matching.test.ts: real capability rows
 * with real prices, so the "priced commitment" under test is an actual listing
 * price and not a template guess.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requestRoutes } from "../routes/requests.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema } from "@pcc/store";
import {
  initJobOffersStore,
  _resetJobOffersStoreForTests,
  getJobOffersStore,
} from "../services/job-offers-store.js";

const { shopKernels, capabilities } = schema;

const RIDE_KERNEL = "kernel-ride-authz";
const RIDE_CAP = "cap-ride-authz";
/** Listing price per unit, in USDC. */
const RIDE_PRICE = 18;

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });

  const { db } = getStore();
  const now = new Date().toISOString();

  db.insert(shopKernels)
    .values([
      {
        id: RIDE_KERNEL,
        name: "Acme Rideshare",
        operatorAddress: "driver@acme.example",
        physicalAddress: "roams San Francisco",
        location: { lat: 0, lng: 0 },
        maxAssuranceTier: 2,
        publicKey: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        reputation: 0,
        totalJobsCompleted: 0,
        status: "online",
        registeredAt: now,
        lastHeartbeat: now,
        version: "0.1.0",
      } as never,
    ])
    .run();

  db.insert(capabilities)
    .values([
      {
        id: RIDE_CAP,
        kernelId: RIDE_KERNEL,
        type: "rideshare-driver",
        name: "Rideshare ride <10mi",
        description: "",
        materials: [],
        assuranceTiers: [0, 1],
        pricing: { currency: "USDC", baseCost: String(RIDE_PRICE), minimum: String(RIDE_PRICE) },
        availability: {},
        location: { lat: 0, lng: 0 },
        queueDepth: 0,
      } as never,
    ])
    .run();

  initJobOffersStore({});

  const app = Fastify({ logger: false });
  // apiGate stand-in. The ROUTE reads `req.operatorId` exactly as it does in
  // production; only the way that field gets populated is simulated here, so a
  // test can act as a specific principal without running the full middleware
  // stack. Same technique as buildAuthedApp() in requests.test.ts.
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h !== "") {
      (req as unknown as { operatorId: string }).operatorId = h;
    }
  });
  await app.register(requestRoutes);
  await app.ready();
  return app;
}

/** The identity `order()` records as the request's requester. */
const REQUESTER = "rider@example.com";
const STRANGER = "stranger@elsewhere.test";

function as(principal: string): Record<string, string> {
  return { "x-test-operator": principal };
}

/** Direct-match order: `quantity` rides at RIDE_PRICE each, against `budget`. */
async function order(
  app: FastifyInstance,
  budget: number,
  quantity: number,
): Promise<{ statusCode: number; body: Record<string, never> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      title: "Rides",
      description: "Need rides across town",
      capabilityType: "rideshare-driver",
      capabilityId: RIDE_CAP,
      quantity,
      budget,
      requesterEmail: REQUESTER,
    },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe("R-06 — the authorized ceiling", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeStore();
    _resetJobOffersStoreForTests();
  });

  // ── Below the ceiling: allowed, unchanged behaviour ────────────────────
  it("a priced estimate BELOW the ceiling is allowed and publishes", async () => {
    const { statusCode, body } = await order(app, 100, 2); // 36 <= 100

    expect(statusCode).toBe(201);
    const request = body.request as unknown as { budget: number; authorizedCeiling: number; status: string };
    // The ceiling is the requester's own number, untouched by the reprice.
    expect(request.budget).toBe(100);
    expect(request.authorizedCeiling).toBe(100);
    expect(request.status).toBe("published");

    const authz = body.budgetAuthorization as unknown as {
      authorizedCeiling: number;
      committedEstimate: number;
      withinAuthorization: boolean;
      requiresReauthorization: boolean;
    };
    expect(authz.authorizedCeiling).toBe(100);
    expect(authz.committedEstimate).toBe(36);
    expect(authz.withinAuthorization).toBe(true);
    expect(authz.requiresReauthorization).toBe(false);

    // ...and the work actually went live.
    expect(getJobOffersStore().listOpen({ capabilityType: "rideshare-driver" })).toHaveLength(1);
  });

  // ── NEGATIVE CONTROL: above the ceiling ───────────────────────────────
  it("a priced estimate ABOVE the ceiling is refused — never silently applied", async () => {
    const { statusCode, body } = await order(app, 20, 5); // 90 > 20

    expect(statusCode).toBe(201);
    const request = body.request as unknown as { budget: number; authorizedCeiling: number; status: string };

    // THE REGRESSION GUARD: the old code did `request.budget =
    // result.derivedBudget`, so this would have come back as 90 — the
    // requester "authorizing" 90 having only ever said 20.
    expect(request.budget).toBe(20);
    expect(request.authorizedCeiling).toBe(20);
    expect(request.budget).not.toBe(90);

    // Flagged, explicitly.
    const authz = body.budgetAuthorization as unknown as {
      committedEstimate: number;
      withinAuthorization: boolean;
      requiresReauthorization: boolean;
    };
    expect(authz.committedEstimate).toBe(90);
    expect(authz.withinAuthorization).toBe(false);
    expect(authz.requiresReauthorization).toBe(true);

    // Nothing went live: the direct-match path normally auto-publishes, and
    // that is exactly the bypass this has to close.
    expect(request.status).toBe("decomposed");
    expect(getJobOffersStore().listOpen({ capabilityType: "rideshare-driver" })).toHaveLength(0);
  });

  it("publish REFUSES while the priced estimate exceeds the ceiling", async () => {
    const { body } = await order(app, 20, 5); // 90 > 20
    const id = (body.request as unknown as { id: string }).id;

    const pub = await app.inject({ method: "POST", url: `/api/requests/${id}/publish` });
    expect(pub.statusCode).toBe(409);
    const err = pub.json();
    expect(err.error).toBe("budget_authorization_exceeded");
    expect(err.budgetAuthorization.authorizedCeiling).toBe(20);
    expect(err.budgetAuthorization.committedEstimate).toBe(90);

    // No bounties, no offers — the refusal is real, not cosmetic.
    const after = await app.inject({ method: "GET", url: `/api/requests/${id}` });
    const nodes = after.json().request.capabilityDag as Array<{ status: string; bountyId?: string }>;
    expect(nodes.every((n) => n.status === "pending")).toBe(true);
    expect(nodes.every((n) => !n.bountyId)).toBe(true);
    expect(getJobOffersStore().listOpen({ capabilityType: "rideshare-driver" })).toHaveLength(0);
  });

  it("renewed acceptance (PUT raises the ceiling) unblocks publish", async () => {
    const { body } = await order(app, 20, 5); // 90 > 20
    const id = (body.request as unknown as { id: string }).id;

    // Blocked first — establishes that the later success is caused by the
    // raise, not by the gate never having applied.
    const blocked = await app.inject({ method: "POST", url: `/api/requests/${id}/publish` });
    expect(blocked.statusCode).toBe(409);

    // The REQUESTER explicitly agrees to more. This is the ONLY way up, and it
    // is theirs alone — see the refusals in the next describe block.
    const raised = await app.inject({
      method: "PUT",
      url: `/api/requests/${id}`,
      payload: { budget: 120 },
      headers: as(REQUESTER),
    });
    expect(raised.statusCode).toBe(200);
    expect(raised.json().request.budget).toBe(120);
    expect(raised.json().request.authorizedCeiling).toBe(120);

    const pub = await app.inject({ method: "POST", url: `/api/requests/${id}/publish` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().publishedCount).toBeGreaterThan(0);
  });

  it("re-decomposition never rewrites the ceiling", async () => {
    const { body } = await order(app, 20, 5);
    const id = (body.request as unknown as { id: string }).id;

    const dec = await app.inject({ method: "POST", url: `/api/requests/${id}/decompose` });
    expect(dec.statusCode).toBe(200);

    // Whatever the re-decomposition priced, the stored authority is still the
    // requester's stated 20 — the second overwrite site is closed too.
    const after = await app.inject({ method: "GET", url: `/api/requests/${id}` });
    expect(after.json().request.budget).toBe(20);
    expect(after.json().request.authorizedCeiling).toBe(20);
  });

  it("an unmatched (template-priced) plan does not consume authority", async () => {
    // No capabilityType -> NL decomposition against a store with one listing.
    // Template guesses are not quotes; only real prices may consume a ceiling,
    // so a template-only plan must not be blocked by one.
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "Build a thing",
        description: "Design, fabricate and assemble a small mechanical widget with a custom housing",
        budget: 1,
        requesterEmail: "buyer@example.com",
      },
    });
    expect(res.statusCode).toBe(201);
    const authz = res.json().budgetAuthorization;
    expect(authz.authorizedCeiling).toBe(1);
    // Nothing in the plan is backed by a registered capability at a real price.
    expect(authz.committedEstimate).toBe(0);
    expect(authz.requiresReauthorization).toBe(false);
    // The stated ceiling is still untouched.
    expect(res.json().request.budget).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round 2 — who may perform "renewed acceptance"
// ---------------------------------------------------------------------------

describe("R-06 — raising the ceiling is the requester's act alone", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetJobOffersStoreForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("refuses an anonymous ceiling raise, and publish stays blocked", async () => {
    const { body } = await order(app, 20, 5); // 90 > 20
    const id = (body.request as unknown as { id: string }).id;

    const raised = await app.inject({
      method: "PUT",
      url: `/api/requests/${id}`,
      payload: { budget: 120 },
    });
    expect(raised.statusCode).toBe(401);
    expect(raised.json().error).toBe("authentication_required");
    expect(raised.json().fields).toContain("budget");

    // The stored ceiling did not move, and the gate still holds.
    const after = await app.inject({ method: "GET", url: `/api/requests/${id}` });
    expect(after.json().request.budget).toBe(20);
    expect(after.json().request.authorizedCeiling).toBe(20);
    const pub = await app.inject({ method: "POST", url: `/api/requests/${id}/publish` });
    expect(pub.statusCode).toBe(409);
    expect(getJobOffersStore().listOpen({ capabilityType: "rideshare-driver" })).toHaveLength(0);
  });

  it("refuses a STRANGER's ceiling raise — the documented bypass, closed", async () => {
    // The refuted path verbatim: decompose, read the derived number off the
    // response, PUT it as the new budget, publish. Step 2 now fails.
    const { body } = await order(app, 20, 5);
    const id = (body.request as unknown as { id: string }).id;
    const derived = (body.budgetAuthorization as unknown as { committedEstimate: number }).committedEstimate;
    expect(derived).toBeGreaterThan(20);

    const raised = await app.inject({
      method: "PUT",
      url: `/api/requests/${id}`,
      payload: { budget: derived },
      headers: as(STRANGER),
    });
    expect(raised.statusCode).toBe(403);
    expect(raised.json().error).toBe("not_requester");

    const after = await app.inject({ method: "GET", url: `/api/requests/${id}` });
    expect(after.json().request.budget).toBe(20);
    const pub = await app.inject({ method: "POST", url: `/api/requests/${id}/publish` });
    expect(pub.statusCode).toBe(409);
    expect(getJobOffersStore().listOpen({ capabilityType: "rideshare-driver" })).toHaveLength(0);
  });

  it("refuses a stranger REWRITING the requester identity the check reads", async () => {
    // Otherwise the ownership gate is decorative: become the requester first,
    // then raise the ceiling legitimately.
    const { body } = await order(app, 20, 5);
    const id = (body.request as unknown as { id: string }).id;

    const hijack = await app.inject({
      method: "PUT",
      url: `/api/requests/${id}`,
      payload: { requesterEmail: STRANGER },
      headers: as(STRANGER),
    });
    expect(hijack.statusCode).toBe(403);
    expect(hijack.json().error).toBe("not_requester");
    expect(hijack.json().fields).toContain("requesterEmail");

    const after = await app.inject({ method: "GET", url: `/api/requests/${id}` });
    expect(after.json().request.requesterEmail).toBe(REQUESTER);
  });

  it("still lets anyone edit non-authority fields — the gate is narrow", async () => {
    // The fix must not turn into a blanket lock on the row: only the fields
    // that carry or determine authority are gated.
    const { body } = await order(app, 20, 5);
    const id = (body.request as unknown as { id: string }).id;

    const res = await app.inject({
      method: "PUT",
      url: `/api/requests/${id}`,
      payload: { title: "Rides, renamed", urgency: "emergency" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request.title).toBe("Rides, renamed");
    expect(res.json().request.budget).toBe(20);
  });

  it("the requester may still raise their own ceiling by wallet identity", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "Rides",
        description: "Need rides across town",
        capabilityType: "rideshare-driver",
        capabilityId: RIDE_CAP,
        quantity: 5,
        budget: 20,
        requesterWallet: "0xAbCdEf0000000000000000000000000000000001",
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().request.id;

    // Case-insensitive: an EVM address differs only by EIP-55 checksum casing.
    const raised = await app.inject({
      method: "PUT",
      url: `/api/requests/${id}`,
      payload: { budget: 120 },
      headers: as("0xabcdef0000000000000000000000000000000001"),
    });
    expect(raised.statusCode).toBe(200);
    expect(raised.json().request.authorizedCeiling).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Round 2 — the "spend outside the ceiling via unmatched nodes" question
// ---------------------------------------------------------------------------

describe("R-06 — unmatched nodes get a bounty marker but no live work", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetJobOffersStoreForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("publishing a partially matched plan creates ZERO job-offers", async () => {
    // The open question after round 1: `matchedCommitment` counts only matched
    // nodes, while the publish loop stamps a bountyId on EVERY pending node —
    // so could spend happen outside the ceiling, through the unmatched ones?
    //
    // Answer, pinned here: no. `produceJobOffersForRequest` HOLDS the whole
    // plan when any node is unmatched (commitment not committable and not a
    // pure digest gap), so nothing becomes claimable; and `node.bountyId` is
    // written at routes/requests.ts and read nowhere — `bountyService` mints
    // its own ids, so a bounty id from here resolves in no claim path. The
    // marker is inert. If either fact ever changes, this test fails.
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "Build a thing",
        description: "Design, fabricate and assemble a small mechanical widget with a custom housing",
        budget: 1,
        requesterEmail: REQUESTER,
      },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().request.id;
    // Under the ceiling (nothing matched -> committedEstimate 0), so publish is
    // allowed: the question is what publishing such a plan actually does.
    expect(res.json().budgetAuthorization.committedEstimate).toBe(0);

    const pub = await app.inject({ method: "POST", url: `/api/requests/${id}/publish` });
    expect(pub.statusCode).toBe(200);

    // Every node got a bounty marker...
    const nodes = pub.json().request.capabilityDag as Array<{ bountyId?: string; status: string }>;
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => !!n.bountyId)).toBe(true);

    // ...and NOT ONE of them is live work anyone can claim.
    expect(pub.json().jobOffers.created).toHaveLength(0);
    expect(pub.json().jobOffers.held).toBeTruthy();
    expect(getJobOffersStore().size()).toBe(0);
  });
});

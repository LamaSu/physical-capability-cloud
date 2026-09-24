/**
 * Courier-shim claim authorization (LO-GW-3a, round 2).
 *
 * WHY THIS FILE EXISTS. Round 1 put an ownership guard on
 * `POST /api/job-offers/:id/claim`. A refutation showed the guard protected one
 * door into a store with two: `POST /api/courier-jobs/:id/claim` — a live
 * backward-compat shim registered in the same app (server.ts:751 job-offers,
 * :754 courier-jobs) over the same singleton store — validated only
 * `if (!driverAgent) 400` and forwarded straight to `JobOffersStore.claim`,
 * which looks an offer up in ONE map with no capability filter and no owner
 * check. Same write, same field (`claimedByKernelId`), no authority.
 *
 * So every test here is PAIRED: the guarded door and the shim door get the
 * SAME attacker, the SAME offer and the SAME victim kernel, and must answer
 * the same way. A test that only exercised one door is what let this through.
 *
 * The harness mirrors server.ts: ONE Fastify app with BOTH route sets
 * registered, so the two doors really do share a store rather than being
 * independently mocked.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { jobOffersRoutes } from "../routes/job-offers.js";
import { courierJobsRoutes } from "../routes/courier-jobs.js";
import { initStore, closeStore } from "../db.js";
import { getKernelFacade } from "../facades/index.js";
import {
  initCourierJobsStore,
  _resetCourierJobsStoreForTests,
  type VerifyFn,
} from "../services/courier-jobs-store.js";
import { getJobOffersStore } from "../services/job-offers-store.js";

// ── Identities ─────────────────────────────────────────────────────────────

const OPERATOR = "operator@shop.test";
const STRANGER = "stranger@elsewhere.test";
const DRIVER_KERNEL = "kernel-driver-7";
const LAB_KERNEL = "kernel-lab-berkeley";
/** A driver-agent name that is NOT a registered kernel — the v0.2 shape
 *  (docs/COURIER_MATCHING.md uses "drone-a3") that the shim exists to serve. */
const LEGACY_DRIVER = "drone-a3";

function asOperator(id: string): Record<string, string> {
  return { "x-posted-by": id };
}

async function registerKernel(id: string, owner: string): Promise<void> {
  const res = await getKernelFacade().register(
    {
      id,
      name: id,
      location: { lat: 37.77, lng: -122.42 },
      physicalAddress: "1 Test Way",
      maxAssuranceTier: 2,
    } as never,
    owner as never,
  );
  if (!res.success) throw new Error(`kernel register failed for ${id}: ${JSON.stringify(res.error)}`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const now = () => new Date(Date.parse("2026-06-19T00:00:00.000Z"));

/** No fixture sets sourceVerifyUrl, but the stub guarantees no test can reach
 *  the network even if one is added later. */
const stubVerify: VerifyFn = async () => ({ ok: true, body: { ok: true } });

function hplcOffer(id: string): Record<string, unknown> {
  return {
    id,
    capabilityType: "lab.hplc",
    requirements: { sampleCount: 10, protocol: "purity-analysis-v1", sampleType: "liquid" },
    pricing: { amount: 40, currency: "USD", model: "per-unit", unit: "sample" },
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Mirrors server.ts — both surfaces over one store.
  await app.register(jobOffersRoutes);
  await app.register(courierJobsRoutes);
  await app.ready();
  return app;
}

/** Post a courier.dispatch offer through the courier surface. */
async function postCourierJob(app: FastifyInstance, id: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/courier-jobs",
    payload: { deliveryId: id, pickup: { name: "A" }, dropoff: { name: "B" } },
    headers: asOperator("poster@store.test"),
  });
  expect(res.statusCode).toBe(201);
}

function offerState(id: string): { status: string; claimedBy: string | null } {
  const o = getJobOffersStore().get(id);
  if (!o) throw new Error(`offer ${id} not found`);
  return { status: o.status, claimedBy: o.claimedByKernelId };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  await registerKernel(DRIVER_KERNEL, OPERATOR);
  await registerKernel(LAB_KERNEL, OPERATOR);
});

afterAll(() => closeStore());

beforeEach(() => {
  _resetCourierJobsStoreForTests();
  initCourierJobsStore({ verify: stubVerify, now });
});

afterEach(() => {
  _resetCourierJobsStoreForTests();
});

// ── The bypass, closed ─────────────────────────────────────────────────────

describe("POST /api/courier-jobs/:id/claim — the second door enforces the same authority", () => {
  it("refuses the stranger on BOTH doors for the same offer + victim kernel", async () => {
    const app = await buildApp();
    try {
      await postCourierJob(app, "c-2");

      // CONTROL — the guarded door already refuses this.
      const guarded = await app.inject({
        method: "POST",
        url: "/api/job-offers/c-2/claim",
        payload: { kernelId: DRIVER_KERNEL },
        headers: asOperator(STRANGER),
      });
      expect(guarded.statusCode).toBe(403);
      expect(guarded.json().error).toBe("not_kernel_operator");
      expect(offerState("c-2").status).toBe("open");

      // THE FIX — the same attacker, same offer, same victim kernel, other door.
      const shim = await app.inject({
        method: "POST",
        url: "/api/courier-jobs/c-2/claim",
        payload: { driverAgent: DRIVER_KERNEL },
        headers: asOperator(STRANGER),
      });
      expect(shim.statusCode).toBe(403);
      expect(shim.json().error).toBe("not_kernel_operator");
      expect(offerState("c-2")).toEqual({ status: "open", claimedBy: null });
    } finally {
      await app.close();
    }
  });

  it("refuses an anonymous claim (no identity at all)", async () => {
    const app = await buildApp();
    try {
      await postCourierJob(app, "c-anon");
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs/c-anon/claim",
        payload: { driverAgent: DRIVER_KERNEL },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("missing_identity");
      expect(offerState("c-anon")).toEqual({ status: "open", claimedBy: null });
    } finally {
      await app.close();
    }
  });

  it("refuses a driverAgent that is neither a kernel the caller operates nor the caller", async () => {
    const app = await buildApp();
    try {
      await postCourierJob(app, "c-ghost");
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs/c-ghost/claim",
        payload: { driverAgent: "kernel-does-not-exist" },
        headers: asOperator(STRANGER),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_driver_identity");
      expect(offerState("c-ghost")).toEqual({ status: "open", claimedBy: null });
    } finally {
      await app.close();
    }
  });

  it("refuses a claim posted on ANOTHER driver's behalf", async () => {
    const app = await buildApp();
    try {
      await postCourierJob(app, "c-behalf");
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs/c-behalf/claim",
        payload: { driverAgent: LEGACY_DRIVER },
        headers: asOperator(STRANGER),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("not_driver_identity");
      expect(offerState("c-behalf")).toEqual({ status: "open", claimedBy: null });
    } finally {
      await app.close();
    }
  });
});

// ── The courier door only reaches courier offers ───────────────────────────

describe("POST /api/courier-jobs/:id/claim — capability scope", () => {
  it("cannot claim a non-courier offer, which the guarded door still claims fine", async () => {
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        payload: hplcOffer("h-1"),
        headers: asOperator("requester@lab.test"),
      });
      expect(created.statusCode).toBe(201);

      // The courier surface does not see non-courier offers on its read side
      // (listOpen / countByStatus filter on courier.dispatch); its claim now
      // says the same thing rather than reaching across categories.
      const shim = await app.inject({
        method: "POST",
        url: "/api/courier-jobs/h-1/claim",
        payload: { driverAgent: LAB_KERNEL },
        headers: asOperator(OPERATOR),
      });
      expect(shim.statusCode).toBe(404);
      expect(offerState("h-1")).toEqual({ status: "open", claimedBy: null });

      // Control: the offer WAS claimable — by its own kernel's operator, on the
      // generic door. So the 404 above is about the door, not the offer.
      const guarded = await app.inject({
        method: "POST",
        url: "/api/job-offers/h-1/claim",
        payload: { kernelId: LAB_KERNEL },
        headers: asOperator(OPERATOR),
      });
      expect(guarded.statusCode).toBe(200);
      expect(offerState("h-1")).toEqual({ status: "claimed", claimedBy: LAB_KERNEL });
    } finally {
      await app.close();
    }
  });
});

// ── Legitimate claims still work ───────────────────────────────────────────

describe("POST /api/courier-jobs/:id/claim — authorized paths", () => {
  it("lets the kernel's operator claim through the shim", async () => {
    const app = await buildApp();
    try {
      await postCourierJob(app, "c-ok");
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs/c-ok/claim",
        payload: { driverAgent: DRIVER_KERNEL, etaMin: 6 },
        headers: asOperator(OPERATOR),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().job.claimedBy).toBe(DRIVER_KERNEL);
      expect(offerState("c-ok")).toEqual({ status: "claimed", claimedBy: DRIVER_KERNEL });
    } finally {
      await app.close();
    }
  });

  it("preserves the v0.2 free-form driver agent claiming under its OWN name", async () => {
    // docs/COURIER_MATCHING.md's driver loop posts driverAgent: MY_AGENT_ID,
    // and routes/print-and-mail.ts's gig worker is that same driver — neither
    // is a registered kernel. The binding this adds is to the CALLER, not to
    // kernel-ness, so that documented flow keeps working.
    const app = await buildApp();
    try {
      await postCourierJob(app, "c-legacy");
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs/c-legacy/claim",
        payload: { driverAgent: LEGACY_DRIVER },
        headers: asOperator(LEGACY_DRIVER),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().job.claimedBy).toBe(LEGACY_DRIVER);
      expect(offerState("c-legacy")).toEqual({ status: "claimed", claimedBy: LEGACY_DRIVER });
    } finally {
      await app.close();
    }
  });
});

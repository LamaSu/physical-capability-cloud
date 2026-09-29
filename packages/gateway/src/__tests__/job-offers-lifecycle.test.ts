/**
 * N81 (rehearsal R0, G5): an offer event must keep the offer inside its
 * lifecycle. Nothing advances an unclaimed offer; delivery comes only after a
 * claim; a delivered, cancelled, settled or expired offer does not move back.
 * A refused event answers 409 and records nothing. The courier shim shares the
 * store, so it gets the same rule.
 *
 * Who may post an event is a separate question (kits #395); every call here
 * is made by one caller.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { jobOffersRoutes } from "../routes/job-offers.js";
import { courierJobsRoutes } from "../routes/courier-jobs.js";
import {
  getJobOffersStore,
  initJobOffersStore,
  _resetJobOffersStoreForTests,
  type JobOfferStatus,
} from "../services/job-offers-store.js";

let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
let app: FastifyInstance;

beforeEach(async () => {
  _resetJobOffersStoreForTests();
  nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  initJobOffersStore({ verify: async () => ({ ok: true, body: { ok: true } }), now: () => new Date(nowMs) });
  app = Fastify({ logger: false });
  await app.register(jobOffersRoutes);
  await app.register(courierJobsRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  _resetJobOffersStoreForTests();
});

const POSTER = { "x-posted-by": "poster" };
let seq = 0;

async function offerIn(status: JobOfferStatus): Promise<string> {
  const id = `offer-${++seq}`;
  const created = await app.inject({
    method: "POST",
    url: "/api/job-offers",
    headers: POSTER,
    payload: {
      id,
      capabilityType: "lab.plate-read",
      requirements: { wells: 2 },
      pricing: { amount: 25, currency: "USD", model: "fixed" },
      validUntilIso: "2026-10-01T01:00:00.000Z",
    },
  });
  expect(created.statusCode).toBeLessThan(300);
  const claim = () =>
    app.inject({ method: "POST", url: `/api/job-offers/${id}/claim`, headers: POSTER, payload: { kernelId: "k-1" } });
  const ev = (event: string) => event_(id, event);
  switch (status) {
    case "open":
      break;
    case "claimed":
      await claim();
      break;
    case "in_progress":
      await claim();
      await ev("in_progress");
      break;
    case "delivered":
      await claim();
      await ev("delivered");
      break;
    case "cancelled":
      await ev("cancelled");
      break;
    case "expired":
      nowMs += 3 * 60 * 60 * 1000; // past the offer's validity
      await getJobOffersStore().sweep();
      break;
    case "settled":
      // Nothing on master sets "settled" (N81's open question), so the test
      // puts the offer there directly.
      await claim();
      await ev("delivered");
      (getJobOffersStore() as unknown as { offers: Map<string, { status: string }> }).offers.get(id)!.status = "settled";
      break;
    default:
      throw new Error(`no setup for ${status}`);
  }
  expect(getJobOffersStore().get(id)!.status).toBe(status);
  return id;
}

function event_(id: string, event: string) {
  return app.inject({ method: "POST", url: `/api/job-offers/${id}/events`, headers: POSTER, payload: { event } });
}

describe("an event keeps the offer inside its lifecycle", () => {
  it.each([
    ["open", "in_progress"],
    ["open", "pickup"],
    ["open", "delivered"],
    ["delivered", "in_progress"],
    ["delivered", "pickup"],
    ["delivered", "cancelled"],
    ["cancelled", "in_progress"],
    ["cancelled", "delivered"],
    ["expired", "in_progress"],
    ["expired", "delivered"],
    ["expired", "cancelled"],
    ["settled", "in_progress"],
    ["settled", "delivered"],
    ["settled", "cancelled"],
  ] as Array<[JobOfferStatus, string]>)("%s + %s is refused (409), and nothing is recorded", async (from, event) => {
    const id = await offerIn(from);
    const before = getJobOffersStore().getEvents(id).length;
    const res = await event_(id, event);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "invalid_transition", event, currentStatus: from });
    expect(getJobOffersStore().get(id)!.status).toBe(from);
    expect(getJobOffersStore().getEvents(id).length).toBe(before);
  });

  it.each([
    ["open", "cancelled", "cancelled"],
    ["claimed", "in_progress", "in_progress"],
    ["claimed", "pickup", "in_progress"],
    ["claimed", "delivered", "delivered"],
    ["claimed", "cancelled", "cancelled"],
    ["in_progress", "in_progress", "in_progress"],
    ["in_progress", "delivered", "delivered"],
    ["in_progress", "cancelled", "cancelled"],
    ["delivered", "delivered", "delivered"],
    ["cancelled", "cancelled", "cancelled"],
  ] as Array<[JobOfferStatus, string, JobOfferStatus]>)("%s + %s goes to %s", async (from, event, to) => {
    const id = await offerIn(from);
    const res = await event_(id, event);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(to);
  });

  it.each(["open", "claimed", "delivered", "cancelled", "expired", "settled"] as JobOfferStatus[])(
    "a note or progress update on a %s offer is recorded and changes nothing",
    async (from) => {
      const id = await offerIn(from);
      for (const event of ["note", "progress_update"]) {
        const res = await event_(id, event);
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe(from);
      }
    },
  );

  it("a repeated delivery keeps the first delivery time", async () => {
    const id = await offerIn("delivered");
    const first = getJobOffersStore().get(id)!.deliveredAt;
    nowMs += 60_000;
    await event_(id, "delivered");
    expect(getJobOffersStore().get(id)!.deliveredAt).toBe(first);
  });

  it("R0's sequence on an unclaimed offer stops at the first step", async () => {
    const id = await offerIn("open");
    expect((await event_(id, "delivered")).statusCode).toBe(409);
    expect(getJobOffersStore().get(id)!.status).toBe("open");
  });
});

describe("the courier shim shares the rule", () => {
  it("a pickup on an open courier job is refused (409); after a claim it goes through", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/courier-jobs",
      headers: POSTER,
      payload: { deliveryId: "cj-1", pickup: { name: "A" }, dropoff: { name: "B" } },
    });
    expect(created.statusCode).toBe(201);
    const early = await app.inject({ method: "POST", url: "/api/courier-jobs/cj-1/events", payload: { event: "pickup" } });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("invalid_transition");
    const claimed = await app.inject({ method: "POST", url: "/api/courier-jobs/cj-1/claim", payload: { driverAgent: "driver-1" } });
    expect(claimed.statusCode).toBe(200);
    const pickup = await app.inject({ method: "POST", url: "/api/courier-jobs/cj-1/events", payload: { event: "pickup" } });
    expect(pickup.statusCode).toBe(200);
  });
});

/**
 * N81 (rehearsal R0, G5): an offer event must keep the offer inside its
 * lifecycle. Nothing advances an unclaimed offer; delivery comes only after a
 * claim; a delivered, cancelled, settled or expired offer does not move back.
 * A refused event answers 409 and records nothing. The courier shim shares the
 * store, so it gets the same rule.
 *
 * Who may post an event is a separate question (kits #395). The fixtures below
 * are authenticated participants, as #395's routes require: a request hook sets
 * the authenticated actor, kernels have owners, and every call is made by an
 * actor who may post that event. So a lifecycle refusal here comes from the
 * lifecycle, not from authentication. Without #395's checks the fixtures change
 * nothing.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { jobOffersRoutes } from "../routes/job-offers.js";
import { courierJobsRoutes } from "../routes/courier-jobs.js";
import { initStore, closeStore, getStore } from "../db.js";
import {
  getJobOffersStore,
  initJobOffersStore,
  _resetJobOffersStoreForTests,
  EVENT_ALLOWED_FROM,
  JOB_OFFER_STATUSES,
  REVIEW_WINDOW_MS,
  RECLAIM_BLOCK_MS,
  type JobOfferStatus,
  type VerifyFn,
  type VerifyResult,
  type SqliteDatabaseLike,
} from "../services/job-offers-store.js";

// ── Participants (the authenticated fixtures) ───────────────────────────────

/** Stands in for an API key: the hook below turns it into req.operatorId, the field #395's routes read. */
const as = (operatorId: string) => ({ "x-test-operator": operatorId });

const POSTER = "poster@lifecycle.test";
const CLAIMANT = "claimant-1@lifecycle.test";
const OTHER_CLAIMANT = "claimant-2@lifecycle.test";
const STRANGER = "stranger@lifecycle.test";

/** kernelId -> the identity that owns it. A Map: a kernel id is data, never a property name. */
const KERNEL_OWNERS: ReadonlyMap<string, string> = new Map([
  ["k-1", CLAIMANT],
  ["k-2", OTHER_CLAIMANT],
]);

/**
 * Who posts which event, as the offer rules assign them (kits #3989, #4063):
 * the claimant posts what moves an offer forward or hands it back, the poster
 * posts what ends or judges it, either posts the rest. Written out here, not
 * read from any production table. "settled" is the server's alone: nobody may
 * post it, so the poster stands in.
 */
const CLAIMANT_EVENTS: ReadonlySet<string> = new Set(["in_progress", "pickup", "delivered", "release"]);
const actorFor = (event: string): string => (CLAIMANT_EVENTS.has(event) ? CLAIMANT : POSTER);

/**
 * A claimant-only event on an offer nobody holds (open, or expired unclaimed):
 * with #395's checks no actor may post it (403 not_claimed, before the
 * lifecycle runs); without them the lifecycle refuses it (409). Either way
 * nothing changes. The lifecycle's own refusal of these cells is asserted
 * exactly, with no routes, in the store-level matrix.
 */
const NOBODY_HOLDS: ReadonlySet<JobOfferStatus> = new Set<JobOfferStatus>(["open", "expired"]);
const refusalCodes = (from: JobOfferStatus, event: string): number[] =>
  CLAIMANT_EVENTS.has(event) && NOBODY_HOLDS.has(from) ? [403, 409] : [409];

// ── App ─────────────────────────────────────────────────────────────────────

let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
let app: FastifyInstance;
const store = () => getJobOffersStore();

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  a.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string" && h !== "") (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await a.register(jobOffersRoutes, { kernelOwnerOf: (kernelId: string) => KERNEL_OWNERS.get(kernelId) ?? null });
  await a.register(courierJobsRoutes);
  await a.ready();
  return a;
}

beforeEach(async () => {
  _resetJobOffersStoreForTests();
  nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  initJobOffersStore({ verify: async () => ({ ok: true, body: { ok: true } }), now: () => new Date(nowMs) });
  app = await buildApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  _resetJobOffersStoreForTests();
});

let seq = 0;
const iso = (ms: number): string => new Date(ms).toISOString();

const claimAs = (id: string, kernelId = "k-1", actor = CLAIMANT) =>
  app.inject({ method: "POST", url: `/api/job-offers/${id}/claim`, headers: as(actor), payload: { kernelId } });

function event_(id: string, event: string, actor: string = actorFor(event)) {
  return app.inject({ method: "POST", url: `/api/job-offers/${id}/events`, headers: as(actor), payload: { event } });
}

/** The whole observable state of an offer: the offer and its event log, deep-copied. */
function snapshot(id: string) {
  return JSON.parse(JSON.stringify({ offer: store().get(id), events: store().getEvents(id) }));
}

async function createOffer(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const created = await app.inject({
    method: "POST",
    url: "/api/job-offers",
    headers: as(POSTER),
    payload: {
      id,
      capabilityType: "lab.plate-read",
      requirements: { wells: 2 },
      pricing: { amount: 25, currency: "USD", model: "fixed" },
      ...extra,
    },
  });
  expect(created.statusCode).toBeLessThan(300);
}

async function offerIn(status: JobOfferStatus): Promise<string> {
  const id = `offer-${++seq}`;
  await createOffer(id);
  const ev = (event: string) => event_(id, event);
  switch (status) {
    case "open":
      break;
    case "claimed":
      await claimAs(id);
      break;
    case "in_progress":
      await claimAs(id);
      await ev("in_progress");
      break;
    case "delivered":
      await claimAs(id);
      await ev("delivered");
      break;
    case "cancelled":
      await claimAs(id);
      await ev("cancelled");
      break;
    case "expired":
      nowMs += 3 * 60 * 60 * 1000; // past the offer's validity
      await store().sweep();
      break;
    case "completed":
      await claimAs(id);
      await ev("delivered");
      await ev("confirmed");
      break;
    case "disputed":
      await claimAs(id);
      await ev("delivered");
      await ev("disputed");
      break;
    case "lapsed":
      await claimAs(id);
      await ev("delivered");
      nowMs += REVIEW_WINDOW_MS + 1;
      await store().sweep();
      break;
    case "settled":
      // Nothing on master sets "settled" (N81's open question), so the test
      // puts the offer there directly.
      await claimAs(id);
      await ev("delivered");
      (store() as unknown as { offers: Map<string, { status: string }> }).offers.get(id)!.status = "settled";
      break;
    default:
      throw new Error(`no setup for ${status}`);
  }
  expect(store().get(id)!.status).toBe(status);
  return id;
}

describe("an event keeps the offer inside its lifecycle", () => {
  it.each([
    ["delivered", "in_progress"],
    ["delivered", "pickup"],
    ["delivered", "cancelled"],
    ["cancelled", "in_progress"],
    ["cancelled", "delivered"],
    ["expired", "cancelled"],
    ["settled", "in_progress"],
    ["settled", "delivered"],
    ["settled", "cancelled"],
  ] as Array<[JobOfferStatus, string]>)("%s + %s is refused (409), and nothing is recorded", async (from, event) => {
    const id = await offerIn(from);
    const before = snapshot(id);
    const res = await event_(id, event);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "invalid_transition", event, currentStatus: from });
    expect(snapshot(id)).toEqual(before);
  });

  it.each([
    ["open", "in_progress"],
    ["open", "pickup"],
    ["open", "delivered"],
    ["expired", "in_progress"],
    ["expired", "delivered"],
  ] as Array<[JobOfferStatus, string]>)(
    "%s + %s (nobody holds the offer) is refused, and nothing is recorded",
    async (from, event) => {
      const id = await offerIn(from);
      const before = snapshot(id);
      const res = await event_(id, event);
      expect(refusalCodes(from, event)).toContain(res.statusCode);
      if (res.statusCode === 409) {
        expect(res.json()).toEqual({ error: "invalid_transition", event, currentStatus: from });
      }
      expect(snapshot(id)).toEqual(before);
    },
  );

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
    const first = store().get(id)!.deliveredAt;
    nowMs += 60_000;
    await event_(id, "delivered");
    expect(store().get(id)!.deliveredAt).toBe(first);
  });

  it("R0's sequence on an unclaimed offer stops at the first step", async () => {
    const id = await offerIn("open");
    const before = snapshot(id);
    expect([403, 409]).toContain((await event_(id, "delivered")).statusCode);
    expect(store().get(id)!.status).toBe("open");
    expect(snapshot(id)).toEqual(before);
  });
});

describe("the courier shim shares the rule", () => {
  it("a pickup on an open courier job is refused; after a claim it goes through", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/courier-jobs",
      headers: as(POSTER),
      payload: { deliveryId: "cj-1", pickup: { name: "A" }, dropoff: { name: "B" } },
    });
    expect(created.statusCode).toBe(201);
    const early = await app.inject({
      method: "POST", url: "/api/courier-jobs/cj-1/events", headers: as(CLAIMANT), payload: { event: "pickup" },
    });
    // 409 from the lifecycle; with #395's checks, 403 (nobody has claimed it yet).
    expect([403, 409]).toContain(early.statusCode);
    if (early.statusCode === 409) expect(early.json().error).toBe("invalid_transition");
    expect(store().get("cj-1")!.status).toBe("open");
    const claimed = await app.inject({
      method: "POST", url: "/api/courier-jobs/cj-1/claim", headers: as(CLAIMANT), payload: { driverAgent: "driver-1" },
    });
    expect(claimed.statusCode).toBe(200);
    const pickup = await app.inject({
      method: "POST", url: "/api/courier-jobs/cj-1/events", headers: as(CLAIMANT), payload: { event: "pickup" },
    });
    expect(pickup.statusCode).toBe(200);
  });
});

describe("how a delivered offer ends (kits #3989)", () => {
  it("the poster's 'confirmed' completes a delivered offer, once; nothing else completes it", async () => {
    const id = await offerIn("delivered");
    const r = await event_(id, "confirmed");
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("completed");
    expect(store().get(id)!.completedAt).toBeTruthy();
    expect((await event_(id, "confirmed")).json().status).toBe("completed");
    for (const from of ["open", "claimed", "in_progress"] as JobOfferStatus[]) {
      const other = await offerIn(from);
      expect((await event_(other, "confirmed")).statusCode).toBe(409);
    }
  });

  it("'disputed' is allowed only within the review window", async () => {
    const inWindow = await offerIn("delivered");
    expect((await event_(inWindow, "disputed")).json().status).toBe("disputed");
    const late = await offerIn("delivered");
    nowMs += REVIEW_WINDOW_MS + 1;
    const r = await event_(late, "disputed");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("review_window_closed");
  });

  it.each(["open", "claimed", "in_progress", "delivered", "completed"] as JobOfferStatus[])(
    "a posted 'settled' is refused on a %s offer: only the server settles",
    async (from) => {
      const id = await offerIn(from);
      const r = await event_(id, "settled");
      expect(r.statusCode).toBe(409);
      expect(store().get(id)!.status).toBe(from);
    },
  );

  it("a delivery nobody confirms or disputes lapses after the window, never before, and never as success", async () => {
    const id = await offerIn("delivered");
    nowMs += REVIEW_WINDOW_MS - 1_000;
    await store().sweep();
    expect(store().get(id)!.status).toBe("delivered");
    nowMs += 2_000;
    const swept = await store().sweep();
    expect(swept.lapsed).toBe(1);
    expect(store().get(id)!.status).toBe("lapsed");
    expect(store().getEvents(id).at(-1)).toMatchObject({ event: "lapsed", reason: "delivery_unconfirmed" });
    const done = await offerIn("completed");
    nowMs += REVIEW_WINDOW_MS * 2;
    await store().sweep();
    expect(store().get(done)!.status).toBe("completed");
  });

  it.each(["completed", "disputed", "lapsed"] as JobOfferStatus[])("a %s offer is final", async (from) => {
    const id = await offerIn(from);
    for (const ev of ["in_progress", "delivered", "release", "cancelled", from === "completed" ? "disputed" : "confirmed"]) {
      expect((await event_(id, ev)).statusCode, ev).toBe(409);
    }
    expect(store().get(id)!.status).toBe(from);
  });
});

describe("a claimant's release (kits #3989)", () => {
  it("puts a claimed or in-progress offer back to open and clears the claim; not after delivery", async () => {
    for (const from of ["claimed", "in_progress"] as JobOfferStatus[]) {
      const id = await offerIn(from);
      expect((await event_(id, "release")).json().status).toBe("open");
      const o = store().get(id)!;
      expect(o.claimedByKernelId).toBeNull();
      expect(o.claimedAt).toBeNull();
    }
    const delivered = await offerIn("delivered");
    expect((await event_(delivered, "release")).statusCode).toBe(409);
  });

  it("the releasing kernel cannot re-claim that offer for an hour; another kernel can at once", async () => {
    const id = await offerIn("claimed"); // claimed by k-1
    await event_(id, "release");
    const again = await claimAs(id, "k-1", CLAIMANT);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("recently_released");
    expect(again.json().retryAfterMs).toBe(RECLAIM_BLOCK_MS);
    expect((await claimAs(id, "k-2", OTHER_CLAIMANT)).statusCode).toBe(200);
  });

  it("after the hour, the releasing kernel may claim it again", async () => {
    const id = await offerIn("claimed");
    await event_(id, "release");
    nowMs += RECLAIM_BLOCK_MS;
    expect((await claimAs(id)).statusCode).toBe(200);
  });

  it("the courier shim refuses the re-claim too, and projects completed and lapsed statuses", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/courier-jobs", headers: as(POSTER),
      payload: { deliveryId: "cj-rel", pickup: { name: "A" }, dropoff: { name: "B" } },
    });
    expect(created.statusCode).toBe(201);
    const courierClaim = () =>
      app.inject({ method: "POST", url: "/api/courier-jobs/cj-rel/claim", headers: as(CLAIMANT), payload: { driverAgent: "d1" } });
    await courierClaim();
    await event_("cj-rel", "release");
    const again = await courierClaim();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("recently_released");
    const done = await offerIn("completed");
    const lapsed = await offerIn("lapsed");
    const courierStatus = async (id: string) => (await app.inject({ method: "GET", url: `/api/courier-jobs/${id}` })).json();
    expect(JSON.stringify(await courierStatus(done))).toContain('"status":"delivered"');
    expect(JSON.stringify(await courierStatus(lapsed))).toContain('"status":"expired"');
  });
});

// ═══ Review round 1 (pack 106 on 10f4545f): each finding reproduced first ═══

describe("F1: an event name is data, never a property of the rule table", () => {
  // Every name a plain object inherits: toString, constructor, __proto__, ...
  const inherited = Object.getOwnPropertyNames(Object.prototype);

  it("the list is not empty (the test would pass vacuously otherwise)", () => {
    expect(inherited).toEqual(expect.arrayContaining(["toString", "constructor", "__proto__"]));
  });

  it.each(inherited)("F1: a posted event named %s is recorded as a status-neutral event", async (name) => {
    const id = await offerIn("claimed");
    const before = store().getEvents(id).length;
    const res = await event_(id, name, POSTER);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("claimed");
    expect(store().get(id)!.status).toBe("claimed");
    expect(store().getEvents(id).length).toBe(before + 1);
    expect(store().getEvents(id).at(-1)).toMatchObject({ event: name });
  });

  it("F1: the store records such an event instead of throwing", async () => {
    const id = await offerIn("delivered");
    for (const name of inherited) {
      const r = store().recordEvent(id, name, null, null, null);
      expect(r.ok, name).toBe(true);
      if (r.ok) expect(r.status).toBe("delivered");
    }
  });

  it("F1: the courier shim, which accepts a fixed set of event names, refuses them as invalid_event", async () => {
    const id = await offerIn("claimed");
    for (const name of inherited) {
      const res = await app.inject({
        method: "POST", url: `/api/courier-jobs/${id}/events`, headers: as(CLAIMANT), payload: { event: name },
      });
      expect(res.statusCode, name).toBe(400);
      expect(res.json().error, name).toBe("invalid_event");
    }
  });
});

/** What the courier shim shows for each generic status (its own vocabulary). Written out, not read from the shim. */
const COURIER_VIEW: ReadonlyMap<JobOfferStatus, string> = new Map<JobOfferStatus, string>([
  ["open", "open"],
  ["claimed", "claimed"],
  ["in_progress", "in_transit"],
  ["delivered", "delivered"],
  ["completed", "delivered"],
  ["settled", "delivered"],
  ["disputed", "delivered"],
  ["cancelled", "cancelled"],
  ["expired", "expired"],
  ["lapsed", "expired"],
]);

describe("F2: DELETE cancels only where a posted 'cancelled' would", () => {
  const routes = [
    { name: "generic", url: (id: string) => `/api/job-offers/${id}`, view: (s: JobOfferStatus) => s as string },
    { name: "courier", url: (id: string) => `/api/courier-jobs/${id}`, view: (s: JobOfferStatus) => COURIER_VIEW.get(s)! },
  ];
  const del = (url: string, actor = POSTER) => app.inject({ method: "DELETE", url, headers: as(actor) });

  it("F2: a delivered offer is not cancelled by its poster's DELETE: refused, and nothing changes", async () => {
    const id = `offer-${++seq}`;
    await createOffer(id);
    expect((await claimAs(id)).statusCode).toBe(200);
    expect((await event_(id, "delivered")).statusCode).toBe(200);
    const before = snapshot(id);
    const res = await del(`/api/job-offers/${id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "invalid_transition", event: "cancelled", currentStatus: "delivered" });
    expect(snapshot(id)).toEqual(before);
    expect(store().get(id)!.status).toBe("delivered");
    expect(store().get(id)!.cancelledAt).toBeNull();
    expect(store().getEvents(id).some((e) => e.event === "deleted_by_poster")).toBe(false);
  });

  for (const route of routes) {
    describe(`through the ${route.name} route`, () => {
      it.each(["delivered", "completed", "settled", "expired", "lapsed", "disputed"] as JobOfferStatus[])(
        "F2: DELETE on a %s offer is refused (409); the state and the log stay unchanged",
        async (from) => {
          const id = await offerIn(from);
          const before = snapshot(id);
          const res = await del(route.url(id));
          expect(res.statusCode).toBe(409);
          expect(res.json()).toEqual({ error: "invalid_transition", event: "cancelled", currentStatus: route.view(from) });
          expect(snapshot(id)).toEqual(before);
        },
      );

      it.each(["open", "claimed", "in_progress"] as JobOfferStatus[])(
        "F2: DELETE on a %s offer cancels it and logs the deletion",
        async (from) => {
          const id = await offerIn(from);
          const eventsBefore = store().getEvents(id).length;
          const res = await del(route.url(id));
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ ok: true, status: "cancelled" });
          const o = store().get(id)!;
          expect(o.status).toBe("cancelled");
          expect(o.cancelledAt).toBe(iso(nowMs));
          expect(store().getEvents(id).length).toBe(eventsBefore + 1);
          expect(store().getEvents(id).at(-1)).toMatchObject({ event: "deleted_by_poster" });
        },
      );

      it("F2: a repeated DELETE is state-idempotent: it keeps the original cancellation time", async () => {
        const id = await offerIn("claimed");
        expect((await del(route.url(id))).statusCode).toBe(200);
        const first = store().get(id)!.cancelledAt;
        expect(first).toBe(iso(nowMs));
        nowMs += 60_000;
        const again = await del(route.url(id));
        expect(again.statusCode).toBe(200);
        expect(again.json()).toEqual({ ok: true, status: "cancelled" });
        expect(store().get(id)!.status).toBe("cancelled");
        expect(store().get(id)!.cancelledAt).toBe(first);
        // Like a repeated 'cancelled' event: the state holds, the repeat is logged.
        expect(store().getEvents(id).filter((e) => e.event === "deleted_by_poster").length).toBe(2);
      });

      it("F2: a stranger's DELETE on a delivered offer is forbidden (403), not answered with its status", async () => {
        const id = await offerIn("delivered");
        const before = snapshot(id);
        const res = await del(route.url(id), STRANGER);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("forbidden");
        expect(snapshot(id)).toEqual(before);
      });

      it("F2: DELETE on an unknown offer is 404", async () => {
        expect((await del(route.url("no-such-offer"))).statusCode).toBe(404);
      });

      it("F2: a refusal the route does not know is never answered as a success (500)", async () => {
        const id = await offerIn("claimed");
        vi.spyOn(store(), "cancel").mockReturnValue({ ok: false, reason: "unheard_of" } as never);
        const res = await del(route.url(id));
        expect(res.statusCode).toBe(500);
        expect(res.json().ok).not.toBe(true);
      });
    });
  }

  it("F2: the same refusal comes from DELETE and from a posted 'cancelled' event", async () => {
    for (const from of ["delivered", "completed", "settled", "expired", "lapsed", "disputed"] as JobOfferStatus[]) {
      const id = await offerIn(from);
      const viaDelete = await del(`/api/job-offers/${id}`);
      const viaEvent = await event_(id, "cancelled");
      expect(viaDelete.statusCode, from).toBe(viaEvent.statusCode);
      expect(viaDelete.json(), from).toEqual(viaEvent.json());
    }
  });
});

describe("F3: a source re-check that returns late cannot overwrite what happened meanwhile", () => {
  const SOURCE = "https://source.example.test/order/1";
  const FAILED: VerifyResult = { ok: false, reason: "http_non_2xx", status: 500 };

  /** A source that answers the creation check at once, then holds every later check until the test settles it. */
  function heldSource() {
    const held: Array<{ url: string; settle: (r: VerifyResult) => void }> = [];
    let holding = false;
    const verify: VerifyFn = (url) =>
      holding
        ? new Promise<VerifyResult>((settle) => held.push({ url, settle }))
        : Promise.resolve({ ok: true, body: { ok: true } });
    return { verify, held, hold: () => { holding = true; } };
  }

  /** An open offer whose source was verified at creation and is due another check; the sweep starts and waits on the source. */
  async function sweepWaitingOnSource() {
    const source = heldSource();
    initJobOffersStore({ verify: source.verify, now: () => new Date(nowMs) });
    const id = `offer-${++seq}`;
    await createOffer(id, { sourceVerifyUrl: SOURCE });
    expect(store().get(id)!.verified).toBe(true);
    nowMs += 60_000; // the early re-check interval
    source.hold();
    const sweeping = store().sweep();
    expect(source.held.length).toBe(1);
    expect(source.held[0]!.url).toBe(SOURCE);
    return { id, source, sweeping };
  }

  it("F3: an offer delivered while a source check was out stays delivered when the check fails", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    expect((await claimAs(id)).statusCode).toBe(200);
    expect((await event_(id, "delivered")).statusCode).toBe(200);
    const before = snapshot(id);
    source.held[0]!.settle(FAILED);
    const swept = await sweeping;
    expect(store().get(id)!.status).toBe("delivered");
    expect(store().get(id)!.cancelledAt).toBeNull();
    expect(store().get(id)!.verified).toBe(true);
    expect(swept.autoCancelled).toBe(0);
    expect(snapshot(id)).toEqual(before);
  });

  it("F3: a poster's cancel while the check is out stands: the late failure adds nothing", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    expect((await app.inject({ method: "DELETE", url: `/api/job-offers/${id}`, headers: as(POSTER) })).statusCode).toBe(200);
    const before = snapshot(id);
    nowMs += 5_000;
    source.held[0]!.settle(FAILED);
    const swept = await sweeping;
    expect(swept.autoCancelled).toBe(0);
    expect(snapshot(id)).toEqual(before);
    expect(store().getEvents(id).some((e) => e.reason === "source_verify_failed_after_post")).toBe(false);
  });

  it("F3: a claim while the check is out stands: the claimed offer is not cancelled, and keeps its claim", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    expect((await claimAs(id)).statusCode).toBe(200);
    const before = snapshot(id);
    source.held[0]!.settle(FAILED);
    await sweeping;
    expect(store().get(id)!.status).toBe("claimed");
    expect(store().get(id)!.claimedByKernelId).toBe("k-1");
    expect(snapshot(id)).toEqual(before);
  });

  it("F3: an offer another sweep expired while the check was out stays expired, not cancelled", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    nowMs += 3 * 60 * 60 * 1000;
    const other = await store().sweep(); // sees it past its validity; expires it before asking the source
    expect(other.expired).toBe(1);
    const before = snapshot(id);
    source.held[0]!.settle(FAILED);
    await sweeping;
    expect(store().get(id)!.status).toBe("expired");
    expect(snapshot(id)).toEqual(before);
  });

  it("F3: a passing check that returns late changes nothing on an offer that has moved on", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    expect((await claimAs(id)).statusCode).toBe(200);
    expect((await event_(id, "delivered")).statusCode).toBe(200);
    const before = snapshot(id);
    source.held[0]!.settle({ ok: true, body: { ok: true } });
    const swept = await sweeping;
    expect(swept.reverified).toBe(0);
    expect(snapshot(id)).toEqual(before);
  });

  it("F3: control: with nothing in between, a failed check still cancels the open offer, and says why", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    source.held[0]!.settle(FAILED);
    const swept = await sweeping;
    expect(swept.autoCancelled).toBe(1);
    const o = store().get(id)!;
    expect(o.status).toBe("cancelled");
    expect(o.verified).toBe(false);
    expect(o.cancelledAt).toBe(iso(nowMs));
    expect(store().getEvents(id).at(-1)).toMatchObject({
      event: "cancelled",
      reason: "source_verify_failed_after_post",
      verifyReason: "http_non_2xx",
    });
  });

  it("F3: control: with nothing in between, a passing check records the re-verification", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    source.held[0]!.settle({ ok: true, body: { ok: true } });
    const swept = await sweeping;
    expect(swept.reverified).toBe(1);
    expect(store().get(id)!.status).toBe("open");
    expect(store().get(id)!.lastVerifyAt).toBe(iso(nowMs));
  });

  type Live = { claimedByKernelId: string | null; claimedAt: string | null; sourceVerifyUrl: string | null };
  it.each([
    ["the claim", (o: Live) => { o.claimedByKernelId = "k-elsewhere"; }],
    ["the claim time", (o: Live) => { o.claimedAt = "2026-10-01T00:00:30.000Z"; }],
    ["the source address", (o: Live) => { o.sourceVerifyUrl = "https://elsewhere.example.test/order/9"; }],
  ] as Array<[string, (o: Live) => void]>)(
    "F3: the answer is discarded when %s is not the one asked about, even with no status change",
    async (_what, change) => {
      const { id, source, sweeping } = await sweepWaitingOnSource();
      change(store().get(id) as unknown as Live);
      const before = snapshot(id);
      source.held[0]!.settle(FAILED);
      const swept = await sweeping;
      expect(swept.autoCancelled).toBe(0);
      expect(store().get(id)!.status).toBe("open");
      expect(snapshot(id)).toEqual(before);
    },
  );

  it("F3: the answer is discarded when the offer record was replaced while the check was out", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    const offers = (store() as unknown as { offers: Map<string, Record<string, unknown>> }).offers;
    offers.set(id, { ...offers.get(id)! });
    const before = snapshot(id);
    source.held[0]!.settle(FAILED);
    const swept = await sweeping;
    expect(swept.autoCancelled).toBe(0);
    expect(store().get(id)!.status).toBe("open");
    expect(snapshot(id)).toEqual(before);
  });

  it("F3: a poster's heartbeat or edit while the check is out does not keep a failed answer from applying", async () => {
    const { id, source, sweeping } = await sweepWaitingOnSource();
    expect((await app.inject({ method: "POST", url: `/api/job-offers/${id}/heartbeat`, headers: as(POSTER) })).statusCode).toBe(200);
    const edited = await app.inject({
      method: "PATCH", url: `/api/job-offers/${id}`, headers: as(POSTER), payload: { requirements: { wells: 3 } },
    });
    expect(edited.statusCode).toBe(200);
    source.held[0]!.settle(FAILED);
    const swept = await sweeping;
    expect(swept.autoCancelled).toBe(1);
    expect(store().get(id)!.status).toBe("cancelled");
  });
});

describe("F4: the fixtures are authenticated participants", () => {
  it("F4: the actor the request hook sets is the poster the routes record, and the one DELETE compares", async () => {
    const id = await offerIn("open");
    expect(store().get(id)!.posterDid).toBe(POSTER);
    expect((await app.inject({ method: "DELETE", url: `/api/job-offers/${id}`, headers: as(STRANGER) })).statusCode).toBe(403);
    expect(store().get(id)!.status).toBe("open");
    expect((await app.inject({ method: "DELETE", url: `/api/job-offers/${id}`, headers: as(POSTER) })).statusCode).toBe(200);
  });
});

// ═══ F5: the full status x event matrix ═══════════════════════════════════════

/** The review window in milliseconds, written out here: independent of the production constant. */
const WINDOW_MS = 72 * 60 * 60 * 1000;

/** Events that change no status. The last three are names a plain object inherits. */
const FREE_FORM = ["note", "progress_update", "error", "acknowledged", "toString", "constructor", "__proto__"];

/**
 * The rule, cell by cell, written out from kits #3989 and the N81 commits and
 * independent of the production table: for each status-changing event, the
 * statuses it may be posted from, and where each lands. Every cell not listed
 * is refused. A change to the production table cannot change these
 * expectations; the pin test below fails until they are changed on purpose.
 *   - delivered is the claimant's assertion: never terminal, never success;
 *   - confirmed (poster) ends a delivery in 'completed', the success;
 *   - disputed (poster) ends it in 'disputed';
 *   - confirmed and disputed are the two JUDGMENTS of a delivery: from
 *     'delivered' each is allowed only inside the review window (see JUDGMENTS
 *     below), so the delivered -> completed and delivered -> disputed cells are
 *     the inside-the-window ones;
 *   - release (claimant, before delivery) puts the offer back to 'open';
 *   - settled is the server's alone: a posted one is refused from every status;
 *   - a repeat of an event that already holds is allowed and changes nothing.
 */
const ALLOWED_TO_ROWS: Record<string, Partial<Record<JobOfferStatus, JobOfferStatus>>> = {
  in_progress: { claimed: "in_progress", in_progress: "in_progress" },
  pickup: { claimed: "in_progress", in_progress: "in_progress" },
  delivered: { claimed: "delivered", in_progress: "delivered", delivered: "delivered" },
  release: { claimed: "open", in_progress: "open" },
  cancelled: { open: "cancelled", claimed: "cancelled", in_progress: "cancelled", cancelled: "cancelled" },
  confirmed: { delivered: "completed", completed: "completed" },
  disputed: { delivered: "disputed", disputed: "disputed" },
  settled: {},
};
const ALLOWED_TO = new Map(Object.entries(ALLOWED_TO_ROWS));

/** Every status, written out: a status added in production fails the pin test until it is placed here. */
const ALL_STATUSES: readonly JobOfferStatus[] = [
  "open", "claimed", "in_progress", "delivered", "completed", "settled", "cancelled", "expired", "lapsed", "disputed",
];

/** What an event writes the first time it moves an offer, besides its status. */
const WRITES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["in_progress", []],
  ["pickup", []],
  ["delivered", ["deliveredAt"]],
  ["release", ["claimedByKernelId", "claimedAt"]],
  ["cancelled", ["cancelledAt"]],
  ["confirmed", ["completedAt"]],
  ["disputed", ["disputedAt"]],
]);
const STAMP_OF: ReadonlyMap<string, string> = new Map([
  ["delivered", "deliveredAt"],
  ["cancelled", "cancelledAt"],
  ["confirmed", "completedAt"],
  ["disputed", "disputedAt"],
]);

/**
 * The events that judge a delivery (kits #3989): from 'delivered', each is
 * allowed only while the offer is no more than 72 h past its delivery. Anywhere
 * else the window plays no part: a judgment already made may be repeated at any
 * age. Written out here, like the table above: a change to the production rule
 * cannot change it, and the matrix below reads every cell at the window's edges.
 */
const JUDGMENTS: ReadonlySet<string> = new Set(["confirmed", "disputed"]);

/** How long after an offer reached its status an event is posted: well inside the window, its last instant, one millisecond past it. */
const AGES: ReadonlyArray<readonly [string, number]> = [
  ["60 s", 60_000],
  ["exactly 72 h", WINDOW_MS],
  ["72 h + 1 ms", WINDOW_MS + 1],
];

// The matrix is generated from the production table: every status against every event in it, and the free-form ones.
const EVENTS: string[] = [...EVENT_ALLOWED_FROM.keys(), ...FREE_FORM];
const CELLS: Array<[JobOfferStatus, string]> = JOB_OFFER_STATUSES.flatMap((s) =>
  EVENTS.map((e): [JobOfferStatus, string] => [s, e]),
);
/** Each cell read at each age: the table is the same at every moment except where a window closes. */
const TIMED_CELLS: Array<[JobOfferStatus, string, string, number]> = AGES.flatMap(([label, ageMs]) =>
  CELLS.map(([s, e]): [JobOfferStatus, string, string, number] => [s, e, label, ageMs]),
);

type Expectation =
  | { allowed: true; to: JobOfferStatus }
  | { allowed: false; reason: "invalid_transition" | "review_window_closed" };

function expectedFor(status: JobOfferStatus, event: string, ageMs: number = AGES[0]![1]): Expectation {
  if (EVENT_ALLOWED_FROM.has(event) && !ALLOWED_TO.has(event)) {
    throw new Error(`the production table has the event ${event}, with no independent expectation here`);
  }
  const row = ALLOWED_TO.get(event);
  if (!row) return { allowed: true, to: status }; // not in the table: recorded, no status change
  const to = row[status];
  if (to === undefined) return { allowed: false, reason: "invalid_transition" };
  if (JUDGMENTS.has(event) && status === "delivered" && ageMs > WINDOW_MS) {
    return { allowed: false, reason: "review_window_closed" };
  }
  return { allowed: true, to };
}

type Snap = { offer: Record<string, unknown>; events: Array<Record<string, unknown>> };

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
}

/** An accepted event: one more log entry; the status the table gives; only the fields it writes change, and a repeat changes none. */
function expectAllowed(before: Snap, after: Snap, status: JobOfferStatus, event: string, to: JobOfferStatus, at: string): void {
  const cell = `${status} + ${event}`;
  expect(after.events.length, `${cell}: the log`).toBe(before.events.length + 1);
  expect(after.events.at(-1), `${cell}: the logged event`).toMatchObject({ at, event });
  expect(after.offer.status, `${cell}: the status`).toBe(to);
  const moved = to !== status;
  const writes = moved ? ["status", ...(WRITES.get(event) ?? [])].sort() : [];
  expect(changedKeys(before.offer, after.offer), `${cell}: the fields that changed`).toEqual(writes);
  const stamp = STAMP_OF.get(event);
  if (moved && stamp) expect(after.offer[stamp], `${cell}: ${stamp}`).toBe(at);
  if (moved && event === "release") {
    expect(after.offer.claimedByKernelId).toBeNull();
    expect(after.offer.claimedAt).toBeNull();
  }
}

describe("F5: the production table is the one the expectations describe", () => {
  it("F5: the same statuses", () => {
    expect([...JOB_OFFER_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
  });

  it("F5: the same status-changing events, each allowed from the same statuses", () => {
    expect([...EVENT_ALLOWED_FROM.keys()].sort()).toEqual([...ALLOWED_TO.keys()].sort());
    for (const [event, from] of EVENT_ALLOWED_FROM) {
      expect([...from].sort(), event).toEqual(Object.keys(ALLOWED_TO.get(event)!).sort());
    }
  });

  it("F5: the matrix has every status against every event, and none twice", () => {
    expect(CELLS.length).toBe(ALL_STATUSES.length * (ALLOWED_TO.size + FREE_FORM.length));
    expect(new Set(CELLS.map(([s, e]) => `${s}|${e}`)).size).toBe(CELLS.length);
  });

  it("F5: the windows are 72 h to dispute and 1 h before a released offer may be re-claimed by the same kernel", () => {
    expect(REVIEW_WINDOW_MS).toBe(WINDOW_MS);
    expect(RECLAIM_BLOCK_MS).toBe(60 * 60 * 1000);
  });
});

describe("F5: the status x event matrix, at the store (no routes, no authentication)", () => {
  it.each(CELLS)("%s + %s", async (status, event) => {
    const id = await offerIn(status);
    const before = snapshot(id);
    nowMs += 60_000; // a timestamp a refused or repeated event wrote would differ from every earlier one
    const exp = expectedFor(status, event);
    const r = store().recordEvent(id, event, "tester", null, null);
    if (!exp.allowed) {
      expect(r).toEqual({ ok: false, reason: "invalid_transition", currentStatus: status });
      expect(snapshot(id)).toEqual(before);
      return;
    }
    expect(r).toMatchObject({ ok: true, status: exp.to });
    expectAllowed(before, snapshot(id), status, event, exp.to, iso(nowMs));
  });
});

describe("F5: the same matrix through POST /api/job-offers/:id/events, by an actor who may post each event", () => {
  it.each(CELLS)("%s + %s", async (status, event) => {
    const id = await offerIn(status);
    const before = snapshot(id);
    nowMs += 60_000;
    const exp = expectedFor(status, event);
    const res = await event_(id, event);
    if (!exp.allowed) {
      expect(refusalCodes(status, event)).toContain(res.statusCode);
      // "settled" is also refused by #395's own server-only answer, with its own body.
      if (res.statusCode === 409 && event !== "settled") {
        expect(res.json()).toEqual({ error: "invalid_transition", event, currentStatus: status });
      }
      expect(snapshot(id)).toEqual(before);
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(exp.to);
    expectAllowed(before, snapshot(id), status, event, exp.to, iso(nowMs));
  });
});

// ═══ Q2 MEDIUM (#455 r2): 'confirmed' is bounded by the review window too ═══

describe("Q2 MEDIUM (#455 r2): the store x event matrix holds at every age, including the window's edges", () => {
  // Every (status, event) cell, read at 60s (well inside any window), at exactly
  // 72h, and at 72h + 1ms — the only ages where a JUDGMENT (confirmed/disputed)
  // from 'delivered' can change answer. expectedFor is the one place the rule
  // lives for this test file; a change to the production rule that this matrix
  // doesn't also reflect fails here, at the store, before it fails anywhere else.
  it.each(TIMED_CELLS)("%s + %s at %s", async (status, event, _label, ageMs) => {
    const id = await offerIn(status);
    const before = snapshot(id);
    nowMs += ageMs;
    const exp = expectedFor(status, event, ageMs);
    const r = store().recordEvent(id, event, "tester", null, null);
    if (!exp.allowed) {
      expect(r).toEqual({ ok: false, reason: exp.reason, currentStatus: status });
      expect(snapshot(id)).toEqual(before);
      return;
    }
    expect(r).toMatchObject({ ok: true, status: exp.to });
    expectAllowed(before, snapshot(id), status, event, exp.to, iso(nowMs));
  });
});

describe("Q2 MEDIUM (#455 r2): 'confirmed' is bounded by the 72 h review window, like disputed", () => {
  const confirm = (id: string) => event_(id, "confirmed");

  it.each([
    ["1 ms after delivery", 1],
    ["1 h after delivery", 60 * 60 * 1000],
    ["71 h 59 m after delivery", WINDOW_MS - 60_000],
    ["exactly 72 h after delivery", WINDOW_MS],
  ] as Array<[string, number]>)("inside the window, %s: allowed, and records when", async (_label, age) => {
    const id = await offerIn("delivered");
    nowMs += age;
    const res = await confirm(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
    expect(store().get(id)!.completedAt).toBe(iso(nowMs));
  });

  it.each([
    ["1 ms past 72 h", WINDOW_MS + 1],
    ["73 h", WINDOW_MS + 60 * 60 * 1000],
    ["30 days", 30 * 24 * 60 * 60 * 1000],
  ] as Array<[string, number]>)("outside the window, %s: refused (409 review_window_closed), and nothing changes", async (_label, age) => {
    const id = await offerIn("delivered");
    nowMs += age;
    const before = snapshot(id);
    const res = await confirm(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "review_window_closed", event: "confirmed", currentStatus: "delivered" });
    expect(snapshot(id)).toEqual(before);
    expect(store().get(id)!.completedAt).toBeNull();
  });

  it("the store itself: allowed at exactly 72 h, refused one millisecond later", async () => {
    const atEdge = await offerIn("delivered");
    nowMs += WINDOW_MS;
    expect(store().recordEvent(atEdge, "confirmed", null, null, null)).toMatchObject({ ok: true, status: "completed" });

    const pastEdge = await offerIn("delivered");
    nowMs += WINDOW_MS + 1;
    expect(store().recordEvent(pastEdge, "confirmed", null, null, null)).toEqual({
      ok: false,
      reason: "review_window_closed",
      currentStatus: "delivered",
    });
  });

  it("the window runs from the delivery, not from posting or from the claim", async () => {
    const id = `offer-${++seq}`;
    await createOffer(id);
    nowMs += 100 * 60 * 60 * 1000; // posted and unclaimed for 100 h (nothing swept it)
    expect((await claimAs(id)).statusCode).toBe(200);
    nowMs += 80 * 60 * 60 * 1000; // claimed for 80 h
    expect((await event_(id, "delivered")).statusCode).toBe(200);
    nowMs += 60 * 60 * 1000; // delivered an hour ago
    expect((await confirm(id)).json().status).toBe("completed");
  });

  it("a delivered offer with no recorded delivery time cannot be confirmed: the window fails closed", async () => {
    const id = await offerIn("delivered");
    (store().get(id) as unknown as { deliveredAt: string | null }).deliveredAt = null;
    const res = await confirm(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("review_window_closed");
    expect(store().get(id)!.status).toBe("delivered");
  });

  it("past the window a confirm is refused for its window; once the sweep lapses the offer, as an invalid transition", async () => {
    const id = await offerIn("delivered");
    nowMs += WINDOW_MS + 1;
    expect((await confirm(id)).json().error).toBe("review_window_closed");
    await store().sweep();
    expect(store().get(id)!.status).toBe("lapsed");
    const after = await confirm(id);
    expect(after.statusCode).toBe(409);
    expect(after.json()).toEqual({ error: "invalid_transition", event: "confirmed", currentStatus: "lapsed" });
  });
});

describe("F5: the courier shim carries the same cells for the events it accepts", () => {
  const SHIM_EVENTS = ["pickup", "delivered", "cancelled", "note"];
  const shimCells = CELLS.filter(([, e]) => SHIM_EVENTS.includes(e));

  it("F5: every cell is there", () => {
    expect(shimCells.length).toBe(ALL_STATUSES.length * SHIM_EVENTS.length);
  });

  it.each(shimCells)("%s + %s", async (status, event) => {
    const id = await offerIn(status);
    const before = snapshot(id);
    nowMs += 60_000;
    const exp = expectedFor(status, event);
    const res = await app.inject({
      method: "POST", url: `/api/courier-jobs/${id}/events`, headers: as(actorFor(event)), payload: { event },
    });
    if (!exp.allowed) {
      expect(refusalCodes(status, event)).toContain(res.statusCode);
      if (res.statusCode === 409) {
        expect(res.json()).toEqual({ error: "invalid_transition", event, currentStatus: COURIER_VIEW.get(status) });
      }
      expect(snapshot(id)).toEqual(before);
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(COURIER_VIEW.get(exp.to));
    expectAllowed(before, snapshot(id), status, event, exp.to, iso(nowMs));
  });

  it.each(["in_progress", "release", "confirmed", "disputed", "settled"])(
    "F5: the shim does not carry %s (400 invalid_event), and nothing changes",
    async (event) => {
      const id = await offerIn("delivered");
      const before = snapshot(id);
      const res = await app.inject({
        method: "POST", url: `/api/courier-jobs/${id}/events`, headers: as(actorFor(event)), payload: { event },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_event");
      expect(snapshot(id)).toEqual(before);
    },
  );
});

describe("F5: DELETE is the 'cancelled' column of the table", () => {
  it.each([...JOB_OFFER_STATUSES])("DELETE on a %s offer is refused exactly where a posted 'cancelled' is", async (status) => {
    const id = await offerIn(status);
    const fromTable = EVENT_ALLOWED_FROM.get("cancelled")!.has(status);
    const fromExpectations = ALLOWED_TO_ROWS.cancelled![status] !== undefined;
    expect(fromTable).toBe(fromExpectations);
    const before = snapshot(id);
    const res = await app.inject({ method: "DELETE", url: `/api/job-offers/${id}`, headers: as(POSTER) });
    expect(res.statusCode).toBe(fromExpectations ? 200 : 409);
    if (!fromExpectations) expect(snapshot(id)).toEqual(before);
  });
});

describe("F5: the 72 h dispute window (kits #3989)", () => {
  const dispute = (id: string) => event_(id, "disputed");

  it.each([
    ["1 ms after delivery", 1],
    ["1 h after delivery", 60 * 60 * 1000],
    ["71 h 59 m after delivery", WINDOW_MS - 60_000],
    ["exactly 72 h after delivery", WINDOW_MS],
  ] as Array<[string, number]>)("inside the window, %s: allowed, and records when", async (_label, age) => {
    const id = await offerIn("delivered");
    nowMs += age;
    const res = await dispute(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("disputed");
    expect(store().get(id)!.disputedAt).toBe(iso(nowMs));
  });

  it.each([
    ["1 ms past 72 h", WINDOW_MS + 1],
    ["73 h", WINDOW_MS + 60 * 60 * 1000],
    ["30 days", 30 * 24 * 60 * 60 * 1000],
  ] as Array<[string, number]>)("outside the window, %s: refused (409 review_window_closed), and nothing changes", async (_label, age) => {
    const id = await offerIn("delivered");
    nowMs += age;
    const before = snapshot(id);
    const res = await dispute(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "review_window_closed", event: "disputed", currentStatus: "delivered" });
    expect(snapshot(id)).toEqual(before);
    expect(store().get(id)!.disputedAt).toBeNull();
  });

  it("the store says review_window_closed, with the status it is in", async () => {
    const id = await offerIn("delivered");
    nowMs += WINDOW_MS + 1;
    expect(store().recordEvent(id, "disputed", null, null, null)).toEqual({
      ok: false,
      reason: "review_window_closed",
      currentStatus: "delivered",
    });
  });

  it("the window runs from the delivery, not from posting or from the claim", async () => {
    const id = `offer-${++seq}`;
    await createOffer(id);
    nowMs += 100 * 60 * 60 * 1000; // posted and unclaimed for 100 h (nothing swept it)
    expect((await claimAs(id)).statusCode).toBe(200);
    nowMs += 80 * 60 * 60 * 1000; // claimed for 80 h
    expect((await event_(id, "delivered")).statusCode).toBe(200);
    nowMs += 60 * 60 * 1000; // delivered an hour ago
    expect((await dispute(id)).json().status).toBe("disputed");
  });

  it("a delivered offer with no recorded delivery time cannot be disputed: the window fails closed", async () => {
    const id = await offerIn("delivered");
    (store().get(id) as unknown as { deliveredAt: string | null }).deliveredAt = null;
    const res = await dispute(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("review_window_closed");
    expect(store().get(id)!.status).toBe("delivered");
  });

  it("a repeated dispute on a disputed offer is allowed after the window, and keeps the first time", async () => {
    const id = await offerIn("disputed");
    const first = store().get(id)!.disputedAt;
    nowMs += 2 * WINDOW_MS;
    const res = await dispute(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("disputed");
    expect(store().get(id)!.disputedAt).toBe(first);
  });

  it("past the window a dispute is refused for its window; once the sweep lapses the offer, as an invalid transition", async () => {
    const id = await offerIn("delivered");
    nowMs += WINDOW_MS + 1;
    expect((await dispute(id)).json().error).toBe("review_window_closed");
    await store().sweep();
    expect(store().get(id)!.status).toBe("lapsed");
    const after = await dispute(id);
    expect(after.statusCode).toBe(409);
    expect(after.json()).toEqual({ error: "invalid_transition", event: "disputed", currentStatus: "lapsed" });
  });

  it("the sweep lapses at the same moment a dispute stops being allowed: not at 72 h, one millisecond after", async () => {
    const id = await offerIn("delivered");
    nowMs += WINDOW_MS;
    expect((await store().sweep()).lapsed).toBe(0);
    expect(store().get(id)!.status).toBe("delivered");
    nowMs += 1;
    expect((await store().sweep()).lapsed).toBe(1);
    expect(store().get(id)!.status).toBe("lapsed");
    expect(store().get(id)!.lapsedAt).toBe(iso(nowMs));
  });
});

describe("F5: a repeat keeps the first time, and a release clears the whole claim", () => {
  it.each([
    ["delivered", "delivered", "deliveredAt"],
    ["cancelled", "cancelled", "cancelledAt"],
    ["completed", "confirmed", "completedAt"],
    ["disputed", "disputed", "disputedAt"],
  ] as Array<[JobOfferStatus, string, string]>)(
    "an offer already %s: a repeated %s event keeps %s, and is logged",
    async (status, event, field) => {
      const id = await offerIn(status);
      const first = (store().get(id) as unknown as Record<string, unknown>)[field];
      expect(first).toBeTruthy();
      const logged = store().getEvents(id).length;
      nowMs += 60_000;
      const res = await event_(id, event);
      expect(res.statusCode).toBe(200);
      expect((store().get(id) as unknown as Record<string, unknown>)[field]).toBe(first);
      expect(store().getEvents(id).length).toBe(logged + 1);
    },
  );

  it("a repeated cancel keeps the first cancellation time, whether posted as an event or sent as DELETE", async () => {
    const id = await offerIn("open");
    expect((await event_(id, "cancelled")).statusCode).toBe(200);
    const first = store().get(id)!.cancelledAt;
    expect(first).toBe(iso(nowMs));
    nowMs += 60_000;
    expect((await event_(id, "cancelled")).statusCode).toBe(200);
    expect(store().get(id)!.cancelledAt).toBe(first);
    nowMs += 60_000;
    expect((await app.inject({ method: "DELETE", url: `/api/job-offers/${id}`, headers: as(POSTER) })).statusCode).toBe(200);
    expect(store().get(id)!.cancelledAt).toBe(first);
    expect(store().get(id)!.status).toBe("cancelled");
  });

  it("a release clears the claim signature, the ETA and the contact as well as the claimant", async () => {
    const id = `offer-${++seq}`;
    await createOffer(id);
    const claimed = await app.inject({
      method: "POST", url: `/api/job-offers/${id}/claim`, headers: as(CLAIMANT),
      payload: { kernelId: "k-1", claimSignature: "sig-1", etaMin: 12, contact: "driver@example.test" },
    });
    expect(claimed.statusCode).toBe(200);
    expect(store().get(id)).toMatchObject({ claimSignature: "sig-1", driverEtaMin: 12, driverContact: "driver@example.test" });
    expect((await event_(id, "release")).statusCode).toBe(200);
    expect(store().get(id)).toMatchObject({
      status: "open",
      claimedByKernelId: null,
      claimedAt: null,
      claimSignature: null,
      driverEtaMin: null,
      driverContact: null,
    });
  });
});

// ═══ Q3 MEDIUM (#455 r2): the re-claim guard survives a restart ════════════

describe("Q3 MEDIUM (#455 r2): the 1 h re-claim guard is rebuilt from the persisted event log", () => {
  let raw: SqliteDatabaseLike;

  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    const client = (getStore().db as unknown as { $client?: SqliteDatabaseLike }).$client;
    if (!client) throw new Error("test rig: no raw SQLite handle on the store");
    raw = client;
  });
  afterAll(() => closeStore());

  /** A fresh JobOffersStore over the SAME sqlite handle: the application-level
   * effect of a restart (new process, same database) without tearing down the
   * in-memory :memory: connection the test itself depends on. */
  async function restart(): Promise<void> {
    _resetJobOffersStoreForTests();
    initJobOffersStore({ sqlite: raw, verify: async () => ({ ok: true, body: { ok: true } }), now: () => new Date(nowMs) });
    app = await buildApp();
  }

  it("inside the hour, after a restart: the releasing kernel is still blocked, another kernel is not", async () => {
    await restart();
    const id = await offerIn("claimed"); // claimed by k-1 (CLAIMANT)
    await event_(id, "release");
    nowMs += 30 * 60 * 1000; // 30 min later — inside RECLAIM_BLOCK_MS
    await restart(); // a NEW store, the SAME database, "before 1h"
    const again = await claimAs(id, "k-1", CLAIMANT);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("recently_released");
    expect(again.json().retryAfterMs).toBeGreaterThan(0);
    expect((await claimAs(id, "k-2", OTHER_CLAIMANT)).statusCode).toBe(200);
  });

  it("after the hour, a restart does not resurrect an expired guard: the releasing kernel may claim again", async () => {
    await restart();
    const id = await offerIn("claimed");
    await event_(id, "release");
    nowMs += RECLAIM_BLOCK_MS; // exactly the hour — the existing (non-restart) test uses this same boundary
    await restart(); // a NEW store, the SAME database, "after 1h"
    expect((await claimAs(id)).statusCode).toBe(200);
  });

  it("an offer re-claimed and released again carries only the LATEST release forward", async () => {
    await restart();
    const id = await offerIn("claimed"); // k-1
    expect((await event_(id, "release")).statusCode).toBe(200); // guard (in-memory, pre-restart): k-1
    expect((await claimAs(id, "k-2", OTHER_CLAIMANT)).statusCode).toBe(200);
    // The CURRENT claimant (k-2's operator) posts this release. Where claimant
    // checks apply (#395), k-1's operator may not release k-2's claim.
    expect((await event_(id, "release", OTHER_CLAIMANT)).statusCode).toBe(200); // guard overwritten: k-2 is now the latest releaser
    nowMs += 30 * 60 * 1000; // inside the hour for k-2's release
    await restart(); // rebuilds the guard from the event log alone
    // Checked k-2 FIRST, while the offer is still open: a rebuild that wrongly
    // kept k-1's stale, superseded release (instead of k-2's, the latest one)
    // would let this claim through. It must not.
    const k2Claim = await claimAs(id, "k-2", OTHER_CLAIMANT);
    expect(k2Claim.statusCode).toBe(409);
    expect(k2Claim.json().error).toBe("recently_released");
    // k-1's much earlier release must NOT carry forward forever: its claim succeeds.
    expect((await claimAs(id, "k-1", CLAIMANT)).statusCode).toBe(200);
  });
});

// ═══ Q3 MEDIUM (#455 r2): an unknown courier status fails closed ═══════════

describe("Q3 MEDIUM (#455 r2): an unknown courier status projects as expired, never open", () => {
  it("a hydrated offer with an unrecognized status (e.g. 'archived'): detail, claim refusal and the open feed all agree it is unavailable", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/courier-jobs", headers: as(POSTER),
      payload: { deliveryId: "cj-archived", pickup: { name: "A" }, dropoff: { name: "B" } },
    });
    expect(created.statusCode).toBe(201);
    (store() as unknown as { offers: Map<string, { status: string }> }).offers.get("cj-archived")!.status = "archived";

    const detail = await app.inject({ method: "GET", url: "/api/courier-jobs/cj-archived" });
    expect(detail.json().job.status).toBe("expired");

    const claim = await app.inject({
      method: "POST", url: "/api/courier-jobs/cj-archived/claim", headers: as(CLAIMANT), payload: { driverAgent: "d1" },
    });
    expect(claim.statusCode).toBe(409);
    expect(claim.json()).toMatchObject({ error: "not_open", currentStatus: "expired" });

    const feed = await app.inject({ method: "GET", url: "/api/courier-jobs/open" });
    expect((feed.json().jobs as Array<{ id: string }>).map((j) => j.id)).not.toContain("cj-archived");

    // The generic surface's own feed already excludes it on the real (unmapped) status alone.
    const genericFeed = await app.inject({ method: "GET", url: "/api/job-offers/open?capabilityType=courier.dispatch" });
    expect((genericFeed.json().offers as Array<{ id: string }>).map((o) => o.id)).not.toContain("cj-archived");
  });
});

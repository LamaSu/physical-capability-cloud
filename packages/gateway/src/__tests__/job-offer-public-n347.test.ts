/** N347: public projections preserve stored identities and withhold them at every served surface. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getStore } from "../db.js";
import { __resetRateLimitState } from "../middleware/rate-limiter.js";
import { getCourierJobsStore, type CourierJob } from "../services/courier-jobs-store.js";
import {
  _resetJobOffersStoreForTests, getJobOffersStore, initJobOffersStore,
  type JobOffer, type JobOfferEvent, type SqliteDatabaseLike,
} from "../services/job-offers-store.js";
import { publicCourierJob, publicEvent, publicEvents, publicOffer } from "../services/job-offer-public.js";

const W = "0x" + "ab".repeat(20);
type Headers = Record<string, string>;
type Family = "job-offers" | "courier-jobs";
type Served = Record<string, unknown>;
type Detail = { offer?: Served; job?: Served; events: JobOfferEvent[] };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("N347 served job offers, courier jobs and events", () => {
  let app: FastifyInstance;
  let raw: SqliteDatabaseLike;
  let posterKey: ReturnType<typeof provisionApiKey>;
  let claimerKey: ReturnType<typeof provisionApiKey>;
  let sessionKeyW: ReturnType<typeof provisionApiKey>;
  const previousDbPath = process.env.PCC_DB_PATH;
  const bearer = (key: ReturnType<typeof provisionApiKey>): Headers => ({ authorization: `Bearer ${key.rawKey}` });
  const path = (id: string, family: Family = "job-offers") => `/api/${family}/${id}`;
  const create = async (family: Family = "job-offers", headers: Headers = bearer(posterKey)) => {
    const id = `n347-${randomUUID()}`;
    const payload = family === "job-offers"
      ? { id, capabilityType: "pizza.order", requirements: { shopId: "shop-1", items: ["margherita"] }, pricing: { amount: 18.5, currency: "USD", model: "fixed" } }
      : { deliveryId: id, pickup: { name: "PCC Shop", address: "1 Shop Way, SF" }, dropoff: { name: "USPS Rincon Center", address: "180 Steuart St, SF" } };
    const result = await app.inject({ method: "POST", url: `/api/${family}`, headers, payload });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json<{ id: string }>().id).toBe(id);
    return id;
  };
  const claim = (id: string, family: Family = "job-offers") => app.inject({
    method: "POST", url: `${path(id, family)}/claim`, headers: bearer(claimerKey),
    payload: family === "job-offers"
      ? { kernelId: "k-1", contact: "driver-7@example.com" }
      : { driverAgent: "d-1", contact: "driver-7@example.com" },
  });
  const edit = (id: string, family: Family = "job-offers") => app.inject({
    method: "PATCH", url: path(id, family), headers: bearer(posterKey),
    payload: family === "job-offers" ? { pricing: { amount: 20, currency: "USD", model: "fixed" } } : { feeUSD: 20 },
  });
  const event = (id: string, kind: string, key: ReturnType<typeof provisionApiKey>, family: Family = "job-offers") => app.inject({
    method: "POST", url: `${path(id, family)}/events`, headers: bearer(key), payload: { event: kind },
  });
  const read = async (url: string) => {
    const result = await app.inject({ method: "GET", url });
    expect(result.statusCode, result.body).toBe(200);
    return result;
  };
  const withoutOfferIdentity = (stored: JobOffer) => {
    const expected: Served = { ...stored };
    delete expected.posterDid;
    delete expected.driverContact;
    delete expected.idempotencyKey;
    if (stored.capabilityType === "courier.dispatch") {
      expected.requirements = { ...stored.requirements, pickup: {}, dropoff: {} };
    }
    return json(expected);
  };
  const withoutCourierIdentity = (stored: CourierJob, view: "public" | "party") => {
    const expected: Served = { ...stored };
    delete expected.postedBy;
    delete expected.driverContact;
    if (view === "public") {
      delete expected.raw;
      expected.pickup = {};
      expected.dropoff = {};
    }
    return json(expected);
  };
  const checkOffer = (served: Served | undefined, id: string) => {
    expect(served).toBeDefined();
    expect(served).not.toHaveProperty("posterDid");
    expect(served).not.toHaveProperty("driverContact");
    expect(served).not.toHaveProperty("idempotencyKey");
    expect(served).toEqual(withoutOfferIdentity(getJobOffersStore().get(id)!));
  };
  const checkCourier = (served: Served | undefined, id: string, view: "public" | "party" = "public") => {
    expect(served).toBeDefined();
    expect(served).not.toHaveProperty("postedBy");
    expect(served).not.toHaveProperty("driverContact");
    expect(served).not.toHaveProperty("posterDid");
    expect(served).toEqual(withoutCourierIdentity(getCourierJobsStore().get(id)!, view));
  };
  const noContactIdentity = (body: string) => {
    expect(body).not.toContain("poster@example.com");
    expect(body).not.toContain("driver-7@example.com");
    expect(body).not.toContain("driver-9@example.com");
  };
  const row = (id: string) => {
    const found = raw.prepare("SELECT data FROM job_offers WHERE id = ?").get(id) as { data: string } | undefined;
    expect(found).toBeDefined();
    return JSON.parse(found!.data) as Record<string, unknown>;
  };
  const rewrite = (id: string, modify: (data: Record<string, unknown>) => void) => {
    const data = row(id);
    modify(data);
    raw.prepare("UPDATE job_offers SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
  };
  const reload = () => {
    _resetJobOffersStoreForTests();
    initJobOffersStore({ sqlite: raw });
  };
  const plantLegacy = (id: string) => {
    const at = Date.now();
    const rows: JobOfferEvent[] = [
      { at: new Date(at).toISOString(), event: "patched", by: "poster@example.com", before: {}, after: {} },
      { at: new Date(at + 1).toISOString(), event: "heartbeat", by: W },
      { at: new Date(at + 2).toISOString(), event: "note", by: "kernel-driver-7", note: "legacy" },
      { at: new Date(at + 3).toISOString(), event: "note", by: 42 },
      { at: new Date(at + 4).toISOString(), event: "note", by: "poster" },
      { at: new Date(at + 5).toISOString(), event: "note", by: "claimer" },
      { at: new Date(at + 6).toISOString(), event: "note" },
      { at: new Date(at + 7).toISOString(), event: "note", by: "constructor" },
      { at: new Date(at + 8).toISOString(), event: "note", by: "__proto__" },
    ];
    for (const data of rows) {
      raw.prepare("INSERT INTO job_offer_events (offer_id, at, data) VALUES (?, ?, ?)").run(id, data.at, JSON.stringify(data));
    }
    reload();
    return rows;
  };

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    await app.ready();
    const sqlite = (getStore().db as unknown as { $client?: SqliteDatabaseLike }).$client;
    expect(sqlite).toBeDefined();
    raw = sqlite!;
    posterKey = provisionApiKey({ operatorId: "poster@example.com", scopes: ["*"] });
    claimerKey = provisionApiKey({ operatorId: "claimer@example.com", scopes: ["*"] });
    sessionKeyW = provisionApiKey({ operatorId: W, scopes: ["*"], metadata: { source: "siwe-session" } });
  }, 120_000);

  beforeEach(() => { __resetRateLimitState(); });

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (previousDbPath === undefined) delete process.env.PCC_DB_PATH;
      else process.env.PCC_DB_PATH = previousDbPath;
    }
  });

  it("N347 U1: publicOffer removes exactly the private keys without changing its input", () => {
    const id = `n347-${randomUUID()}`;
    const input: JobOffer = {
      id, status: "claimed", posterDid: "poster@example.com", driverContact: "driver-7@example.com",
      claimedByKernelId: "k-1", pricing: { amount: 18.5, currency: "USD", model: "fixed" },
      requirements: { items: ["margherita"] }, posterKernelId: "poster-kernel", idempotencyKey: "unit-replay",
      capabilityType: "pizza.order", requirementsValidated: false, serviceAreaGeofence: null,
      deadlineIso: null, assuranceTier: 0, evidenceRequirements: { events_required: ["delivered"] },
      sourceVerifyUrl: null, requireHeartbeat: false, postedAt: "2026-11-16T00:00:00.000Z",
      validUntil: "2026-11-17T00:00:00.000Z", claimedAt: null, claimSignature: null,
      verified: false, lastVerifyAt: null, lastHeartbeatAt: null, deliveredAt: null, cancelledAt: null, expiredAt: null,
    };
    const before = structuredClone(input);
    const result = publicOffer(input);
    expect(result).toEqual({
      id, status: "claimed", claimedByKernelId: "k-1",
      pricing: { amount: 18.5, currency: "USD", model: "fixed" },
      requirements: { items: ["margherita"] }, posterKernelId: "poster-kernel",
      capabilityType: "pizza.order", requirementsValidated: false, serviceAreaGeofence: null,
      deadlineIso: null, assuranceTier: 0, evidenceRequirements: { events_required: ["delivered"] },
      sourceVerifyUrl: null, requireHeartbeat: false, postedAt: "2026-11-16T00:00:00.000Z",
      validUntil: "2026-11-17T00:00:00.000Z", claimedAt: null, claimSignature: null,
      verified: false, lastVerifyAt: null, lastHeartbeatAt: null, deliveredAt: null, cancelledAt: null, expiredAt: null,
    });
    expect(result).not.toHaveProperty("idempotencyKey");
    expect(result).not.toBe(input);
    expect(input).toEqual(before);
  });

  it("N347 U2: publicCourierJob removes exactly the private keys without changing its input", () => {
    const id = `n347-${randomUUID()}`;
    const input = {
      id, status: "claimed", postedBy: "poster@example.com", driverContact: "driver-7@example.com",
      claimedBy: "d-1", feeUSD: 18.5, pickup: { address: "1 Shop Way, SF" }, dropoff: { address: "180 Steuart St, SF" },
    } as CourierJob;
    const before = structuredClone(input);
    const result = publicCourierJob(input);
    expect(result).toEqual({
      id, status: "claimed", claimedBy: "d-1", feeUSD: 18.5,
      pickup: { address: "1 Shop Way, SF" }, dropoff: { address: "180 Steuart St, SF" },
    });
    expect(result).not.toBe(input);
    expect(input).toEqual(before);
  });

  it("N347 U3: event projections always serve a role or null and preserve all other keys and order", () => {
    const cases: Array<{ by?: unknown; served: "poster" | "claimer" | null }> = [
      { by: "poster", served: "poster" }, { by: "claimer", served: "claimer" },
      { by: "poster@example.com", served: null }, { by: W, served: null },
      { by: "kernel-driver-7", served: null }, { by: "Poster", served: null },
      { by: "constructor", served: null }, { by: "__proto__", served: null },
      { by: "toString", served: null }, { by: "hasOwnProperty", served: null },
      { by: "", served: null }, { by: 42, served: null }, { by: null, served: null }, { served: null },
    ];
    const inputs: JobOfferEvent[] = cases.map((value, index) => ({
      at: `unit-at-${index}`, event: "note", note: "kept", payload: { index, nested: ["kept"] },
      before: { amount: index }, after: { amount: index + 1 },
      ...("by" in value ? { by: value.by } : {}),
    }));
    const before = structuredClone(inputs);
    const expected = inputs.map((input, index) => ({ ...input, by: cases[index]!.served }));
    for (const [index, input] of inputs.entries()) {
      const result = publicEvent(input);
      expect(result).toHaveProperty("by", cases[index]!.served);
      expect(Object.hasOwn(result, "by")).toBe(true);
      expect(result).toEqual(expected[index]);
      expect(result).not.toBe(input);
      expect(input).toEqual(before[index]);
    }
    const results = publicEvents(inputs);
    expect(results).not.toBe(inputs);
    expect(results).toEqual(expected);
    for (const [index, result] of results.entries()) {
      expect(Object.hasOwn(result, "by")).toBe(true);
      expect(result).not.toBe(inputs[index]);
    }
    expect(inputs).toEqual(before);
    expect(Object.hasOwn(inputs.at(-1)!, "by")).toBe(false);
  });

  it("N347 J1: job-offer details and open feed withhold stored identities before and after reload", async () => {
    const a = await create();
    const b = await create();
    const claimed = await claim(a);
    expect(claimed.statusCode, claimed.body).toBe(200);
    rewrite(b, (data) => { data.driverContact = "driver-9@example.com"; });
    reload();
    expect(getJobOffersStore().get(a)?.posterDid).toBe("poster@example.com");
    expect(getJobOffersStore().get(b)?.posterDid).toBe("poster@example.com");
    expect(getJobOffersStore().get(a)?.driverContact).toBe("driver-7@example.com");
    expect(getJobOffersStore().get(b)?.driverContact).toBe("driver-9@example.com");
    for (const again of [false, true]) {
      if (again) reload();
      for (const id of [a, b]) {
        const result = await read(path(id));
        checkOffer(result.json<Detail>().offer, id);
        noContactIdentity(result.body);
      }
      const result = await read("/api/job-offers/open?capabilityType=pizza.order&limit=1000");
      const offers = result.json<{ offers: Served[] }>().offers;
      checkOffer(offers.find((offer) => offer.id === b), b);
      noContactIdentity(result.body);
    }
  });

  it("N347 J2: fresh and reloaded job-offer claim and PATCH replies project every stored field", async () => {
    const exercise = async (held: string, editable: string) => {
      const claimed = await claim(held);
      expect(claimed.statusCode, claimed.body).toBe(200);
      checkOffer(claimed.json<{ offer: Served }>().offer, held);
      noContactIdentity(claimed.body);
      const patched = await edit(editable);
      expect(patched.statusCode, patched.body).toBe(200);
      checkOffer(patched.json<{ offer: Served }>().offer, editable);
      noContactIdentity(patched.body);
    };
    await exercise(await create(), await create());
    const held = await create();
    const editable = await create();
    rewrite(editable, (data) => { data.driverContact = "driver-9@example.com"; });
    reload();
    await exercise(held, editable);
  });

  it("N347 J3: new event replies and detail logs serve participant roles and explicit nulls across reload", async () => {
    const id = await create();
    const claimed = await claim(id);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const progress = await event(id, "in_progress", claimerKey);
    expect(progress.statusCode, progress.body).toBe(200);
    expect(progress.json()).toHaveProperty("event.by", "claimer");
    const note = await event(id, "note", posterKey);
    expect(note.statusCode, note.body).toBe(200);
    expect(note.json()).toHaveProperty("event.by", "poster");
    for (const again of [false, true]) {
      if (again) reload();
      const result = await read(path(id));
      const events = result.json<Detail>().events;
      expect(events.map((entry) => entry.event)).toEqual(["posted", "claimed", "in_progress", "note"]);
      expect(events.map((entry) => entry.by)).toEqual([null, null, "claimer", "poster"]);
      for (const entry of events) expect(Object.hasOwn(entry, "by")).toBe(true);
      noContactIdentity(result.body);
    }
  });

  it("N347 L1: all three detail reads normalize legacy event by values while preserving each other key", async () => {
    const id = await create("courier-jobs");
    const rows = plantLegacy(id);
    const servedBy = [null, null, null, null, "poster", "claimer", null, null, null];
    for (const url of [path(id), path(id, "courier-jobs"), `/api/courier-jobs/jobs/${id}`]) {
      const result = await read(url);
      const events = result.json<Detail>().events;
      expect(events).toHaveLength(10);
      expect(events[0]).toMatchObject({ event: "posted", by: null });
      expect(events.slice(1)).toEqual(rows.map((entry, index) => ({ ...entry, by: servedBy[index] })));
      for (const entry of events) expect(Object.hasOwn(entry, "by")).toBe(true);
      expect(result.body).not.toContain("poster@example.com");
      expect(result.body).not.toContain(W);
      expect(result.body).not.toContain("kernel-driver-7");
    }
  });

  it("N347 C1: courier details, aliases and all open feeds withhold identities before and after reload", async () => {
    const h = await create("courier-jobs");
    const i = await create("courier-jobs");
    const claimed = await claim(h, "courier-jobs");
    expect(claimed.statusCode, claimed.body).toBe(200);
    rewrite(i, (data) => { data.driverContact = "driver-9@example.com"; });
    reload();
    expect(getJobOffersStore().get(h)?.driverContact).toBe("driver-7@example.com");
    expect(getJobOffersStore().get(i)?.driverContact).toBe("driver-9@example.com");
    for (const again of [false, true]) {
      if (again) reload();
      for (const id of [h, i]) {
        for (const url of [path(id, "courier-jobs"), `/api/courier-jobs/jobs/${id}`]) {
          const result = await read(url);
          checkCourier(result.json<Detail>().job, id);
          noContactIdentity(result.body);
        }
      }
      for (const url of ["/api/courier-jobs/open", "/api/courier-jobs/jobs/open"]) {
        const result = await read(url);
        checkCourier(result.json<{ jobs: Served[] }>().jobs.find((job) => job.id === i), i);
        noContactIdentity(result.body);
      }
      const open = await read("/api/job-offers/open?capabilityType=courier.dispatch&limit=1000");
      checkOffer(open.json<{ offers: Served[] }>().offers.find((offer) => offer.id === i), i);
      noContactIdentity(open.body);
      const detail = await read(path(h));
      checkOffer(detail.json<Detail>().offer, h);
      noContactIdentity(detail.body);
    }
  });

  it("N347 C2: fresh and reloaded courier claim, PATCH and event replies use public projections", async () => {
    const exercise = async (held: string, editable: string) => {
      const claimed = await claim(held, "courier-jobs");
      expect(claimed.statusCode, claimed.body).toBe(200);
      checkCourier(claimed.json<{ job: Served }>().job, held, "party");
      noContactIdentity(claimed.body);
      const patched = await edit(editable, "courier-jobs");
      expect(patched.statusCode, patched.body).toBe(200);
      checkCourier(patched.json<{ job: Served }>().job, editable, "party");
      noContactIdentity(patched.body);
      const pickup = await event(held, "pickup", claimerKey, "courier-jobs");
      expect(pickup.statusCode, pickup.body).toBe(200);
      expect(pickup.json()).toHaveProperty("event.by", "claimer");
      noContactIdentity(pickup.body);
      for (const url of [path(held, "courier-jobs"), `/api/courier-jobs/jobs/${held}`]) {
        const result = await read(url);
        expect(result.json()).toHaveProperty("job.status", "in_transit");
        checkCourier(result.json<Detail>().job, held);
        noContactIdentity(result.body);
      }
      const delivered = await event(held, "delivered", claimerKey, "courier-jobs");
      expect(delivered.statusCode, delivered.body).toBe(200);
      expect(delivered.json()).toHaveProperty("event.by", "claimer");
      noContactIdentity(delivered.body);
      for (const url of [path(held, "courier-jobs"), `/api/courier-jobs/jobs/${held}`]) {
        const result = await read(url);
        expect(result.json()).toHaveProperty("job.status", "delivered");
        checkCourier(result.json<Detail>().job, held);
        noContactIdentity(result.body);
      }
    };
    await exercise(await create("courier-jobs"), await create("courier-jobs"));
    const held = await create("courier-jobs");
    const editable = await create("courier-jobs");
    rewrite(editable, (data) => { data.driverContact = "driver-9@example.com"; });
    reload();
    await exercise(held, editable);
  });

  it("N347 W1: wallet poster identities remain stored and never appear in detail or open reads", async () => {
    const offer = await create("job-offers", bearer(sessionKeyW));
    const courier = await create("courier-jobs", bearer(sessionKeyW));
    expect(getJobOffersStore().get(offer)?.posterDid).toBe(W);
    expect(getJobOffersStore().get(courier)?.posterDid).toBe(W);
    const offerDetail = await read(path(offer));
    const offerOpen = await read("/api/job-offers/open?capabilityType=pizza.order&limit=1000");
    const courierDetail = await read(path(courier, "courier-jobs"));
    const courierOpen = await read("/api/courier-jobs/open");
    const served = [
      offerDetail.json<Detail>().offer!,
      offerOpen.json<{ offers: Served[] }>().offers.find((entry) => entry.id === offer)!,
      courierDetail.json<Detail>().job!,
      courierOpen.json<{ jobs: Served[] }>().jobs.find((entry) => entry.id === courier)!,
    ];
    for (const entry of served) {
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty("posterDid");
      expect(entry).not.toHaveProperty("postedBy");
    }
    for (const result of [offerDetail, offerOpen, courierDetail, courierOpen]) {
      expect(result.body.toLowerCase()).not.toContain("ab".repeat(20));
    }
  });

  it("N347 S1: serving details, feeds and write replies never changes stored identities or raw events", async () => {
    const p = await create("courier-jobs");
    const claimed = await claim(p, "courier-jobs");
    expect(claimed.statusCode, claimed.body).toBe(200);
    const legacy = plantLegacy(p);
    const q = await create("courier-jobs");
    rewrite(q, (data) => { data.driverContact = "driver-9@example.com"; });
    reload();
    const before = [p, q].map((id) => ({
      id, offer: structuredClone(getJobOffersStore().get(id)!), events: structuredClone(getJobOffersStore().getEvents(id)),
    }));
    expect(before[0]!.offer).toMatchObject({ posterDid: "poster@example.com", driverContact: "driver-7@example.com" });
    expect(before[1]!.offer).toMatchObject({ posterDid: "poster@example.com", driverContact: "driver-9@example.com" });
    expect(before[0]!.events.slice(2)).toEqual(legacy);
    for (const id of [p, q]) {
      for (const url of [path(id), path(id, "courier-jobs"), `/api/courier-jobs/jobs/${id}`]) await read(url);
    }
    for (const url of ["/api/courier-jobs/open", "/api/courier-jobs/jobs/open", "/api/job-offers/open?capabilityType=courier.dispatch&limit=1000"]) {
      const result = await read(url);
      const feed = result.json<{ jobs?: Served[]; offers?: Served[] }>();
      expect((feed.jobs ?? feed.offers)!.some((entry) => entry.id === q)).toBe(true);
    }
    for (const snapshot of before) {
      expect(getJobOffersStore().get(snapshot.id)).toEqual(snapshot.offer);
      expect(getJobOffersStore().getEvents(snapshot.id)).toEqual(snapshot.events);
    }
    const patched = await edit(q, "courier-jobs");
    expect(patched.statusCode, patched.body).toBe(200);
    expect(getJobOffersStore().get(q)).toMatchObject({ posterDid: "poster@example.com", driverContact: "driver-9@example.com" });
    const fresh = await create("courier-jobs");
    const freshClaim = await claim(fresh, "courier-jobs");
    expect(freshClaim.statusCode, freshClaim.body).toBe(200);
    expect(getJobOffersStore().get(fresh)?.driverContact).toBe("driver-7@example.com");
  });
});

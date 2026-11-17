/** N367: public and party views through the real gateway, including authentication. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos, getStore } from "../db.js";
import { isOfferDetailRead } from "../middleware/api-gate.js";
import { __resetRateLimitState } from "../middleware/rate-limiter.js";
import type { CourierJob } from "../services/courier-jobs-store.js";
import { getJobOffersStore, type JobOffer, type JobOfferEvent, type SqliteDatabaseLike } from "../services/job-offers-store.js";
import {
  publicCourierJob, publicEvent, publicEvents, publicOffer,
  publicViewCourierJob, publicViewEvent, publicViewEvents, publicViewOffer, publicViewValue,
} from "../services/job-offer-public.js";

const W = "0x" + "ab".repeat(20);
const V = "0x" + "cd".repeat(20);
const REQ = { shopId: "shop-n367", items: ["margherita"],
  customer: { name: "N367 Customer", phone: "+1-555-0100" },
  deliveryAddress: "1 Test Way, SF",
  raw: { vendor: "n367" },
  pickup: { name: "N367 Shop", address: "2 Shop Way, SF", lat: 37.774929, lng: -122.419416 },
  dropoff: { name: "N367 Customer", line1: "1 Test Way", lat: 37.793743, lng: -122.392914 } };
const PUBLIC_REQ = { shopId: "shop-n367", items: ["margherita"], pickup: { lat: 37.77, lng: -122.42 }, dropoff: { lat: 37.79, lng: -122.39 } };
const PICKUP = { name: "N367 Shop", address: "2 Shop Way, SF", lat: 37.774929, lng: -122.419416 };
const DROPOFF = { name: "N367 Customer", address: "1 Test Way, SF", lat: 37.793743, lng: -122.392914 };
type Headers = Record<string, string>;
type Family = "job-offers" | "courier-jobs";
type Served = Record<string, unknown>;
type Detail = { offer?: Served; job?: Served; events: JobOfferEvent[] };
type Key = ReturnType<typeof provisionApiKey>;
type CallerCase = { name: string; fixture: "A" | "B" | "C"; headers: Headers; view: "party" | "public" | "401" };
const chain = (depth: number, leaf: Served = {}, key = "a"): Served => {
  let result = leaf;
  for (let i = 0; i < depth; i++) result = { [key]: result };
  return result;
};
const arrayChain = (depth: number): unknown[] => {
  let result: unknown[] = [];
  for (let i = 0; i < depth; i++) result = [result];
  return result;
};
const noIdentity = (served: Served) => {
  for (const key of ["idempotencyKey", "posterDid", "postedBy", "driverContact"]) expect(key in served, key).toBe(false);
};
const without = (value: Served, keys: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

describe("N367 offer views and real gateway readers", () => {
  let app: FastifyInstance;
  let raw: SqliteDatabaseLike;
  let posterKey: Key;
  let claimerKey: Key;
  let strangerKey: Key;
  let sessionKeyW1: Key;
  let adminKey: Key;
  let adminStarKey: Key;
  let basicKey: Key;
  let claimEqualKey: Key;
  let claimEqualIdKey: Key;
  let walletClaimKey: Key;
  let cookieW: Headers;
  let cookieV: Headers;
  let bearerW: Headers;
  let unproven: Headers;
  let unknownCookie: Headers;
  let tamperedCookie: Headers;
  let expiredCookie: Headers;
  let ADMIN: string;
  const badKey = { authorization: "Bearer pcc_not_a_key" };
  const badBearer = { authorization: "Bearer n367-not-a-session" };
  const previousDbPath = process.env.PCC_DB_PATH;
  const bearer = (key: Key): Headers => ({ authorization: `Bearer ${key.rawKey}` });
  const path = (id: string, family: Family = "job-offers", alias = false) => `/api/${family}/${alias ? "jobs/" : ""}${id}`;
  const entity = (detail: Detail): Served => (detail.offer ?? detail.job)!;
  const read = async (id: string, headers: Headers = {}, family: Family = "job-offers", alias = false) => {
    const result = await app.inject({ method: "GET", url: path(id, family, alias), headers });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    const detail = result.json<Detail>();
    noIdentity(entity(detail));
    return detail;
  };
  const create = async (headers: Headers = bearer(posterKey), family: Family = "job-offers", overrides: Served = {}) => {
    const id = `n367-${randomUUID()}`;
    const payload = family === "job-offers"
      ? { id, capabilityType: "n367.delivery", requirements: REQ, pricing: { amount: 21.71, currency: "USD", model: "fixed" }, idempotencyKey: `n367-key-${randomUUID()}`, ...overrides }
      : { deliveryId: id, pickup: PICKUP, dropoff: DROPOFF, feeUSD: 7, raw: { vendor: "n367" }, ...overrides };
    const result = await app.inject({ method: "POST", url: `/api/${family}`, headers, payload });
    expect(result.statusCode, result.body).toBe(201);
    expect(result.json<{ id: string }>().id).toBe(id);
    noIdentity(result.json<Served>());
    return id;
  };
  const claim = (id: string, family: Family = "job-offers") => app.inject({
    method: "POST", url: `${path(id, family)}/claim`, headers: bearer(claimerKey),
    payload: family === "job-offers" ? { kernelId: "k-1", contact: "driver-7@example.com" } : { driverAgent: "d-1", contact: "driver-7@example.com" },
  });
  const patch = (id: string, payload: Served, family: Family = "job-offers") => app.inject({ method: "PATCH", url: path(id, family), headers: bearer(posterKey), payload });
  const record = (id: string, payload: Served, family: Family = "job-offers") => app.inject({ method: "POST", url: `${path(id, family)}/events`, headers: bearer(claimerKey), payload });
  const fixtures = async (family: Family): Promise<Record<"A" | "B" | "C", string>> => {
    const A = await create(bearer(posterKey), family);
    const claimed = await claim(A, family);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const B = await create(cookieW, family);
    const C = await create(bearer(walletClaimKey), family);
    expect(getJobOffersStore().get(C)!.posterDid).toBe(W);
    return { A, B, C };
  };
  const callerCases = (): CallerCase[] => [
    { name: "poster key", fixture: "A", headers: bearer(posterKey), view: "party" },
    { name: "claimer key", fixture: "A", headers: bearer(claimerKey), view: "party" },
    { name: "admin scope", fixture: "A", headers: bearer(adminKey), view: "party" },
    { name: "stranger and admin header", fixture: "A", headers: { ...bearer(strangerKey), "x-admin-key": ADMIN }, view: "party" },
    { name: "admin header alone", fixture: "A", headers: { "x-admin-key": ADMIN }, view: "party" },
    { name: "wallet cookie", fixture: "B", headers: cookieW, view: "party" },
    { name: "wallet bearer", fixture: "B", headers: bearerW, view: "party" },
    { name: "wallet session key", fixture: "B", headers: bearer(sessionKeyW1), view: "party" },
    { name: "cookie and failing bearer", fixture: "B", headers: { ...cookieW, ...badBearer }, view: "party" },
    { name: "proven posterDid wallet", fixture: "C", headers: cookieW, view: "party" },
    { name: "anonymous", fixture: "A", headers: {}, view: "public" },
    { name: "stranger key", fixture: "A", headers: bearer(strangerKey), view: "public" },
    { name: "basic key", fixture: "A", headers: bearer(basicKey), view: "public" },
    { name: "same operator claim", fixture: "A", headers: bearer(claimEqualKey), view: "public" },
    { name: "operator claims poster key id", fixture: "A", headers: bearer(claimEqualIdKey), view: "public" },
    { name: "admin wildcard", fixture: "A", headers: bearer(adminStarKey), view: "public" },
    { name: "admin scope and wrong header", fixture: "A", headers: { ...bearer(adminKey), "x-admin-key": "n367-wrong" }, view: "public" },
    { name: "wrong admin header alone", fixture: "A", headers: { "x-admin-key": "n367-wrong" }, view: "public" },
    { name: "unread api key header", fixture: "A", headers: { "x-pcc-api-key": posterKey.rawKey }, view: "public" },
    { name: "other wallet cookie", fixture: "B", headers: cookieV, view: "public" },
    { name: "unknown cookie", fixture: "B", headers: unknownCookie, view: "public" },
    { name: "tampered cookie", fixture: "B", headers: tamperedCookie, view: "public" },
    { name: "expired cookie", fixture: "B", headers: expiredCookie, view: "public" },
    { name: "unproven operator wallet", fixture: "B", headers: bearer(walletClaimKey), view: "public" },
    { name: "cookie after failing key", fixture: "B", headers: unproven, view: "public" },
    { name: "cookie with unread api key header", fixture: "B", headers: { ...cookieW, "x-pcc-api-key": posterKey.rawKey }, view: "public" },
    { name: "failing key", fixture: "A", headers: badKey, view: "401" },
    { name: "failing bearer", fixture: "A", headers: badBearer, view: "401" },
  ];
  const checkView = (served: Served, party: Served, family: Family, view: "party" | "public") => {
    noIdentity(served);
    if (family === "job-offers") {
      expect(served.requirements).toStrictEqual(view === "party" ? REQ : PUBLIC_REQ);
      expect(without(served, ["requirements"])).toStrictEqual(without(party, ["requirements"]));
    } else {
      expect(served.pickup).toStrictEqual(view === "party" ? PICKUP : { lat: 37.77, lng: -122.42 });
      expect(served.dropoff).toStrictEqual(view === "party" ? DROPOFF : { lat: 37.79, lng: -122.39 });
      if (view === "party") expect(served.raw).toStrictEqual({ vendor: "n367" });
      else expect("raw" in served).toBe(false);
      expect(without(served, ["pickup", "dropoff", "raw"])).toStrictEqual(without(party, ["pickup", "dropoff", "raw"]));
    }
  };
  const checkMatrix = async (ids: Record<"A" | "B" | "C", string>, family: Family, exact401: Served, alias = false) => {
    const parties = {
      A: entity(await read(ids.A, bearer(posterKey), family, alias)),
      B: entity(await read(ids.B, cookieW, family, alias)),
      C: entity(await read(ids.C, bearer(walletClaimKey), family, alias)),
    };
    for (const row of callerCases()) {
      const result = await app.inject({ method: "GET", url: path(ids[row.fixture], family, alias), headers: row.headers });
      expect(result.statusCode, `${row.name}: ${result.body}`).toBe(row.view === "401" ? 401 : 200);
      if (row.view === "401") expect(result.json()).toStrictEqual(exact401);
      else {
        expect(result.headers["cache-control"], row.name).toBe("no-store");
        checkView(entity(result.json<Detail>()), parties[row.fixture], family, row.view);
      }
    }
    for (const headers of [{}, bearer(posterKey), badKey]) {
      const result = await app.inject({ method: "GET", url: path(`n367-${randomUUID()}`, family, alias), headers });
      expect(result.statusCode, result.body).toBe(headers === badKey ? 401 : 404);
      expect(result.json()).toStrictEqual(headers === badKey ? exact401 : { error: "not_found" });
      if (headers !== badKey) expect(result.headers["cache-control"]).toBe("no-store");
    }
  };
  const feedCallers = () => [{}, bearer(posterKey), bearer(adminKey), { "x-admin-key": ADMIN }, bearer(strangerKey), badKey];
  const session = (walletAddress: string, expired = false) => {
    const token = `n367-session-${randomUUID()}`;
    const now = Date.now();
    getRepos().sessions.insert({ id: token, token, walletAddress, createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), expiresAt: new Date(now + (expired ? -3_600_000 : 3_600_000)).toISOString() });
    return { token, headers: { cookie: `pcc_session=${app.signCookie(token)}` } };
  };

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    ADMIN = `n367-admin-${randomUUID()}`;
    vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    await app.ready();
    const sqlite = (getStore().db as unknown as { $client?: SqliteDatabaseLike }).$client;
    expect(sqlite).toBeDefined();
    raw = sqlite!;
    posterKey = provisionApiKey({ operatorId: "poster@example.com", scopes: ["*"] });
    claimerKey = provisionApiKey({ operatorId: "claimer@example.com", scopes: ["*"] });
    strangerKey = provisionApiKey({ operatorId: "stranger@example.com", scopes: ["*"] });
    sessionKeyW1 = provisionApiKey({ operatorId: W, scopes: ["*"], metadata: { source: "siwe-session" } });
    adminKey = provisionApiKey({ operatorId: "admin@example.com", scopes: ["admin"] });
    adminStarKey = provisionApiKey({ operatorId: "admin-star@example.com", scopes: ["admin", "*"] });
    basicKey = provisionApiKey({ operatorId: "basic@example.com", scopes: ["operator:basic"] });
    claimEqualKey = provisionApiKey({ operatorId: "poster@example.com", scopes: ["*"] });
    claimEqualIdKey = provisionApiKey({ operatorId: posterKey.record!.id, scopes: ["*"] });
    walletClaimKey = provisionApiKey({ operatorId: W, scopes: ["*"] });
    cookieW = session(W).headers;
    cookieV = session(V).headers;
    bearerW = { authorization: `Bearer ${session(W).token}` };
    unproven = { ...cookieW, ...badKey };
    unknownCookie = { cookie: `pcc_session=${app.signCookie("n367-no-such-session")}` };
    tamperedCookie = { cookie: "pcc_session=n367-tampered.value" };
    expiredCookie = session(W, true).headers;
  }, 120_000);

  beforeEach(() => { __resetRateLimitState(); });
  afterAll(async () => {
    try { await app?.close(); }
    finally {
      vi.unstubAllEnvs();
      if (previousDbPath === undefined) delete process.env.PCC_DB_PATH;
      else process.env.PCC_DB_PATH = previousDbPath;
    }
  });

  it("N367 V1: public values remove party keys, cut places and round coordinates at every depth", () => {
    const input = { shopId: "s1",
      customer: { name: "c", phone: "p" },
      deliveryAddress: "a",
      raw: { r: 1 },
      pickup: { name: "n", address: "a", line1: "l", lat: 37.774929, lng: -122.419416, phone: "p" },
      dropoff: { lng: -122.392914, lat: 37.793743, name: "n" },
      location: { lat: 37.774929, lng: -122.419416, note: "kept" },
      lat: 37.774929,
      lng: "-122.4194",
      items: [1, "two", null, { name: "i", customer: "c", pickup: "a string" }, [{ deliveryAddress: "a", lat: 1.006 }]],
      nested: { deeper: { dropoff: ["x"], pickup: null, lat: null, lng: Infinity, keep: true } } };
    const before = structuredClone(input);
    const result = publicViewValue(input) as Served;
    expect(result).toStrictEqual({ shopId: "s1",
      pickup: { lat: 37.77, lng: -122.42 },
      dropoff: { lat: 37.79, lng: -122.39 },
      location: { lat: 37.77, lng: -122.42, note: "kept" },
      lat: 37.77,
      items: [1, "two", null, { name: "i", pickup: {} }, [{ lat: 1.01 }]],
      nested: { deeper: { dropoff: {}, pickup: {}, keep: true } } });
    for (const key of ["customer", "deliveryAddress", "raw", "lng"]) expect(key in result).toBe(false);
    expect(input).toStrictEqual(before);
    for (const value of [null, undefined, true, 4, "kept"]) expect(publicViewValue(value)).toStrictEqual(value);
    const places = { pickup: Object.create({ lat: 1, lng: 2 }) as Served, dropoff: Object.defineProperty({ lat: 1.234 }, "lng", { value: 5.678, enumerable: false }) };
    expect(publicViewValue(places)).toStrictEqual({ pickup: {}, dropoff: { lat: 1.23 } });
  });

  it("N367 V2: depth starts at zero, stops at 32, and bounds deep and cyclic inputs", () => {
    expect(publicViewValue(chain(32))).toStrictEqual(chain(32));
    expect(publicViewValue(chain(33))).toStrictEqual(chain(32));
    expect(publicViewValue(arrayChain(32))).toStrictEqual(arrayChain(32));
    expect(publicViewValue(arrayChain(33))).toStrictEqual(arrayChain(32));
    expect(publicViewValue(chain(32, { v: 5 }))).toStrictEqual(chain(32, { v: 5 }));
    let deep: Served = {};
    for (let i = 0; i < 100_000; i++) deep = { a: deep };
    let result: unknown;
    expect(() => { result = publicViewValue(deep); }).not.toThrow();
    expect(result).toStrictEqual(chain(32));
    const cyclic: Served = {};
    cyclic.self = cyclic;
    expect(publicViewValue(cyclic)).toStrictEqual(chain(32, {}, "self"));
  });

  it("N367 V3: an own __proto__ stays a data key on a plain object without changing input", () => {
    const input = JSON.parse('{"__proto__":{"customer":"x","pickup":{"name":"n","lat":1.234,"lng":5.678},"keep":1},"k":[1,{"raw":2}]}');
    const before = JSON.stringify(input);
    const result = publicViewValue(input) as Served;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result)).toStrictEqual(["__proto__", "k"]);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toStrictEqual({ pickup: { lat: 1.23, lng: 5.68 }, keep: 1 });
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")).toStrictEqual({ value: { pickup: { lat: 1.23, lng: 5.68 }, keep: 1 }, enumerable: true, writable: true, configurable: true });
    expect(result.k).toStrictEqual([1, {}]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("N367 V4: throwing object and array getters are omitted without throwing", () => {
    const object = Object.defineProperty({ a: 1 }, "b", { enumerable: true, get() { throw new Error("n367 getter"); } });
    const array = Object.defineProperty([0, "x", 2], "1", { enumerable: true, get() { throw new Error("n367 getter"); } });
    let objectResult: unknown;
    let arrayResult: unknown;
    expect(() => { objectResult = publicViewValue(object); }).not.toThrow();
    expect(() => { arrayResult = publicViewValue(array); }).not.toThrow();
    expect(objectResult).toStrictEqual({ a: 1 });
    expect(arrayResult).toStrictEqual([0, 2]);
    const place = { pickup: Object.defineProperty({ lng: 5.678 }, "lat", { enumerable: true, get() { throw new Error("n367 coordinate getter"); } }) };
    expect(publicViewValue(place)).toStrictEqual({ pickup: { lng: 5.68 } });
  });

  it("N367 V5: composed public views walk their specified roots and stay safe as map callbacks", () => {
    const offer = { id: `n367-${randomUUID()}`, posterDid: W, driverContact: "driver@example.com", idempotencyKey: "n367-unit-key", requirements: REQ, serviceAreaGeofence: { lat: 37.774929, customer: "kept" } } as unknown as JobOffer;
    expect(publicViewOffer(offer)).toStrictEqual({ id: offer.id, requirements: PUBLIC_REQ, serviceAreaGeofence: { lat: 37.774929, customer: "kept" } });
    noIdentity(publicViewOffer(offer) as unknown as Served);
    const job = { id: `n367-${randomUUID()}`, postedBy: W, driverContact: "driver@example.com", pickup: PICKUP, dropoff: DROPOFF, raw: { vendor: "n367" }, description: "kept" } as unknown as CourierJob;
    const jobResult = publicViewCourierJob(job);
    expect(jobResult).toStrictEqual({ id: job.id, pickup: { lat: 37.77, lng: -122.42 }, dropoff: { lat: 37.79, lng: -122.39 }, description: "kept" });
    noIdentity(jobResult as unknown as Served);
    expect("raw" in jobResult).toBe(false);
    const event: JobOfferEvent = { event: "note", at: "n367-at", by: W, before: REQ, after: REQ, payload: REQ, note: { customer: "kept", lat: 37.774929 } };
    expect(publicViewEvent(event)).toStrictEqual({ event: "note", at: "n367-at", by: null, before: PUBLIC_REQ, after: PUBLIC_REQ, payload: PUBLIC_REQ, note: { customer: "kept", lat: 37.774929 } });
    expect(publicViewEvent({ at: "n367-at", event: "note" })).toStrictEqual({ at: "n367-at", event: "note", by: null });
    const deepOffer = { ...offer, requirements: chain(32) };
    const deepJob = { ...job, extra: chain(32) };
    const deepEvent = { ...event, by: "claimer", before: chain(32), after: chain(32), payload: chain(32) };
    expect([offer, deepOffer].map(publicViewOffer)[1]).toStrictEqual(publicViewOffer(deepOffer));
    expect([job, deepJob].map(publicViewCourierJob)[1]).toStrictEqual(publicViewCourierJob(deepJob));
    expect([event, deepEvent].map(publicViewEvent)[1]).toStrictEqual(publicViewEvent(deepEvent));
    expect(publicViewEvents([event, deepEvent])).toStrictEqual([publicViewEvent(event), publicViewEvent(deepEvent)]);
    expect(offer.requirements).toStrictEqual(REQ);
    expect(job.raw).toStrictEqual({ vendor: "n367" });
  });

  it("N367 V6: party projections omit the replay key and preserve whole requirements, jobs and events", () => {
    const offer = { id: `n367-${randomUUID()}`, posterDid: W, driverContact: "driver@example.com", idempotencyKey: "n367-unit-key", requirements: REQ } as unknown as JobOffer;
    const result = publicOffer(offer);
    expect(result).toStrictEqual({ id: offer.id, requirements: REQ });
    expect(result.requirements).toStrictEqual(REQ);
    for (const key of ["posterDid", "driverContact", "idempotencyKey"]) expect(key in result).toBe(false);
    const id = `n367-${randomUUID()}`;
    const job = { id, status: "claimed", postedBy: "poster@example.com", driverContact: "driver-7@example.com", claimedBy: "d-1", feeUSD: 18.5, pickup: { address: "1 Shop Way, SF" }, dropoff: { address: "180 Steuart St, SF" } } as CourierJob;
    const before = structuredClone(job);
    expect(publicCourierJob(job)).toStrictEqual({ id, status: "claimed", claimedBy: "d-1", feeUSD: 18.5, pickup: { address: "1 Shop Way, SF" }, dropoff: { address: "180 Steuart St, SF" } });
    expect(job).toStrictEqual(before);
    const cases: Array<{ by?: unknown; served: "poster" | "claimer" | null }> = [
      { by: "poster", served: "poster" }, { by: "claimer", served: "claimer" }, { by: "poster@example.com", served: null }, { by: W, served: null },
      { by: "kernel-driver-7", served: null }, { by: "Poster", served: null }, { by: "", served: null }, { by: 42, served: null }, { by: null, served: null }, { served: null },
    ];
    const inputs: JobOfferEvent[] = cases.map((value, index) => ({ at: `unit-at-${index}`, event: "note", note: "kept", payload: { index, nested: ["kept"] }, before: { amount: index }, after: { amount: index + 1 }, ...("by" in value ? { by: value.by } : {}) }));
    const originals = structuredClone(inputs);
    const expected = inputs.map((input, index) => ({ ...input, by: cases[index]!.served }));
    for (const [index, input] of inputs.entries()) expect(publicEvent(input)).toStrictEqual(expected[index]);
    expect(publicEvents(inputs)).toStrictEqual(expected);
    expect(inputs).toStrictEqual(originals);
  });

  it("N367 K1: create, replay, feeds, detail, claim and PATCH omit the stored idempotency key", async () => {
    const id = `n367-${randomUUID()}`;
    const idempotencyKey = `n367-key-${randomUUID()}`;
    const payload = { id, capabilityType: "n367.delivery", requirements: REQ, pricing: { amount: 21.71, currency: "USD", model: "fixed" }, idempotencyKey };
    const posted = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload });
    expect(posted.statusCode, posted.body).toBe(201);
    expect("idempotencyKey" in posted.json<Served>()).toBe(false);
    const { id: _id, ...replayPayload } = payload;
    const replay = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: replayPayload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toStrictEqual({ ok: true, id, status: "open", note: "already posted", requirementsValidated: false });
    expect("idempotencyKey" in replay.json<Served>()).toBe(false);
    expect(getJobOffersStore().get(id)!.idempotencyKey).toBe(idempotencyKey);
    const feed = await app.inject({ method: "GET", url: "/api/job-offers/open?capabilityType=n367.delivery&limit=1000" });
    expect(feed.statusCode).toBe(200);
    const served = feed.json<{ offers: Served[] }>().offers.find((offer) => offer.id === id)!;
    expect(served).toBeDefined();
    noIdentity(served);
    for (const headers of [bearer(posterKey), bearer(adminKey), bearer(strangerKey)]) noIdentity(entity(await read(id, headers)));
    const edited = await patch(id, { pricing: { amount: 22, currency: "USD", model: "fixed" } });
    expect(edited.statusCode, edited.body).toBe(200);
    noIdentity(edited.json<{ offer: Served }>().offer);
    const claimed = await claim(id);
    expect(claimed.statusCode, claimed.body).toBe(200);
    noIdentity(claimed.json<{ offer: Served }>().offer);
    expect(getJobOffersStore().get(id)!.idempotencyKey).toBe(idempotencyKey);
    const courier = await create(bearer(posterKey), "courier-jobs");
    const courierFeed = await app.inject({ method: "GET", url: "/api/courier-jobs/open" });
    expect(courierFeed.statusCode).toBe(200);
    noIdentity(courierFeed.json<{ jobs: Served[] }>().jobs.find((job) => job.id === courier)!);
    noIdentity(entity(await read(courier, bearer(posterKey), "courier-jobs")));
  });

  it("N367 P1: offer detail chooses the party or public view from proven callers and refuses failing Authorization", async () => {
    const exact401 = { error: "api_key_required", message: "This endpoint requires authentication. Provide an API key via Authorization: Bearer pcc_live_... header, or sign in with your wallet.", provision_url: "/api/auth/provision", docs: "https://capability.network/whitepaper.md" };
    await checkMatrix(await fixtures("job-offers"), "job-offers", exact401);
  });

  it("N367 P2: both courier detail paths choose the party or public view and refuse failing Authorization", async () => {
    const exact401 = { error: "api_key_required", message: "This endpoint requires authentication. Provide an API key via Authorization: Bearer pcc_live_... header, or sign in with your wallet.", provision_url: "/api/auth/provision", docs: "https://capability.network/whitepaper.md" };
    const ids = await fixtures("courier-jobs");
    await checkMatrix(ids, "courier-jobs", exact401);
    await checkMatrix(ids, "courier-jobs", exact401, true);
  });

  it("N367 P3: HEAD follows authenticated GET and sends no-store on both detail families", async () => {
    for (const family of ["job-offers", "courier-jobs"] as const) {
      const id = await create(bearer(posterKey), family);
      for (const headers of [{}, bearer(posterKey), badKey]) {
        const result = await app.inject({ method: "HEAD", url: path(id, family, family === "courier-jobs"), headers });
        expect(result.statusCode, result.body).toBe(headers === badKey ? 401 : 200);
        if (headers !== badKey) expect(result.headers["cache-control"]).toBe("no-store");
      }
    }
  });

  it("N367 P4: detail event before, after and payload are whole for parties and public for other readers", async () => {
    const D = await create();
    const CD = await create(bearer(posterKey), "courier-jobs");
    const requirements = { pickup: { name: "N367 New", lat: 37.801234, lng: -122.405678 }, customer: { name: "N367 Other" } };
    for (const result of [await patch(D, { requirements }), await patch(CD, { feeUSD: 9 }, "courier-jobs")]) expect(result.statusCode, result.body).toBe(200);
    for (const [id, family] of [[D, "job-offers"], [CD, "courier-jobs"]] as const) {
      const party = await read(id, bearer(posterKey), family);
      const publicRead = await read(id, bearer(strangerKey), family);
      const whole = party.events.find((event) => event.event === "patched")!;
      const redacted = publicRead.events.find((event) => event.event === "patched")!;
      expect(whole).toBeDefined();
      expect(redacted).toBeDefined();
      expect(publicRead.events.find((event) => event.event === "posted")).toStrictEqual(party.events.find((event) => event.event === "posted"));
      if (family === "job-offers") {
        expect((whole.before as Served).requirements).toStrictEqual(REQ);
        expect((whole.after as Served).requirements).toStrictEqual(requirements);
        expect((redacted.before as Served).requirements).toStrictEqual(PUBLIC_REQ);
        expect((redacted.after as Served).requirements).toStrictEqual({ pickup: { lat: 37.8, lng: -122.41 } });
      } else {
        const before = (whole.before as Served).requirements as Served;
        const publicBefore = (redacted.before as Served).requirements as Served;
        expect(before.pickup).toStrictEqual(PICKUP);
        expect(before.dropoff).toStrictEqual(DROPOFF);
        expect(before.raw).toStrictEqual({ vendor: "n367" });
        expect(publicBefore.pickup).toStrictEqual({ lat: 37.77, lng: -122.42 });
        expect(publicBefore.dropoff).toStrictEqual({ lat: 37.79, lng: -122.39 });
        expect("raw" in publicBefore).toBe(false);
        expect(redacted.after).toStrictEqual(whole.after);
      }
    }
    const payload = { step: "at door", customer: { name: "N367 Customer" }, dropoff: { name: "N367 Customer", lat: 37.793743, lng: -122.392914 }, lat: 37.774929, lng: -122.419416 };
    for (const family of ["job-offers", "courier-jobs"] as const) {
      const id = await create(bearer(posterKey), family);
      const claimed = await claim(id, family);
      expect(claimed.statusCode, claimed.body).toBe(200);
      const kind = family === "job-offers" ? "in_progress" : "pickup";
      const result = await record(id, family === "job-offers" ? { event: kind, payload } : { event: kind, proof: payload }, family);
      expect(result.statusCode, result.body).toBe(200);
      const party = await read(id, bearer(posterKey), family);
      const publicRead = await read(id, bearer(strangerKey), family);
      expect(party.events.find((event) => event.event === kind)!.payload).toStrictEqual(payload);
      expect(publicRead.events.find((event) => event.event === kind)!.payload).toStrictEqual({ step: "at door", dropoff: { lat: 37.79, lng: -122.39 }, lat: 37.77, lng: -122.42 });
    }
  });

  it("N367 F1: every feed caller gets the public view while feed and health credentials remain optional", async () => {
    const offer = await create();
    const courier = await create(bearer(posterKey), "courier-jobs");
    const partyOffer = entity(await read(offer, bearer(posterKey)));
    const partyCourier = entity(await read(courier, bearer(posterKey), "courier-jobs"));
    for (const headers of feedCallers()) {
      for (const [url, key, id, family, party] of [
        ["/api/job-offers/open?capabilityType=n367.delivery&limit=1000", "offers", offer, "job-offers", partyOffer],
        ["/api/courier-jobs/open", "jobs", courier, "courier-jobs", partyCourier],
        ["/api/courier-jobs/jobs/open", "jobs", courier, "courier-jobs", partyCourier],
      ] as const) {
        const result = await app.inject({ method: "GET", url, headers });
        expect(result.statusCode, result.body).toBe(200);
        const served = result.json<Record<string, Served[]>>()[key]!.find((value) => value.id === id)!;
        expect(served).toBeDefined();
        checkView(served, party, family, "public");
      }
    }
    for (const headers of [{}, badKey]) for (const family of ["job-offers", "courier-jobs"]) {
      const result = await app.inject({ method: "GET", url: `/api/${family}/healthz`, headers });
      expect(result.statusCode, result.body).toBe(200);
    }
  });

  it("N367 W1: both feeds measure within from the rounded public pickup", async () => {
    const pickup = { ...PICKUP, lat: 37.7749, lng: -122.4194 };
    const offer = await create(bearer(posterKey), "job-offers", { capabilityType: "n367.within", requirements: { ...REQ, pickup } });
    const courier = await create(bearer(posterKey), "courier-jobs", { pickup });
    for (const [point, listed] of [["37.7749,-122.4194,0.1", false], ["37.77,-122.42,0.1", true]] as const) {
      for (const [base, key, id] of [["/api/job-offers/open?capabilityType=n367.within&limit=1000", "offers", offer], ["/api/courier-jobs/open?", "jobs", courier]] as const) {
        const result = await app.inject({ method: "GET", url: `${base}&within=${point}` });
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json<Record<string, Served[]>>()[key]!.some((value) => value.id === id)).toBe(listed);
      }
    }
  });

  it("N367 R1: successful claim, PATCH and event writes keep the whole party view", async () => {
    const payload = { customer: { name: "N367 Customer" }, pickup: PICKUP, lat: 37.774929 };
    for (const family of ["job-offers", "courier-jobs"] as const) {
      const id = await create(bearer(posterKey), family);
      const changes = family === "job-offers" ? { requirements: { customer: { name: "N367 Updated" } } } : { feeUSD: 9 };
      const edited = await patch(id, changes, family);
      expect(edited.statusCode, edited.body).toBe(200);
      const editedEntity = entity(edited.json<Detail>());
      noIdentity(editedEntity);
      if (family === "job-offers") expect(editedEntity.requirements).toStrictEqual({ ...REQ, customer: { name: "N367 Updated" } });
      else {
        expect(editedEntity.pickup).toStrictEqual(PICKUP);
        expect(editedEntity.dropoff).toStrictEqual(DROPOFF);
        expect(editedEntity.raw).toStrictEqual({ vendor: "n367" });
        expect(editedEntity.feeUSD).toBe(9);
      }
      const claimed = await claim(id, family);
      expect(claimed.statusCode, claimed.body).toBe(200);
      const claimedEntity = entity(claimed.json<Detail>());
      noIdentity(claimedEntity);
      if (family === "job-offers") expect(claimedEntity.requirements).toStrictEqual({ ...REQ, customer: { name: "N367 Updated" } });
      else {
        expect(claimedEntity.pickup).toStrictEqual(PICKUP);
        expect(claimedEntity.dropoff).toStrictEqual(DROPOFF);
        expect(claimedEntity.raw).toStrictEqual({ vendor: "n367" });
      }
      const kind = family === "job-offers" ? "in_progress" : "pickup";
      const result = await record(id, family === "job-offers" ? { event: kind, payload } : { event: kind, proof: payload }, family);
      expect(result.statusCode, result.body).toBe(200);
      const event = result.json<{ event: JobOfferEvent }>().event;
      expect(event.payload).toStrictEqual(payload);
      expect(event.by).toBe("claimer");
      expect(event).toStrictEqual(publicEvent(getJobOffersStore().getEvents(id).at(-1)!));
    }
  });

  it("N367 S1: all caller, feed and within reads leave the stored offer, events and row unchanged", async () => {
    const id = await create();
    const store = getJobOffersStore();
    const row = () => (raw.prepare("SELECT data FROM job_offers WHERE id = ?").get(id) as { data: string }).data;
    const beforeOffer = structuredClone(store.get(id));
    const beforeEvents = structuredClone(store.getEvents(id));
    const beforeRow = structuredClone(row());
    for (const caller of callerCases()) {
      const result = await app.inject({ method: "GET", url: path(id), headers: caller.headers });
      expect(result.statusCode, result.body).toBe(caller.view === "401" ? 401 : 200);
    }
    for (const headers of feedCallers()) for (const url of [
      "/api/job-offers/open?capabilityType=n367.delivery&limit=1000",
      "/api/courier-jobs/open", "/api/courier-jobs/jobs/open",
    ]) {
      const result = await app.inject({ method: "GET", url, headers });
      expect(result.statusCode, result.body).toBe(200);
    }
    for (const within of ["37.7749,-122.4194,0.1", "37.77,-122.42,0.1"]) for (const base of ["/api/job-offers/open?capabilityType=n367.delivery&limit=1000", "/api/courier-jobs/open?"]) {
      const result = await app.inject({ method: "GET", url: `${base}&within=${within}` });
      expect(result.statusCode, result.body).toBe(200);
    }
    expect(store.get(id)).toStrictEqual(beforeOffer);
    expect(store.getEvents(id)).toStrictEqual(beforeEvents);
    expect(row()).toStrictEqual(beforeRow);
  });

  it("N367 G1: only GET and HEAD detail paths use optional private authentication", () => {
    const details = ["/api/job-offers/x1", "/api/job-offers/x1?a=b", "/api/courier-jobs/x1", "/api/courier-jobs/jobs/x1"];
    for (const url of details) {
      for (const method of ["GET", "HEAD"]) expect(isOfferDetailRead(url, method), `${method} ${url}`).toBe(true);
      for (const method of ["POST", "PATCH", "DELETE"]) expect(isOfferDetailRead(url, method), `${method} ${url}`).toBe(false);
    }
    expect(isOfferDetailRead("/api/job-offers/x1", "get")).toBe(true);
    for (const url of ["/api/job-offers/open", "/api/job-offers/open?capabilityType=x", "/api/job-offers/healthz", "/api/courier-jobs/open", "/api/courier-jobs/jobs/open", "/api/courier-jobs/healthz", "/api/job-offers", "/api/job-offers/", "/api/job-offers/x1/claim", "/api/job-offers/x1/events", "/api/courier-jobs/jobs/x1/claim"]) expect(isOfferDetailRead(url, "GET"), url).toBe(false);
    expect(isOfferDetailRead("/api/job-offers/x1")).toBe(false);
  });
});

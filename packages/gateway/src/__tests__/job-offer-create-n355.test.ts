/** N355: create replays preserve the first offer and its recorded posting identity. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { bindBuyer, BUYER_PROOF_REQUIRED, BUYER_PROOF_SOURCES } from "../auth/buyer-identity.js";
import { getRepos, getStore } from "../db.js";
import { __resetRateLimitState } from "../middleware/rate-limiter.js";
import { offerCaller } from "../services/job-offer-event-rules.js";
import {
  _resetJobOffersStoreForTests, getJobOffersStore, initJobOffersStore,
  type CreateJobOfferInput, type SqliteDatabaseLike, type VerifyFn,
} from "../services/job-offers-store.js";

const W = "0x" + "ab".repeat(20);
const V = "0x" + "cd".repeat(20);
const missingIdentity = {
  error: "missing_identity", message: "This action needs your API key or a wallet sign-in.",
};
type Headers = Record<string, string>;
type Family = "job-offers" | "courier-jobs";
type Entity = { id: string; status: string; posterDid?: string | null; postedBy?: string | null; deliveredAt: string | null; cancelledAt: string | null; requirements?: Record<string, unknown>; claimedByKernelId?: string | null; feeUSD?: number | null };
type RecordedEvent = { event: string; by?: string; at: string; [key: string]: unknown };
type Snapshot = { offer?: Entity; job?: Entity; events: RecordedEvent[] };

describe("N355 real gateway create replay authorization", () => {
  let app: FastifyInstance;
  let raw: SqliteDatabaseLike;
  let posterKey: ReturnType<typeof provisionApiKey>;
  let claimerKey: ReturnType<typeof provisionApiKey>;
  let strangerKey: ReturnType<typeof provisionApiKey>;
  let sessionKeyW1: ReturnType<typeof provisionApiKey>;
  let sessionKeyW2: ReturnType<typeof provisionApiKey>;
  let cookieW: Headers;
  let unproven: Headers;
  const previousDbPath = process.env.PCC_DB_PATH;
  const bearer = (key: string | ReturnType<typeof provisionApiKey>): Headers => ({ authorization: `Bearer ${typeof key === "string" ? key : key.rawKey}` });
  const path = (id: string, family: Family = "job-offers") => `/api/${family}/${id}`;
  const entity = (snapshot: Snapshot) => (snapshot.offer ?? snapshot.job)!;
  const read = async (id: string, family: Family = "job-offers"): Promise<Snapshot> => {
    const result = await app.inject({ method: "GET", url: path(id, family) });
    expect(result.statusCode, result.body).toBe(200);
    return result.json<Snapshot>();
  };
  const event = (id: string, kind: string, headers: Headers, family: Family = "job-offers", extra: Record<string, unknown> = {}) => app.inject({
    method: "POST", url: `${path(id, family)}/events`, headers, payload: { event: kind, ...extra },
  });
  const claim = (id: string, headers: Headers, family: Family = "job-offers") => app.inject({
    method: "POST", url: `${path(id, family)}/claim`, headers,
    payload: family === "job-offers" ? { kernelId: "k-1" } : { driverAgent: "d-1" },
  });
  const create = async (headers: Headers = bearer(posterKey), family: Family = "job-offers", overrides: Record<string, unknown> = {}) => {
    const id = `n355-${randomUUID()}`;
    const payload = family === "job-offers"
      ? { id, capabilityType: "pizza.order", requirements: { shopId: "shop-1", items: ["margherita"] }, pricing: { amount: 18.5, currency: "USD", model: "fixed" }, ...overrides }
      : { deliveryId: id, pickup: { name: "PCC Shop", address: "1 Shop Way, SF" }, dropoff: { name: "USPS Rincon Center", address: "180 Steuart St, SF" }, ...overrides };
    const result = await app.inject({ method: "POST", url: `/api/${family}`, headers, payload });
    expect(result.statusCode, result.body).toBe(201);
    return result.json<{ id: string }>().id;
  };
  const claimed = async (family: Family = "job-offers", headers: Headers = bearer(claimerKey)) => {
    const id = await create(bearer(posterKey), family);
    const result = await claim(id, headers, family);
    expect(result.statusCode, result.body).toBe(200);
    return id;
  };
  const refused = async (id: string, request: () => ReturnType<typeof event>, status: number, body?: unknown, family: Family = "job-offers") => {
    const before = await read(id, family);
    const result = await request();
    expect(result.statusCode, result.body).toBe(status);
    if (body !== undefined) expect(result.json()).toEqual(body);
    expect(await read(id, family)).toEqual(before);
    return result;
  };
  const acceptedEvent = async (id: string, kind: string, headers: Headers, status: string, by: string, family: Family = "job-offers", extra: Record<string, unknown> = {}) => {
    const result = await event(id, kind, headers, family, extra);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ ok: true, status, event: { event: kind, by } });
    const snapshot = await read(id, family);
    expect(entity(snapshot).status).toBe(status);
    expect(snapshot.events.at(-1)).toMatchObject({ event: kind, by });
    if (kind === "delivered") expect(entity(snapshot).deliveredAt).toBe(snapshot.events.at(-1)!.at);
    if (kind === "cancelled") expect(entity(snapshot).cancelledAt).toBe(snapshot.events.at(-1)!.at);
    return result;
  };
  const edit = (id: string, action: "PATCH" | "DELETE" | "heartbeat", headers: Headers, family: Family = "job-offers") => action === "heartbeat"
    ? app.inject({ method: "POST", url: `${path(id, family)}/heartbeat`, headers })
    : app.inject({ method: action, url: path(id, family), headers, ...(action === "PATCH" ? { payload: family === "job-offers" ? { pricing: { amount: 20, currency: "USD", model: "fixed" } } : { feeUSD: 20 } } : {}) });
  const row = (id: string) => {
    const found = raw.prepare("SELECT data FROM job_offers WHERE id = ?").get(id) as { data: string } | undefined;
    expect(found).toBeDefined();
    return JSON.parse(found!.data) as Record<string, unknown>;
  };
  const postedCount = (snapshot: Snapshot) => snapshot.events.filter((entry) => entry.event === "posted").length;
  const rowCount = () => (raw.prepare("SELECT COUNT(*) AS n FROM job_offers").get() as { n: number }).n;
  const rowsWithKey = (key: string) => (raw.prepare("SELECT data FROM job_offers").all() as { data: string }[])
    .filter((entry) => JSON.parse(entry.data).idempotencyKey === key).length;
  const openCount = () => getJobOffersStore().countByStatus("open");
  const gates = new Map<string, { enter: () => void; released: Promise<void>; release: () => void }>();
  const gate = () => {
    const url = `https://verify.n355.test/gate/${randomUUID()}`;
    let enter!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    gates.set(url, { enter, released, release });
    return { url, reached, release };
  };
  const stub: VerifyFn = async (url) => {
    const pending = gates.get(url);
    if (pending) {
      pending.enter();
      await pending.released;
    }
    return { ok: true, body: { placed: true } };
  };
  const useStub = () => {
    _resetJobOffersStoreForTests();
    initJobOffersStore({ sqlite: raw, verify: stub });
  };
  const reload = () => useStub();

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const { createGateway } = await import("../server.js");
    ({ app } = await createGateway(0));
    await app.ready();
    const sqlite = (getStore().db as unknown as { $client?: SqliteDatabaseLike }).$client;
    expect(sqlite).toBeDefined();
    raw = sqlite!;
    useStub();
    posterKey = provisionApiKey({ operatorId: "poster@example.com", scopes: ["*"] });
    claimerKey = provisionApiKey({ operatorId: "claimer@example.com", scopes: ["*"] });
    strangerKey = provisionApiKey({ operatorId: "stranger@example.com", scopes: ["*"] });
    sessionKeyW1 = provisionApiKey({ operatorId: W, scopes: ["*"], metadata: { source: "siwe-session" } });
    sessionKeyW2 = provisionApiKey({ operatorId: W, scopes: ["*"], metadata: { source: "siwe-session" } });
    const session = (walletAddress: string): Headers => {
      const token = `n355-session-${randomUUID()}`;
      const now = Date.now();
      getRepos().sessions.insert({ id: token, token, walletAddress, createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() });
      return { cookie: `pcc_session=${app.signCookie(token)}` };
    };
    cookieW = session(W);
    unproven = { ...cookieW, authorization: "Bearer pcc_not_a_key" };
  }, 120_000);

  beforeEach(() => { __resetRateLimitState(); });
  afterEach(() => {
    for (const pending of gates.values()) pending.release();
    gates.clear();
  });
  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (previousDbPath === undefined) delete process.env.PCC_DB_PATH;
      else process.env.PCC_DB_PATH = previousDbPath;
    }
  });

  it("N355 R1: a same-id race loser answers 409 and preserves the winning offer and poster", async () => {
    const id = `n355-${randomUUID()}`;
    const g = gate();
    const first = app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: {
      id, capabilityType: "pizza.order", requirements: { shopId: "shop-p1", items: ["p1"] },
      pricing: { amount: 18.5, currency: "USD", model: "fixed" }, sourceVerifyUrl: g.url,
    } });
    await g.reached;
    const fastId = await create(bearer(strangerKey), "job-offers", { id, requirements: { shopId: "shop-p2", items: ["p2"] } });
    expect(fastId).toBe(id);
    g.release();
    const late = await first;
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json()).toEqual({ error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    const snapshot = await read(id);
    expect(entity(snapshot).requirements?.shopId).toBe("shop-p2");
    expect(postedCount(snapshot)).toBe(1);
    const denied = await edit(id, "PATCH", bearer(posterKey));
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ error: "forbidden" });
    expect((await edit(id, "PATCH", bearer(strangerKey))).statusCode).toBe(200);
    reload();
    const restored = await read(id);
    expect(entity(restored).requirements?.shopId).toBe("shop-p2");
    expect(postedCount(restored)).toBe(1);
    const deniedAgain = await edit(id, "PATCH", bearer(posterKey));
    expect(deniedAgain.statusCode, deniedAgain.body).toBe(403);
    expect(deniedAgain.json()).toMatchObject({ error: "forbidden" });
  });

  it("N355 R2: a same-id race loser answers 409 and preserves an intervening claim", async () => {
    const id = `n355-${randomUUID()}`;
    const g = gate();
    const first = app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: {
      id, capabilityType: "pizza.order", requirements: { shopId: "shop-p1", items: ["p1"] },
      pricing: { amount: 18.5, currency: "USD", model: "fixed" }, sourceVerifyUrl: g.url,
    } });
    await g.reached;
    await create(bearer(strangerKey), "job-offers", { id, requirements: { shopId: "shop-p2", items: ["p2"] } });
    const claimedResult = await claim(id, bearer(claimerKey));
    expect(claimedResult.statusCode, claimedResult.body).toBe(200);
    g.release();
    const late = await first;
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json()).toEqual({ error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    const snapshot = await read(id);
    expect(entity(snapshot)).toMatchObject({ status: "claimed", claimedByKernelId: "k-1", requirements: { shopId: "shop-p2" } });
    expect(postedCount(snapshot)).toBe(1);
    await acceptedEvent(id, "delivered", bearer(claimerKey), "delivered", "claimer");
  });

  it("N355 R3: a same-key race loser answers 409 and writes no offer, index, or row", async () => {
    const key = `n355-${randomUUID()}`;
    const g = gate();
    const first = app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: {
      capabilityType: "pizza.order", requirements: { shopId: "shop-p1", items: ["p1"] },
      pricing: { amount: 18.5, currency: "USD", model: "fixed" }, idempotencyKey: key, sourceVerifyUrl: g.url,
    } });
    await g.reached;
    const id = await create(bearer(strangerKey), "job-offers", { id: undefined, idempotencyKey: key, requirements: { shopId: "shop-p2", items: ["p2"] } });
    const opens = openCount();
    const rows = rowCount();
    g.release();
    const late = await first;
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json()).toEqual({ error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    expect(getJobOffersStore().getByIdempotencyKey(key)?.id).toBe(id);
    expect(openCount()).toBe(opens);
    expect(rowCount()).toBe(rows);
    expect(rowsWithKey(key)).toBe(1);
    reload();
    expect(getJobOffersStore().getByIdempotencyKey(key)?.id).toBe(id);
    await read(id);
  });

  it("N355 R4: a same-caller same-key race replay answers already posted and writes nothing", async () => {
    const key = `n355-${randomUUID()}`;
    const g = gate();
    const first = app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: {
      capabilityType: "pizza.order", requirements: { shopId: "shop-p1", items: ["p1"] },
      pricing: { amount: 18.5, currency: "USD", model: "fixed" }, idempotencyKey: key, sourceVerifyUrl: g.url,
    } });
    await g.reached;
    const id = await create(bearer(posterKey), "job-offers", { id: undefined, idempotencyKey: key, requirements: { shopId: "shop-p2", items: ["p2"] } });
    const opens = openCount();
    const rows = rowCount();
    g.release();
    const late = await first;
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json()).toMatchObject({ ok: true, id, note: "already posted" });
    expect(openCount()).toBe(opens);
    expect(rowCount()).toBe(rows);
    expect(rowsWithKey(key)).toBe(1);
    const snapshot = await read(id);
    expect(postedCount(snapshot)).toBe(1);
    expect(entity(snapshot).requirements?.shopId).toBe("shop-p2");
  });

  it("N355 R5: a courier race loser answers 409 and preserves the alias winner's fee and poster", async () => {
    const id = `n355-${randomUUID()}`;
    const g = gate();
    const body = { deliveryId: id, pickup: { name: "PCC Shop", address: "1 Shop Way, SF" }, dropoff: { name: "USPS Rincon Center", address: "180 Steuart St, SF" } };
    const first = app.inject({ method: "POST", url: "/api/courier-jobs", headers: bearer(posterKey), payload: { ...body, feeUSD: 11, sourceVerifyUrl: g.url } });
    await g.reached;
    const fast = await app.inject({ method: "POST", url: "/api/courier-jobs/jobs", headers: bearer(strangerKey), payload: { ...body, feeUSD: 22 } });
    expect(fast.statusCode, fast.body).toBe(201);
    g.release();
    const late = await first;
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json()).toEqual({ error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    const snapshot = await read(id, "courier-jobs");
    expect(entity(snapshot).feeUSD).toBe(22);
    expect(postedCount(snapshot)).toBe(1);
    const denied = await edit(id, "PATCH", bearer(posterKey), "courier-jobs");
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ error: "forbidden" });
    expect((await edit(id, "PATCH", bearer(strangerKey), "courier-jobs")).statusCode).toBe(200);
  });

  it("N355 X1: another caller's sequential id replay answers 409 on all create routes and writes nothing", async () => {
    const id = await create();
    const courier = await create(bearer(posterKey), "courier-jobs");
    const before = await read(id);
    const beforeCourier = await read(courier, "courier-jobs");
    const body = { id, capabilityType: "pizza.order", requirements: { shopId: "shop-p2", items: ["p2"] }, pricing: { amount: 99, currency: "USD", model: "fixed" } };
    await refused(id, () => app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(strangerKey), payload: body }), 409,
      { error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    expect(await read(id)).toEqual(before);
    for (const url of ["/api/courier-jobs", "/api/courier-jobs/jobs"]) {
      await refused(courier, () => app.inject({ method: "POST", url, headers: bearer(strangerKey), payload: {
        deliveryId: courier, pickup: { name: "PCC Shop", address: "1 Shop Way, SF" }, dropoff: { name: "USPS Rincon Center", address: "180 Steuart St, SF" }, feeUSD: 99,
      } }), 409, { error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." }, "courier-jobs");
      expect(await read(courier, "courier-jobs")).toEqual(beforeCourier);
    }
    reload();
    for (const [offerId, family] of [[id, "job-offers"], [courier, "courier-jobs"]] as const) {
      const denied = await edit(offerId, "PATCH", bearer(strangerKey), family);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json()).toMatchObject({ error: "forbidden" });
      expect((await edit(offerId, "PATCH", bearer(posterKey), family)).statusCode).toBe(200);
    }
  });

  it("N355 X2: another caller's sequential key replay answers 409 and creates no id or row", async () => {
    const key = `n355-${randomUUID()}`;
    const id = await create(bearer(posterKey), "job-offers", { idempotencyKey: key });
    const before = await read(id);
    const freshId = `n355-${randomUUID()}`;
    const body = { capabilityType: "pizza.order", requirements: { shopId: "shop-p2", items: ["p2"] }, pricing: { amount: 99, currency: "USD", model: "fixed" }, idempotencyKey: key };
    const withId = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(strangerKey), payload: { ...body, id: freshId } });
    expect(withId.statusCode, withId.body).toBe(409);
    expect(withId.json()).toEqual({ error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    expect((await app.inject({ method: "GET", url: path(freshId) })).statusCode).toBe(404);
    expect(await read(id)).toEqual(before);
    expect(rowsWithKey(key)).toBe(1);
    const opens = openCount();
    const noId = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(strangerKey), payload: body });
    expect(noId.statusCode, noId.body).toBe(409);
    expect(noId.json()).toEqual({ error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    expect(openCount()).toBe(opens);
    expect(await read(id)).toEqual(before);
  });

  it("N355 X3: a caller who may edit receives already posted by id or key and changes nothing", async () => {
    const key = `n355-${randomUUID()}`;
    const id = await create(bearer(posterKey), "job-offers", { idempotencyKey: key });
    const before = await read(id);
    const body = { capabilityType: "pizza.order", requirements: { shopId: "shop-replay", items: ["replay"] }, pricing: { amount: 99, currency: "USD", model: "fixed" } };
    const replay = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: { ...body, id } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, id, note: "already posted" });
    expect(await read(id)).toEqual(before);
    const freshId = `n355-${randomUUID()}`;
    const byKey = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: { ...body, id: freshId, idempotencyKey: key } });
    expect(byKey.statusCode, byKey.body).toBe(200);
    expect(byKey.json()).toMatchObject({ ok: true, id, note: "already posted" });
    expect((await app.inject({ method: "GET", url: path(freshId) })).statusCode).toBe(404);
    expect(await read(id)).toEqual(before);
    expect(postedCount(await read(id))).toBe(1);

    const walletKey = `n355-${randomUUID()}`;
    const walletId = await create(bearer(sessionKeyW1), "job-offers", { idempotencyKey: walletKey });
    const walletBefore = await read(walletId);
    const walletReplay = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(sessionKeyW2), payload: { ...body, id: walletId } });
    expect(walletReplay.statusCode, walletReplay.body).toBe(200);
    expect(walletReplay.json()).toMatchObject({ ok: true, id: walletId, note: "already posted" });
    expect(await read(walletId)).toEqual(walletBefore);
    const walletFreshId = `n355-${randomUUID()}`;
    const walletByKey = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(sessionKeyW2), payload: { ...body, id: walletFreshId, idempotencyKey: walletKey } });
    expect(walletByKey.statusCode, walletByKey.body).toBe(200);
    expect(walletByKey.json()).toMatchObject({ ok: true, id: walletId, note: "already posted" });
    expect((await app.inject({ method: "GET", url: path(walletFreshId) })).statusCode).toBe(404);
    expect(await read(walletId)).toEqual(walletBefore);
    expect(postedCount(await read(walletId))).toBe(1);

    const courier = await create(bearer(posterKey), "courier-jobs", { feeUSD: 11 });
    const courierBefore = await read(courier, "courier-jobs");
    const courierReplay = await app.inject({ method: "POST", url: "/api/courier-jobs/jobs", headers: bearer(posterKey), payload: {
      deliveryId: courier, pickup: { name: "PCC Shop", address: "1 Shop Way, SF" }, dropoff: { name: "USPS Rincon Center", address: "180 Steuart St, SF" }, feeUSD: 99,
    } });
    expect(courierReplay.statusCode, courierReplay.body).toBe(200);
    expect(courierReplay.json()).toMatchObject({ ok: true, id: courier, note: "already posted" });
    expect(await read(courier, "courier-jobs")).toEqual(courierBefore);
    expect(postedCount(await read(courier, "courier-jobs"))).toBe(1);
  });

  it("N355 X4: no-caller replays answer already posted only without a recorded identity and every conflict writes nothing", async () => {
    const store = getJobOffersStore();
    const input = (id: string): CreateJobOfferInput => ({ id, capabilityType: "pizza.order", requirements: { shopId: "shop-x4", items: ["x4"] }, pricing: { amount: 18.5, currency: "USD", model: "fixed" } });
    const callerP1 = offerCaller({ apiKeyId: posterKey.record!.id });
    const a = `n355-${randomUUID()}`;
    expect(await store.create(input(a))).toMatchObject({ ok: true, created: true });
    for (const replay of [await store.create(input(a)), await store.create(input(a), null)]) {
      expect(replay).toMatchObject({ ok: true, created: false, offer: { id: a } });
    }

    const b = `n355-${randomUUID()}`;
    expect(await store.create(input(b), callerP1)).toMatchObject({ ok: true, created: true });
    for (const caller of [undefined, null]) {
      const before = structuredClone(store.get(b));
      const beforeRow = row(b);
      expect(await store.create(input(b), caller)).toEqual({ ok: false, reason: "idempotency_conflict" });
      expect(store.get(b)).toEqual(before);
      expect(row(b)).toEqual(beforeRow);
      expect(store.getEvents(b).filter((entry) => entry.event === "posted")).toHaveLength(1);
    }

    const c = `n355-${randomUUID()}`;
    expect(await store.create(input(c))).toMatchObject({ ok: true, created: true });
    const beforeC = structuredClone(store.get(c));
    const rowC = row(c);
    expect(await store.create(input(c), callerP1)).toEqual({ ok: false, reason: "idempotency_conflict" });
    expect(store.get(c)).toEqual(beforeC);
    expect(row(c)).toEqual(rowC);
    expect(store.getEvents(c).filter((entry) => entry.event === "posted")).toHaveLength(1);

    const e = `n355-${randomUUID()}`;
    expect(await store.create({ ...input(e), posterDid: W })).toMatchObject({ ok: true, created: true });
    expect(await store.create(input(e), offerCaller({ provenWallet: W, provenWalletVia: "siwe-session" }))).toMatchObject({ ok: true, created: false, offer: { id: e } });
    const beforeE = structuredClone(store.get(e));
    const rowE = row(e);
    expect(await store.create(input(e), callerP1)).toEqual({ ok: false, reason: "idempotency_conflict" });
    expect(store.get(e)).toEqual(beforeE);
    expect(row(e)).toEqual(rowE);
    expect(store.getEvents(e).filter((entry) => entry.event === "posted")).toHaveLength(1);

    const f = `n355-${randomUUID()}`;
    const g = `n355-${randomUUID()}`;
    const key = `n355-${randomUUID()}`;
    expect(await store.create({ ...input(f), idempotencyKey: key }, callerP1)).toMatchObject({ ok: true, created: true });
    const beforeF = structuredClone(store.get(f));
    const rowF = row(f);
    expect(await store.create({ ...input(g), idempotencyKey: key })).toEqual({ ok: false, reason: "idempotency_conflict" });
    expect(store.get(f)).toEqual(beforeF);
    expect(row(f)).toEqual(rowF);
    expect(store.getEvents(f).filter((entry) => entry.event === "posted")).toHaveLength(1);
    expect(store.get(g)).toBeUndefined();
    expect(raw.prepare("SELECT data FROM job_offers WHERE id = ?").get(g)).toBeUndefined();

    const id = await create(unproven);
    const beforeHttp = await read(id);
    const replay = await app.inject({ method: "POST", url: "/api/job-offers", headers: unproven, payload: input(id) });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, id, note: "already posted" });
    expect(await read(id)).toEqual(beforeHttp);
    const beforeOffer = structuredClone(store.get(id));
    const beforeRow = row(id);
    const conflict = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(posterKey), payload: input(id) });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toEqual({ error: "idempotency_conflict", message: "This id or idempotencyKey belongs to another caller's offer." });
    expect(store.get(id)).toEqual(beforeOffer);
    expect(row(id)).toEqual(beforeRow);
    expect(store.getEvents(id).filter((entry) => entry.event === "posted")).toHaveLength(1);
    expect(await read(id)).toEqual(beforeHttp);
  });

  it("N355 K1: a claim records its claimer before the offer row is written", async () => {
    const id = await claimed();
    expect(row(id)._claimerDigest).toBe(createHash("sha256").update("key:" + claimerKey.record!.id, "utf8").digest("hex"));
    reload();
    await acceptedEvent(id, "in_progress", bearer(claimerKey), "in_progress", "claimer");
  });

  it("N355 K2: a courier claim records its claimer before the offer row is written", async () => {
    const id = await claimed("courier-jobs");
    expect(row(id)._claimerDigest).toBe(createHash("sha256").update("key:" + claimerKey.record!.id, "utf8").digest("hex"));
    reload();
    await acceptedEvent(id, "delivered", bearer(claimerKey), "delivered", "claimer", "courier-jobs");
  });

  it("N355 O1: the reserved event check comes before the identity check and writes nothing", async () => {
    const id = await create();
    await refused(id, () => event(id, "posted", unproven), 400, { error: "reserved_event", event: "posted" });
  });

  it("N355 O2: the identity check comes before the offer existence check", async () => {
    const result = await event(`n355-unknown-${randomUUID()}`, "note", unproven);
    expect(result.statusCode, result.body).toBe(401);
    expect(result.json()).toEqual(missingIdentity);
  });

  it("N355 O3: the poster check comes before the patch status check and writes nothing", async () => {
    const id = await claimed();
    const result = await refused(id, () => edit(id, "PATCH", bearer(strangerKey)), 403, { error: "forbidden", message: "You can only patch offers you posted" });
    expect(result.json()).not.toHaveProperty("currentStatus");
  });

  it("N355 V1: wallet proof origins are frozen and read-only before caller and buyer binding", () => {
    expect(BUYER_PROOF_SOURCES).not.toBeInstanceOf(Set);
    expect(Object.isFrozen(BUYER_PROOF_SOURCES)).toBe(true);
    expect(() => Set.prototype.add.call(BUYER_PROOF_SOURCES, "self-link:device")).toThrow(TypeError);
    expect(() => { (BUYER_PROOF_SOURCES as { has: unknown }).has = () => true; }).toThrow(TypeError);
    // @ts-expect-error BUYER_PROOF_SOURCES has no add method
    expect(() => BUYER_PROOF_SOURCES.add("self-link:device")).toThrow(TypeError);
    for (const source of ["self-link:agent", "siwe-session"]) expect(BUYER_PROOF_SOURCES.has(source)).toBe(true);
    for (const source of ["self-link:device", "", "SIWE-SESSION", " siwe-session", "self-link:agent:x"]) expect(BUYER_PROOF_SOURCES.has(source)).toBe(false);
    expect(offerCaller({ provenWallet: W, provenWalletVia: "self-link:device", apiKeyId: "k1" })).toEqual({ identity: "key:k1", wallet: null });
    expect(offerCaller({ provenWallet: W, provenWalletVia: "siwe-session", apiKeyId: "k1" })).toEqual({ identity: "wallet:" + W, wallet: W });
    expect(bindBuyer({ admin: false, provenWallet: W, provenWalletVia: "self-link:device" }, W)).toEqual({ ok: false, status: 403, body: BUYER_PROOF_REQUIRED });
    expect(bindBuyer({ admin: false, provenWallet: W, provenWalletVia: "siwe-session" }, W)).toEqual({ ok: true, buyer: W });
  });
});

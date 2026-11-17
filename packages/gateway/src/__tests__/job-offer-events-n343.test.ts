/** N343: exercise authorization, lifecycle and private persistence through the real gateway. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos, getStore } from "../db.js";
import { __resetRateLimitState } from "../middleware/rate-limiter.js";
import { identityDigest, offerCaller } from "../services/job-offer-event-rules.js";
import {
  _resetJobOffersStoreForTests, getJobOffersStore, initJobOffersStore,
  type SqliteDatabaseLike,
} from "../services/job-offers-store.js";

const W = "0x" + "ab".repeat(20);
const V = "0x" + "cd".repeat(20);
const missingIdentity = {
  error: "missing_identity", message: "This action needs your API key or a wallet sign-in.",
};
type Headers = Record<string, string>;
type Family = "job-offers" | "courier-jobs";
type Entity = { id: string; status: string; posterDid?: string | null; postedBy?: string | null; deliveredAt: string | null; cancelledAt: string | null };
type RecordedEvent = { event: string; by?: string; at: string; [key: string]: unknown };
type Snapshot = { offer?: Entity; job?: Entity; events: RecordedEvent[] };

describe("N343 real gateway offer authorization", () => {
  let app: FastifyInstance;
  let raw: SqliteDatabaseLike;
  let posterKey: ReturnType<typeof provisionApiKey>;
  let claimerKey: ReturnType<typeof provisionApiKey>;
  let strangerKey: ReturnType<typeof provisionApiKey>;
  let sessionKeyW1: ReturnType<typeof provisionApiKey>;
  let sessionKeyW2: ReturnType<typeof provisionApiKey>;
  let forgedPosterKey: string;
  let forgedWalletKey: string;
  let forgedClaimerKey: string;
  let cookieW: Headers;
  let cookieV: Headers;
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
    const id = `n343-${randomUUID()}`;
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
  const sideBody = (need: "claimer" | "poster" | "poster_or_claimer") => ({
    error: "not_participant", need,
    message: need === "claimer" ? "Only the offer's claimer may send this event."
      : need === "poster" ? "Only the offer's poster may send this event."
        : "Only the offer's poster or its claimer may send events.",
  });
  const refused = async (id: string, request: () => ReturnType<typeof event>, status: number, body?: unknown, family: Family = "job-offers") => {
    const before = await read(id, family);
    const result = await request();
    expect(result.statusCode, result.body).toBe(status);
    if (body !== undefined) expect(result.json()).toEqual(body);
    expect(await read(id, family)).toEqual(before);
    return result;
  };
  const refuseEvent = (id: string, kind: string, headers: Headers, need: "claimer" | "poster" | "poster_or_claimer", family: Family = "job-offers") => refused(id, () => event(id, kind, headers, family), 403, sideBody(need), family);
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
  const refusedPosterActions = async (id: string, headers: Headers, family: Family = "job-offers") => {
    await refuseEvent(id, "cancelled", headers, "poster", family);
    for (const action of ["PATCH", "DELETE", "heartbeat"] as const) {
      const result = await refused(id, () => edit(id, action, headers, family), 403, undefined, family);
      expect(result.json()).toMatchObject({ error: "forbidden" });
    }
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
  const expire = async (id: string) => {
    const result = await app.inject({ method: "PATCH", url: path(id), headers: bearer(posterKey), payload: { validUntil: "2000-01-01T00:00:00.000Z" } });
    expect(result.statusCode, result.body).toBe(200);
    await getJobOffersStore().sweep();
    expect(entity(await read(id)).status).toBe("expired");
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
    strangerKey = provisionApiKey({ operatorId: "stranger@example.com", scopes: ["*"] });
    sessionKeyW1 = provisionApiKey({ operatorId: W, scopes: ["*"], metadata: { source: "siwe-session" } });
    sessionKeyW2 = provisionApiKey({ operatorId: W, scopes: ["*"], metadata: { source: "siwe-session" } });
    const forge = async (payload: Record<string, unknown>) => {
      const result = await app.inject({ method: "POST", url: "/api/auth/provision", payload });
      expect(result.statusCode, result.body).toBe(201);
      const key = result.json<{ api_key: string }>().api_key;
      expect(typeof key).toBe("string");
      return key;
    };
    forgedPosterKey = await forge({ email: "poster@example.com" });
    forgedWalletKey = await forge({ walletAddress: W });
    forgedClaimerKey = await forge({ email: "claimer@example.com" });
    const session = (walletAddress: string): Headers => {
      const token = `n343-session-${randomUUID()}`;
      const now = Date.now();
      getRepos().sessions.insert({ id: token, token, walletAddress, createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() });
      return { cookie: `pcc_session=${app.signCookie(token)}` };
    };
    cookieW = session(W);
    cookieV = session(V);
    unproven = { ...cookieW, authorization: "Bearer pcc_not_a_key" };
  }, 120_000);

  // Each cell exercises authentication with the real gate, independently of the per-IP request budget.
  beforeEach(() => { __resetRateLimitState(); });

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (previousDbPath === undefined) delete process.env.PCC_DB_PATH;
      else process.env.PCC_DB_PATH = previousDbPath;
    }
  });

  it("N343 U1: offerCaller follows the proven wallet, key, and no-identity table", () => {
    const cases: Array<[{ provenWallet?: unknown; provenWalletVia?: unknown; apiKeyId?: unknown; operatorId?: unknown; userId?: unknown; headers?: unknown; body?: unknown }, unknown]> = [
      [{ provenWallet: "0x" + "AB".repeat(20), provenWalletVia: "siwe-session", apiKeyId: "k1" }, { identity: "wallet:" + W, wallet: W }],
      [{ provenWallet: "0x" + "AB".repeat(20), provenWalletVia: "self-link:agent", apiKeyId: "k1" }, { identity: "wallet:" + W, wallet: W }],
      [{ provenWallet: W, provenWalletVia: "self-link:device", apiKeyId: "k1" }, { identity: "key:k1", wallet: null }],
      [{ provenWallet: W, provenWalletVia: "self-link:device" }, null],
      [{ provenWallet: "not-a-wallet", provenWalletVia: "siwe-session", apiKeyId: "k1" }, { identity: "key:k1", wallet: null }],
      [{ apiKeyId: "k1", operatorId: "o", userId: "u" }, { identity: "key:k1", wallet: null }],
      [{ operatorId: "o", userId: "u" }, null],
      [{ apiKeyId: "" }, null],
      [{}, null],
      [{ headers: { "x-posted-by": W }, body: { by: W, driverAgent: W } }, null],
    ];
    for (const [input, expected] of cases) expect(offerCaller(input)).toEqual(expected);
  });

  it("N343 U2: identityDigest is the UTF-8 SHA-256 hexadecimal digest", () => {
    expect(identityDigest("key:k1")).toBe(createHash("sha256").update("key:k1", "utf8").digest("hex"));
  });

  it("N343 A1: a stranger cannot deliver a claimed offer", async () => {
    await refuseEvent(await claimed(), "delivered", bearer(strangerKey), "claimer");
  });
  it("N343 A2: a stranger cannot cancel an open offer", async () => {
    await refuseEvent(await create(), "cancelled", bearer(strangerKey), "poster");
  });
  it("N343 A3: a stranger cannot append a neutral note", async () => {
    await refuseEvent(await claimed(), "note", bearer(strangerKey), "poster_or_claimer");
  });
  it("N343 A4: even the poster cannot deliver the claimer's offer", async () => {
    const id = await claimed();
    await refuseEvent(id, "delivered", bearer(posterKey), "claimer");
    expect(entity(await read(id)).status).toBe("claimed");
  });
  it("N343 A5: the poster cannot send in_progress or pickup", async () => {
    const id = await claimed();
    for (const kind of ["in_progress", "pickup"]) await refuseEvent(id, kind, bearer(posterKey), "claimer");
  });
  it("N343 A6: the claimer cannot send cancelled", async () => {
    const id = await claimed();
    await refuseEvent(id, "cancelled", bearer(claimerKey), "poster");
    expect(entity(await read(id)).status).toBe("claimed");
  });
  it("N343 A7: the claimer advances in_progress then delivered with role attribution", async () => {
    const id = await claimed();
    await acceptedEvent(id, "in_progress", bearer(claimerKey), "in_progress", "claimer");
    await acceptedEvent(id, "delivered", bearer(claimerKey), "delivered", "claimer");
  });
  it("N343 A8: pickup advances claimed to in_progress", async () => {
    await acceptedEvent(await claimed(), "pickup", bearer(claimerKey), "in_progress", "claimer");
  });
  it("N343 A9: the poster cancels open, claimed, and in_progress offers", async () => {
    const open = await create();
    const held = await claimed();
    const working = await claimed();
    await acceptedEvent(working, "in_progress", bearer(claimerKey), "in_progress", "claimer");
    for (const id of [open, held, working]) await acceptedEvent(id, "cancelled", bearer(posterKey), "cancelled", "poster");
  });
  it("N343 A10: terminal states reject each forbidden lifecycle transition without mutation", async () => {
    const delivered = await claimed();
    await acceptedEvent(delivered, "delivered", bearer(claimerKey), "delivered", "claimer");
    const cancelled = await claimed();
    await acceptedEvent(cancelled, "cancelled", bearer(posterKey), "cancelled", "poster");
    const expired = await create();
    await expire(expired);
    for (const [id, kind, status, key] of [
      [delivered, "delivered", "delivered", claimerKey],
      [cancelled, "delivered", "cancelled", claimerKey],
      [delivered, "in_progress", "delivered", claimerKey],
      [cancelled, "pickup", "cancelled", claimerKey],
      [delivered, "cancelled", "delivered", posterKey],
      [cancelled, "cancelled", "cancelled", posterKey],
      [expired, "cancelled", "expired", posterKey],
    ] as const) await refused(id, () => event(id, kind, bearer(key)), 409, { error: "invalid_transition", event: kind, currentStatus: status });
  });
  it("N343 A11: in_progress may repeat while in_progress", async () => {
    const id = await claimed();
    await acceptedEvent(id, "in_progress", bearer(claimerKey), "in_progress", "claimer");
    await acceptedEvent(id, "in_progress", bearer(claimerKey), "in_progress", "claimer");
  });
  it("N343 A12: neither participant can send a server-only kind", async () => {
    const id = await claimed();
    for (const kind of ["posted", "claimed", "patched", "heartbeat", "expired", "deleted_by_poster", "settled", "disputed", "open"]) {
      for (const key of [posterKey, claimerKey]) await refused(id, () => event(id, kind, bearer(key)), 400, { error: "reserved_event", event: kind });
    }
  });
  it("N343 A13: apiGate refuses every write without a credential despite caller-chosen labels", async () => {
    const id = await create();
    const headers = { "x-posted-by": "poster@example.com" };
    await refused(id, () => event(id, "cancelled", headers, "job-offers", { by: "poster@example.com" }), 401);
    await refused(id, () => claim(id, headers), 401);
    for (const action of ["PATCH", "DELETE", "heartbeat"] as const) await refused(id, () => edit(id, action, headers), 401);
  });
  it("N343 A14: an unproven cookie fallback cannot use its matching public posterDid", async () => {
    const id = await create(cookieW);
    expect(getJobOffersStore().get(id)?.posterDid).toBe(W);
    expect(entity(await read(id))).not.toHaveProperty("posterDid");
    const headers = { ...unproven, "x-posted-by": W };
    await refused(id, () => event(id, "cancelled", headers), 401, missingIdentity);
    const other = await create();
    await refused(other, () => claim(other, headers), 401, missingIdentity);
    for (const action of ["PATCH", "DELETE", "heartbeat"] as const) await refused(id, () => edit(id, action, headers), 401, missingIdentity);
  });
  it("N343 A15: a proven cookie wallet may cancel its own offer as poster", async () => {
    const id = await create(cookieW);
    expect(getJobOffersStore().get(id)?.posterDid).toBe(W);
    expect(entity(await read(id))).not.toHaveProperty("posterDid");
    await acceptedEvent(id, "cancelled", cookieW, "cancelled", "poster");
  });
  it("N343 A16: note by records the participant role and ignores the request body", async () => {
    const id = await claimed();
    await acceptedEvent(id, "note", bearer(claimerKey), "claimed", "claimer", "job-offers", { by: "poster@example.com" });
    await acceptedEvent(id, "note", bearer(posterKey), "claimed", "poster", "job-offers", { by: "claimer@example.com" });
    const bothRoles = await claimed("job-offers", bearer(posterKey));
    await acceptedEvent(bothRoles, "note", bearer(posterKey), "claimed", "claimer", "job-offers", { by: "poster" });
  });
  it("N343 A17: participants' neutral and unknown events leave status unchanged", async () => {
    await acceptedEvent(await create(), "note", bearer(posterKey), "open", "poster");
    const id = await claimed();
    for (const kind of ["progress_update", "acknowledged", "error", "custom_kind"]) await acceptedEvent(id, kind, bearer(claimerKey), "claimed", "claimer");
  });
  it("N343 A18: object prototype property names are ordinary neutral unknown kinds", async () => {
    const id = await claimed();
    for (const kind of ["toString", "__proto__", "constructor", "hasOwnProperty"]) await acceptedEvent(id, kind, bearer(claimerKey), "claimed", "claimer");
  });
  it("N343 A19: a missing caller cannot claim or poison a later authenticated claim", async () => {
    const id = await create();
    await refused(id, () => claim(id, unproven), 401, missingIdentity);
    const before = await read(id);
    expect(entity(before).status).toBe("open");
    expect(before.events.some((entry) => entry.event === "claimed")).toBe(false);
    const result = await claim(id, bearer(claimerKey));
    expect(result.statusCode, result.body).toBe(200);
  });
  it("N343 A20: a losing claimant acquires no claimer role", async () => {
    const id = await claimed();
    const result = await refused(id, () => claim(id, bearer(strangerKey)), 409);
    expect(result.json()).toMatchObject({ error: "not_open", currentStatus: "claimed" });
    await refuseEvent(id, "delivered", bearer(strangerKey), "claimer");
    await acceptedEvent(id, "delivered", bearer(claimerKey), "delivered", "claimer");
  });
  it("N343 A21: an idempotent create replay never transfers the poster role", async () => {
    const id = await create();
    const before = await read(id);
    const replay = await app.inject({ method: "POST", url: "/api/job-offers", headers: bearer(strangerKey), payload: { id, capabilityType: "pizza.order", requirements: { shopId: "shop-1", items: ["margherita"] }, pricing: { amount: 18.5, currency: "USD", model: "fixed" } } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ id, note: "already posted" });
    expect(await read(id)).toEqual(before);
    await refuseEvent(id, "cancelled", bearer(strangerKey), "poster");
    expect((await edit(id, "PATCH", bearer(posterKey))).statusCode).toBe(200);
  });

  it("N343 F1: a self-service key naming the poster email cannot cancel or edit either family", async () => {
    for (const family of ["job-offers", "courier-jobs"] as const) {
      const id = await create(bearer(posterKey), family);
      const snapshot = await read(id, family);
      expect(getJobOffersStore().get(id)?.posterDid).toBe("poster@example.com");
      expect(entity(snapshot)).not.toHaveProperty(family === "job-offers" ? "posterDid" : "postedBy");
      await refusedPosterActions(id, bearer(forgedPosterKey), family);
    }
  });
  it("N343 F2: a self-service key naming an unproven wallet cannot cancel or edit either family", async () => {
    for (const family of ["job-offers", "courier-jobs"] as const) {
      const id = await create(bearer(sessionKeyW1), family);
      const snapshot = await read(id, family);
      expect(getJobOffersStore().get(id)?.posterDid).toBe(W);
      expect(entity(snapshot)).not.toHaveProperty(family === "job-offers" ? "posterDid" : "postedBy");
      await refusedPosterActions(id, bearer(forgedWalletKey), family);
    }
  });
  it("N343 F3: a self-service key naming the claimer email acquires no claimer role", async () => {
    const id = await claimed();
    for (const kind of ["in_progress", "pickup", "delivered"]) await refuseEvent(id, kind, bearer(forgedClaimerKey), "claimer");
    const courier = await claimed("courier-jobs");
    for (const kind of ["pickup", "delivered"]) await refuseEvent(courier, kind, bearer(forgedClaimerKey), "claimer", "courier-jobs");
  });
  it("N343 K1: posting and claiming keys retain their own authorized writes in both families", async () => {
    for (const family of ["job-offers", "courier-jobs"] as const) {
      const id = await create(bearer(posterKey), family);
      for (const action of ["PATCH", "heartbeat", "DELETE"] as const) {
        const result = await edit(id, action, bearer(posterKey), family);
        expect(result.statusCode, result.body).toBe(200);
        expect((await read(id, family)).events.at(-1)).toMatchObject({ by: "poster" });
      }
      await acceptedEvent(await create(bearer(posterKey), family), "cancelled", bearer(posterKey), "cancelled", "poster", family);
      const held = await claimed(family);
      if (family === "job-offers") await acceptedEvent(held, "in_progress", bearer(claimerKey), "in_progress", "claimer");
      await acceptedEvent(held, "pickup", bearer(claimerKey), family === "job-offers" ? "in_progress" : "in_transit", "claimer", family);
      await acceptedEvent(held, "delivered", bearer(claimerKey), "delivered", "claimer", family);
    }
  });
  it("N343 K2: a legacy wallet poster accepts only that proven wallet", async () => {
    const ids = [await create(bearer(sessionKeyW1)), await create(bearer(sessionKeyW1)), await create(bearer(sessionKeyW1))];
    for (const id of ids) rewrite(id, (data) => { delete data._posterDigest; });
    reload();
    await acceptedEvent(ids[0]!, "cancelled", cookieW, "cancelled", "poster");
    for (const action of ["PATCH", "heartbeat", "DELETE"] as const) expect((await edit(ids[1]!, action, cookieW)).statusCode).toBe(200);
    await refusedPosterActions(ids[2]!, cookieV);
  });
  it("N343 K3: rotating SIWE keys and cookies share a wallet's claimer identity", async () => {
    const fromKey = await claimed("job-offers", bearer(sessionKeyW1));
    await acceptedEvent(fromKey, "delivered", bearer(sessionKeyW2), "delivered", "claimer");
    const fromCookie = await claimed("job-offers", cookieW);
    await acceptedEvent(fromCookie, "delivered", bearer(sessionKeyW2), "delivered", "claimer");
  });

  it("N343 P1: both digests survive neutral events and poster heartbeats before reload", async () => {
    const id = await claimed();
    await acceptedEvent(id, "note", bearer(claimerKey), "claimed", "claimer");
    reload();
    await refuseEvent(id, "pickup", bearer(forgedClaimerKey), "claimer");
    await acceptedEvent(id, "delivered", bearer(claimerKey), "delivered", "claimer");
    const data = row(id);
    expect(data._claimerDigest).toBe(createHash("sha256").update("key:" + claimerKey.record!.id, "utf8").digest("hex"));
    expect(data._posterDigest).toBe(createHash("sha256").update("key:" + posterKey.record!.id, "utf8").digest("hex"));
    expect(JSON.stringify(data)).not.toContain("key:");
    expect(JSON.stringify(data)).not.toContain("claimer@example.com");
    const second = await claimed();
    expect((await edit(second, "heartbeat", bearer(posterKey))).statusCode).toBe(200);
    reload();
    await acceptedEvent(second, "delivered", bearer(claimerKey), "delivered", "claimer");
  });
  it("N343 P2: the posting digest survives a PATCH and reload", async () => {
    const id = await create();
    expect((await edit(id, "PATCH", bearer(posterKey))).statusCode).toBe(200);
    reload();
    expect((await edit(id, "heartbeat", bearer(posterKey))).statusCode).toBe(200);
    const result = await refused(id, () => edit(id, "heartbeat", bearer(forgedPosterKey)), 403);
    expect(result.json()).toMatchObject({ error: "forbidden" });
  });
  it("N343 P3: the posting digest survives sweep expiration and reload", async () => {
    const id = await create();
    await expire(id);
    reload();
    expect((await edit(id, "heartbeat", bearer(posterKey))).statusCode).toBe(200);
    const result = await refused(id, () => edit(id, "heartbeat", bearer(strangerKey)), 403);
    expect(result.json()).toMatchObject({ error: "forbidden" });
  });
  it("N343 P4: a legacy claim fails closed while its recorded poster can cancel", async () => {
    const id = await claimed();
    rewrite(id, (data) => { delete data._claimerDigest; });
    reload();
    await refuseEvent(id, "delivered", bearer(claimerKey), "claimer");
    await refuseEvent(id, "note", bearer(strangerKey), "poster_or_claimer");
    await acceptedEvent(id, "cancelled", bearer(posterKey), "cancelled", "poster");
  });
  it("N343 P5: malformed private digests are rejected and stripped from all served offers", async () => {
    const ids: string[] = [];
    for (const digest of ["x", 7, "a".repeat(63)]) {
      const id = await claimed();
      ids.push(id);
      rewrite(id, (data) => { data._claimerDigest = digest; });
    }
    const badPoster = await create();
    rewrite(badPoster, (data) => { data._posterDigest = "x"; });
    reload();
    for (const id of ids) await refuseEvent(id, "delivered", bearer(claimerKey), "claimer");
    await refuseEvent(badPoster, "cancelled", bearer(posterKey), "poster");
    for (const id of [...ids, badPoster]) {
      const served = JSON.stringify(await read(id));
      expect(served).not.toContain("_claimerDigest");
      expect(served).not.toContain("_posterDigest");
    }
  });
  it("N343 R1: claims, PATCH replies, details and both open feeds never expose identity digests", async () => {
    const held = await create();
    const claimedResponse = await claim(held, bearer(claimerKey));
    expect(claimedResponse.statusCode, claimedResponse.body).toBe(200);
    const open = await create();
    const courier = await claimed("courier-jobs");
    await create(bearer(posterKey), "courier-jobs");
    const forbiddenStrings = ["_claimerDigest", "_posterDigest", "key:", "wallet:",
      createHash("sha256").update("key:" + claimerKey.record!.id, "utf8").digest("hex"),
      createHash("sha256").update("key:" + posterKey.record!.id, "utf8").digest("hex")];
    for (const afterReload of [false, true]) {
      if (afterReload) reload();
      const patched = await edit(open, "PATCH", bearer(posterKey));
      expect(patched.statusCode, patched.body).toBe(200);
      const responses = [claimedResponse, patched];
      for (const url of [path(held), path(open), "/api/job-offers/open?capabilityType=pizza.order", path(courier, "courier-jobs"), "/api/courier-jobs/open"]) {
        const result = await app.inject({ method: "GET", url });
        expect(result.statusCode, result.body).toBe(200);
        responses.push(result);
      }
      for (const response of responses) for (const secret of forbiddenStrings) expect(response.body).not.toContain(secret);
    }
  });

  it("N343 N1: a callerless offer with a null posterDid has no poster", async () => {
    const result = await getJobOffersStore().create({ capabilityType: "pizza.order", requirements: { shopId: "shop-1", items: ["margherita"] }, pricing: { amount: 18.5, currency: "USD", model: "fixed" }, posterDid: null });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("create failed");
    for (const headers of [bearer(posterKey), bearer(strangerKey), cookieW]) await refusedPosterActions(result.offer.id, headers);
  });
  it("N343 N2: an email posterDid alone confers no poster identity", async () => {
    const result = await getJobOffersStore().create({ capabilityType: "pizza.order", requirements: { shopId: "shop-1", items: ["margherita"] }, pricing: { amount: 18.5, currency: "USD", model: "fixed" }, posterDid: "poster@example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("create failed");
    await refusedPosterActions(result.offer.id, bearer(posterKey));
  });
  it("N343 C1: a stranger cannot deliver a claimed courier job", async () => {
    await refuseEvent(await claimed("courier-jobs"), "delivered", bearer(strangerKey), "claimer", "courier-jobs");
  });
  it("N343 C2: courier pickup and delivery use the claimer role despite a forged driver label", async () => {
    const id = await claimed("courier-jobs");
    await acceptedEvent(id, "pickup", bearer(claimerKey), "in_transit", "claimer", "courier-jobs", { driverAgent: "someone-else" });
    await acceptedEvent(id, "delivered", bearer(claimerKey), "delivered", "claimer", "courier-jobs", { driverAgent: "someone-else" });
  });
  it("N343 C3: courier cancellation belongs to the poster alone", async () => {
    await acceptedEvent(await claimed("courier-jobs"), "cancelled", bearer(posterKey), "cancelled", "poster", "courier-jobs");
    await refuseEvent(await claimed("courier-jobs"), "cancelled", bearer(claimerKey), "poster", "courier-jobs");
  });
  it("N343 C4: courier delivery cannot repeat and pickup cannot follow delivery", async () => {
    const id = await claimed("courier-jobs");
    await acceptedEvent(id, "delivered", bearer(claimerKey), "delivered", "claimer", "courier-jobs");
    for (const kind of ["delivered", "pickup"]) await refused(id, () => event(id, kind, bearer(claimerKey), "courier-jobs"), 409, { error: "invalid_transition", event: kind, currentStatus: "delivered" }, "courier-jobs");
  });
  it("N343 C5: a courier claim requires a proven caller and leaves the open job untouched", async () => {
    const id = await create(bearer(posterKey), "courier-jobs");
    await refused(id, () => claim(id, unproven, "courier-jobs"), 401, missingIdentity, "courier-jobs");
    expect(entity(await read(id, "courier-jobs")).status).toBe("open");
  });
  it("N343 C6: a body driverAgent cannot authorize courier events without a proven caller", async () => {
    const id = await claimed("courier-jobs");
    for (const kind of ["pickup", "delivered", "cancelled", "note"]) await refused(id, () => event(id, kind, unproven, "courier-jobs", { driverAgent: "d-1" }), 401, missingIdentity, "courier-jobs");
  });
});

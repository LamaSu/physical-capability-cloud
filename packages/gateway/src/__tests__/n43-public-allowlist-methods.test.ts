/**
 * Board N43, gate half (orchestrator #7167 / #7248; steward ruling #2637).
 *
 * apiGate's PUBLIC_PREFIXES matched with a raw startsWith and ignored the method. So the
 * "/api/marketplace/" prefix, meant for browsing, also made POST/PUT/DELETE
 * /api/marketplace/listings(/:id) and POST /api/marketplace/orders public: an anonymous caller could
 * create a listing, rewrite or delete ANY listing, and place orders in the in-memory mock. Every public
 * entry now declares its method; a prefix opens GET only (HEAD follows GET) and matches on a
 * path-segment boundary.
 *
 * - Marketplace (steward #2637): the surface is retiring (kits #2523), so its writes get 410 for EVERY
 *   caller, keyed or not, and no ownership logic is built for it. POST /api/marketplace/roi (pure
 *   computation, stores nothing) and the marketplace reads stay public.
 * - DHT announce: POST /api/dht/announce was dead on master. The public "/api/dht/" prefix meant apiGate
 *   never set req.apiKeyId or req.userId, so the handler answered 401 to everyone. Once "/api/dht/" is
 *   public for GET only, apiGate authenticates the POST, and any key would reach a handler that stores
 *   and gossips ANY kernelId with no owner binding. A route-level onRequest hook keeps it refused (501
 *   DHT_ANNOUNCE_DISABLED). apiGate's onRequest hook runs first, so an anonymous caller gets apiGate's 401.
 * - Segment boundary: "/api/health" opens "/api/health" and the paths below it, never a sibling such as
 *   "/api/healthcheck-debug".
 *
 * The marketplace and DHT tests run on the real gateway (createGateway), in production hook order.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { randomUUID } from "node:crypto";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

let app: FastifyInstance;
let apiKey = "";
let siweToken = "";

// A distinct client address per request (the gateway trusts X-Forwarded-For), so no per-IP limiter or
// monitor state carries over from one request to the next.
let ipSeq = 0;
function clientIp(): string {
  ipSeq += 1;
  return `10.43.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

type Caller = "anonymous" | "an API key" | "a SIWE session";
const CALLERS: readonly Caller[] = ["anonymous", "an API key", "a SIWE session"];

function headersFor(caller: Caller): Record<string, string> {
  const headers: Record<string, string> = { "x-forwarded-for": clientIp() };
  if (caller === "an API key") headers.authorization = `Bearer ${apiKey}`;
  if (caller === "a SIWE session") headers.authorization = `Bearer ${siweToken}`;
  return headers;
}

function send(caller: Caller, opts: InjectOptions) {
  return app.inject({ ...opts, headers: { ...headersFor(caller), ...(opts.headers ?? {}) } });
}

function body(res: { body: string }): Record<string, unknown> {
  try {
    return JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return { raw: res.body };
  }
}

beforeAll(async () => {
  const server = await import("../server.js");
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready(); // no listen(): every request below is app.inject

  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  const { getRepos } = await import("../db.js");
  // Self-service provisioning mints scopes ["*"]: the most a key can hold.
  apiKey = provisionApiKey({ operatorId: "n43-keyed-caller" }).rawKey;
  siweToken = randomUUID();
  const now = new Date();
  getRepos().sessions.insert({
    id: randomUUID(),
    walletAddress: "0xabc0000000000000000000000000000000000043",
    token: siweToken,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    lastActiveAt: now.toISOString(),
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) Marketplace: retired writes are 410 for every caller; reads and the ROI calculator stay public.
// ─────────────────────────────────────────────────────────────────────────────

interface Listing {
  id: string;
  inStock: boolean;
}

/** The whole observable marketplace mock: every listing and every order. */
async function marketplaceState() {
  const listings = await send("anonymous", { method: "GET", url: "/api/marketplace/listings" });
  const orders = await send("anonymous", { method: "GET", url: "/api/marketplace/orders" });
  expect(listings.statusCode).toBe(200);
  expect(orders.statusCode).toBe(200);
  return { listings: body(listings), orders: body(orders) };
}

/** The four registered marketplace writes, each with a body the old handler accepted in full. */
function marketplaceWrites(listingId: string): InjectOptions[] {
  return [
    {
      method: "POST",
      url: "/api/marketplace/listings",
      payload: { name: "n43 forged listing", category: "other", pricePerUnit: 1, unit: "each", sellerId: "someone-else" },
    },
    { method: "PUT", url: `/api/marketplace/listings/${listingId}`, payload: { name: "n43 rewritten", pricePerUnit: 0.01 } },
    { method: "POST", url: "/api/marketplace/orders", payload: { listingId, quantity: 1, buyerId: "someone-else" } },
    { method: "DELETE", url: `/api/marketplace/listings/${listingId}` },
  ];
}

describe("N43 (a): the retired marketplace writes are 410 for every caller, and the mock never changes", () => {
  it.each(CALLERS)("%s gets 410 on POST/PUT/DELETE /api/marketplace/listings(/:id) and POST /api/marketplace/orders", async (caller) => {
    const before = await marketplaceState();
    const target = (before.listings.listings as Listing[]).find((l) => l.inStock);
    expect(target, "the mock has an in-stock listing to aim at").toBeDefined();

    const results = [];
    for (const write of marketplaceWrites(target!.id)) {
      const res = await send(caller, write);
      results.push({ request: `${write.method} ${write.url}`, status: res.statusCode, error: body(res).error });
    }

    expect(results).toEqual(
      marketplaceWrites(target!.id).map((w) => ({
        request: `${w.method} ${w.url}`,
        status: 410,
        error: "marketplace_writes_retired",
      })),
    );
    expect(await marketplaceState()).toEqual(before);
  });

  it.each(CALLERS)("%s gets 410 for a write the marketplace never registered (default deny: PATCH, or a new POST path)", async (caller) => {
    const before = await marketplaceState();
    const id = (before.listings.listings as Listing[])[0]!.id;
    for (const write of [
      { method: "PATCH", url: `/api/marketplace/listings/${id}`, payload: { pricePerUnit: 0.01 } },
      { method: "POST", url: "/api/marketplace/listings/bulk-import", payload: {} },
      { method: "PUT", url: "/api/marketplace/orders/ord-demo-001", payload: { status: "cancelled" } },
    ] as InjectOptions[]) {
      const res = await send(caller, write);
      expect({ status: res.statusCode, error: body(res).error }, `${write.method} ${write.url}`).toEqual({
        status: 410,
        error: "marketplace_writes_retired",
      });
    }
    expect(await marketplaceState()).toEqual(before);
  });

  it("the marketplace reads stay public: an anonymous GET of the listings, one listing, and their HEAD", async () => {
    const state = await marketplaceState(); // asserts 200 on GET /api/marketplace/listings and /orders
    const id = (state.listings.listings as Listing[])[0]!.id;
    for (const opts of [
      { method: "GET", url: "/api/marketplace/listings" },
      { method: "GET", url: `/api/marketplace/listings/${id}` },
      { method: "GET", url: "/api/marketplace/categories" },
      { method: "HEAD", url: "/api/marketplace/listings" },
    ] as InjectOptions[]) {
      const res = await send("anonymous", opts);
      expect(res.statusCode, `${opts.method} ${opts.url}`).toBe(200);
    }
  });

  it.each(CALLERS)("POST /api/marketplace/roi stays public for %s: pure computation that stores nothing", async (caller) => {
    const before = await marketplaceState();
    const res = await send(caller, {
      method: "POST",
      url: "/api/marketplace/roi",
      payload: { monthlyCost: 200, avgJobValue: 30, utilization: 65 },
    });
    expect(res.statusCode).toBe(200);
    expect((body(res).projection as unknown[]).length).toBe(25);
    expect(await marketplaceState()).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) DHT announce stays refused; nothing is stored or gossiped.
// ─────────────────────────────────────────────────────────────────────────────

const PROBE_TYPE = "n43-dht-poison-probe";

/** An announcement the old handler stored in full: another operator's kernel id, a caller-chosen DID. */
const ANNOUNCEMENT = {
  kernelId: "kernel-owned-by-someone-else",
  kernelDid: "did:pcc:kernel-owned-by-someone-else",
  capabilities: [{ type: PROBE_TYPE }],
  endpoints: [{ transport: "websocket-relay", url: "wss://attacker.example/ws", priority: 1 }],
  ttlSeconds: 3600,
};

/** What the DHT registry holds, read through its public GET routes. */
async function dhtState() {
  const peers = await send("anonymous", { method: "GET", url: "/api/dht/peers" });
  const metrics = await send("anonymous", { method: "GET", url: "/api/dht/metrics" });
  const probe = await send("anonymous", { method: "GET", url: `/api/dht/query?type=${PROBE_TYPE}` });
  expect([peers.statusCode, metrics.statusCode, probe.statusCode]).toEqual([200, 200, 200]);
  return {
    storedAnnouncements: body(peers).totalAnnouncements,
    announcementsEverStored: (body(metrics).metrics as { announcementsTotal: number }).announcementsTotal,
    probeTypeResults: body(probe).count,
  };
}

describe("N43 (d): POST /api/dht/announce stays refused and nothing is stored", () => {
  // Each test compares the response AND the registry in one assertion, so a failure shows both what
  // the caller got and what was stored.
  it("an anonymous caller is refused by apiGate itself (401 api_key_required), before the route", async () => {
    const before = await dhtState();
    expect(before.probeTypeResults).toBe(0);
    const res = await send("anonymous", { method: "POST", url: "/api/dht/announce", payload: ANNOUNCEMENT });
    expect({ status: res.statusCode, error: body(res).error, registry: await dhtState() }).toEqual({
      status: 401,
      error: "api_key_required",
      registry: before,
    });
  });

  it.each(["an API key", "a SIWE session"] as const)(
    "%s passes apiGate and gets the route's explicit refusal (501 DHT_ANNOUNCE_DISABLED); nothing is stored",
    async (caller) => {
      // announcementsEverStored counts every store, even one that overwrites an entry, so any store shows.
      const before = await dhtState();
      const res = await send(caller, { method: "POST", url: "/api/dht/announce", payload: ANNOUNCEMENT });
      expect({ status: res.statusCode, error: body(res).error, code: body(res).code, registry: await dhtState() }).toEqual({
        status: 501,
        error: "not_implemented",
        code: "DHT_ANNOUNCE_DISABLED",
        registry: before,
      });
      expect(typeof body(res).message).toBe("string");
    },
  );

  it("the refusal comes before any body parsing: a keyed caller with a non-JSON body still gets 501", async () => {
    const before = await dhtState();
    const res = await send("an API key", {
      method: "POST",
      url: "/api/dht/announce",
      headers: { "content-type": "text/plain" },
      payload: "not json",
    });
    expect({ status: res.statusCode, code: body(res).code, registry: await dhtState() }).toEqual({
      status: 501,
      code: "DHT_ANNOUNCE_DISABLED",
      registry: before,
    });
  });

  it("DHT discovery stays public: an anonymous GET of query, peers and metrics is 200", async () => {
    for (const url of ["/api/dht/query", "/api/dht/peers", "/api/dht/metrics"]) {
      const res = await send("anonymous", { method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Segment boundary: a sibling that shares a prefix's characters is not public.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Siblings of every public entry that master matched as a raw prefix. None of these routes exists; each
 * would have been public, for every method, the moment someone registered it.
 */
const SIBLINGS = [
  "/api/healthcheck-debug",
  "/api/auth/validate-admin",
  "/api/auth/provision-admin",
  "/api/waitlist-admin",
  "/api/beta-apply-export",
  "/api/feedback-export",
  "/api/admin/feedbacks-all",
  "/api/onboard/identify-device-log",
  "/api/onboard/chatlog",
];

describe("N43 (b): public prefixes match only on a path-segment boundary", () => {
  let mini: FastifyInstance;

  beforeAll(async () => {
    // Production order: apiGate first, then the routes (here, stand-ins for routes not built yet).
    const { apiGate } = await import("../middleware/api-gate.js");
    mini = Fastify({ logger: false });
    await mini.register(apiGate);
    for (const path of [...SIBLINGS, "/api/health/deep"]) {
      mini.get(path, async () => ({ reached: path }));
      mini.post(path, async () => ({ reached: path }));
    }
    await mini.ready();
  });

  afterAll(async () => {
    await mini?.close();
  });

  it.each(SIBLINGS)("an anonymous GET or POST of %s is refused by apiGate (401), never reaching the route", async (path) => {
    for (const method of ["GET", "POST"] as const) {
      const res = await mini.inject({ method, url: path, headers: { "x-forwarded-for": clientIp() }, payload: method === "POST" ? {} : undefined });
      expect({ status: res.statusCode, error: body(res).error }, `${method} ${path}`).toEqual({ status: 401, error: "api_key_required" });
    }
  });

  it("a path BELOW a prefix stays public for GET (the boundary is a segment, not an exact match), and its POST does not", async () => {
    const get = await mini.inject({ method: "GET", url: "/api/health/deep", headers: { "x-forwarded-for": clientIp() } });
    expect({ status: get.statusCode, body: body(get) }).toEqual({ status: 200, body: { reached: "/api/health/deep" } });
    const post = await mini.inject({ method: "POST", url: "/api/health/deep", headers: { "x-forwarded-for": clientIp() }, payload: {} });
    expect(post.statusCode).toBe(401);
  });

  it("isPublicRoute (exported) refuses the siblings, a non-/api sibling such as /docsX, and still opens the real paths", async () => {
    const gate = (await import("../middleware/api-gate.js")) as { isPublicRoute?: (url: string, method?: string) => boolean };
    expect(gate.isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    const isPublicRoute = gate.isPublicRoute!;
    for (const path of [...SIBLINGS, "/docsX", "/docs-internal", "/.well-knownX/x", "/api/dhtx/query", "/api/marketplacex/listings"]) {
      expect(isPublicRoute(path, "GET"), `GET ${path}`).toBe(false);
      expect(isPublicRoute(path, "POST"), `POST ${path}`).toBe(false);
    }
    for (const path of ["/api/health", "/api/health/deep", "/docs", "/docs/api", "/api/onboard/chat/health", "/api/waitlist/count"]) {
      expect(isPublicRoute(path, "GET"), `GET ${path}`).toBe(true);
      expect(isPublicRoute(path, "HEAD"), `HEAD ${path}`).toBe(true);
    }
  });
});

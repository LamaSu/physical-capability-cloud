/**
 * WP-A round 5 (coord-watch #2883): DHT authentication is real.
 *
 * - /ws/dht is outside /api, so apiGate never sees it. It accepted any string
 *   starting "pcc_" (dht-ws.ts:53). dhtPeerPrincipal now requires a key that
 *   resolves, or a valid SIWE session.
 * - POST /api/dht/announce was on the public list as "authenticates itself", but it
 *   only read what apiGate attaches, and apiGate skips public routes. With a key it
 *   stored caller-chosen kernel ids, endpoints and TTLs with no ownership check. It
 *   is now authenticated by apiGate, bound to the kernel's recorded owner, bounded,
 *   and the kernel DID is derived rather than taken from the body.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let dhtPeerPrincipal: typeof import("../routes/dht-ws.js").dhtPeerPrincipal;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `dht-auth-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

const announce = (raw: string | undefined, payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/api/dht/announce",
    remoteAddress: `10.99.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: raw ? { authorization: `Bearer ${raw}` } : {},
  });

const OWNER = "dht-owner@x.test";
const KERNEL = "dht-auth-kernel-1";
let ownerKey: string;
let strangerKey: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  ({ dhtPeerPrincipal } = await import("../routes/dht-ws.js"));
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready();
  ownerKey = seedKey(OWNER);
  strangerKey = seedKey("dht-stranger@x.test");
  const reg = await app.inject({
    method: "POST",
    url: "/api/kernels",
    remoteAddress: "10.99.0.1",
    headers: { authorization: `Bearer ${ownerKey}` },
    payload: { id: KERNEL, name: "DHT auth kernel" },
  });
  expect(reg.statusCode, reg.body).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

const fakeReq = (headers: Record<string, string>, query: Record<string, string> = {}) =>
  ({ headers, query, cookies: {}, unsignCookie: undefined }) as unknown as FastifyRequest;

describe("/ws/dht peer authentication", () => {
  it("[neg] a made-up key that merely starts with pcc_ is not a credential (header or query)", () => {
    expect(dhtPeerPrincipal(fakeReq({ authorization: "Bearer pcc_anything" }))).toBeNull();
    expect(dhtPeerPrincipal(fakeReq({}, { apiKey: "pcc_live_" + "0".repeat(64) }))).toBeNull();
    expect(dhtPeerPrincipal(fakeReq({}))).toBeNull();
  });

  it("a key that resolves is the peer's principal", () => {
    expect(dhtPeerPrincipal(fakeReq({ authorization: `Bearer ${ownerKey}` }))).toBe(OWNER);
    expect(dhtPeerPrincipal(fakeReq({}, { apiKey: ownerKey }))).toBe(OWNER);
  });
});

describe("POST /api/dht/announce", () => {
  const good = { kernelId: KERNEL, capabilities: [{ type: "fdm-printing" }], endpoints: [{ transport: "websocket-relay", url: "wss://node.example/ws" }] };

  it("[neg] without a key it is refused at the gate (401)", async () => {
    expect((await announce(undefined, good)).statusCode).toBe(401);
  });

  it("[neg] a stranger's key cannot announce someone else's kernel (403), nor an unknown one (404)", async () => {
    const res = await announce(strangerKey, good);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect((await announce(strangerKey, { ...good, kernelId: "no-such-kernel" })).statusCode).toBe(404);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an oversized TTL", { ttlSeconds: 10_000_000 }],
    ["a plain-http endpoint", { endpoints: [{ transport: "http", url: "http://attacker.example/" }] }],
    ["too many capabilities", { capabilities: Array.from({ length: 51 }, (_, i) => ({ type: `t${i}` })) }],
    ["no capabilities", { capabilities: [] }],
  ])("[neg] %s is refused (400), even for the owner", async (_name, patch) => {
    expect((await announce(ownerKey, { ...good, ...patch })).statusCode).toBe(400);
  });

  it("the owner announces its kernel; the stored DID is derived, never taken from the body", async () => {
    const res = await announce(ownerKey, { ...good, kernelDid: "did:pcc:someone-else" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ announced: true, kernelId: KERNEL });
    const peers = await app.inject({ method: "GET", url: "/api/dht/peers", remoteAddress: "10.99.0.2" });
    expect(peers.body).not.toContain("did:pcc:someone-else");
  });
});

/**
 * WP-A round 6 (wpa-326-admingates-astra: bind announcements to an authorized
 * kernel, and enforce signed content, freshness, schema limits and quotas).
 * The seam: a REAL /ws/dht peer connection (injectWS) with a valid key.
 */
describe("DHT announcement integrity (round 6)", () => {
  const Q_OWNER = "dht-quota-owner@x.test";
  const Q_KERNEL = "dht-quota-kernel-1";
  let qOwnerKey: string;

  beforeAll(async () => {
    qOwnerKey = seedKey(Q_OWNER);
    const reg = await app.inject({
      method: "POST",
      url: "/api/kernels",
      remoteAddress: "10.99.0.3",
      headers: { authorization: `Bearer ${qOwnerKey}` },
      payload: { id: Q_KERNEL, name: "DHT quota kernel" },
    });
    expect(reg.statusCode, reg.body).toBeLessThan(300);
  });

  const query = async (type: string) =>
    (await app.inject({ method: "GET", url: `/api/dht/query?type=${type}`, remoteAddress: "10.99.0.4" })).json() as {
      results: Array<{ kernelDid: string; signature: string }>;
    };

  it("[neg] a /ws/dht peer's own announcement is not stored or served (the REST owner check cannot be bypassed)", async () => {
    // A real socket: listen on an ephemeral port and connect with Node's WebSocket
    // client. It cannot set headers, and /ws/dht also takes ?apiKey=.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dht?apiKey=${encodeURIComponent(strangerKey)}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws connect failed")));
    });
    const injected = {
      kernelDid: `did:pcc:${KERNEL}`,
      kernelId: KERNEL,
      capabilities: [{ type: "ws-injected-type" }],
      endpoints: [{ transport: "websocket-relay", url: "wss://attacker.example/ws" }],
      ttlSeconds: 300,
      timestamp: new Date().toISOString(),
      signature: "forged",
    };
    ws.send(JSON.stringify({ protocol: "/pcc/cap-gossip/1.0.0", payload: { type: "announce", announcement: injected, ttl: 2 } }));
    await new Promise((r) => setTimeout(r, 150));
    const peers = await app.inject({ method: "GET", url: "/api/dht/peers", remoteAddress: "10.99.0.5" });
    expect((peers.json() as { peers: unknown[] }).peers.length).toBeGreaterThan(0); // the peer really is connected
    expect((await query("ws-injected-type")).results).toEqual([]);
    ws.close();
  }, 20_000);

  it("[neg] a caller-supplied signature is never passed on as if the gateway had checked it", async () => {
    const res = await announce(qOwnerKey, { kernelId: Q_KERNEL, capabilities: [{ type: "sig-probe-type" }], signature: "forged-signature" });
    expect(res.statusCode).toBe(200);
    const { results } = await query("sig-probe-type");
    expect(results).toHaveLength(1);
    expect(results[0]!.signature).toBe("");
  });

  it("[neg] the per-principal announce quota answers 429 once it is spent", async () => {
    const { ANNOUNCE_QUOTA } = await import("../routes/dht-ws.js");
    const codes: number[] = [];
    for (let i = 0; i < ANNOUNCE_QUOTA.limit + 1; i++) {
      codes.push((await announce(qOwnerKey, { kernelId: Q_KERNEL, capabilities: [{ type: "quota-type" }] })).statusCode);
    }
    // The signature probe above already used one of this principal's announcements.
    expect(codes.filter((c) => c === 200)).toHaveLength(ANNOUNCE_QUOTA.limit - 1);
    expect(codes.slice(-2)).toEqual([429, 429]);
  });

  it("boundary: /api/dht/peers and /api/dht/metrics are public by design and carry no network address", async () => {
    for (const url of ["/api/dht/peers", "/api/dht/metrics"]) {
      const res = await app.inject({ method: "GET", url, remoteAddress: "10.99.0.6" });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toMatch(/"(ip|remoteAddress|address|host)"\s*:/);
      expect(res.body, url).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    }
    const peers = (await app.inject({ method: "GET", url: "/api/dht/peers", remoteAddress: "10.99.0.7" })).json() as {
      peers: Array<{ did: string }>;
    };
    for (const p of peers.peers) expect(p.did).toMatch(/^did:pcc:peer_[A-Za-z0-9_-]+$/);
  });
});

/**
 * WP-A round 7 (wpa-326-admingates-r2-astra AG-18 and AG-13):
 *   - AG-18: shape validation counted the capabilities but not their elements.
 *     null, strings and arbitrary objects were stored and broadcast as sent. Each
 *     capability and endpoint is now validated and REBUILT from known fields.
 *   - AG-13: /api/dht/metrics returned raw telemetry events. A query_started event
 *     carries the caller's search filter, which is demand data. The public reads now
 *     return an explicit field set.
 */
describe("DHT announcement elements and the public read boundary (round 7)", () => {
  const R7_OWNER = "dht-r7-owner@x.test";
  const R7_KERNEL = "dht-r7-kernel-1";
  let r7Key: string;

  beforeAll(async () => {
    r7Key = seedKey(R7_OWNER);
    const reg = await app.inject({
      method: "POST",
      url: "/api/kernels",
      remoteAddress: "10.99.0.8",
      headers: { authorization: `Bearer ${r7Key}` },
      payload: { id: R7_KERNEL, name: "DHT round-7 kernel" },
    });
    expect(reg.statusCode, reg.body).toBeLessThan(300);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "fdm-printing"],
    ["a number", 42],
    ["an object with no type", {}],
    ["an empty type", { type: "" }],
    ["an over-long type", { type: "x".repeat(200) }],
    ["materials that are not a string array", { type: "fdm-printing", materials: "PLA" }],
    ["an inverted price range", { type: "fdm-printing", priceRange: { min: 5, max: 1, currency: "USD" } }],
  ])("[neg] a capability that is %s is refused (400), not stored", async (_name, bad) => {
    const res = await announce(r7Key, { kernelId: R7_KERNEL, capabilities: [{ type: "fdm-printing" }, bad] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_announcement");
  });

  it("[neg] unknown keys are dropped: what is stored is rebuilt from known fields only", async () => {
    const res = await announce(r7Key, {
      kernelId: R7_KERNEL,
      capabilities: [{ type: "r7-rebuilt-type", materials: ["PLA"], injected: "<script>", nested: { deep: true } }],
      endpoints: [{ url: "wss://node.example/ws", evil: "x", transport: "websocket-relay" }],
    });
    expect(res.statusCode).toBe(200);
    const q = (await app.inject({ method: "GET", url: "/api/dht/query?type=r7-rebuilt-type", remoteAddress: "10.99.0.9" })).json() as {
      results: Array<{ capabilities: Array<Record<string, unknown>>; endpoints: Array<Record<string, unknown>> }>;
    };
    expect(q.results).toHaveLength(1);
    expect(q.results[0]!.capabilities).toEqual([{ type: "r7-rebuilt-type", materials: ["PLA"] }]);
    expect(q.results[0]!.endpoints).toEqual([{ transport: "websocket-relay", url: "wss://node.example/ws", priority: 1 }]);
  });

  it("[neg] /api/dht/metrics never exposes a caller's search filter (demand data)", async () => {
    await app.inject({ method: "GET", url: "/api/dht/query?type=secret-demand-probe-7&materials=unobtainium", remoteAddress: "10.99.0.10" });
    const res = await app.inject({ method: "GET", url: "/api/dht/metrics", remoteAddress: "10.99.0.11" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("secret-demand-probe-7");
    expect(res.body).not.toContain("unobtainium");
    const body = res.json() as { metrics: Record<string, unknown>; recentEvents: Array<Record<string, unknown>> };
    const allowedEvent = new Set(["type", "timestamp", "kernelDid", "capabilityTypes", "resultCount", "durationMs", "count", "ttl"]);
    for (const e of body.recentEvents) for (const k of Object.keys(e)) expect(allowedEvent.has(k), k).toBe(true);
    expect(body.recentEvents.some((e) => e.type === "query_started")).toBe(true); // the event is there, just without its filter
    for (const v of Object.values(body.metrics)) expect(typeof v).toBe("number");
  });

  it("boundary: /api/dht/peers returns only a DID per peer", async () => {
    const res = await app.inject({ method: "GET", url: "/api/dht/peers", remoteAddress: "10.99.0.12" });
    for (const p of (res.json() as { peers: Array<Record<string, unknown>> }).peers) expect(Object.keys(p)).toEqual(["did"]);
  });
});

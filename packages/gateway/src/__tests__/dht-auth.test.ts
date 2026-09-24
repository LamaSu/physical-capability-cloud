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

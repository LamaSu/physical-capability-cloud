import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema, sql } from "@pcc/store";

// ───────────────────────────────────────────────────────────────────────────
// N4b-gw behind the REAL auth (astra r1 on #400, items 1, 2 and 8).
//
// device-relay.test.ts stands in for apiGate with two test headers. Here the
// production pieces run in production order (server.ts: cors, then apiGate,
// then the relay plugin), so the relay's principal can only come from what
// apiGate resolved: a provisioned API key or a stored SIWE session. It also
// pins the routing edge cases and the relay guard's encapsulation.
// ───────────────────────────────────────────────────────────────────────────

const { shopKernels, toolCallRelay, executionScopes } = schema;

const SIWE_ADDRESS = "0xabc0000000000000000000000000000000000002";
let app: FastifyInstance;
let operatorKey: string;
let strangerKey: string;
let siweToken: string;

function seedKernel(id: string, operatorAddress: string) {
  getStore().db.insert(shopKernels).values({
    id,
    name: `Kernel ${id}`,
    operatorAddress,
    location: { lat: 37.7, lng: -122.4 },
    physicalAddress: "123 Test St",
    maxAssuranceTier: 2,
    publicKey: "pk_test",
    reputation: 100,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "1.0.0",
  }).run();
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const PENDING = "/api/relay/kernel-a/tool-call/pending";

beforeAll(async () => {
  process.env.DATABASE_URL = ":memory:";
  closeStore();
  initStore({ seed: false });

  app = Fastify({ logger: false }); // the router defaults server.ts uses
  await app.register(cors, { origin: true, methods: ["GET", "POST", "OPTIONS"] });
  await app.register(apiGate);
  // Sibling plugins on either side of the relay: the relay's guard must not reach them.
  await app.register(async (sib) => {
    sib.get("/api/sibling-before/whoami", async (req) => ({ userId: req.userId ?? null }));
  });
  await app.register(deviceRelayRoutes);
  await app.register(async (sib) => {
    sib.get("/api/sibling-after/whoami", async (req) => ({ userId: req.userId ?? null }));
  });
  await app.ready();

  seedKernel("kernel-a", "operator-a");
  seedKernel("kernel-siwe", SIWE_ADDRESS);
  operatorKey = provisionApiKey({ operatorId: "operator-a" }).rawKey;
  strangerKey = provisionApiKey({ operatorId: "stranger" }).rawKey;

  siweToken = randomUUID();
  const now = new Date();
  getRepos().sessions.insert({
    id: randomUUID(),
    walletAddress: SIWE_ADDRESS,
    token: siweToken,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    lastActiveAt: now.toISOString(),
  });
});

afterAll(async () => {
  await app.close();
  closeStore();
});

beforeEach(() => {
  const { db } = getStore();
  db.run(sql`DELETE FROM tool_call_relay`);
  db.run(sql`DELETE FROM execution_scopes`);
});

describe("N4b-gw behind the real apiGate: the principal comes only from authentication", () => {
  it("answers 401 without a key or session, before the relay runs", async () => {
    const res = await app.inject({ method: "GET", url: PENDING });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("api_key_required");
  });

  it("ignores identity headers: only a key or a session names the caller", async () => {
    const spoof = {
      "x-test-key": "operator-a",
      "x-operator-id": "operator-a",
      "x-user-id": "operator-a",
      "x-pcc-operator": "operator-a",
      "x-forwarded-user": "operator-a",
    };
    const anonymous = await app.inject({ method: "GET", url: PENDING, headers: spoof });
    expect(anonymous.statusCode).toBe(401);
    const stranger = await app.inject({ method: "GET", url: PENDING, headers: { ...spoof, ...bearer(strangerKey) } });
    expect(stranger.statusCode).toBe(403);
  });

  it("lets the kernel operator's provisioned key in, and nobody else's", async () => {
    expect((await app.inject({ method: "GET", url: PENDING, headers: bearer(operatorKey) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: PENDING, headers: bearer(strangerKey) })).statusCode).toBe(403);
    const otherKernel = await app.inject({ method: "GET", url: "/api/relay/kernel-siwe/tool-call/pending", headers: bearer(operatorKey) });
    expect(otherKernel.statusCode).toBe(403);
  });

  it("treats a stored SIWE session as the wallet's principal, on its own kernel only", async () => {
    const own = await app.inject({ method: "GET", url: "/api/relay/kernel-siwe/tool-call/pending", headers: bearer(siweToken) });
    expect(own.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: PENDING, headers: bearer(siweToken) })).statusCode).toBe(403);
    const forged = await app.inject({ method: "GET", url: "/api/relay/kernel-siwe/tool-call/pending", headers: bearer(randomUUID()) });
    expect(forged.statusCode).toBe(401);
  });

  it("a stranger's real key can't mint a scope or queue a call", async () => {
    const scope = await app.inject({
      method: "POST", url: "/api/relay/kernel-a/scope", headers: bearer(strangerKey),
      payload: { createdBy: "stranger", allowedTools: ["shell"] },
    });
    expect(scope.statusCode).toBe(403);
    const call = await app.inject({
      method: "POST", url: "/api/relay/kernel-a/tool-call", headers: bearer(strangerKey),
      payload: { toolName: "home" },
    });
    expect(call.statusCode).toBe(403);
    const { db } = getStore();
    expect(db.select().from(executionScopes).all()).toHaveLength(0);
    expect(db.select().from(toolCallRelay).all()).toHaveLength(0);
  });
});

describe("N4b-gw behind the real apiGate: URL variants never reach a relay handler unguarded", () => {
  const VARIANTS = [
    "/api/relay/kernel-a/tool-call/pending/", // trailing slash
    "/API/relay/kernel-a/tool-call/pending", // case
    "/api/Relay/kernel-a/tool-call/pending",
    "/api//relay/kernel-a/tool-call/pending", // duplicate slash
    "/api/relay/kernel-a//tool-call/pending",
    "/api/relay/kernel-a/tool-call/pending%2F",
    "/api/relay/kernel-a/../kernel-a/tool-call/pending", // dot segments
    "/api/relay/kernel-a/tool-call/%70ending", // encoded letter in a static segment
    "/api/relay/kernel%2Da/tool-call/pending", // encoded parameter: decodes to kernel-a
    "/api/relay/kernel-a/tool-call/pending;x=1",
    "/api/relay/kernel-a/tool-call/pending?kernelId=kernel-siwe",
  ];

  it.each(VARIANTS)("%s: 404, or the guard's own answer; never data for a stranger", async (url) => {
    for (const headers of [{}, bearer(strangerKey), bearer(siweToken)]) {
      const res = await app.inject({ method: "GET", url, headers });
      expect([401, 403, 404]).toContain(res.statusCode);
    }
  });

  it("an encoded parameter is checked against the decoded kernel", async () => {
    const res = await app.inject({ method: "GET", url: "/api/relay/kernel%2Da/tool-call/pending", headers: bearer(operatorKey) });
    expect(res.statusCode).toBe(200);
  });

  it("HEAD is refused like GET, and a CORS preflight performs no relay operation", async () => {
    expect((await app.inject({ method: "HEAD", url: PENDING, headers: bearer(strangerKey) })).statusCode).toBe(403);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/relay/kernel-a/tool-call",
      headers: { origin: "https://example.test", "access-control-request-method": "POST" },
    });
    expect(preflight.statusCode).toBeLessThan(300);
    expect(getStore().db.select().from(toolCallRelay).all()).toHaveLength(0);
  });
});

describe("N4b-gw behind the real apiGate: the relay guard is encapsulated", () => {
  it("does not reach sibling plugins registered before or after it", async () => {
    for (const url of ["/api/sibling-before/whoami", "/api/sibling-after/whoami"]) {
      const res = await app.inject({ method: "GET", url, headers: bearer(strangerKey) });
      expect(res.statusCode).toBe(200);
      expect(res.json().userId).toBe("stranger");
    }
  });

  it("fails closed when registered under a prefix: no route key matches the table", async () => {
    const prefixed = Fastify({ logger: false });
    await prefixed.register(apiGate);
    // An /api/ prefix keeps apiGate resolving the operator's key, so the refusal
    // below comes from the access table itself: the prefixed route key is not in it.
    await prefixed.register(deviceRelayRoutes, { prefix: "/api/v2" });
    await prefixed.ready();
    try {
      const res = await prefixed.inject({ method: "GET", url: `/api/v2${PENDING}`, headers: bearer(operatorKey) });
      expect(res.statusCode).toBe(403);
    } finally {
      await prefixed.close();
    }
  });
});

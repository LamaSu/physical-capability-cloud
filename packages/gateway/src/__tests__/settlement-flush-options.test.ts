/**
 * N46 pack 96 LOW: a NON-preflight OPTIONS request is not a way around the auth
 * gate on POST /api/settlement/flush (a money write: it flushes the batch
 * settlement queue on chain).
 *
 * How OPTIONS is treated today, measured on the real gateway (createGateway: the
 * same hooks and registration order as production), not assumed:
 *
 *   - apiGate never lists OPTIONS as public (api-gate.ts: "OPTIONS is never
 *     listed"). It leans on @fastify/cors answering a PREFLIGHT in its own
 *     onRequest hook, before the gate runs.
 *   - A request that is not a preflight (no Access-Control-Request-Method) is
 *     answered by @fastify/cors itself with 400 "Invalid Preflight Request"
 *     (strictPreflight) when the Origin is absent or allowed. That is the case
 *     for a bare `curl -X OPTIONS`.
 *   - When the Origin is NOT on the allowlist the CORS hook stands aside, and
 *     the request matches only the CORS plugin's own catch-all `OPTIONS *`
 *     route. apiGate decides on the MATCHED route template (authPath), which
 *     for that route is "*": not under /api/, so the gate does not run. The
 *     catch-all handler then calls reply.callNotFound(), and the answer is a
 *     bare 404. The flush handler is registered for POST only and is never
 *     reached; the gate is skipped, but there is nothing behind it.
 *   - So no credential is asked for, and none unlocks anything: with or
 *     without a settlement-scoped key the answers are identical.
 *
 * What this file pins: for every non-preflight OPTIONS shape, the status is the
 * one above, it is never a 2xx, and the flush handler (and its enabled check) is
 * never invoked. The control proves the spy is live: an authenticated POST does
 * reach the handler. A real preflight stays answered by CORS (204), credential
 * free, as a browser needs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const batch = vi.hoisted(() => ({ flushes: 0, enabledChecks: 0 }));

vi.mock("../contracts/batch-settlement.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBatchEnabled: () => {
    batch.enabledChecks += 1;
    return true;
  },
  flushSettlements: async () => {
    batch.flushes += 1;
    return {
      epochId: 7,
      totalIntents: 0,
      batches: [],
      byAgent: {},
      byOperation: {},
      startedAt: 0,
      completedAt: 0,
    };
  },
}));

const FLUSH = "/api/settlement/flush";
const ALLOWED_ORIGIN = "https://capability.network";
const UNKNOWN_ORIGIN = "https://evil.example";

let app: FastifyInstance;
let settlementKey = "";

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.PCC_SEED_DATA = "false";
  const server = await import("../server.js");
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready(); // does NOT call start()/listen(): no port is bound
  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  settlementKey = provisionApiKey({ operatorId: "flush-options-settler@x.test", scopes: ["settlement"] }).rawKey;
}, 180_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  batch.flushes = 0;
  batch.enabledChecks = 0;
});

const asKey = () => ({ authorization: `Bearer ${settlementKey}` });
const options = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "OPTIONS", url, headers });

/** Every shape of OPTIONS that is not a valid preflight, and what the stack answers today. */
const NON_PREFLIGHT: Array<{ name: string; headers: Record<string, string>; status: number }> = [
  { name: "no headers at all (a bare curl -X OPTIONS)", headers: {}, status: 400 },
  { name: "an allowed Origin, no Access-Control-Request-Method", headers: { origin: ALLOWED_ORIGIN }, status: 400 },
  { name: "Access-Control-Request-Method but no Origin", headers: { "access-control-request-method": "POST" }, status: 400 },
  { name: "an unknown Origin, no Access-Control-Request-Method", headers: { origin: UNKNOWN_ORIGIN }, status: 404 },
  {
    name: "an unknown Origin asking for POST (a preflight from a stranger's page)",
    headers: { origin: UNKNOWN_ORIGIN, "access-control-request-method": "POST" },
    status: 404,
  },
];

describe("a non-preflight OPTIONS to /api/settlement/flush is not a way around the auth gate", () => {
  it("control: an authenticated POST reaches the flush handler (so the spy below can see a handler)", async () => {
    const res = await app.inject({ method: "POST", url: FLUSH, headers: asKey() });
    expect(res.statusCode, res.body).toBe(200);
    expect(batch.enabledChecks).toBe(1);
    expect(batch.flushes).toBe(1);
  });

  it("control: the same POST without credentials is refused by the gate and runs nothing", async () => {
    const res = await app.inject({ method: "POST", url: FLUSH });
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().error).toBe("api_key_required");
    expect(batch.enabledChecks).toBe(0);
    expect(batch.flushes).toBe(0);
  });

  for (const variant of NON_PREFLIGHT) {
    it(`[neg] OPTIONS with ${variant.name}: ${variant.status}, never a 2xx, no handler runs, with or without a key`, async () => {
      for (const credentials of [{}, asKey()]) {
        const res = await options(FLUSH, { ...variant.headers, ...credentials });
        const who = Object.keys(credentials).length === 0 ? "no key" : "settlement key";
        expect(res.statusCode, `${who}: ${res.body}`).toBe(variant.status);
        expect(res.statusCode, who).toBeGreaterThanOrEqual(400);
        // Whatever answered, it was not the flush handler's output.
        expect(res.body, who).not.toContain("epoch");
        expect(res.body, who).not.toContain("batch_disabled");
        expect(res.headers["access-control-allow-origin"], who).not.toBe("*");
      }
      expect(batch.enabledChecks).toBe(0);
      expect(batch.flushes).toBe(0);
    });
  }

  it("[neg] a percent-encoded path does not turn OPTIONS into the POST handler either", async () => {
    for (const headers of [{ origin: UNKNOWN_ORIGIN }, { origin: UNKNOWN_ORIGIN, ...asKey() }]) {
      const res = await options("/api/%73ettlement/flush", headers);
      expect(res.statusCode, res.body).toBe(404);
    }
    expect(batch.enabledChecks).toBe(0);
    expect(batch.flushes).toBe(0);
  });

  it("[neg] the same holds for a sibling money write: OPTIONS /api/escrow/chain/:address/fund runs nothing and is no 2xx", async () => {
    const url = "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund";
    for (const variant of NON_PREFLIGHT) {
      const res = await options(url, variant.headers);
      expect(res.statusCode, `${variant.name}: ${res.body}`).toBe(variant.status);
    }
  });

  it("control: a REAL preflight (allowed Origin + Access-Control-Request-Method) is still answered by CORS, with no credential, and runs no handler", async () => {
    const res = await options(FLUSH, {
      origin: ALLOWED_ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(batch.enabledChecks).toBe(0);
    expect(batch.flushes).toBe(0);
  });

  it("the gate itself never lists OPTIONS as public: it relies on CORS for a preflight, not on an allowlist entry", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    expect(isPublicRoute(FLUSH, "OPTIONS")).toBe(false);
    expect(isPublicRoute(FLUSH, "POST")).toBe(false);
  });
});

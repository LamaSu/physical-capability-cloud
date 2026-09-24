/**
 * WP-A fold F5 (refvertical #2586, coord-watch #2608): api-gate's public
 * allowlist is METHOD-AWARE.
 *
 * isPublicRoute matched PUBLIC_PREFIXES, PUBLIC_EXACT and three regexes for
 * EVERY method, so a comment like "Capability listing is public" also opened
 * the WRITES on that path to callers with no key at all:
 *   POST   /api/capabilities                 (unauthenticated capability upsert)
 *   POST   /api/marketplace/listings
 *   PUT    /api/marketplace/listings/:id
 *   DELETE /api/marketplace/listings/:id
 *   POST   /api/marketplace/orders
 * Every public entry now declares its methods (reads: GET, HEAD follows GET);
 * a write is public only when listed as public-by-design, exactly, with a
 * justification. Anything else falls through to authentication.
 *
 * The SNAPSHOT below enumerates the ENTIRE public (method, path) set. Widening
 * the unauthenticated surface means editing this list — a visible diff.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { initStore, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";

let app: FastifyInstance;
let bearer: string;

const ok = async () => ({ reached: true });

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  bearer = provisionApiKey({ operatorId: "gate-test@x.test", scopes: ["operator"] }).rawKey;

  app = Fastify({ logger: false });
  await app.register(apiGate);
  // Stubs at the real route templates. The gate only needs a matched route.
  app.get("/api/health", ok);
  app.get("/api/capabilities", ok);
  app.post("/api/capabilities", ok);
  app.get("/api/capabilities/:capId", ok);
  app.post("/api/capabilities/:capId", ok);
  app.post("/api/capabilities/graph-search", ok);
  app.post("/api/capabilities/templates/match", ok);
  app.get("/api/marketplace/listings", ok);
  app.post("/api/marketplace/listings", ok);
  app.get("/api/marketplace/listings/:id", ok);
  app.put("/api/marketplace/listings/:id", ok);
  app.delete("/api/marketplace/listings/:id", ok);
  app.get("/api/marketplace/orders", ok);
  app.post("/api/marketplace/orders", ok);
  app.post("/api/marketplace/roi", ok);
  app.get("/api/onboard/registrations", ok);
  app.post("/api/onboard/registrations", ok);
  app.get("/api/operators/:id/ratings", ok);
  app.post("/api/operators/:id/ratings", ok);
  app.get("/api/kernels/:kernelId/agent-card.json", ok);
  app.post("/api/kernels/:kernelId/agent-card.json", ok);
  app.get("/api/dht/peers", ok);
  app.delete("/api/dht/peers", ok);
  app.post("/api/dht/announce", ok);
  app.post("/api/auth/provision", ok);
  app.patch("/api/auth/provision", ok);
  app.get("/api/auth/nonce", ok);
  app.post("/api/auth/verify", ok);
  app.post("/api/waitlist", ok);
  app.get("/api/waitlist/count", ok);
  app.post("/api/beta-apply", ok);
  app.post("/api/feedback", ok);
  app.post("/api/feedback/agent-report", ok);
  app.post("/api/feedback/:anything", ok);
  app.post("/api/onboard/chat", ok);
  app.get("/api/onboard/chat/health", ok);
  app.post("/api/onboard/identify-device", ok);
  app.post("/api/carrier/webhook/easypost", ok);
  app.post("/api/lob/webhook", ok);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
const call = (method: Method, url: string, withKey = false) =>
  app.inject({
    method,
    url,
    payload: method === "GET" || method === "HEAD" ? undefined : {},
    headers: withKey ? { authorization: `Bearer ${bearer}` } : {},
  });

describe("F5 — writes on 'public' paths now require authentication", () => {
  it.each<[Method, string]>([
    ["POST", "/api/capabilities"],
    ["POST", "/api/marketplace/listings"],
    ["PUT", "/api/marketplace/listings/lst-1"],
    ["DELETE", "/api/marketplace/listings/lst-1"],
    ["POST", "/api/marketplace/orders"],
  ])("%s %s without a key -> 401", async (method, url) => {
    const res = await call(method, url);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("api_key_required");
    expect(res.json().reached).toBeUndefined();
  });

  it.each<[Method, string]>([
    ["POST", "/api/capabilities/cap-1"], // the detail regex used to match every method
    ["POST", "/api/operators/op-1/ratings"],
    ["POST", "/api/kernels/k-1/agent-card.json"],
    ["POST", "/api/onboard/registrations"], // exact entry used to match every method
    ["DELETE", "/api/dht/peers"], // a public READ prefix no longer opens other methods
    ["PATCH", "/api/auth/provision"], // provisioning is public for POST only
    ["POST", "/api/feedback/something-else"], // only the two listed feedback writes
  ])("%s %s without a key -> 401 (method not declared)", async (method, url) => {
    const res = await call(method, url);
    expect(res.statusCode).toBe(401);
  });

  it("an ENCODED variant of a gated write is gated too", async () => {
    const res = await call("POST", "/api/%63apabilities");
    expect(res.statusCode).toBe(401);
  });

  it("control: the same writes pass the gate WITH a key (auth, not a blanket deny)", async () => {
    for (const [method, url] of [
      ["POST", "/api/capabilities"],
      ["PUT", "/api/marketplace/listings/lst-1"],
      ["POST", "/api/marketplace/orders"],
    ] as Array<[Method, string]>) {
      const res = await call(method, url, true);
      expect(res.statusCode, `${method} ${url}`).toBe(200);
    }
  });
});

describe("F5 — reads and public-by-design writes keep working without a key", () => {
  it.each<[Method, string]>([
    ["GET", "/api/capabilities"],
    ["GET", "/api/capabilities/cap-1"],
    ["GET", "/api/marketplace/listings"],
    ["GET", "/api/marketplace/listings/lst-1"],
    ["GET", "/api/marketplace/orders"],
    ["GET", "/api/onboard/registrations"],
    ["GET", "/api/operators/op-1/ratings"],
    ["GET", "/api/kernels/k-1/agent-card.json"],
    ["GET", "/api/dht/peers"],
    ["GET", "/api/waitlist/count"],
    ["GET", "/api/onboard/chat/health"],
    ["GET", "/api/auth/nonce"],
    ["HEAD", "/api/health"], // HEAD follows GET
    ["HEAD", "/api/capabilities"],
  ])("%s %s is public", async (method, url) => {
    const res = await call(method, url);
    expect(res.statusCode).toBe(200);
  });

  it.each<[Method, string]>([
    ["POST", "/api/auth/provision"],
    ["POST", "/api/auth/verify"],
    ["POST", "/api/waitlist"],
    ["POST", "/api/beta-apply"],
    ["POST", "/api/feedback"],
    ["POST", "/api/feedback/agent-report"],
    ["POST", "/api/onboard/chat"],
    ["POST", "/api/onboard/identify-device"],
    ["POST", "/api/capabilities/templates/match"],
    ["POST", "/api/capabilities/graph-search"],
    ["POST", "/api/marketplace/roi"],
    ["POST", "/api/dht/announce"],
    ["POST", "/api/carrier/webhook/easypost"],
    ["POST", "/api/lob/webhook"],
  ])("public-by-design %s %s passes the gate without a key", async (method, url) => {
    const res = await call(method, url);
    expect(res.statusCode).toBe(200);
    expect(res.json().reached).toBe(true);
  });
});

describe("F5 — the public (method, path) set is pinned", () => {
  it("SNAPSHOT: the entire public allowlist (edit deliberately; a widening is a diff here)", async () => {
    const { publicRouteSnapshot } = await import("../middleware/api-gate.js");
    expect(publicRouteSnapshot()).toEqual([
      "GET prefix /api/health",
      "GET prefix /api/auth/validate",
      "GET prefix /api/waitlist",
      "GET prefix /api/admin/feedback",
      "GET prefix /api/onboard/check/",
      "GET prefix /api/onboard/chat",
      "GET prefix /api/dht/",
      "GET prefix /api/marketplace/",
      "GET prefix /.well-known/",
      "GET prefix /docs",
      "GET exact /api/capabilities/types",
      "GET exact /api/capabilities",
      "GET exact /api/agents/status",
      "GET exact /api/onboard/registrations",
      "GET exact /api/orchestrator/templates",
      "GET exact /openapi.json",
      "GET exact /api/courier-jobs/open",
      "GET exact /api/courier-jobs/jobs/open",
      "GET exact /api/courier-jobs/healthz",
      "GET exact /api/job-offers/open",
      "GET exact /api/job-offers/healthz",
      "GET exact /api/kernels",
      "GET regex ^\\/api\\/capabilities\\/[^/]+(?:\\/button|\\/td)?$",
      "GET regex ^\\/api\\/operators\\/[^/]+\\/ratings$",
      "GET regex ^\\/api\\/kernels\\/[^/]+\\/agent-card\\.json$",
      "GET regex ^\\/api\\/job-offers\\/[^/]+$",
      "GET regex ^\\/api\\/courier-jobs\\/(?:jobs\\/)?[^/]+$",
      "GET regex ^\\/api\\/artifacts(?:\\/[^/]+)?$",
      "GET regex ^\\/api\\/compose\\/registry-snapshot(?:\\/[^/]+)?$",
      "POST exact /api/auth/provision",
      "GET exact /api/auth/nonce",
      "POST exact /api/auth/verify",
      "POST exact /api/waitlist",
      "POST exact /api/beta-apply",
      "POST exact /api/feedback",
      "POST exact /api/feedback/agent-report",
      "POST exact /api/onboard/chat",
      "POST exact /api/onboard/identify-device",
      "POST exact /api/capabilities/templates/match",
      "POST exact /api/capabilities/graph-search",
      "POST exact /api/marketplace/roi",
      "POST exact /api/dht/announce",
      "POST exact /api/carrier/webhook/easypost",
      "POST exact /api/lob/webhook",
    ]);
  });

  it("every public write is EXACT and carries a justification", async () => {
    const { publicWriteJustifications, publicRouteSnapshot } = await import("../middleware/api-gate.js");
    const writes = publicWriteJustifications();
    expect(writes.length).toBe(14);
    for (const w of writes) {
      expect(w.why.trim().length, `${w.method} ${w.path}`).toBeGreaterThan(10);
    }
    // No prefix or regex entry opens anything but GET.
    for (const line of publicRouteSnapshot()) {
      const [method, match] = line.split(" ");
      if (match !== "exact") expect(method, line).toBe("GET");
    }
  });
});

describe("F5 — isPublicRoute unit behaviour", () => {
  it("treats HEAD as GET and never opens OPTIONS / PUT / PATCH / DELETE", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    expect(isPublicRoute("/api/health", "HEAD")).toBe(true);
    expect(isPublicRoute("/api/health", "GET")).toBe(true);
    for (const m of ["OPTIONS", "PUT", "PATCH", "DELETE", "POST"]) {
      expect(isPublicRoute("/api/health", m), m).toBe(false);
    }
    expect(isPublicRoute("/api/capabilities?x=1", "GET")).toBe(true);
    expect(isPublicRoute("/api/capabilities", "POST")).toBe(false);
    expect(isPublicRoute("/api/capabilities", undefined)).toBe(false);
  });
});

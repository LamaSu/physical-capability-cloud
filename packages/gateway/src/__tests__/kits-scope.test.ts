/**
 * Scope authorization tests for the Capability Kit routes (kits K1 slice 1).
 *
 * scope-checker.ts's DEFAULT_SCOPE_REQUIREMENTS adds:
 *   { method: "POST", pattern: "/api/kits",    scopes: ["template_author","operator","admin"] }
 *   { method: "POST", pattern: "/api/kits/**", scopes: ["template_author","operator","admin"] }
 * GET /api/kits has no requirement and is not on the money-path default-deny
 * list, so it stays open to any authenticated caller regardless of scope.
 *
 * Mirrors scope-checker-money-path.test.ts's mock/build pattern exactly: the
 * db module is mocked so the middleware falls back to
 * DEFAULT_SCOPE_REQUIREMENTS (empty governance table) and reads scopes from a
 * test-controlled `keyScopes` string via a stubbed apiKeys repo.
 */

import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

let keyScopes: string;

vi.mock("../db.js", () => ({
  getRepos: () => ({
    // Empty governance table -> middleware falls back to DEFAULT_SCOPE_REQUIREMENTS.
    governance: { findAllEndpointScopes: () => [] },
    apiKeys: { findById: () => ({ id: "key-1", scopes: keyScopes }) },
  }),
}));

const { scopeChecker } = await import("../middleware/scope-checker.js");

/** Build an app with the scope-checker mounted and a key pre-attached, same as scope-checker-money-path.test.ts. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand in for api-gate, which sets req.apiKeyId on authenticated requests.
  app.addHook("onRequest", async (req) => {
    (req as unknown as { apiKeyId?: string }).apiKeyId = "key-1";
  });
  await app.register(scopeChecker);

  const ok = async () => ({ reached: true });
  app.get("/api/kits", ok);
  app.post("/api/kits", ok);
  app.post("/api/kits/:digest/fork", ok);
  await app.ready();
  return app;
}

const FORK_URL = `/api/kits/sha256:${"a".repeat(64)}/fork`;

describe("scope-checker — Capability Kit routes", () => {
  describe("publish and fork are gated", () => {
    it("DENIES POST /api/kits to a key scoped only [\"contributor:read\"]", async () => {
      keyScopes = JSON.stringify(["contributor:read"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/kits" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("DENIES POST /api/kits/:digest/fork to a key scoped only [\"contributor:read\"]", async () => {
      keyScopes = JSON.stringify(["contributor:read"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: FORK_URL });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });
  });

  describe("template_author reaches the handler", () => {
    it("ALLOWS POST /api/kits to a key scoped [\"template_author\"]", async () => {
      keyScopes = JSON.stringify(["template_author"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/kits" });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });

    it("ALLOWS POST /api/kits/:digest/fork to a key scoped [\"template_author\"]", async () => {
      keyScopes = JSON.stringify(["template_author"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: FORK_URL });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });
  });

  describe("wildcard keys reach the handler", () => {
    it("ALLOWS POST /api/kits to a key scoped [\"*\"]", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/kits" });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });

    it("ALLOWS POST /api/kits/:digest/fork to a key scoped [\"*\"]", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: FORK_URL });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });
  });

  describe("GET /api/kits stays open", () => {
    it("ALLOWS GET /api/kits to an under-scoped key (no requirement matches a GET)", async () => {
      keyScopes = JSON.stringify(["contributor:read"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/kits" });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });
  });
});

// ── astra k1-511 HIGH 1 and HIGH 2: the kit routes check the publishing role themselves ──
//
// The scope-checker's defaults above are not enough on their own:
//   - HIGH 1: a governance table with ANY rows replaces the defaults (refreshScopeCache uses all
//     rows or all defaults), so the kit rules can be absent and a contributor:read key would publish;
//   - HIGH 2: the checker returns early for a caller without an API key (a SIWE session).
// So routes/kits.ts decides the publishing role itself. These tests mount ONLY kitRoutes (no
// scope-checker at all), which is exactly the situation of a deployment whose policy table lacks
// the kit rules. The mocked apiKeys repo above supplies the key's scopes to getCallerScopes.

const { kitRoutes } = await import("../routes/kits.js");
const { KitRegistry } = await import("../services/kit-registry.js");
const os = await import("node:os");
const path = await import("node:path");
const { promises: fsp } = await import("node:fs");

const H = (c: string) => `sha256:${c.repeat(64)}`;
const completeKit = (version = "1.0.0") => ({
  schema: "pcc.capability-kit/v1",
  name: "OT-2 dye serial dilution",
  version,
  parentKitDigest: null,
  capabilities: [{ csdUrl: "pcc://capabilities/liquid-handling/v1", capabilityContractDigest: H("a") }],
  artifacts: [
    { role: "method", name: "serial-dilution.py", mediaType: "text/x-python", digest: H("1") },
    { role: "tests", name: "checks.json", mediaType: "application/json", digest: H("5") },
    { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: H("6") },
    { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: H("7") },
  ],
  economics: { spdxLicense: "Apache-2.0" },
});

/** kitRoutes alone, with a caller attached the way api-gate attaches one. */
async function routesOnly(caller: { apiKeyId?: string; operatorId?: string; userId?: string }) {
  const rootDir = await fsp.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "kits-scope-"));
  const registry = new KitRegistry({ rootDir, durable: () => true, audit: () => undefined });
  const app = Fastify();
  app.addHook("onRequest", async (req) => Object.assign(req as unknown as Record<string, unknown>, caller));
  await app.register(kitRoutes, { registry });
  await app.ready();
  return { app, registry, cleanup: () => fsp.rm(rootDir, { recursive: true, force: true }) };
}

describe("astra k1-511: the kit routes decide the publishing role themselves", () => {
  it("HIGH 1: a contributor:read key cannot publish, even with no scope rule for /api/kits anywhere", async () => {
    keyScopes = JSON.stringify(["contributor:read"]);
    const { app, registry, cleanup } = await routesOnly({ apiKeyId: "key-1", operatorId: "op@kits.test" });
    const res = await app.inject({ method: "POST", url: "/api/kits", payload: completeKit() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
    expect((await registry.list()).total).toBe(0);
    const fork = await app.inject({ method: "POST", url: FORK_URL, payload: completeKit("1.0.1") });
    expect(fork.statusCode).toBe(403);
    await app.close();
    await cleanup();
  });

  it("HIGH 2: a SIWE session (userId, no API key) cannot publish or fork", async () => {
    keyScopes = JSON.stringify(["*"]);
    const { app, registry, cleanup } = await routesOnly({ userId: "0xabc0000000000000000000000000000000000001" });
    const res = await app.inject({ method: "POST", url: "/api/kits", payload: completeKit() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("kit_publish_requires_api_key");
    expect((await app.inject({ method: "POST", url: FORK_URL, payload: completeKit("1.0.1") })).statusCode).toBe(403);
    expect((await registry.list()).total).toBe(0);
    await app.close();
    await cleanup();
  });

  it.each([["template_author"], ["operator"], ["admin"], ["*"]])("a key scoped [%s] may publish", async (scope) => {
    keyScopes = JSON.stringify([scope]);
    const { app, registry, cleanup } = await routesOnly({ apiKeyId: "key-1", operatorId: "op@kits.test" });
    const res = await app.inject({ method: "POST", url: "/api/kits", payload: completeKit() });
    expect(res.statusCode).toBe(201);
    expect((await registry.list()).total).toBe(1);
    await app.close();
    await cleanup();
  });

  it("a key with a malformed scopes column grants nothing (getCallerScopes fails closed)", async () => {
    keyScopes = "";
    const { app, cleanup } = await routesOnly({ apiKeyId: "key-1", operatorId: "op@kits.test" });
    expect((await app.inject({ method: "POST", url: "/api/kits", payload: completeKit() })).statusCode).toBe(403);
    await app.close();
    await cleanup();
  });

  it("reads stay open to any authenticated caller", async () => {
    keyScopes = JSON.stringify(["contributor:read"]);
    const { app, cleanup } = await routesOnly({ apiKeyId: "key-1", operatorId: "op@kits.test" });
    expect((await app.inject({ method: "GET", url: "/api/kits" })).statusCode).toBe(200);
    await app.close();
    await cleanup();
  });
});

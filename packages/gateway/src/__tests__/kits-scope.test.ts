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

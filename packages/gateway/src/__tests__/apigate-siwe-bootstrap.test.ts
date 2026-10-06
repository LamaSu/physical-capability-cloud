/**
 * SIWE login bootstrap must be reachable without a key.
 *
 * Regression guard for the prod bug found 2026-08-27: /api/auth/nonce and
 * /api/auth/verify were NOT on apiGate's public allowlist, so both 401'd on
 * live capability.network — a bootstrap deadlock (you need SIWE to get a key,
 * but the SIWE endpoints demanded a key). That made SIWE login, and the
 * SIWE-gated provisioning built on it, dead on arrival in production.
 *
 * These assert apiGate lets the two bootstrap endpoints through unauthenticated
 * — and that the exact-match intent holds: a sibling like /api/auth/sessions
 * (which needs a credential) stays gated, and a crafted /api/auth/verify-extra
 * does NOT leak public off a prefix match.
 *
 * /api/auth/logout is public too, by its own entry (N103): it ends the session
 * its own cookie names and authenticates nothing, and under N103 a cookie alone
 * no longer passes this gate, so a gated logout would leave the session alive.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { initStore, closeStore } from "../db.js";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  app = Fastify({ logger: false });
  await app.register(apiGate);
  // Stub routes so a "passed the gate" request 200s instead of 404-after-gate.
  app.get("/api/auth/nonce", async () => ({ nonce: "x" }));
  app.post("/api/auth/verify", async () => ({ ok: true }));
  app.post("/api/auth/logout", async () => ({ ok: true }));
  app.get("/api/auth/sessions", async () => ({ count: 0 }));
  app.post("/api/auth/verify-extra", async () => ({ ok: true }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  closeStore();
});

const noKey = { headers: { "content-type": "application/json" }, payload: "{}" };

describe("SIWE bootstrap endpoints are public", () => {
  it("GET /api/auth/nonce passes the gate with no key", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/nonce" });
    expect(r.statusCode).not.toBe(401);
    expect(r.statusCode).toBe(200);
  });

  it("POST /api/auth/verify passes the gate with no key", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/verify", ...noKey });
    expect(r.statusCode).not.toBe(401);
    expect(r.statusCode).toBe(200);
  });
});

describe("logout is public by its own entry (N103)", () => {
  it("POST /api/auth/logout passes the gate with no key", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/logout", ...noKey });
    expect(r.statusCode).toBe(200);
  });

  it("only POST: GET /api/auth/logout stays gated (401)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/logout" });
    expect(r.statusCode).toBe(401);
  });
});

describe("exact-match intent holds — siblings stay gated", () => {
  it("GET /api/auth/sessions still requires auth (401)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/sessions" });
    expect(r.statusCode).toBe(401);
  });

  it("a crafted /api/auth/verify-extra does NOT leak public (401)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/verify-extra", ...noKey });
    expect(r.statusCode).toBe(401);
  });
});

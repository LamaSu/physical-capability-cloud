import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import http from "node:http";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { SELF_SERVICE_KEY_SCOPES } from "../auth/key-scopes.js";
import { getRepos } from "../db.js";
import { __resetRateLimitState } from "../middleware/rate-limiter.js";

const secret = "synthetic-admin-secret-n340";
const paths = ["status", "overview", "traffic", "pages", "events", "errors", "devices", "geography", "security"]
  .map((route) => `/api/analytics/${route}`);
const forbidden = { error: "forbidden" };
const invalidQuery = { error: "invalid_query", message: "from and to must be YYYY-MM-DD dates." };
const posthogPrefix = "https://us.posthog.com/api/projects/";
const sentryPrefix = "https://sentry.io/api/0/";
const providerCalls: { url: string; body?: string }[] = [];
type Key = ReturnType<typeof provisionApiKey>;
let app: FastifyInstance;
let adminKey: Key;
let wildcardKey: Key;
let mixedKey: Key;
let selfServiceKey: Key;

const bearer = (key: Key) => ({ authorization: `Bearer ${key.rawKey}` });
const read = (path: string, headers: Record<string, string>, query = "") =>
  app.inject({ method: "GET", url: `${path}${query}`, headers });

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("SERVE_DASHBOARD", "false");
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("TENANT_ENFORCE", "");
  delete process.env.TENANT_ENFORCE;
  vi.stubEnv("POSTHOG_PERSONAL_API_KEY", "synthetic-posthog-key-n340");
  vi.stubEnv("POSTHOG_PROJECT_ID", "synthetic-posthog-project-n340");
  vi.stubEnv("SENTRY_AUTH_TOKEN", "synthetic-sentry-token-n340");
  vi.stubEnv("SENTRY_ORG", "synthetic-sentry-org-n340");
  vi.stubEnv("SENTRY_PROJECT", "synthetic-sentry-project-n340");
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(posthogPrefix)) {
      providerCalls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ columns: [], results: [] }), { status: 200 });
    }
    if (url.startsWith(sentryPrefix)) {
      providerCalls.push({ url });
      return new Response(JSON.stringify(url.includes("/stats_v2/") ? { intervals: [], groups: [] } : []), { status: 200 });
    }
    return originalFetch(input, init);
  }) satisfies typeof fetch);
  app = (await (await import("../server.js")).createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  [adminKey, wildcardKey, mixedKey, selfServiceKey] = [
    ["admin"], ["*"], ["*", "admin"], [...SELF_SERVICE_KEY_SCOPES],
  ].map((scopes, index) => provisionApiKey({
    operatorId: `synthetic-n340-operator-${index}`, name: `synthetic-n340-key-${index}`, scopes,
  }));
}, 180_000);

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("TENANT_ENFORCE", "");
  delete process.env.TENANT_ENFORCE;
  providerCalls.length = 0;
});

afterAll(async () => {
  try { await app?.close(); }
  finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});

describe("analytics: admins only before any read; from and to must be YYYY-MM-DD days", () => {
  it("AG1: an admin-scope key reads all nine routes, and overview and errors reach the providers", async () => {
    for (const path of paths) {
      const before = providerCalls.length;
      const res = await read(path, bearer(adminKey), "?from=2025-01-01&to=2025-01-02");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeTypeOf("object");
      const calls = providerCalls.slice(before);
      if (path.endsWith("/status")) {
        expect(res.json().posthog.canQuery).toBe(true);
        expect(res.json().sentry.canQuery).toBe(true);
      }
      if (path.endsWith("/overview")) {
        expect(calls.some((call) => call.url.startsWith(posthogPrefix))).toBe(true);
        expect(calls.some((call) => call.url.startsWith(sentryPrefix))).toBe(true);
      }
      if (path.endsWith("/errors")) {
        expect(calls.some((call) => call.url.startsWith(sentryPrefix))).toBe(true);
        expect(res.json()).toEqual({ issues: [], errorSeries: [], totalErrors: 0 });
      }
    }
  });

  it("AG2: a self-service key with the admin header reads all nine routes", async () => {
    for (const path of paths) {
      const before = providerCalls.length;
      const res = await read(path, { ...bearer(selfServiceKey), "x-admin-key": secret }, "?from=2025-01-03&to=2025-01-04");
      expect(res.statusCode).toBe(200);
      if (path.endsWith("/traffic")) {
        expect(providerCalls.slice(before).some((call) => call.url.startsWith(posthogPrefix))).toBe(true);
      }
    }
  });

  it("AG3: a self-service key gets 403 on all nine routes, GET and HEAD, with no provider call", async () => {
    for (const path of paths) {
      for (const method of ["GET", "HEAD"] as const) {
        const res = await app.inject({ method, url: `${path}?from=2025-01-05&to=2025-01-06`, headers: bearer(selfServiceKey) });
        expect(res.statusCode).toBe(403);
        if (method === "GET") expect(res.json()).toEqual(forbidden);
      }
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("AG4: the admin header alone still gets the apiGate 401 on all nine routes, with no provider call", async () => {
    for (const path of paths) {
      expect((await read(path, { "x-admin-key": secret })).statusCode).toBe(401);
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("AG5: a wrong admin header gets 403 with a self-service key and with an admin-scope key", async () => {
    for (const key of [selfServiceKey, adminKey]) {
      for (const path of paths) {
        const res = await read(path, { ...bearer(key), "x-admin-key": "synthetic-wrong-admin-n340" });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual(forbidden);
      }
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("AG6: the wildcard admin header gets 403 even when the admin secret is the wildcard", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", "*");
    for (const path of paths) {
      const res = await read(path, { ...bearer(selfServiceKey), "x-admin-key": "*" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(forbidden);
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("AG7: wildcard scopes get 403, with and without the admin scope", async () => {
    for (const key of [wildcardKey, mixedKey]) {
      for (const path of paths) {
        const res = await read(path, bearer(key));
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual(forbidden);
      }
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("AG8: under TENANT_ENFORCE both admin arms get 403, with no provider call", async () => {
    vi.stubEnv("TENANT_ENFORCE", "true");
    for (const headers of [bearer(adminKey), { ...bearer(selfServiceKey), "x-admin-key": secret }]) {
      for (const path of paths) {
        const res = await read(path, headers);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual(forbidden);
      }
    }
    expect(providerCalls).toHaveLength(0);
    delete process.env.TENANT_ENFORCE;
    expect((await read("/api/analytics/overview", bearer(adminKey), "?from=2025-01-07&to=2025-01-08")).statusCode).toBe(200);
    expect(providerCalls.some((call) => call.url.startsWith(posthogPrefix))).toBe(true);
  });

  it("AG10: an admin with a malformed from or to gets 400 invalid_query, with no provider call", async () => {
    const badValues = [
      "", "2026-1-01", "2026-01-1", "20260101", "2026-01-01T00:00:00Z",
      "2026-01-01 ", " 2026-01-01", "x2026-01-01", "2026-01-01x", "2026-01-01'",
      "2026/01/01", "2026-02-30", "2026-13-01", "2026-00-10", "+002026-01-01", "+010000-01",
    ];
    for (const path of ["/api/analytics/overview", "/api/analytics/status"]) {
      for (const field of ["from", "to"]) {
        for (const value of badValues) {
          const res = await read(path, bearer(adminKey), `?${field}=${encodeURIComponent(value)}`);
          expect(res.statusCode, `${path} ${field}=${JSON.stringify(value)}`).toBe(400);
          expect(res.json()).toEqual(invalidQuery);
        }
      }
    }
    for (const field of ["from", "to"]) {
      const res = await read("/api/analytics/overview", bearer(adminKey), `?${field}=2026-01-01&${field}=2026-01-02`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual(invalidQuery);
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("AG11: a self-service key with a malformed date gets 403, not 400", async () => {
    for (const query of ["?from=2026-02-30", "?to=x"]) {
      const res = await read("/api/analytics/overview", bearer(selfServiceKey), query);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(forbidden);
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("AG12: valid from and to reach the PostHog query text unchanged", async () => {
    const res = await read("/api/analytics/overview", bearer(adminKey), "?from=2025-03-04&to=2025-03-05");
    expect(res.statusCode).toBe(200);
    expect(res.json().dateRange).toEqual({ from: "2025-03-04", to: "2025-03-05" });
    const queries = providerCalls.filter((call) => call.url.startsWith(posthogPrefix))
      .map((call) => JSON.parse(call.body!).query.query as string);
    expect(queries.some((query) => query.includes("timestamp >= '2025-03-04'") && query.includes("'2025-03-05 23:59:59'"))).toBe(true);
  });

  it("AG13: absent from and to still read with the default range", async () => {
    const res = await read("/api/analytics/overview", bearer(adminKey));
    expect(res.statusCode).toBe(200);
    expect(res.json().dateRange.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.json().dateRange.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(providerCalls.some((call) => call.url.startsWith(posthogPrefix))).toBe(true);
  });

  it("AG14: a real leap day reads, and a non-day in the YYYY-MM-DD shape gets 400", async () => {
    const res = await read("/api/analytics/overview", bearer(adminKey), "?from=2024-02-29&to=2024-03-01");
    expect(res.statusCode).toBe(200);
    expect(providerCalls.some((call) => call.url.startsWith(posthogPrefix))).toBe(true);
    const before = providerCalls.length;
    const invalid = await read("/api/analytics/overview", bearer(adminKey), "?from=2025-02-29");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual(invalidQuery);
    expect(providerCalls).toHaveLength(before);
  });

  it("AG15: a signed-in session with no API key gets 403 on all nine routes, with no provider call", async () => {
    const token = "synthetic-n340-session";
    const now = Date.now();
    getRepos().sessions.insert({
      id: token, token, walletAddress: "0x1111111111111111111111111111111111111111",
      createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
    });
    const headers = { cookie: `pcc_session=${app.signCookie(token)}` };
    for (const path of paths) {
      const res = await read(path, headers, "?from=2025-01-11&to=2025-01-12");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(forbidden);
    }
    expect(providerCalls).toHaveLength(0);
    const res = await read("/api/analytics/overview", { ...headers, "x-admin-key": secret }, "?from=2025-01-13&to=2025-01-14");
    expect(res.statusCode).toBe(200);
    expect(providerCalls.some((call) => call.url.startsWith(posthogPrefix))).toBe(true);
  });
});

it("AG9: two admin header fields get 403 on a real socket, with a self-service key and with an admin-scope key", async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  for (const key of [selfServiceKey, adminKey]) {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port: address.port, method: "GET",
        path: "/api/analytics/overview?from=2025-01-09&to=2025-01-10",
        headers: ["Host", "127.0.0.1", "X-Admin-Key", secret, "x-admin-key", secret, "Authorization", `Bearer ${key.rawKey}`],
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.setTimeout(5000, () => req.destroy(new Error("Synthetic socket timeout")));
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual(forbidden);
  }
  expect(providerCalls).toHaveLength(0);
});

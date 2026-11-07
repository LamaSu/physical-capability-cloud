import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import http from "node:http";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos } from "../db.js";
import { auditService } from "../services/audit-service.js";

const path = "/api/admin/posture";
const secret = "synthetic-admin-secret-n237";
let app: FastifyInstance;
let keys: ReturnType<typeof provisionApiKey>[];
const readRows = () => auditService.query({ eventType: "admin.posture.read", limit: 1000 });
const refusalRows = () => auditService.query({ eventType: "admin.posture.refused", limit: 1000 });
const bearer = (index = 0) => ({ authorization: `Bearer ${keys[index].rawKey}` });
const admin = () => ({ "x-admin-key": process.env.PCC_ADMIN_KEY });
const request = (headers = admin()) => app.inject({ method: "GET", url: path, headers });

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("SERVE_DASHBOARD", "false");
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("SYN_N237_TOKEN", "synthetic-token-no-echo-237");
  vi.stubEnv("SYN_N237_URL", "https://syn-user:syn-password@syn-private-n237.test/abcdefghijklmnop?syn-query=private");
  vi.stubEnv("PCC_POSTURE_POLICY", "");
  delete process.env.PCC_POSTURE_POLICY;
  const server = await import("../server.js");
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready(); // inject only: never listen in the runnable cells
  keys = [["admin"], ["*"], ["*", "admin"], ["operator"], ["operator:basic"]].map((scopes, n) => provisionApiKey({ operatorId: `syn-operator-${n}`, name: `syn-key-${n}`, scopes }));
}, 180_000);
beforeEach(() => {
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("PCC_POSTURE_POLICY", "");
  delete process.env.PCC_POSTURE_POLICY;
});
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

describe("admin posture through createGateway and inject", () => {
  it("A1: admin secret alone reads with one restricted audit row", async () => {
    const before = readRows().length;
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.json().spec).toBe("pcc.posture/v1");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(readRows()).toHaveLength(before + 1);
    expect(readRows()[0]).toMatchObject({ eventType: "admin.posture.read", actor: "admin-key", action: "read", resourceType: "posture", metadata: { verdict: "no_policy", flags: [], errors: [] } });
    expect(readRows()[0].ip).toBeUndefined();
    expect(readRows()[0].userAgent).toBeUndefined();
    const health = (await app.inject({ url: "/api/health" })).json();
    expect(res.json().build).toEqual(Object.fromEntries(["commit", "commitSource", "buildArg", "sourceDigest", "sourceDigestSpec"].map((key) => [key, health[key]])));
  });
  it("A2: admin-scoped key reads under its key id", async () => {
    const before = readRows().length;
    expect((await request(bearer())).statusCode).toBe(200);
    expect(readRows()).toHaveLength(before + 1);
    expect(readRows()[0].actor).toBe(keys[0].record.id);
  });
  it.each([undefined, "", "  "])("A3: unavailable admin secret %s is refused before handler", async (configured) => {
    vi.stubEnv("PCC_ADMIN_KEY", configured ?? "");
    if (configured === undefined) delete process.env.PCC_ADMIN_KEY;
    const before = [readRows().length, refusalRows().length];
    for (const value of [configured ?? "", "synthetic-random-secret"]) {
      const res = await request({ "x-admin-key": value });
      expect(res.statusCode).toBe(401);
    }
    expect([readRows().length, refusalRows().length]).toEqual(before);
  });
  it("A4: wildcard admin secret reaches handler and is refused", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", "*");
    const res = await request({ "x-admin-key": "*" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(refusalRows()[0]).toMatchObject({ action: "read", resourceType: "posture", metadata: { credential: "wildcard_admin_secret" } });
    expect(refusalRows()[0].actor).toBeUndefined();
  });
  it.each([1, 2])("A5: wildcard-scoped key %s is refused even with admin scope", async (index) => {
    const res = await request(bearer(index));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(refusalRows()[0]).toMatchObject({ actor: keys[index].record.id, metadata: { credential: "wildcard_scope" } });
  });
  it.each([3, 4])("A7: operator key %s is refused by scopeChecker without posture audit", async (index) => {
    const before = [readRows().length, refusalRows().length];
    const res = await request(bearer(index));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
    expect([readRows().length, refusalRows().length]).toEqual(before);
  });
  it("A7 session: existing signed-cookie helper pattern has no scopes", async () => {
    const token = "synthetic-n237-session";
    const now = Date.now();
    getRepos().sessions.insert({ id: token, token, walletAddress: "0x1111111111111111111111111111111111111111", createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() });
    const before = [readRows().length, refusalRows().length];
    const res = await request({ cookie: `pcc_session=${app.signCookie(token)}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
    expect([readRows().length, refusalRows().length]).toEqual(before);
  });
  it("A8: no credential gets apiGate 401 and no posture audit", async () => {
    const before = [readRows().length, refusalRows().length];
    expect((await request({})).statusCode).toBe(401);
    expect([readRows().length, refusalRows().length]).toEqual(before);
  });
  it("A9: HEAD and POST have no report and no read audit", async () => {
    const before = readRows().length;
    for (const method of ["HEAD", "POST"] as const) {
      // The admin key also authenticates HEAD so a default-generated HEAD
      // handler cannot hide behind apiGate's method-specific admin-secret rule.
      for (const headers of [admin(), { ...admin(), ...bearer() }]) {
        const res = await app.inject({ method, url: path, headers });
        expect(res.statusCode).not.toBe(200);
        expect(res.body).not.toContain("pcc.posture/v1");
      }
    }
    expect(readRows()).toHaveLength(before);
  });
  it("A10: response and audit never echo synthetic secret or url parts", async () => {
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.json().env.find((row: { name: string }) => row.name === "SYN_N237_URL")).toMatchObject({ class: "url", provider: "other", credentialShaped: true });
    const output = res.body + JSON.stringify([...readRows(), ...refusalRows()]);
    for (const marker of [process.env.SYN_N237_TOKEN!, process.env.SYN_N237_URL!, "syn-private-n237.test", "abcdefghijklmnop", "syn-query=private", secret]) expect(output).not.toContain(marker);
  });
  it("A11: flagging result and audit metadata contain exactly verdict flags errors", async () => {
    vi.stubEnv("PCC_POSTURE_POLICY", JSON.stringify([{ id: "syn-1", all: [{ name: "SYN_N237_TOKEN", present: true }] }]));
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verdict: "flagged", flags: ["syn-1"], errors: [] });
    expect(readRows()[0].metadata).toEqual({ verdict: "flagged", flags: ["syn-1"], errors: [] });
  });
  it("A12: policy marker and policy text never enter response or audit", async () => {
    for (const raw of [JSON.stringify([{ id: "syn-1", all: [{ name: "SYN_N237_TOKEN", valueNot: "synthetic-policy-marker-n237" }] }]), "{synthetic-policy-marker-n237"]) {
      vi.stubEnv("PCC_POSTURE_POLICY", raw);
      const res = await request();
      expect(res.statusCode).toBe(200);
      const output = res.body + JSON.stringify([...readRows(), ...refusalRows()]);
      expect(output).not.toContain("synthetic-policy-marker-n237");
      expect(output).not.toContain(raw);
    }
  });
  it("A13: a presented invalid or wildcard admin header never falls back to an admin key", async () => {
    for (const value of ["synthetic-mismatch", "*"]) {
      const res = await request({ ...bearer(), "x-admin-key": value });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
      expect(refusalRows()[0]).toMatchObject({ actor: keys[0].record.id, metadata: { credential: value === "*" ? "wildcard_admin_secret" : "admin_key_mismatch" } });
    }
  });
});

// Written, not test-run: light-my-request collapses repeated fields. As in
// relay-admin-gate.test.ts, real raw duplicates require the socket transport.
it.skip("A6: duplicate raw headers alone get 401; with admin key get handler 403 (socket, written not test-run)", async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  for (const authenticated of [false, true]) {
    const before = [readRows().length, refusalRows().length];
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: address.port, method: "GET", path, headers: ["Host", "127.0.0.1", "X-Admin-Key", secret, "x-admin-key", secret, ...(authenticated ? ["Authorization", `Bearer ${keys[0].rawKey}`] : [])] }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.setTimeout(5000, () => req.destroy(new Error("Synthetic socket timeout")));
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(authenticated ? 403 : 401);
    expect(readRows()).toHaveLength(before[0]);
    expect(refusalRows()).toHaveLength(before[1] + (authenticated ? 1 : 0));
    if (authenticated) {
      expect(JSON.parse(res.body)).toEqual({ error: "forbidden" });
      expect(refusalRows()[0]).toMatchObject({ actor: keys[0].record.id, metadata: { credential: "duplicate_admin_key" } });
    }
  }
});

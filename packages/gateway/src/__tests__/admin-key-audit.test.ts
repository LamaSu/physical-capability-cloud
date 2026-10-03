/**
 * Admin key audit route tests (retire-the-wildcard #1099, piece 4).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { adminKeyAuditRoutes } from "../routes/admin-key-audit.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore } from "../db.js";

describe("GET /api/admin/keys/wildcard-audit", () => {
  let app: FastifyInstance;
  const ADMIN_ID = "admin@example.com";

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    // Stand in for apiGate, which sets req.operatorId on authenticated requests.
    app.addHook("onRequest", async (req) => {
      const claimed = req.headers["x-test-operator-id"];
      if (typeof claimed === "string") {
        (req as unknown as { operatorId?: string }).operatorId = claimed;
      }
    });
    await app.register(adminKeyAuditRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  beforeEach(() => {
    process.env.PCC_KEY_ADMINS = ADMIN_ID;
  });

  afterEach(() => {
    delete process.env.PCC_KEY_ADMINS;
  });

  it("denies a caller who is not on the allowlist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/keys/wildcard-audit",
      headers: { "x-test-operator-id": "not-an-admin@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies an unauthenticated caller (no operatorId at all)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
    expect(res.statusCode).toBe(403);
  });

  it("is closed-by-default when PCC_KEY_ADMINS is unset, even for a real operator", async () => {
    delete process.env.PCC_KEY_ADMINS;
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/keys/wildcard-audit",
      headers: { "x-test-operator-id": ADMIN_ID },
    });
    expect(res.statusCode).toBe(403);
  });

  it("reports wildcard vs narrow-scoped counts for an allowlisted admin", async () => {
    provisionApiKey({ operatorId: `wc-${Date.now()}@example.com`, scopes: ["*"] });
    provisionApiKey({ operatorId: `narrow-${Date.now()}@example.com`, scopes: ["operator"] });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/keys/wildcard-audit",
      headers: { "x-test-operator-id": ADMIN_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total_active_keys: number;
      wildcard_count: number;
      narrow_scoped_count: number;
      wildcard_keys: Array<{ operator_id: string }>;
    };
    expect(body.wildcard_count).toBeGreaterThanOrEqual(1);
    expect(body.total_active_keys).toBe(body.wildcard_count + body.narrow_scoped_count);
    // Never leaks the key hash or raw key — only id/prefix/operator/timestamps.
    // key_prefix is INTENTIONALLY present (generateApiKey() in api-key-auth.ts
    // sets keyPrefix = rawKey.slice(0, 12), e.g. "pcc_live_787") so an operator
    // can recognize a key without it being usable as a credential. A regex
    // that simply forbids the "pcc_live_"/"pcc_test_" substring anywhere false
    // -positives on that legitimate field; what must actually never appear is
    // the full-length raw key or a key hash, neither of which is a field on
    // WildcardKeySummary. Assert the structural guarantee instead: every
    // key_prefix is exactly the 12-char prefix generateApiKey() produces
    // (never the full secret), and no raw-key/hash field is present at all.
    for (const k of body.wildcard_keys) {
      expect(k.key_prefix).toHaveLength(12);
      expect(k as Record<string, unknown>).not.toHaveProperty("key_hash");
      expect(k as Record<string, unknown>).not.toHaveProperty("api_key");
      expect(k as Record<string, unknown>).not.toHaveProperty("raw_key");
    }
  });
});

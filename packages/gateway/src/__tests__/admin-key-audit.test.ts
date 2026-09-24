/**
 * Admin key audit route tests (retire-the-wildcard #1099, piece 4;
 * WP-A A8, MUST-CLOSE 9).
 *
 * ── UPDATED: the gate is now the admin SECRET, not an identity ─────
 * This route used to be gated by the PCC_KEY_ADMINS operatorId allowlist, and
 * this file asserted that gate (old -> new -> why):
 *   - "denies a caller who is not on the allowlist" (403)
 *       -> a caller WITHOUT X-Admin-Key is refused (401) whoever they are, and a
 *          non-allowlisted caller WITH the right key gets 200. Identity no longer
 *          decides anything: it was spoofable (a self-service email key could
 *          claim an allowlisted operatorId).
 *   - "denies an unauthenticated caller (no operatorId at all)" (403)
 *       -> no header = 401 admin_key_required.
 *   - "is closed-by-default when PCC_KEY_ADMINS is unset" (403)
 *       -> closed-by-default when PCC_ADMIN_KEY is unset outside NODE_ENV
 *          test/development (503 admin_key_unconfigured).
 *   - "reports wildcard vs narrow-scoped counts for an allowlisted admin"
 *       -> same report, reached with the X-Admin-Key header; legacy wildcard
 *          rows are seeded directly because "*" can no longer be minted.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { adminKeyAuditRoutes } from "../routes/admin-key-audit.js";
import { provisionApiKey, generateApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos } from "../db.js";

const ADMIN_SECRET = "test-admin-secret-0123456789abcdef";
const WALLET_SECRET = "0xdeadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef";

/**
 * Seed a LEGACY wildcard key straight into the table, the way pre-#1099
 * provisioning left it. provisionApiKey refuses to mint "*" (MUST-CLOSE 6), so
 * this is now the only way such a row comes into existence — which is exactly
 * the population this audit endpoint exists to find. The row carries operator
 * wallet material too, to prove the report never copies it out.
 */
function seedLegacyWildcardKey(operatorId: string): { rawKey: string; keyHash: string } {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `legacy-${operatorId}`,
    keyHash,
    keyPrefix,
    operatorId,
    name: "legacy wildcard",
    description: null,
    scopes: JSON.stringify(["*"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    metadata: null,
    publicKey: null,
    operatorWalletAddress: "0x1111111111111111111111111111111111111111",
    operatorWalletPrivateKey: WALLET_SECRET,
  } as never);
  return { rawKey, keyHash };
}

describe("GET /api/admin/keys/wildcard-audit — gated by the admin secret (A8)", () => {
  let app: FastifyInstance;
  const ADMIN_ID = "admin@example.com";
  const savedNodeEnv = process.env.NODE_ENV;

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
    process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  });

  afterEach(() => {
    delete process.env.PCC_KEY_ADMINS;
    delete process.env.PCC_ADMIN_KEY;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  const audit = (headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit", headers });

  // ── The spoofable identity no longer opens it ─────────────────────
  it("REFUSES an allowlisted identity that does not present X-Admin-Key (401)", async () => {
    const res = await audit({ "x-test-operator-id": ADMIN_ID });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("admin_key_required");
    expect(res.json().wildcard_keys).toBeUndefined();
  });

  it("REFUSES an allowlisted identity with a WRONG X-Admin-Key (403)", async () => {
    const res = await audit({ "x-test-operator-id": ADMIN_ID, "x-admin-key": "not-the-secret" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_key_invalid");
  });

  it("REFUSES a prefix / superstring of the secret", async () => {
    expect((await audit({ "x-admin-key": ADMIN_SECRET.slice(0, -1) })).statusCode).toBe(403);
    expect((await audit({ "x-admin-key": `${ADMIN_SECRET}x` })).statusCode).toBe(403);
  });

  it("REFUSES an unauthenticated caller with no header (401)", async () => {
    expect((await audit()).statusCode).toBe(401);
  });

  it("REFUSES an empty X-Admin-Key", async () => {
    const res = await audit({ "x-admin-key": "" });
    expect(res.statusCode).toBe(401);
  });

  // ── Fail closed when unconfigured ─────────────────────────────────
  it.each([["production"], ["staging"], ["Test"], ["development "], [undefined]])(
    "unset PCC_ADMIN_KEY fails CLOSED when NODE_ENV=%s (503)",
    async (nodeEnv) => {
      delete process.env.PCC_ADMIN_KEY;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      const res = await audit({ "x-test-operator-id": ADMIN_ID, "x-admin-key": "anything" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("admin_key_unconfigured");
    },
  );

  it("a blank PCC_ADMIN_KEY counts as unset (fails closed in production)", async () => {
    process.env.PCC_ADMIN_KEY = "   ";
    process.env.NODE_ENV = "production";
    const res = await audit({ "x-admin-key": "   " });
    expect(res.statusCode).toBe(503);
  });

  it.each([["test"], ["development"]])(
    "unset PCC_ADMIN_KEY is open only in NODE_ENV=%s",
    async (nodeEnv) => {
      delete process.env.PCC_ADMIN_KEY;
      process.env.NODE_ENV = nodeEnv;
      expect((await audit()).statusCode).toBe(200);
    },
  );

  // ── The secret opens it, for any identity, and leaks nothing ──────
  it("with the correct X-Admin-Key: 200, and the body carries no secret material", async () => {
    const legacy = seedLegacyWildcardKey(`wc-${Date.now()}@example.com`);
    const narrow = provisionApiKey({
      operatorId: `narrow-${Date.now()}@example.com`,
      scopes: ["operator"],
    });

    const res = await audit({ "x-admin-key": ADMIN_SECRET });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total_active_keys: number;
      wildcard_count: number;
      narrow_scoped_count: number;
      wildcard_keys: Array<Record<string, unknown>>;
    };
    expect(body.wildcard_count).toBeGreaterThanOrEqual(1);
    expect(body.total_active_keys).toBe(body.wildcard_count + body.narrow_scoped_count);

    // Exactly the inventory fields — nothing else is copied from the row.
    for (const k of body.wildcard_keys) {
      expect(Object.keys(k).sort()).toEqual(
        ["created_at", "key_id", "key_prefix", "last_used_at", "name", "operator_id"],
      );
      // key_prefix is the 12-char recognition prefix generateApiKey() stores —
      // never the credential.
      expect(k.key_prefix).toHaveLength(12);
    }

    // No secret material anywhere in the serialized body.
    const raw = res.body;
    expect(raw).not.toContain(ADMIN_SECRET);
    expect(raw).not.toContain(legacy.rawKey);
    expect(raw).not.toContain(legacy.keyHash);
    expect(raw).not.toContain(narrow.rawKey);
    expect(raw).not.toContain(WALLET_SECRET);
    expect(raw).not.toMatch(/key_hash|raw_key|api_key|private_key/i);
  });

  it("the secret works for a NON-allowlisted identity (identity decides nothing)", async () => {
    const res = await audit({
      "x-test-operator-id": "not-an-admin@example.com",
      "x-admin-key": ADMIN_SECRET,
    });
    expect(res.statusCode).toBe(200);
  });
});

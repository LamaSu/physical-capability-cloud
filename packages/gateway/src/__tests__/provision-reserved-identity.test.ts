/**
 * Self-service cannot claim an admin identity (WP-A A7).
 *
 * POST /api/auth/provision {email} and POST /api/contributors/quickstart set the
 * new key's operatorId from an email the caller merely TYPED. Routes that
 * authorize by an operatorId allowlist (AUDIT_ADMINS, PCC_DEMAND_ADMINS, ...)
 * then treated that key as the admin. The unverified email paths now refuse any
 * operatorId on any of those allowlists — with 409 `identity_claimed`, the SAME
 * status and body a claimed identity gets (WP-A repair R5). The first version
 * answered 403 `identity_reserved`, which let anyone enumerate the allowlists.
 *
 * Updated assertions (old -> new -> why): every "403 identity_reserved" below
 * became "409 identity_claimed" — R5, a reserved identity must be
 * indistinguishable from a claimed one.
 *
 * The wallet path is SIWE-gated on this branch (a bare walletAddress without a
 * matching SIWE session is 401 wallet_not_verified), so a wallet cannot be
 * claimed without proof; a PROVEN wallet on an allowlist may still provision —
 * proving control of it is what the allowlist means.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { contributorRoutes } from "../routes/contributors.js";
import {
  ADMIN_IDENTITY_ALLOWLIST_ENV_VARS,
  isReservedIdentity,
  reservedIdentityAllowlists,
} from "../auth/reserved-identities.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";

vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

const saved: Record<string, string | undefined> = {};
function clearAllowlists(): void {
  for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) delete process.env[name];
}

function buildSiweMessage(p: { domain: string; address: string; nonce: string }): string {
  return [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    p.address, "", "Sign in to Physical Capability Cloud", "",
    `URI: http://${p.domain}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${p.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

describe("unverified self-service cannot claim an admin identity (A7)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) saved[name] = process.env[name];
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
    await app.register(siweAuthPlugin);
    await app.register(provisionRoutes);
    await app.register(contributorRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    for (const name of ADMIN_IDENTITY_ALLOWLIST_ENV_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  beforeEach(clearAllowlists);
  afterEach(clearAllowlists);

  const provisionEmail = (email: string) =>
    app.inject({ method: "POST", url: "/api/auth/provision", payload: { email } });

  const keysFor = (operatorId: string) => getRepos().apiKeys.countByOperator(operatorId);

  // ── The spec'd pair ───────────────────────────────────────────────
  it("REFUSES provision {email} for an AUDIT_ADMINS identity with 409 identity_claimed", async () => {
    process.env.AUDIT_ADMINS = "admin@x.test";
    const res = await provisionEmail("admin@x.test");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("identity_claimed");
    // Nothing minted — there is no key to misuse.
    expect(keysFor("admin@x.test")).toBe(0);
    // The refusal does not say WHICH allowlist matched.
    expect(res.body).not.toContain("AUDIT_ADMINS");
  });

  it("still provisions a different email: 201 with [\"operator\"]", async () => {
    process.env.AUDIT_ADMINS = "admin@x.test";
    const res = await provisionEmail("someone-else@x.test");
    expect(res.statusCode).toBe(201);
    expect(res.json().scopes).toEqual(["operator"]);
  });

  // ── Every allowlist is covered by the ONE helper ──────────────────
  it.each([...ADMIN_IDENTITY_ALLOWLIST_ENV_VARS])(
    "REFUSES an identity listed only in %s",
    async (envName) => {
      const email = `reserved-${envName.toLowerCase()}@x.test`;
      process.env[envName] = `other@x.test, ${email}`;
      const res = await provisionEmail(email);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("identity_claimed");
      expect(keysFor(email)).toBe(0);
    },
  );

  it("matches case-insensitively and ignores list whitespace (no casing bypass)", async () => {
    process.env.PCC_DEMAND_ADMINS = "  Ops.Admin@Example.COM ,ops2@example.com";
    const res = await provisionEmail("ops.admin@example.com");
    expect(res.statusCode).toBe(409);
    const res2 = await provisionEmail("OPS.ADMIN@EXAMPLE.COM");
    expect(res2.statusCode).toBe(409);
  });

  // ── R5: reserved and claimed are indistinguishable (no enumeration) ─
  it("a reserved identity and a claimed identity get the SAME status and body (provision)", async () => {
    process.env.AUDIT_ADMINS = "admin@x.test";
    const claimed = `claimed-${Date.now()}@x.test`;
    expect((await provisionEmail(claimed)).statusCode).toBe(201);
    const reservedRes = await provisionEmail("admin@x.test");
    const claimedRes = await provisionEmail(claimed);
    expect(claimedRes.statusCode).toBe(409);
    expect(reservedRes.statusCode).toBe(claimedRes.statusCode);
    expect(reservedRes.body).toBe(claimedRes.body);
    expect(reservedRes.headers["content-type"]).toBe(claimedRes.headers["content-type"]);
  });

  it("a reserved identity and a claimed identity get the SAME status and body (quickstart)", async () => {
    process.env.AUDIT_ADMINS = "admin@x.test";
    const claimed = `qs-claimed-${Date.now()}@x.test`;
    expect((await provisionEmail(claimed)).statusCode).toBe(201);
    const qs = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/contributors/quickstart",
        payload: { email, role: "model-author", ratePercent: 1 },
      });
    const reservedRes = await qs("admin@x.test");
    const claimedRes = await qs(claimed);
    expect(claimedRes.statusCode).toBe(409);
    expect(reservedRes.statusCode).toBe(claimedRes.statusCode);
    expect(reservedRes.body).toBe(claimedRes.body);
  });

  it("A7 holds even for a caller holding a key of the reserved identity: the same 409, nothing minted", async () => {
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    getRepos().apiKeys.insert({
      id: `admin-self-${Date.now()}`,
      keyHash,
      keyPrefix,
      operatorId: "admin-self@x.test",
      scopes: JSON.stringify(["operator"]),
      rateLimit: "1000/hour",
      usageCount: "0",
      createdAt: new Date().toISOString(),
    } as never);
    process.env.AUDIT_ADMINS = "admin-self@x.test";
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { email: "admin-self@x.test" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("identity_claimed");
    expect(keysFor("admin-self@x.test")).toBe(1);
  });

  it("an empty or separators-only allowlist reserves nothing", async () => {
    process.env.AUDIT_ADMINS = " , ,, ";
    const res = await provisionEmail(`free-${Date.now()}@x.test`);
    expect(res.statusCode).toBe(201);
  });

  // ── The contributor quickstart is the same unverified-email path ──
  it("REFUSES POST /api/contributors/quickstart for a reserved email (no wallet, no key)", async () => {
    process.env.AUDIT_ADMINS = "admin@x.test";
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/quickstart",
      payload: { email: "admin@x.test", role: "model-author", ratePercent: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("identity_claimed");
    expect(keysFor("admin@x.test")).toBe(0);
  });

  it("still serves the quickstart for a non-reserved email", async () => {
    process.env.AUDIT_ADMINS = "admin@x.test";
    const res = await app.inject({
      method: "POST",
      url: "/api/contributors/quickstart",
      payload: { email: "contributor@x.test", role: "model-author", ratePercent: 1 },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── The wallet path is SIWE-gated (checked, not changed) ──────────
  it("a wallet on an allowlist cannot be claimed WITHOUT SIWE (401 wallet_not_verified)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    process.env.AUDIT_ADMINS = account.address.toLowerCase();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { walletAddress: account.address },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("wallet_not_verified");
    expect(keysFor(account.address)).toBe(0);
  });

  it("a SIWE-PROVEN allowlisted wallet may still provision (proof is what the allowlist means)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    process.env.AUDIT_ADMINS = account.address.toLowerCase();
    const nonceRes = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" } });
    const { nonce } = nonceRes.json() as { nonce: string };
    const message = buildSiweMessage({ domain: "pcc.test", address: account.address, nonce });
    const signature = await account.signMessage({ message });
    const verify = await app.inject({
      method: "POST", url: "/api/auth/verify", headers: { host: "pcc.test" },
      payload: { message, signature },
    });
    expect(verify.statusCode).toBe(200);
    const token = (verify.json() as { token: string }).token;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: { walletAddress: account.address },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().scopes).toEqual(["operator"]);
  });
});

describe("reservedIdentityAllowlists helper", () => {
  beforeEach(clearAllowlists);
  afterEach(clearAllowlists);

  it("names every list an identity is on, and nothing otherwise", () => {
    process.env.AUDIT_ADMINS = "a@x.test";
    process.env.BROKER_OPERATORS = "b@x.test, A@X.TEST";
    expect(reservedIdentityAllowlists("a@x.test").sort()).toEqual(["AUDIT_ADMINS", "BROKER_OPERATORS"]);
    expect(isReservedIdentity("b@x.test")).toBe(true);
    expect(isReservedIdentity("c@x.test")).toBe(false);
  });

  it("an empty identity is never 'reserved' (and never matches an empty entry)", () => {
    process.env.AUDIT_ADMINS = ",,";
    expect(isReservedIdentity("")).toBe(false);
    expect(isReservedIdentity("   ")).toBe(false);
  });
});

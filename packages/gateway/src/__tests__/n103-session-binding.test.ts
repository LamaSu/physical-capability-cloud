/**
 * N103: a SIWE session is bound to the API key it was verified under (gateway's ruling #6597; the
 * shell's plan #6749; astra 19g/19h's cross-process stale read on #354).
 *
 * The defect: a cookie minted while a browser was signed in to API account A stayed usable after
 * the tab switched to account B. Every consumer of resolveSession() (the API gate, tenant context,
 * requireAuth/optionalAuth, SSE auth, the A2A gate, the DHT peer principal, /me, /sessions,
 * provisioning) took the cookie on its own, so B's tab acted as A's wallet.
 *
 * The contract:
 * - POST /api/auth/verify with a valid key mints `<uuid>.<keyId>`; with an invalid credential it
 *   answers 401 before the nonce is spent; with none it mints an unbound `<uuid>` (bootstrap).
 * - A cookie is honored only beside the key it is bound to. An unbound or pre-N103 cookie is
 *   honored nowhere; the Bearer-session path (the token as the credential) is unchanged.
 * - A cookie that isn't honored is left in place, and the binding can't be edited (signed cookie).
 * - Logout is public: it ends the session its own cookie names and authenticates nothing.
 * - resolveSession counts no extra use of the key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { apiGate } from "../middleware/api-gate.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { requireAuth, optionalAuth } from "../auth/require-auth.js";
import { resolveSSEAuth } from "../sse/sse-auth.js";
import { dhtPeerPrincipal } from "../routes/dht-ws.js";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../middleware/security-hardening.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware/security-hardening.js")>()),
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

const COOKIE_SECRET = "test-only-cookie-secret-do-not-use-in-prod";

/** Mirrors apps/dashboard/src/hooks/use-auth.ts buildSiweMessage exactly. */
function buildSiweMessage(p: { domain: string; address: string; uri: string; nonce: string; issuedAt: string }): string {
  return [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    p.address,
    "",
    "Sign in to Physical Capability Cloud",
    "",
    `URI: ${p.uri}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
  ].join("\n");
}

let app: FastifyInstance;
interface Key {
  raw: string;
  id: string;
  operatorId: string;
}
let keyA: Key;
let keyB: Key;
const wallet = privateKeyToAccount(generatePrivateKey());

function mintKey(operatorId: string): Key {
  const { rawKey, record } = provisionApiKey({ operatorId, scopes: ["operator"] });
  return { raw: rawKey, id: record.id, operatorId };
}

const bearer = (k: Key) => ({ authorization: `Bearer ${k.raw}` });

/** The key id a session token names (`<uuid>.<keyId>`), or null for a bare `<uuid>`. Parsed here, not by the code under test. */
const keyIdIn = (token: string): string | null => (token.includes(".") ? token.slice(token.indexOf(".") + 1) : null);

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  delete process.env.PCC_A2A_AUTH_DISABLED;
  delete process.env.SSE_AUTH_REQUIRED;
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: COOKIE_SECRET });
  await app.register(apiGate);
  await app.register(tenantContext);
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  await app.register(a2aTasksRoutes);
  // One probe per resolveSession consumer that has no route of its own here.
  app.get("/api/_test/whoami", async (req) => ({ userId: req.userId ?? null, operatorId: req.operatorId ?? null, provenWallet: req.provenWallet ?? null }));
  app.get("/api/health/_test-tenant", async (req) => ({ tenantId: req.tenantId ?? null }));
  app.get("/_test/require-auth", { preHandler: requireAuth }, async (req) => ({ userId: req.userId ?? null }));
  app.get("/_test/optional-auth", { preHandler: optionalAuth }, async (req) => ({ userId: req.userId ?? null }));
  app.get("/_test/sse-auth", async (req: FastifyRequest) => resolveSSEAuth(req));
  app.get("/_test/dht-principal", async (req) => ({ principal: dhtPeerPrincipal(req) }));
  await app.ready();
  keyA = mintKey("n103-account-a@x.test");
  keyB = mintKey("n103-account-b@x.test");
});

afterAll(async () => {
  await app.close();
  closeStore();
});

beforeEach(() => {
  __resetA2ATasksForTest();
});

/** Drive nonce -> sign -> verify, with `headers` on the verify request. */
async function verifyWith(headers: Record<string, string>, signed?: { message: string; signature: string }) {
  let payload = signed;
  if (!payload) {
    const nonceRes = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" } });
    const { nonce } = nonceRes.json() as { nonce: string };
    const message = buildSiweMessage({ domain: "pcc.test", address: wallet.address, uri: "http://pcc.test", nonce, issuedAt: new Date().toISOString() });
    payload = { message, signature: await wallet.signMessage({ message }) };
  }
  const res = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host: "pcc.test", ...headers }, payload });
  const setCookie = res.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return {
    res,
    payload,
    token: res.statusCode === 200 ? (res.json() as { token: string }).token : null,
    cookie: String(first ?? "").split(";")[0]!,
  };
}

async function signedInUnder(key: Key) {
  const r = await verifyWith(bearer(key));
  expect(r.res.statusCode).toBe(200);
  expect(r.cookie).toMatch(/^pcc_session=/);
  return { token: r.token!, cookie: r.cookie };
}

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
const walletLc = () => wallet.address.toLowerCase();

describe("POST /api/auth/verify binds the session to the request's API key", () => {
  it("a valid key: the token is <uuid>.<keyId>, and the stored session is that token", async () => {
    const { token } = await signedInUnder(keyA);
    expect(token).toMatch(/^[0-9a-f-]{36}\.[^.]/);
    expect(keyIdIn(token)).toBe(keyA.id);
    expect(getRepos().sessions.findByToken(token)?.walletAddress.toLowerCase()).toBe(walletLc());
  });

  it("no credential: an unbound session (the bootstrap), a bare uuid", async () => {
    const r = await verifyWith({});
    expect(r.res.statusCode).toBe(200);
    expect(r.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyIdIn(r.token!)).toBeNull();
  });

  it.each([
    ["an unknown pcc_ key", `Bearer ${["pcc", "live", "0".repeat(64)].join("_")}`],
    ["a revoked key", "revoked"],
    ["a session token in place of a key", "session"],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["an empty header", ""],
  ])("an invalid credential (%s) answers 401 before the nonce is spent", async (_label, value) => {
    let authorization = value;
    if (value === "revoked") {
      const k = mintKey(`n103-revoked-${randomUUID()}@x.test`);
      getRepos().apiKeys.revoke(k.id);
      authorization = `Bearer ${k.raw}`;
    } else if (value === "session") {
      authorization = `Bearer ${(await signedInUnder(keyA)).token}`;
    }
    const refused = await verifyWith({ authorization });
    expect(refused.res.statusCode).toBe(401);
    expect((refused.res.json() as { error: string }).error).toBe("invalid_api_key");
    expect(refused.res.headers["set-cookie"]).toBeUndefined();
    // The same signed message still verifies with a valid key: the nonce wasn't consumed.
    const retried = await verifyWith(bearer(keyA), refused.payload);
    expect(retried.res.statusCode).toBe(200);
    expect(keyIdIn(retried.token!)).toBe(keyA.id);
  });
});

describe("A's cookie with B's key (or no key) is unauthorized for every resolveSession consumer", () => {
  it("/api/auth/me: honored beside its own key only", async () => {
    const { cookie } = await signedInUnder(keyA);
    const own = await get("/api/auth/me", { cookie, ...bearer(keyA) });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { address: string }).address.toLowerCase()).toBe(walletLc());
    const other = await get("/api/auth/me", { cookie, ...bearer(keyB) });
    expect(other.statusCode).toBe(401);
    const alone = await get("/api/auth/me", { cookie });
    expect(alone.statusCode).toBe(401);
  });

  it("the API gate: the cookie alone admits no one, and beside B's key the principal is B", async () => {
    const { cookie } = await signedInUnder(keyA);
    const alone = await get("/api/_test/whoami", { cookie });
    expect(alone.statusCode).toBe(401);
    const other = await get("/api/_test/whoami", { cookie, ...bearer(keyB) });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ userId: keyB.operatorId, operatorId: keyB.operatorId, provenWallet: null });
  });

  it("tenant context: no tenant from the cookie alone (on a public route the gate skips)", async () => {
    const { cookie } = await signedInUnder(keyA);
    expect((await get("/api/health/_test-tenant", { cookie })).json()).toEqual({ tenantId: null });
    expect((await get("/api/health/_test-tenant", { cookie, ...bearer(keyB) })).json()).toEqual({ tenantId: keyB.operatorId });
  });

  it("requireAuth: 401 for the cookie alone or beside B's key; the wallet beside its own key", async () => {
    const { cookie } = await signedInUnder(keyA);
    expect((await get("/_test/require-auth", { cookie })).statusCode).toBe(401);
    expect((await get("/_test/require-auth", { cookie, ...bearer(keyB) })).statusCode).toBe(401);
    const own = await get("/_test/require-auth", { cookie, ...bearer(keyA) });
    expect(own.statusCode).toBe(200);
    expect(String((own.json() as { userId: string }).userId).toLowerCase()).toBe(walletLc());
  });

  it("optionalAuth: no user from the cookie alone or beside B's key", async () => {
    const { cookie } = await signedInUnder(keyA);
    expect((await get("/_test/optional-auth", { cookie })).json()).toEqual({ userId: null });
    expect((await get("/_test/optional-auth", { cookie, ...bearer(keyB) })).json()).toEqual({ userId: null });
  });

  it("SSE auth: the cookie alone names no user; beside B's key the user is B", async () => {
    const { cookie } = await signedInUnder(keyA);
    const alone = (await get("/_test/sse-auth", { cookie })).json() as { userId?: string };
    expect(alone.userId).toBeUndefined();
    const other = (await get("/_test/sse-auth", { cookie, ...bearer(keyB) })).json() as { userId?: string };
    expect(other.userId).toBe(keyB.operatorId);
  });

  it("the DHT peer principal: none from the cookie alone; B beside B's key", async () => {
    const { cookie } = await signedInUnder(keyA);
    expect((await get("/_test/dht-principal", { cookie })).json()).toEqual({ principal: null });
    expect((await get("/_test/dht-principal", { cookie, ...bearer(keyB) })).json()).toEqual({ principal: keyB.operatorId });
  });

  it("the A2A gate: the cookie alone is not authenticated", async () => {
    const { cookie } = await signedInUnder(keyA);
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ jsonrpc: "2.0", id: "n103", method: "tasks/get", params: { id: "does-not-matter" } }),
    });
    const body = res.json() as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toMatch(/authentication required/);
  });

  it("/api/auth/sessions: beside B's key it lists B's sessions, never A's wallet's", async () => {
    const { cookie } = await signedInUnder(keyA);
    const res = await get("/api/auth/sessions", { cookie, ...bearer(keyB) });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json()).toLowerCase()).not.toContain(walletLc());
  });

  it("provisioning: the cookie alone proves no wallet, and the 401 no longer offers the cookie", async () => {
    const { cookie } = await signedInUnder(keyA);
    const res = await app.inject({ method: "POST", url: "/api/auth/provision", headers: { cookie }, payload: { walletAddress: wallet.address, name: "n103" } });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe("wallet_not_verified");
    expect(body.message).not.toMatch(/cookie/i);
  });
});

describe("what still works", () => {
  it("the Bearer-session path is unchanged: a bound or an unbound token authenticates as the credential", async () => {
    const bound = await signedInUnder(keyA);
    const unbound = await verifyWith({});
    for (const token of [bound.token, unbound.token!]) {
      const res = await get("/api/auth/me", { authorization: `Bearer ${token}` });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { address: string }).address.toLowerCase()).toBe(walletLc());
    }
  });

  it("the bootstrap: a wallet with no key yet provisions one with its unbound session token", async () => {
    const fresh = privateKeyToAccount(generatePrivateKey());
    const nonceRes = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" } });
    const { nonce } = nonceRes.json() as { nonce: string };
    const message = buildSiweMessage({ domain: "pcc.test", address: fresh.address, uri: "http://pcc.test", nonce, issuedAt: new Date().toISOString() });
    const verified = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host: "pcc.test" }, payload: { message, signature: await fresh.signMessage({ message }) } });
    const { token } = verified.json() as { token: string };
    expect(keyIdIn(token)).toBeNull();
    const res = await app.inject({ method: "POST", url: "/api/auth/provision", headers: { authorization: `Bearer ${token}` }, payload: { walletAddress: fresh.address, name: "n103-bootstrap" } });
    expect(res.statusCode).toBe(201);
  });

  it("an unbound or pre-N103 session is never honored from a cookie, even beside a valid key", async () => {
    const legacy = randomUUID(); // the pre-N103 token shape
    const now = Date.now();
    getRepos().sessions.insert({
      id: randomUUID(),
      walletAddress: wallet.address,
      token: legacy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    });
    const signedCookie = `pcc_session=${app.signCookie(legacy)}`;
    expect((await get("/api/auth/me", { cookie: signedCookie, ...bearer(keyA) })).statusCode).toBe(401);
    expect((await get("/api/auth/me", { cookie: signedCookie, ...bearer(keyB) })).statusCode).toBe(401);
    const unbound = await verifyWith({});
    expect((await get("/api/auth/me", { cookie: unbound.cookie, ...bearer(keyA) })).statusCode).toBe(401);
  });

  it("revoking the key ends its cookie: beside the revoked key the session names no one", async () => {
    const k = mintKey(`n103-revoked-later-${randomUUID()}@x.test`);
    const { cookie } = await signedInUnder(k);
    expect((await get("/_test/require-auth", { cookie, ...bearer(k) })).statusCode).toBe(200);
    getRepos().apiKeys.revoke(k.id);
    expect((await get("/_test/require-auth", { cookie, ...bearer(k) })).statusCode).toBe(401);
  });

  it("a cookie that isn't honored is left in place: beside its own key it works again", async () => {
    const { token, cookie } = await signedInUnder(keyA);
    expect((await get("/api/auth/me", { cookie, ...bearer(keyB) })).statusCode).toBe(401);
    expect(getRepos().sessions.findByToken(token)).toBeTruthy();
    expect((await get("/api/auth/me", { cookie, ...bearer(keyA) })).statusCode).toBe(200);
  });

  it("the binding can't be edited: a cookie re-pointed at B's key fails its signature", async () => {
    const { token, cookie } = await signedInUnder(keyA);
    const repointed = token.slice(0, token.indexOf(".") + 1) + keyB.id;
    const forged = cookie.replace(encodeURIComponent(token), encodeURIComponent(repointed)).replace(token, repointed);
    expect(forged).not.toBe(cookie);
    expect((await get("/api/auth/me", { cookie: forged, ...bearer(keyB) })).statusCode).toBe(401);
  });

  it("logout is public: with its cookie and no key it ends that session", async () => {
    const { token, cookie } = await signedInUnder(keyA);
    const res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(getRepos().sessions.findByToken(token)).toBeFalsy();
    expect((await get("/api/auth/me", { cookie, ...bearer(keyA) })).statusCode).toBe(401);
  });

  it("resolveSession counts no extra use of the key", async () => {
    const { cookie } = await signedInUnder(keyA);
    const before = Number(getRepos().apiKeys.findById(keyA.id)!.usageCount);
    const res = await get("/api/auth/me", { cookie, ...bearer(keyA) });
    expect(res.statusCode).toBe(200);
    // One use: the gate's. resolveSession (in /me) only asks which key the request carries.
    expect(Number(getRepos().apiKeys.findById(keyA.id)!.usageCount)).toBe(before + 1);
  });
});

/**
 * req.provenWallet: a wallet the caller PROVED, never one it asserted
 * (economics N8 ask #2888; the #326 x #385 seam).
 *
 * #326's money floor lets only an explicitly scoped KEY move money, and a key's
 * operatorId is asserted on the email path. An owner check that needs a proven
 * wallet (N10a, /api/ip) therefore needs to know which keys were minted through
 * the SIWE path. apiGate sets req.provenWallet from a SIWE session, or from the
 * proof /api/auth/provision writes into a key it minted for a SIWE-proven wallet.
 * Everything else is null: email keys, custodial-quickstart keys, legacy rows,
 * malformed or mismatched proofs, and a SIWE cookie riding along on another
 * principal's key.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { apiGate } from "../middleware/api-gate.js";
import { initStore, closeStore } from "../db.js";
import { provisionApiKey, provenWalletOfKey } from "../auth/api-key-auth.js";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

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

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
  await app.register(apiGate);
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  // A gated probe and a public one (GET under the public /api/health prefix).
  const whoami = async (req: import("fastify").FastifyRequest) => ({
    provenWallet: req.provenWallet,
    operatorId: req.operatorId ?? null,
  });
  app.get("/api/_test/whoami", whoami);
  app.get("/api/health/_test-whoami", whoami);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

/** Drive the real nonce -> sign -> verify flow; returns the bearer token and the session cookie. */
async function signIn(account: ReturnType<typeof privateKeyToAccount>): Promise<{ token: string; cookie: string }> {
  const nonceRes = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" } });
  const { nonce } = nonceRes.json() as { nonce: string };
  const message = buildSiweMessage({
    domain: "pcc.test",
    address: account.address,
    uri: "http://pcc.test",
    nonce,
    issuedAt: new Date().toISOString(),
  });
  const signature = await account.signMessage({ message });
  const verifyRes = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    headers: { host: "pcc.test" },
    payload: { message, signature },
  });
  expect(verifyRes.statusCode).toBe(200);
  const setCookie = verifyRes.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return { token: (verifyRes.json() as { token: string }).token, cookie: String(first ?? "").split(";")[0] };
}

async function whoami(headers: Record<string, string>, url = "/api/_test/whoami") {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.json() as { provenWallet: string | null; operatorId: string | null } };
}

async function provisionWithBody(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url: "/api/auth/provision", headers, payload });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return (res.json() as { api_key: string }).api_key;
}

describe("req.provenWallet: the SIWE path proves, nothing else does", () => {
  it("a key minted through the SIWE path proves its wallet", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { token } = await signIn(account);
    const key = await provisionWithBody({ walletAddress: account.address }, { authorization: `Bearer ${token}` });
    const res = await whoami({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    expect(res.body.provenWallet).toBe(account.address.toLowerCase());
  });

  it("a SIWE session proves its wallet", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { token } = await signIn(account);
    const res = await whoami({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body.provenWallet).toBe(account.address.toLowerCase());
  });

  it("an email key proves nothing, even when the body tries to carry a proof", async () => {
    const forged = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const key = await provisionWithBody({
      email: "pw-email@x.test",
      siweVerified: true,
      provenAddress: forged,
      metadata: { siweVerified: true, provenAddress: forged },
    });
    const res = await whoami({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    expect(res.body.provenWallet).toBeNull();
  });

  it("a custodial-quickstart key with a walletAddress in its metadata proves nothing", async () => {
    const custodial = privateKeyToAccount(generatePrivateKey()).address;
    const { rawKey } = provisionApiKey({
      operatorId: "pw-quickstart@x.test",
      scopes: ["operator"],
      metadata: { flow: "quickstart", walletProvider: "test", walletAddress: custodial },
    });
    const res = await whoami({ authorization: `Bearer ${rawKey}` });
    expect(res.body.provenWallet).toBeNull();
  });

  it("a proof that names a different identity than the key is refused", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const { rawKey } = provisionApiKey({
      operatorId: "pw-mismatch@x.test",
      scopes: ["operator"],
      metadata: { siweVerified: true, provenAddress: other },
    });
    const res = await whoami({ authorization: `Bearer ${rawKey}` });
    expect(res.body.provenWallet).toBeNull();
  });

  it("the key decides: another wallet's SIWE cookie riding along proves nothing for an email key", async () => {
    const bystander = privateKeyToAccount(generatePrivateKey());
    const { cookie: sessionCookie } = await signIn(bystander);
    expect(sessionCookie).toMatch(/^pcc_session=/);
    const key = await provisionWithBody({ email: "pw-rider@x.test" });
    const res = await whoami({ authorization: `Bearer ${key}`, cookie: sessionCookie });
    expect(res.body.operatorId).toBe("pw-rider@x.test");
    expect(res.body.provenWallet).toBeNull();
  });

  it("a public route with no credential sees null, never undefined", async () => {
    const res = await whoami({}, "/api/health/_test-whoami");
    expect(res.status).toBe(200);
    expect(res.body.provenWallet).toBeNull();
  });
});

describe("provenWalletOfKey fails closed on anything but the exact proof", () => {
  const addr = "0x" + "ab".repeat(20);
  const ok = { operatorId: "0x" + "AB".repeat(20), metadata: JSON.stringify({ siweVerified: true, provenAddress: addr }) };

  it("accepts the exact proof for the key's own (case-folded) operatorId", () => {
    expect(provenWalletOfKey(ok)).toBe(addr);
  });

  it.each<[string, unknown]>([
    ["no record", null],
    ["no metadata", { operatorId: addr }],
    ["metadata not a string", { operatorId: addr, metadata: { siweVerified: true, provenAddress: addr } }],
    ["malformed JSON", { operatorId: addr, metadata: "{\"siweVerified\":true," }],
    ["a JSON array", { operatorId: addr, metadata: "[true]" }],
    ["siweVerified as a string", { operatorId: addr, metadata: JSON.stringify({ siweVerified: "true", provenAddress: addr }) }],
    ["an uppercase provenAddress", { operatorId: addr, metadata: JSON.stringify({ siweVerified: true, provenAddress: addr.toUpperCase().replace("0X", "0x") }) }],
    ["a malformed address", { operatorId: "0xabc", metadata: JSON.stringify({ siweVerified: true, provenAddress: "0xabc" }) }],
    ["an email operatorId", { operatorId: "a@x.test", metadata: JSON.stringify({ siweVerified: true, provenAddress: addr }) }],
  ])("%s -> null", (_name, record) => {
    expect(provenWalletOfKey(record as Parameters<typeof provenWalletOfKey>[0])).toBeNull();
  });
});

/**
 * SIWE-gated wallet provisioning (retire-the-wildcard #1099, piece 3).
 *
 * Wires the already-existing EIP-4361 machinery (auth/siwe-auth.ts) into
 * POST /api/auth/provision: a bare walletAddress string in the body is no
 * longer trusted as proof of control. The caller must first prove they hold
 * the wallet's private key via SIWE (nonce -> sign -> verify), then
 * provision using the session's bearer token.
 *
 * Scope: wallet-bearing (machine/agent) operators only — they can sign
 * locally with a raw private key, no browser needed. The human-with-no-wallet
 * path (coord #1299 vs #1310) is a separate, still-open product decision and
 * is untouched by this file.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
// An explicit factory REPLACES the whole module, so it must expose every
// function the code under test imports (siwe-auth.ts gained canSiweNonce with
// the nonce rate limit); a missing one is `undefined` and throws a 500.
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

/** Mirrors apps/dashboard/src/hooks/use-auth.ts buildSiweMessage exactly. */
function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    "",
    params.statement,
    "",
    `URI: ${params.uri}`,
    `Version: ${params.version}`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join("\n");
}

describe("POST /api/auth/provision — wallet path requires SIWE", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    // @fastify/cookie throws if asked to sign a cookie (siwe-auth.ts's
    // `setCookie(..., { signed: true })`) with no secret configured — mirror
    // server.ts's `await app.register(cookie, { secret: cookieSecret })`.
    await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
    await app.register(siweAuthPlugin);
    await app.register(provisionRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  /** Drive the real nonce -> sign -> verify flow for a fresh throwaway account. */
  async function signIn(
    account: ReturnType<typeof privateKeyToAccount>,
  ): Promise<{ token: string }> {
    const nonceRes = await app.inject({
      method: "GET",
      url: "/api/auth/nonce",
      headers: { host: "pcc.test" },
    });
    const { nonce } = JSON.parse(nonceRes.body) as { nonce: string };

    const message = buildSiweMessage({
      domain: "pcc.test",
      address: account.address,
      statement: "Sign in to Physical Capability Cloud",
      uri: "http://pcc.test",
      version: "1",
      chainId: 1,
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
    const { token } = JSON.parse(verifyRes.body) as { token: string };
    return { token };
  }

  it("rejects a bare walletAddress claim with no SIWE proof", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { walletAddress: "0x1111111111111111111111111111111111111111" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("wallet_not_verified");
  });

  it("rejects a walletAddress that doesn't match the verified session", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { token } = await signIn(account);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: { walletAddress: "0x2222222222222222222222222222222222222222" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("wallet_not_verified");
  });

  it("mints a key for the SIWE-verified address, scoped narrowly (not '*')", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { token } = await signIn(account);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: { walletAddress: account.address },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { operator_id: string; scopes: string[] };
    expect(body.operator_id.toLowerCase()).toBe(account.address.toLowerCase());
    expect(body.scopes).not.toContain("*");
  });

  it("mints a key from the session alone when walletAddress is omitted", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { token } = await signIn(account);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { operator_id: string };
    expect(body.operator_id.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it("still serves the unverified email path unchanged", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `siwe-coexist-${Date.now()}@example.com` },
    });
    expect(res.statusCode).toBe(201);
  });
});

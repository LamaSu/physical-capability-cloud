/**
 * WP-A round 5 (astra #2829, the authz review's weakest link): SIWE is bound to
 * trusted origins, not to whatever Host header arrives.
 *
 * /api/auth/verify compared the message's domain with req.hostname and never
 * checked its URI. An attacker could get a gateway nonce, have an approved wallet
 * sign a login for THEIR site with it, and relay the signature here with a
 * matching Host. The session could then mint `settlement` authority. Now domain
 * and uri must name a trusted origin (PCC_SIWE_ORIGINS, or production defaults).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
  canSiweNonce: vi.fn(() => true),
}));

let app: FastifyInstance;
const savedEnv = { NODE_ENV: process.env.NODE_ENV, PCC_SIWE_ORIGINS: process.env.PCC_SIWE_ORIGINS };

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "siwe-origin-test-cookie-secret-0123456789" });
  await app.register(siweAuthPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

afterEach(() => {
  process.env.NODE_ENV = savedEnv.NODE_ENV;
  if (savedEnv.PCC_SIWE_ORIGINS === undefined) delete process.env.PCC_SIWE_ORIGINS;
  else process.env.PCC_SIWE_ORIGINS = savedEnv.PCC_SIWE_ORIGINS;
});

/** Nonce -> sign a message for (domain, uri) -> verify, with the given Host header. */
async function login(p: { host: string; domain: string; uri: string }) {
  const account = privateKeyToAccount(generatePrivateKey());
  const nonceRes = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host: p.host } });
  const { nonce } = nonceRes.json() as { nonce: string };
  const message = [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    account.address,
    "",
    "Sign in to Physical Capability Cloud",
    "",
    `URI: ${p.uri}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const signature = await account.signMessage({ message });
  return app.inject({ method: "POST", url: "/api/auth/verify", headers: { host: p.host }, payload: { message, signature } });
}

describe("SIWE origin binding in production", () => {
  it("[neg] a login signed for a FOREIGN site is refused even when the Host header matches it", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_SIWE_ORIGINS = "https://capability.network";
    const res = await login({ host: "evil.example", domain: "evil.example", uri: "https://evil.example" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Domain mismatch");
  });

  it("[neg] the trusted domain with a foreign URI is refused", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_SIWE_ORIGINS = "https://capability.network";
    const res = await login({ host: "capability.network", domain: "capability.network", uri: "https://evil.example/login" });
    expect(res.statusCode).toBe(401);
  });

  it("[neg] with no PCC_SIWE_ORIGINS, production still refuses a foreign origin (canonical defaults)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PCC_SIWE_ORIGINS;
    const res = await login({ host: "evil.example", domain: "evil.example", uri: "https://evil.example" });
    expect(res.statusCode).toBe(401);
  });

  it("control: the trusted origin signs in", async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_SIWE_ORIGINS = "https://capability.network,https://app.capability.network";
    const res = await login({ host: "app.capability.network", domain: "app.capability.network", uri: "https://app.capability.network" });
    expect(res.statusCode).toBe(200);
  });
});

describe("test/development keep the request host, and the URI must name it", () => {
  it("[neg] a URI for another host is refused", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PCC_SIWE_ORIGINS;
    const res = await login({ host: "pcc.test", domain: "pcc.test", uri: "http://evil.example" });
    expect(res.statusCode).toBe(401);
  });

  it("control: the request host with a matching URI signs in", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PCC_SIWE_ORIGINS;
    const res = await login({ host: "pcc.test", domain: "pcc.test", uri: "http://pcc.test" });
    expect(res.statusCode).toBe(200);
  });
});

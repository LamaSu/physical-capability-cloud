import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as signatures from "../auth/evm-signature.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import * as config from "../services/wallet-links/config.js";

const PUBLIC_ORIGIN = "https://capability.network";
const DOMAIN = "capability.network";
let apps: FastifyInstance[];
let remoteAddress: string;
let testNumber = 0;

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
  vi.stubEnv("PCC_PUBLIC_URL", PUBLIC_ORIGIN);
  vi.stubEnv("PCC_GATEWAY_URL", "");
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  apps = [];
  remoteAddress = `198.18.39.${++testNumber}`;
});

afterEach(async () => {
  for (const app of apps) await app.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "siwe-configured-origin-cookie-secret" });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(siweAuthPlugin);
  await app.ready();
  return app;
}

async function getNonce(app: FastifyInstance) {
  const response = await app.inject({ method: "GET", url: "/api/auth/nonce", remoteAddress });
  expect(response.statusCode).toBe(200);
  return response.json<{ nonce: string }>().nonce;
}

async function signedMessage(nonce: string, domain = DOMAIN, uri = PUBLIC_ORIGIN) {
  const account = privateKeyToAccount(generatePrivateKey());
  // Build directly so the malformed-URI case still reaches the gateway parser.
  const message = [
    `${domain} wants you to sign in with your Ethereum account:`, account.address,
    "", "Sign in to PCC.", "", `URI: ${uri}`, "Version: 1", "Chain ID: 84532",
    `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  return { message, signature: await account.signMessage({ message }) };
}

function verify(app: FastifyInstance, payload: Awaited<ReturnType<typeof signedMessage>>, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST", url: "/api/auth/verify", remoteAddress,
    headers: { host: DOMAIN, ...headers }, payload,
  });
}

function expectNoSession(response: Awaited<ReturnType<typeof verify>>) {
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(getRepos().sessions.countActive()).toBe(0);
}

function expectSignedIn(response: Awaited<ReturnType<typeof verify>>) {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["set-cookie"]).toContain("pcc_session=");
  expect(getRepos().sessions.findByToken(response.json().token)).toBeDefined();
}

describe("SIWE configured public origin", () => {
  it("T1 refuses a forwarded-host domain without consuming the nonce", async () => {
    const app = await buildApp();
    const nonce = await getNonce(app);
    const readConfig = vi.spyOn(config, "walletLinkConfig");
    const checkSignature = vi.spyOn(signatures, "verifyEvmMessageSignature");
    const headers = { "x-forwarded-host": "relay.invalid" };
    const response = await verify(app, await signedMessage(nonce, "relay.invalid", "https://relay.invalid"), headers);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Domain mismatch", message: `SIWE message domain must be '${DOMAIN}'` });
    expectNoSession(response);
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(checkSignature).not.toHaveBeenCalled();
    expectSignedIn(await verify(app, await signedMessage(nonce), headers));
    expect(readConfig).toHaveBeenCalledTimes(2);
    expect(checkSignature).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another host", "https://relay.invalid"],
    ["another scheme", "http://capability.network"],
    ["an unparseable URI", "not a url"],
  ])("T2 refuses %s before signature verification and preserves the nonce", async (_case, uri) => {
    const app = await buildApp();
    const nonce = await getNonce(app);
    const checkSignature = vi.spyOn(signatures, "verifyEvmMessageSignature");
    const response = await verify(app, await signedMessage(nonce, DOMAIN, uri));
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "URI mismatch", message: `SIWE message URI must be on ${PUBLIC_ORIGIN}` });
    expectNoSession(response);
    expect(checkSignature).not.toHaveBeenCalled();
    expectSignedIn(await verify(app, await signedMessage(nonce)));
  });

  it.each<Record<string, string>>([
    { host: "relay.invalid" },
    { host: DOMAIN, "x-forwarded-host": "relay.invalid" },
  ])("T3 accepts the configured origin regardless of request headers: %j", async headers => {
    const app = await buildApp();
    const nonce = await getNonce(app);
    expectSignedIn(await verify(app, await signedMessage(nonce), headers));
    expect(getRepos().sessions.countActive()).toBe(1);
  });

  it("T4 defaults to capability.network when both configured URLs are blank", async () => {
    vi.stubEnv("PCC_PUBLIC_URL", "");
    vi.stubEnv("PCC_GATEWAY_URL", "");
    const app = await buildApp();
    const nonce = await getNonce(app);
    const response = await verify(app, await signedMessage(nonce, "localhost", "http://localhost"));
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Domain mismatch", message: `SIWE message domain must be '${DOMAIN}'` });
    expectNoSession(response);
    expectSignedIn(await verify(app, await signedMessage(nonce)));
  });

  it("T5 refuses invalid configuration with 503 and reuses the nonce after configuration recovers", async () => {
    vi.stubEnv("PCC_PUBLIC_URL", "not a url");
    const app = await buildApp();
    const nonce = await getNonce(app);
    const payload = await signedMessage(nonce);
    const checkSignature = vi.spyOn(signatures, "verifyEvmMessageSignature");
    const response = await verify(app, payload);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Sign-in unavailable" });
    expectNoSession(response);
    expect(checkSignature).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.stubEnv("PCC_PUBLIC_URL", PUBLIC_ORIGIN);
    expectSignedIn(await verify(app, payload));
  });

  it("T6 requires the configured domain port and accepts the configured URI port", async () => {
    vi.stubEnv("PCC_PUBLIC_URL", "http://localhost:5173");
    const app = await buildApp();
    const nonce = await getNonce(app);
    const headers = { host: "localhost:5173" };
    const response = await verify(app, await signedMessage(nonce, "localhost", "http://localhost:5173"), headers);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Domain mismatch", message: "SIWE message domain must be 'localhost:5173'" });
    expectNoSession(response);
    const wrongPort = await verify(app, await signedMessage(nonce, "localhost:5173", "http://localhost:3200"), headers);
    expect(wrongPort.statusCode).toBe(401);
    expect(wrongPort.json()).toEqual({ error: "URI mismatch", message: "SIWE message URI must be on http://localhost:5173" });
    expectNoSession(wrongPort);
    expectSignedIn(await verify(app, await signedMessage(nonce, "localhost:5173", "http://localhost:5173"), headers));
  });
});

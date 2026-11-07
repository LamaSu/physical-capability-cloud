import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount } from "viem/accounts";
import * as signatures from "../auth/evm-signature.js";
import * as siwe from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { issueSignInMessage } from "./helpers/siwe-sign-in.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const wrongKey = privateKeyToAccount(`0x${"22".repeat(32)}`);
const instant = Date.parse("2026-11-06T18:00:00.000Z");
let apps: FastifyInstance[];
let remoteAddress: string;
let testNumber = 0;

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_GATEWAY_URL", "");
  vi.stubEnv("PCC_SIGVERIFY_RPC_URL", "");
  vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  siwe.__resetSignInIssueForTests();
  apps = [];
  remoteAddress = `198.18.40.${++testNumber}`;
});

afterEach(async () => {
  for (const app of apps) await app.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "siwe-issued-message-cookie-secret" });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(siwe.siweAuthPlugin);
  await app.ready();
  return app;
}

function issue(app: FastifyInstance, address = account.address as string, ip = remoteAddress) {
  return issueSignInMessage(app, address, { remoteAddress: ip });
}

function requestIssue(app: FastifyInstance, query: string, ip = remoteAddress) {
  return app.inject({ method: "GET", url: `/api/auth/nonce?${query}`, remoteAddress: ip });
}

async function verify(app: FastifyInstance, message: string, signer = account) {
  const signature = await signer.signMessage({ message });
  return app.inject({ method: "POST", url: "/api/auth/verify", payload: { message, signature }, remoteAddress });
}

function expectNoSession(response: Awaited<ReturnType<typeof verify>>) {
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(getRepos().sessions.countActive()).toBe(0);
}

function expectSignedIn(response: Awaited<ReturnType<typeof verify>>, address = account.address as string) {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["set-cookie"]).toContain("pcc_session=");
  expect(response.json().address).toBe(address);
  expect(getRepos().sessions.findByToken(response.json().token)?.walletAddress).toBe(address);
}

function fakeDate(now = instant) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

describe("issued SIWE messages", () => {
  it("T1 issues exactly the configured eleven lines and reply fields with no-store", async () => {
    fakeDate();
    const app = await buildApp();
    const response = await requestIssue(app, `address=${account.address}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const result = response.json();
    expect(Object.keys(result).sort()).toEqual(["nonce", "message", "issuedAt", "expiresAt", "chainId"].sort());
    expect(result.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(result).toEqual({ nonce: result.nonce, chainId: 84532,
      issuedAt: "2026-11-06T18:00:00.000Z", expiresAt: "2026-11-06T18:05:00.000Z",
      message: [
        "capability.network wants you to sign in with your Ethereum account:", account.address,
        "", "Sign in to Physical Capability Cloud", "", "URI: https://capability.network", "Version: 1",
        "Chain ID: 84532", `Nonce: ${result.nonce}`, "Issued At: 2026-11-06T18:00:00.000Z",
        "Expiration Time: 2026-11-06T18:05:00.000Z",
      ].join("\n"),
    });
  });

  it("T2 ignores request host and forwarded origin and supports configured localhost", async () => {
    const app = await buildApp();
    const headers = { host: "relay.invalid", "x-forwarded-host": "relay.invalid", "x-forwarded-proto": "http",
      origin: "https://relay.invalid", referer: "https://relay.invalid/" };
    const result = await issueSignInMessage(app, account.address, { remoteAddress, headers });
    expect(result.message.split("\n")[0].split(" ")[0]).toBe("capability.network");
    expect(result.message.split("\n")[5]).toBe("URI: https://capability.network");
    vi.stubEnv("PCC_PUBLIC_URL", "http://localhost:5173");
    const local = await issueSignInMessage(app, account.address, { remoteAddress, headers });
    expect(local.message.split("\n")[0].split(" ")[0]).toBe("localhost:5173");
    expect(local.message.split("\n")[5]).toBe("URI: http://localhost:5173");
  });

  it("T2 ignores every query parameter except address and purpose", async () => {
    fakeDate();
    const app = await buildApp();
    const plain = await issue(app);
    const response = await requestIssue(app, `address=${account.address}&domain=relay.invalid&uri=${encodeURIComponent("https://relay.invalid")}` +
      "&chainId=1&statement=x&nonce=0&issuedAt=2020-01-01T00:00:00.000Z&version=2");
    expect(response.statusCode).toBe(200);
    const extra = response.json();
    expect(extra.chainId).toBe(84532);
    expect(extra.message.replace(extra.nonce, "N")).toBe(plain.message.replace(plain.nonce, "N"));
  });

  it("T3 verifies an issued text on the chain it names", async () => {
    vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "8453");
    const app = await buildApp();
    const { message } = await issue(app);
    const check = vi.spyOn(signatures, "verifyEvmMessageSignature");
    expectSignedIn(await verify(app, message));
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![0]).toEqual({ address: account.address, message, signature: expect.any(String), chainId: 8453 });
  });

  it("T3 uses the configured chain and refuses invalid chain configuration without storing", async () => {
    const app = await buildApp();
    vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "8453");
    const result = await issue(app);
    expect(result.chainId).toBe(8453);
    expect(result.message.split("\n")[7]).toBe("Chain ID: 8453");
    siwe.__resetSignInIssueForTests();
    vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "abc");
    const rejected = await requestIssue(app, `address=${account.address}`);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toEqual({ error: "Sign-in unavailable" });
    expect(siwe.__issuedSignInCountForTests()).toBe(0);
  });

  it.each([account.address.toLowerCase(), account.address])("T4 preserves valid address %s", async address => {
    const result = await issue(await buildApp(), address);
    expect(result.message.split("\n")[1]).toBe(address);
  });

  it.each([
    `address=${account.address.replace("E", "e")}`,
    `address=0x${"1".repeat(39)}`, `address=0x${"1".repeat(39)}g`,
    `address=${account.address}&address=${account.address}`, "purpose=operator-host",
  ])("T4 refuses invalid address query %s without storing", async query => {
    const response = await requestIssue(await buildApp(), query);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid address" });
    expect(siwe.__issuedSignInCountForTests()).toBe(0);
  });

  it("T5 selects only the two supported purposes", async () => {
    const app = await buildApp();
    expect((await issue(app)).message.split("\n")[3]).toBe("Sign in to Physical Capability Cloud");
    const host = await issueSignInMessage(app, account.address, { purpose: "operator-host", remoteAddress });
    expect(host.message.split("\n")[3]).toBe("Sign in to Physical Capability Cloud as an operator host.");
    const response = await requestIssue(app, `address=${account.address}&purpose=admin`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid purpose" });
  });

  it("T6 refuses invalid origin configuration without storing", async () => {
    vi.stubEnv("PCC_PUBLIC_URL", "ftp://capability.network");
    const response = await requestIssue(await buildApp(), `address=${account.address}`);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Sign-in unavailable" });
    expect(siwe.__issuedSignInCountForTests()).toBe(0);
  });

  it("T7 retains the nonce-only legacy reply without an issued entry", async () => {
    const response = await (await buildApp()).inject({ method: "GET", url: "/api/auth/nonce", remoteAddress });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json())).toEqual(["nonce"]);
    expect(siwe.__issuedSignInCountForTests()).toBe(0);
  });

  it.each([account.address.toLowerCase(), account.address])("T8 signs in and stores the sent address casing %s", async address => {
    const app = await buildApp();
    expectSignedIn(await verify(app, (await issue(app, address)).message), address);
  });

  it.each([
    ["domain", (text: string) => text.replace("capability.network wants", "capability.network.relay.invalid wants")],
    ["URI port", (text: string) => text.replace("URI: https://capability.network", "URI: https://capability.network:8443")],
    ["chain", (text: string) => text.replace("Chain ID: 84532", "Chain ID: 8453")],
    ["issued at", (text: string) => text.replace("Issued At: 2026-11-06T18:00:00.000Z", "Issued At: 2026-11-06T18:00:01.000Z")],
    ["trailing newline", (text: string) => `${text}\n`],
    ["CRLF", (text: string) => text.replaceAll("\n", "\r\n")],
    ["address case", (text: string) => text.replace(account.address, account.address.toLowerCase())],
  ] as const)("T9 refuses a changed %s while preserving the exact issued message", async (_name, change) => {
    fakeDate();
    const app = await buildApp();
    const { message } = await issue(app);
    const response = await verify(app, change(message));
    expect([400, 401]).toContain(response.statusCode);
    expectNoSession(response);
    expectSignedIn(await verify(app, message));
  });

  it("T10 consumes an issued message once", async () => {
    const app = await buildApp();
    const { message } = await issue(app);
    expectSignedIn(await verify(app, message));
    const replay = await verify(app, message);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "Nonce expired or invalid" });
    expect(getRepos().sessions.countActive()).toBe(1);
  });

  it("T11 claims the entry before concurrent signature verification can yield", async () => {
    const app = await buildApp();
    const { message } = await issue(app);
    const signature = await account.signMessage({ message });
    let announce!: () => void;
    const ready = new Promise<void>(resolve => { announce = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const check = vi.spyOn(signatures, "verifyEvmMessageSignature").mockImplementationOnce(async () => {
      announce();
      await gate;
      return { ok: true, kind: "eoa" };
    });
    const post = () => app.inject({ method: "POST", url: "/api/auth/verify", payload: { message, signature }, remoteAddress });
    const first = post();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Signature verification not reached")), 1500);
      })]);
      expect(siwe.__issuedSignInCountForTests()).toBe(0);
      const second = await post();
      expect(second.statusCode).toBe(401);
      expect(second.json()).toEqual({ error: "Nonce expired or invalid" });
      expect(check).toHaveBeenCalledTimes(1);
      release();
      expectSignedIn(await first);
      expect(getRepos().sessions.countActive()).toBe(1);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await first;
    }
  });

  it("T12 accepts just before expiry and refuses at the exact TTL", async () => {
    fakeDate();
    const app = await buildApp();
    const first = await issue(app);
    const second = await issue(app);
    vi.setSystemTime(instant + 299_999);
    expectSignedIn(await verify(app, first.message));
    // Isolate the expired entry's session effect from the successful first sign-in.
    getRepos().sessions.deleteByToken(getRepos().sessions.listActive(new Date().toISOString())[0].token);
    vi.setSystemTime(instant + 300_000);
    const expired = await verify(app, second.message);
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ error: "Nonce expired or invalid" });
    expectNoSession(expired);
  });

  it("T13 burns the entry after a refused signature", async () => {
    const app = await buildApp();
    const { message } = await issue(app);
    const invalid = await verify(app, message, wrongKey);
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ error: "Invalid signature" });
    expectNoSession(invalid);
    const retried = await verify(app, message);
    expect(retried.statusCode).toBe(401);
    expect(retried.json()).toEqual({ error: "Nonce expired or invalid" });
    expectNoSession(retried);
  });

  it("T14 limits each IP and live entries without evicting and resets the IP window", async () => {
    fakeDate();
    siwe.__resetSignInIssueForTests({ perIpPerMinute: 3, liveCap: 5 });
    const app = await buildApp();
    const first = await issue(app);
    await issue(app);
    await issue(app);
    const limited = await requestIssue(app, `address=${account.address}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited", message: "Too many sign-in requests. Try again in a minute." });
    await issue(app, account.address, "198.18.41.1");
    await issue(app, account.address, "198.18.41.2");
    const full = await requestIssue(app, `address=${account.address}`, "198.18.41.3");
    expect(full.statusCode).toBe(503);
    expect(full.headers["retry-after"]).toBe("5");
    expect(full.json()).toEqual({ error: "Sign-in unavailable" });
    expect(siwe.__issuedSignInCountForTests()).toBe(5);
    expectSignedIn(await verify(app, first.message));
    vi.setSystemTime(instant + 60_001);
    await issue(app);
  });

  it("T14 frees live-cap space when entries expire", async () => {
    fakeDate();
    siwe.__resetSignInIssueForTests({ liveCap: 2 });
    const app = await buildApp();
    await issue(app);
    await issue(app);
    expect((await requestIssue(app, `address=${account.address}`)).statusCode).toBe(503);
    vi.setSystemTime(instant + 300_000);
    await issue(app);
    expect(siwe.__issuedSignInCountForTests()).toBe(1);
  });

  it("T15 HEAD returns no body and stores or counts nothing", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "HEAD", url: `/api/auth/nonce?address=${account.address}`, remoteAddress });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(siwe.__issuedSignInCountForTests()).toBe(0);
    siwe.__resetSignInIssueForTests({ perIpPerMinute: 1 });
    await app.inject({ method: "HEAD", url: `/api/auth/nonce?address=${account.address}`, remoteAddress });
    await issue(app);
  });

  it("T16 keeps issued nonces out of the legacy store and legacy nonces out of issued storage", async () => {
    const app = await buildApp();
    const legacy = await app.inject({ method: "GET", url: "/api/auth/nonce", remoteAddress });
    expect(Object.keys(legacy.json())).toEqual(["nonce"]);
    expect(siwe.__issuedSignInCountForTests()).toBe(0);
    const issued = await issue(app);
    const message = [
      "capability.network wants you to sign in with your Ethereum account:", account.address,
      "", "Sign in to PCC.", "", "URI: https://capability.network", "Version: 1", "Chain ID: 84532",
      `Nonce: ${issued.nonce}`, `Issued At: ${issued.issuedAt}`,
    ].join("\n");
    const response = await verify(app, message);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Nonce expired or invalid" });
    expectNoSession(response);
    expectSignedIn(await verify(app, issued.message));
  });

  it("T16 claims a legacy nonce before signature verification can yield", async () => {
    const app = await buildApp();
    const legacyNonce = (await app.inject({ method: "GET", url: "/api/auth/nonce", remoteAddress })).json().nonce;
    const issued = await issue(app);
    const message = issued.message.replace(issued.nonce, legacyNonce);
    const signature = await account.signMessage({ message });
    let announce!: () => void;
    const ready = new Promise<void>(resolve => { announce = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const check = vi.spyOn(signatures, "verifyEvmMessageSignature").mockImplementationOnce(async () => {
      announce();
      await gate;
      return { ok: true, kind: "eoa" };
    });
    const post = () => app.inject({ method: "POST", url: "/api/auth/verify", payload: { message, signature }, remoteAddress });
    const first = post();
    try {
      await ready;
      const second = await post();
      expect(second.statusCode).toBe(401);
      expect(second.json()).toEqual({ error: "Nonce expired or invalid" });
      expect(check).toHaveBeenCalledTimes(1);
      release();
      expectSignedIn(await first);
      expect(getRepos().sessions.countActive()).toBe(1);
    } finally {
      release();
      await first;
    }
  });
});

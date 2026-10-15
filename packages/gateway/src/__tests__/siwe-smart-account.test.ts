import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import {
  createPublicClient, custom, encodeDeployData, erc6492SignatureValidatorAbi,
  erc6492SignatureValidatorByteCode, getAddress, hashMessage, isErc6492Signature,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { __resetSignatureVerifierForTests, setSignatureVerifierTransportForTests } from "../auth/evm-signature.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";

const SMART_ADDRESS = "0x1111111111111111111111111111111111111111";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_SIGNATURE = `0x${"00".repeat(64)}1b` as Hex;
let apps: FastifyInstance[];
let remoteAddress: string;
let testNumber = 0;
let requests: Array<{ method: string; params?: unknown }>;

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  vi.stubEnv("PCC_SIGVERIFY_RPC_URL", `https://sigverify.invalid/v2/${randomBytes(16).toString("hex")}`);
  vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
  vi.stubEnv("PCC_SIGVERIFY_TIMEOUT_MS", "5000");
  initStore({ seed: true });
  sc.__resetScopeCacheForTests();
  apps = [];
  requests = [];
  remoteAddress = `198.18.11.${++testNumber}`;
});

afterEach(async () => {
  for (const app of apps) await app.close();
  __resetSignatureVerifierForTests();
  vi.restoreAllMocks();
  closeStore();
  sc.__resetScopeCacheForTests();
  vi.unstubAllEnvs();
});

async function buildApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "siwe-smart-account-cookie-secret" });
  await app.register(apiGate);
  await app.register(sc.scopeChecker);
  await app.register(siweAuthPlugin);
  await app.ready();
  return app;
}

async function makeMessage(app: FastifyInstance, address: Hex, chainId = 84532) {
  const nonceResponse = await app.inject({ method: "GET", url: "/api/auth/nonce", remoteAddress });
  expect(nonceResponse.statusCode).toBe(200);
  return createSiweMessage({
    address, domain: "localhost", uri: "http://localhost", version: "1", chainId,
    nonce: nonceResponse.json().nonce, issuedAt: new Date(), statement: "Sign in to PCC",
  });
}

function verify(app: FastifyInstance, message: string, signature: Hex) {
  return app.inject({
    method: "POST", url: "/api/auth/verify", headers: { host: "localhost" },
    payload: { message, signature }, remoteAddress,
  });
}

async function smartAccount() {
  const owner = privateKeyToAccount(generatePrivateKey());
  // Account discovery is isolated from the verifier's recording transport.
  const client = createPublicClient({
    chain: baseSepolia,
    transport: custom({ request: async ({ method }) => {
      if (method === "eth_getCode") return "0x";
      throw new Error("Unexpected account-stub request");
    } }),
  });
  return toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1", address: SMART_ADDRESS });
}

function validatorData(address: Hex, message: string, signature: Hex) {
  return encodeDeployData({
    abi: erc6492SignatureValidatorAbi, bytecode: erc6492SignatureValidatorByteCode,
    args: [getAddress(address), hashMessage(message), signature],
  });
}

function installTransport(onCall: (params: unknown) => unknown | Promise<unknown>) {
  setSignatureVerifierTransportForTests(custom({ request: async ({ method, params }) => {
    requests.push({ method, params });
    if (method === "eth_chainId") return "0x14a34";
    if (method === "eth_call") return onCall(params);
    throw new Error("Unexpected verifier-stub request");
  } }));
}

function acceptOnly(expectedData: Hex) {
  installTransport((params) => (params as [{ data?: string }])[0].data === expectedData ? "0x01" : "0x00");
}

function tamper(signature: Hex): Hex {
  const byte = signature.slice(10, 12) === "00" ? "01" : "00";
  return `${signature.slice(0, 10)}${byte}${signature.slice(12)}` as Hex;
}

describe("SIWE smart-account signatures", () => {
  it.each(["unset", "failing"] as const)("keeps EOA sign-in working with RPC %s and no transport requests", async (rpc) => {
    const app = await buildApp();
    const owner = privateKeyToAccount(generatePrivateKey());
    if (rpc === "unset") vi.stubEnv("PCC_SIGVERIFY_RPC_URL", "");
    installTransport(() => { throw new Error("RPC unavailable"); });
    const message = await makeMessage(app, owner.address);
    const response = await verify(app, message, await owner.signMessage({ message }));
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("pcc_session=");
    expect(response.json().address).toBe(owner.address);
    expect(requests).toEqual([]);
  });

  it("returns today's invalid-signature response for a wrong-key EOA when RPC is unset", async () => {
    const app = await buildApp();
    vi.stubEnv("PCC_SIGVERIFY_RPC_URL", "");
    const claimed = privateKeyToAccount(generatePrivateKey());
    const signer = privateKeyToAccount(generatePrivateKey());
    const message = await makeMessage(app, claimed.address);
    const response = await verify(app, message, await signer.signMessage({ message }));
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid signature" });
    expect(requests).toEqual([]);
    expect(getRepos().sessions.countActive()).toBe(0);
  });

  it("rejects the zero address even when the validator accepts it and burns the nonce", async () => {
    const app = await buildApp();
    const message = await makeMessage(app, ZERO_ADDRESS);
    installTransport(() => "0x01");
    const sessionsBefore = getRepos().sessions.countActive();
    const rejected = await verify(app, message, ZERO_SIGNATURE);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "Invalid signature" });
    expect(getRepos().sessions.countActive()).toBe(sessionsBefore);
    expect(requests).toEqual([]);
    const retried = await verify(app, message, ZERO_SIGNATURE);
    expect(retried.statusCode).toBe(401);
    expect(retried.json()).toEqual({ error: "Nonce expired or invalid" });
    expect(getRepos().sessions.countActive()).toBe(sessionsBefore);
  });

  it("signs in an undeployed CSW v1.1 as its own address and mints a session key", async () => {
    const app = await buildApp();
    const account = await smartAccount();
    const message = await makeMessage(app, account.address);
    const signature = await account.signMessage({ message });
    expect(isErc6492Signature(signature)).toBe(true);
    acceptOnly(validatorData(account.address, message, signature));
    const response = await verify(app, message, signature);
    expect(response.statusCode).toBe(200);
    expect(response.json().address).toBe(account.address);
    expect(response.headers["set-cookie"]).toContain("pcc_session=");
    expect(getRepos().sessions.findByToken(response.json().token)?.walletAddress).toBe(account.address);
    const minted = await app.inject({
      method: "POST", url: "/api/auth/session-key", remoteAddress,
      headers: { authorization: `Bearer ${response.json().token}` },
    });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().operator_id).toBe(account.address);
    expect(minted.json().api_key).toMatch(/^pcc_live_/);
    expect(requests.map(({ method }) => method)).toEqual(["eth_chainId", "eth_call"]);
  });

  it("rejects replaying a successful sign-in and keeps exactly one session", async () => {
    const app = await buildApp();
    const account = await smartAccount();
    const message = await makeMessage(app, account.address);
    const signature = await account.signMessage({ message });
    acceptOnly(validatorData(account.address, message, signature));
    const signedIn = await verify(app, message, signature);
    expect(signedIn.statusCode).toBe(200);
    const replayed = await verify(app, message, signature);
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json()).toEqual({ error: "Nonce expired or invalid" });
    expect(getRepos().sessions.countActive()).toBe(1);
  });

  it("burns the nonce after a tampered signature before a valid retry", async () => {
    const app = await buildApp();
    const account = await smartAccount();
    const message = await makeMessage(app, account.address);
    const signature = await account.signMessage({ message });
    acceptOnly(validatorData(account.address, message, signature));
    const rejected = await verify(app, message, tamper(signature));
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "Invalid signature" });
    const retried = await verify(app, message, signature);
    expect(retried.statusCode).toBe(401);
    expect(retried.json()).toEqual({ error: "Nonce expired or invalid" });
    expect(getRepos().sessions.countActive()).toBe(0);
  });

  it("returns retryable 503 for an outage and burns the nonce", async () => {
    const app = await buildApp();
    const account = await smartAccount();
    const message = await makeMessage(app, account.address);
    const signature = await account.signMessage({ message });
    installTransport(() => { throw new Error("RPC unavailable"); });
    const rejected = await verify(app, message, signature);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toEqual({ error: "signature_verifier_unavailable" });
    expect(rejected.headers["retry-after"]).toBe("5");
    acceptOnly(validatorData(account.address, message, signature));
    const retried = await verify(app, message, signature);
    expect(retried.statusCode).toBe(401);
    expect(retried.json()).toEqual({ error: "Nonce expired or invalid" });
    expect(getRepos().sessions.countActive()).toBe(0);
  });

  it("returns unconfigured for a contract signature while an EOA still signs in", async () => {
    const app = await buildApp();
    vi.stubEnv("PCC_SIGVERIFY_RPC_URL", "");
    const account = await smartAccount();
    const message = await makeMessage(app, account.address);
    const signature = await account.signMessage({ message });
    const rejected = await verify(app, message, signature);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toEqual({ error: "smart_account_signin_unavailable" });
    const owner = privateKeyToAccount(generatePrivateKey());
    const eoaMessage = await makeMessage(app, owner.address);
    expect((await verify(app, eoaMessage, await owner.signMessage({ message: eoaMessage }))).statusCode).toBe(200);
    expect(requests).toEqual([]);
  });

  it("rejects a contract signature naming chain 8453 without RPC", async () => {
    const app = await buildApp();
    const account = await smartAccount();
    const message = await makeMessage(app, account.address, 8453);
    const signature = await account.signMessage({ message });
    installTransport(() => "0x01");
    const rejected = await verify(app, message, signature);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: "wrong_chain" });
    expect(requests).toEqual([]);
  });

  it("claims one nonce synchronously before two concurrent 6492 verifications", async () => {
    const app = await buildApp();
    const account = await smartAccount();
    const message = await makeMessage(app, account.address);
    const signature = await account.signMessage({ message });
    const expected = validatorData(account.address, message, signature);
    let announceFirstCall!: () => void;
    const firstCallReady = new Promise<void>((resolve) => { announceFirstCall = resolve; });
    let releaseFirstCall!: () => void;
    const firstCallHeld = new Promise<void>((resolve) => { releaseFirstCall = resolve; });
    let callNumber = 0;
    installTransport(async (params) => {
      if (++callNumber === 1) {
        announceFirstCall();
        await firstCallHeld;
      }
      return (params as [{ data?: string }])[0].data === expected ? "0x01" : "0x00";
    });
    const first = verify(app, message, signature);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        firstCallReady,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("First verification did not reach eth_call")), 1500); }),
      ]);
      const second = await verify(app, message, signature);
      releaseFirstCall();
      const firstResponse = await first;
      expect([firstResponse.statusCode, second.statusCode].sort()).toEqual([200, 401]);
      expect(second.json()).toEqual({ error: "Nonce expired or invalid" });
      expect(callNumber).toBe(1);
      expect(getRepos().sessions.countActive()).toBe(1);
    } finally {
      if (timer) clearTimeout(timer);
      releaseFirstCall();
      await first;
    }
  });

  it("maps a malformed signature to 400 and never creates a session", async () => {
    const app = await buildApp();
    const owner = privateKeyToAccount(generatePrivateKey());
    const message = await makeMessage(app, owner.address);
    const rejected = await verify(app, message, "0x1234");
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "Invalid signature format" });
    expect(requests).toEqual([]);
    expect(getRepos().sessions.countActive()).toBe(0);
  });
});

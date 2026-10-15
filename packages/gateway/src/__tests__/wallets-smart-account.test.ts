import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createPublicClient, custom, encodeDeployData, erc6492SignatureValidatorAbi, erc6492SignatureValidatorByteCode, getAddress, hashMessage, isErc6492Signature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { initStore, closeStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker, __resetScopeCacheForTests } from "../middleware/scope-checker.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { rateLimiter, __resetRateLimitState } from "../middleware/rate-limiter.js";
import { hashApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { __resetSignatureVerifierForTests, setSignatureVerifierTransportForTests } from "../auth/evm-signature.js";
import { walletsRoutes } from "../routes/wallets.js";
import { getLinkRequest, resolveActiveWalletLink } from "../services/wallet-links/repository.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

const path = "/api/wallets/link-requests";
const ownerHeaders = { authorization: "Bearer pcc_test_w11_owner" };
const smartAddress = "0x1111111111111111111111111111111111111111" as const;
let app: FastifyInstance;
let requests: { method: string; params?: unknown }[];
let expectedData: Hex | undefined;
let unavailable: boolean;
let nextIp = 1;
type LinkRequest = { requestId: string; userCode: string; message: string };

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  vi.stubEnv("POSTHOG_API_KEY", "");
  vi.stubEnv("PCC_SIGVERIFY_RPC_URL", `https://sigverify.invalid/v2/${randomBytes(16).toString("hex")}`);
  vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
  __resetRateLimitState();
  __resetScopeCacheForTests();
  __resetSignatureVerifierForTests();
  requests = [];
  expectedData = undefined;
  unavailable = false;
  setSignatureVerifierTransportForTests(custom({ request: async ({ method, params }) => {
    requests.push({ method, params });
    if (unavailable) throw new Error("offline test transport unavailable");
    if (method === "eth_chainId") return "0x14a34";
    if (method === "eth_call") {
      const call = (params as [{ data: Hex }])[0];
      return call.data === expectedData ? "0x01" : "0x00";
    }
    throw new Error("unexpected verifier method");
  } }, { retryCount: 0 }));
  const store = initStore({ seed: false });
  store.repos.apiKeys.insert({ id: "w11-owner", keyHash: hashApiKey("pcc_test_w11_owner"), keyPrefix: "pcc_test_w11", operatorId: "account-a",
    name: null, description: null, scopes: "[]", rateLimit: "1000/hour", usageCount: "0",
    createdAt: new Date().toISOString(), expiresAt: null, metadata: null, publicKey: null });
  app = Fastify({ logger: false });
  await app.register(cookie, { secret: "w11-smart-wallet-test-cookie-secret" });
  await app.register(rateLimiter);
  await app.register(apiGate);
  await app.register(tenantContext);
  await app.register(scopeChecker);
  await app.register(siweAuthPlugin);
  await app.register(walletsRoutes);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  __resetSignatureVerifierForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function create(overrides: Record<string, unknown> = {}): Promise<LinkRequest> {
  const response = await app.inject({ method: "POST", url: path, remoteAddress: `203.0.113.${nextIp++}`,
    payload: { keyType: "secp256k1", address: smartAddress, role: "agent", label: "w11-cli", chainId: 84532, ...overrides } });
  expect(response.statusCode).toBe(201);
  return response.json();
}
function proof(request: LinkRequest, signature: string) {
  return app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } });
}
async function smartSigner() {
  const owner = privateKeyToAccount(generatePrivateKey());
  // This client belongs only to the signing account; verifier counts exclude it.
  const client = createPublicClient({ chain: baseSepolia, transport: custom({ request: async ({ method }) => {
    if (method === "eth_getCode") return "0x";
    throw new Error("unexpected account method");
  } }) });
  return toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1", address: smartAddress });
}
async function smartProof(request: LinkRequest) {
  const account = await smartSigner();
  const signature = await account.signMessage({ message: request.message });
  expect(isErc6492Signature(signature)).toBe(true);
  expectedData = encodeDeployData({ abi: erc6492SignatureValidatorAbi, bytecode: erc6492SignatureValidatorByteCode,
    args: [getAddress(smartAddress), hashMessage(request.message), signature] });
  return signature;
}

describe("W11 smart-account wallet link proofs", () => {
  it("rejects a zero-address proof even when the universal validator accepts it", async () => {
    const zeroAddress = "0x0000000000000000000000000000000000000000";
    setSignatureVerifierTransportForTests(custom({ request: async ({ method, params }) => {
      requests.push({ method, params });
      if (method === "eth_chainId") return "0x14a34";
      if (method === "eth_call") return "0x01";
      throw new Error("unexpected verifier method");
    } }, { retryCount: 0 }));
    const request = await create({ address: zeroAddress });
    const response = await proof(request, `0x${"00".repeat(64)}1b`);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_proof" });
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "failed" });
    expect(await resolveActiveWalletLink({ address: zeroAddress, chainId: 84532 })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("links an undeployed CSW v1.1 and resolves its approved link", async () => {
    const request = await create();
    const response = await proof(request, await smartProof(request));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "awaiting_approval" });
    const decision = await app.inject({ method: "POST", url: `${path}/${request.requestId}/approve`, headers: ownerHeaders,
      payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
    expect(decision.statusCode).toBe(200);
    expect(await resolveActiveWalletLink({ address: smartAddress, chainId: 84532 })).toMatchObject({
      linkId: decision.json().linkId, accountId: "account-a", keyType: "secp256k1", role: "agent",
    });
    expect(requests.map(request => request.method)).toEqual(["eth_chainId", "eth_call"]);
  });

  it("rejects a tampered smart-account proof", async () => {
    const request = await create();
    const signature = await smartProof(request);
    const tampered = `${signature.slice(0, 10)}${signature.slice(10, 12) === "00" ? "01" : "00"}${signature.slice(12)}`;
    const response = await proof(request, tampered);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_proof" });
  });

  it("burns a 6492 proof on a verifier chain mismatch without any RPC", async () => {
    vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "8453");
    const request = await create();
    const response = await proof(request, await smartProof(request));
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_proof" });
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "failed" });
    expect(await resolveActiveWalletLink({ address: smartAddress, chainId: 84532 })).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("burns an unavailable proof with 503 and permits a fresh request after recovery", async () => {
    const first = await create();
    const signature = await smartProof(first);
    unavailable = true;
    const response = await proof(first, signature);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "verifier_unavailable" });
    expect((await app.inject(`${path}/${first.requestId}`)).json()).toEqual({ status: "failed" });
    unavailable = false;
    const second = await create();
    const retry = await proof(second, await smartProof(second));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ status: "awaiting_approval" });
  });

  it("burns an unconfigured contract proof while wrong-key EOA stays invalid", async () => {
    vi.stubEnv("PCC_SIGVERIFY_RPC_URL", "");
    const request = await create();
    const response = await proof(request, await smartProof(request));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "verifier_unavailable" });
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "failed" });
    const claimed = privateKeyToAccount(generatePrivateKey());
    const wrong = privateKeyToAccount(generatePrivateKey());
    const eoa = await create({ address: claimed.address });
    const invalid = await proof(eoa, await wrong.signMessage({ message: eoa.message }));
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ error: "invalid_proof" });
    expect(requests).toHaveLength(0);
  });

  it("preserves EOA and ed25519 proofs without any RPC", async () => {
    unavailable = true;
    const account = privateKeyToAccount(generatePrivateKey());
    const eoa = await create({ address: account.address });
    expect((await proof(eoa, await account.signMessage({ message: eoa.message }))).statusCode).toBe(200);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
    const device = await create({ keyType: "ed25519", address: undefined, publicKey, role: "device", kernelId: "kernel_w11-device" });
    const signature = sign(null, Buffer.from(device.message), pair.privateKey).toString("hex");
    expect((await proof(device, signature)).statusCode).toBe(200);
    expect(requests).toHaveLength(0);
  });

  it("accepts 4098 signature characters and rejects 4099 without burning the request", async () => {
    const accepted = await create();
    const response = await proof(accepted, `0x${"ab".repeat(2048)}`);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_proof" });
    expect(getLinkRequest(accepted.requestId)?.status).toBe("failed");
    const rejected = await create();
    expect((await proof(rejected, `0x${"ab".repeat(2048)}a`)).statusCode).toBe(400);
    expect(getLinkRequest(rejected.requestId)?.status).toBe("pending_proof");
    expect((await proof(rejected, await smartProof(rejected))).statusCode).toBe(200);
  });
});

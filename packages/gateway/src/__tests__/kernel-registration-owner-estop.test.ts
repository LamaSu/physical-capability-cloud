import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker, SELF_SERVICE_KEY_SCOPES } from "../middleware/scope-checker.js";
import { deviceRelayRoutes, emergencyStopState } from "../routes/device-relay.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { provisionRoutes } from "../routes/provision.js";
import { walletsRoutes } from "../routes/wallets.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const KERNEL = "w5-wallet-only-owner-estop";
const LINK_REQUESTS = "/api/wallets/link-requests";
type Headers = Record<string, string>;
const bearer = (key: string): Headers => ({ authorization: `Bearer ${key}` });
let app: FastifyInstance;
let testNumber = 0;
let remoteAddress: string;

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "staging");
  vi.stubEnv("PCC_CHAIN_ID", "84532");
  vi.stubEnv("NODE_ENV", "staging");
  for (const name of ["RAILWAY_VOLUME_MOUNT_PATH", "PCC_ADMIN_KEY", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_KERNEL_LEGACY_SIGNING_PROOF"]) {
    vi.stubEnv(name, "");
  }
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  remoteAddress = `192.0.2.${++testNumber}`;
  app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "w5-owner-estop-test-cookie-secret" });
  await app.register(siweAuthPlugin);
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(provisionRoutes);
  await app.register(kernelRoutes);
  await app.register(deviceRelayRoutes);
  await app.register(operatorRoutes);
  // Like production, the self-link resolver must also reach earlier sibling routes.
  await app.register(walletsRoutes);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.unstubAllEnvs();
});

async function claimedOwnerKey(): Promise<string> {
  const provisioned = await app.inject({
    method: "POST", url: "/api/auth/provision", remoteAddress,
    payload: { walletAddress: OWNER.address },
  });
  expect(provisioned.statusCode, provisioned.body).toBe(201);
  expect(provisioned.json().operator_id).toBe(OWNER.address);
  expect(provisioned.json().scopes).toEqual(SELF_SERVICE_KEY_SCOPES);
  return provisioned.json().api_key;
}

async function selfLinkedOwner(): Promise<Headers> {
  const key = await claimedOwnerKey();
  const created = await app.inject({
    method: "POST", url: LINK_REQUESTS, headers: bearer(key),
    payload: { keyType: "secp256k1", address: OWNER.address.toLowerCase(), chainId: 84532,
      role: "agent", label: "w5-owner-estop" },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const proved = await app.inject({
    method: "POST", url: `${LINK_REQUESTS}/${request.requestId}/proof`,
    payload: { signature: await OWNER.signMessage({ message: request.message }) },
  });
  expect(proved.statusCode, proved.body).toBe(200);
  const approved = await app.inject({
    method: "POST", url: `${LINK_REQUESTS}/${request.requestId}/approve`, headers: bearer(key),
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return { ...bearer(key), "x-pcc-wallet": OWNER.address };
}

async function sessionOwnerKey(): Promise<Headers> {
  const hostname = "localhost";
  const nonce = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host: hostname } });
  expect(nonce.statusCode, nonce.body).toBe(200);
  const message = [
    `${hostname} wants you to sign in with your Ethereum account:`, OWNER.address,
    "", "Sign in to PCC.", "", `URI: http://${hostname}`, "Version: 1", "Chain ID: 84532",
    `Nonce: ${nonce.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const session = await app.inject({
    method: "POST", url: "/api/auth/verify", remoteAddress, headers: { host: hostname },
    payload: { message, signature: await OWNER.signMessage({ message }) },
  });
  expect(session.statusCode, session.body).toBe(200);
  const minted = await app.inject({
    method: "POST", url: "/api/auth/session-key", headers: bearer(session.json().token),
  });
  expect(minted.statusCode, minted.body).toBe(201);
  expect(minted.json().scopes).toEqual(SELF_SERVICE_KEY_SCOPES);
  const key = getRepos().apiKeys.findById(minted.json().key_id)!;
  expect(key.operatorId).toBe(OWNER.address);
  expect(key.operatorWalletCustody).toBeNull();
  expect(JSON.parse(key.metadata!)).toMatchObject({ source: "siwe-session" });
  // Use only the minted key: no session cookie, self-link or selected wallet header.
  return bearer(minted.json().api_key);
}

async function registerKernel(headers: Headers) {
  const challenge = await app.inject({
    method: "POST", url: "/api/kernels/registration-challenges", headers,
    payload: { kernelId: KERNEL, signer: { algorithm: "secp256k1", address: OWNER.address } },
  });
  expect(challenge.statusCode, challenge.body).toBe(201);
  const registered = await app.inject({
    method: "POST", url: "/api/kernels", headers,
    payload: {
      id: KERNEL, name: "Wallet-only owner kernel",
      signingKeyAlgorithm: "secp256k1", signingAddress: OWNER.address,
      registrationProof: {
        challengeId: challenge.json().challengeId,
        signature: await OWNER.signMessage({ message: challenge.json().message }),
      },
    },
  });
  expect(registered.statusCode, registered.body).toBe(201);
  expect(getRepos().kernels.findById(KERNEL)).toMatchObject({
    operatorAddress: OWNER.address, signingKeyAlgorithm: "secp256k1", signingAddress: OWNER.address,
  });
  expect(emergencyStopState(KERNEL)).toBe("clear");
}

async function expectRelayState(headers: Headers, stopped: boolean) {
  expect(emergencyStopState(KERNEL)).toBe(stopped ? "stopped" : "clear");
  const polled = await app.inject({ method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers });
  expect(polled.statusCode, polled.body).toBe(200);
  expect(polled.json()).toMatchObject({ calls: [], count: 0 });
  expect(polled.json().emergencyStop).toBe(stopped ? true : undefined);
}

async function engage(headers: Headers) {
  const response = await app.inject({
    method: "POST", url: "/api/operator/emergency-stop", headers,
    payload: { kernelId: KERNEL, reason: "Owner emergency-stop regression" },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ stopped: true, kernelId: KERNEL });
  await expectRelayState(headers, true);
}

async function resume(headers: Headers) {
  const response = await app.inject({
    method: "POST", url: "/api/operator/emergency-resume", headers, payload: { kernelId: KERNEL },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ resumed: true, kernelId: KERNEL });
  await expectRelayState(headers, false);
}

describe("W5 wallet-only owner emergency stop (steward #8754 and #8783)", () => {
  it("keeps ENGAGE and RESUME available to an agent self-linked owner after fresh W5 registration", async () => {
    const headers = await selfLinkedOwner();
    await registerKernel(headers);
    await engage(headers);
    await resume(headers);
  });

  describe("a key minted from the owner's real SIWE session", () => {
    let headers: Headers;
    beforeEach(async () => {
      headers = await sessionOwnerKey();
      await registerKernel(headers);
    });

    it("keeps ENGAGE available after fresh W5 registration", async () => {
      await engage(headers);
    });

    describe("after ENGAGE", () => {
      // The plain ENGAGE test above keeps that path covered while RESUME tracks N173.
      beforeEach(async () => { await engage(headers); });

      it.fails("allows RESUME (it.fails until N173: SIWE session keys carry no proven wallet)", async () => {
        await resume(headers);
      });
    });
  });

  it("lets a key only claiming the owner's wallet ENGAGE (stop_or_submit), but refuses RESUME without proof", async () => {
    const ownerHeaders = await selfLinkedOwner();
    await registerKernel(ownerHeaders);
    const headers = bearer(await claimedOwnerKey());
    await engage(headers);
    const response = await app.inject({
      method: "POST", url: "/api/operator/emergency-resume", headers, payload: { kernelId: KERNEL },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
    await expectRelayState(headers, true);
  });
});

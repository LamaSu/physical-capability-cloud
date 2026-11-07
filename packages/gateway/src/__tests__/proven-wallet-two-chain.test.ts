import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, initStore } from "../db.js";
import { BUYER_PROOF_REQUIRED } from "../auth/buyer-identity.js";
import { authorityOf } from "../auth/kernel-authority.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { walletsRoutes } from "../routes/wallets.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import { findSelfLinkedWallet } from "../services/wallet-links/repository.js";

// W1b r4 F-c: model a future allow-list with two chains while retaining every
// other production config setting and creating all links through the routes.
vi.mock("../services/wallet-links/config.js", async importOriginal => {
  const original = await importOriginal<typeof import("../services/wallet-links/config.js")>();
  return { ...original, walletLinkConfig: () => ({ ...original.walletLinkConfig(), allowedChainIds: [84532, 31337] }) };
});

const KERNEL = "kernel-w1bf-two-chain";
const LOWER_CHAIN = 31337;
const HIGHER_CHAIN = 84532;
let app: FastifyInstance;
let wallet: ReturnType<typeof privateKeyToAccount>;
let key: ReturnType<typeof provisionApiKey>;
const bearer = () => ({ authorization: `Bearer ${key.rawKey}` });
const headers = () => ({ ...bearer(), "x-pcc-wallet": wallet.address });

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  vi.stubEnv("PCC_ADMIN_KEY", "w1bf-two-chain-admin");
  closeStore();
  const { repos } = initStore({ seed: true });
  wallet = privateKeyToAccount(generatePrivateKey());
  key = provisionApiKey({ operatorId: wallet.address, scopes: ["*"] });
  repos.kernels.insert({ ...repos.kernels.findAll()[0]!, id: KERNEL, operatorAddress: wallet.address });
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiGate);
  await app.register(walletsRoutes);
  await app.register(negotiationRoutes);
  app.get("/api/w1bf/two-chain-authority", async req => authorityOf(req));
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function selfLink(role: "agent" | "device", chainId: number) {
  const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers: bearer(),
    payload: { keyType: "secp256k1", address: wallet.address.toLowerCase(), chainId,
      role, ...(role === "device" ? { kernelId: KERNEL } : {}), label: "w1bf-two-chain" } });
  expect(created.statusCode).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const signature = await wallet.signMessage({ message: request.message });
  expect((await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/proof`,
    payload: { signature } })).statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/approve`,
    headers: bearer(), payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
  expect(approved.statusCode).toBe(200);
}

const storedRole = () => findSelfLinkedWallet({ address: wallet.address, apiKeyId: key.record!.id,
  operatorId: wallet.address, now: Date.now() });

describe("self-link role uses least privilege across allowed chains", () => {
  it.each(["agent", "device"] as const)("preserves the %s-only control", async role => {
    await selfLink(role, HIGHER_CHAIN);
    expect(storedRole()).toBe(role);
  });

  it.each([
    { first: "agent", agentChain: LOWER_CHAIN, deviceChain: HIGHER_CHAIN, location: "lower" },
    { first: "agent", agentChain: HIGHER_CHAIN, deviceChain: LOWER_CHAIN, location: "higher" },
    { first: "device", agentChain: LOWER_CHAIN, deviceChain: HIGHER_CHAIN, location: "lower" },
    { first: "device", agentChain: HIGHER_CHAIN, deviceChain: LOWER_CHAIN, location: "higher" },
  ] as const)("device wins with $first inserted first and agent on the $location chain", async ({ first, agentChain, deviceChain }) => {
    const second = first === "agent" ? "device" : "agent";
    await selfLink(first, first === "agent" ? agentChain : deviceChain);
    await selfLink(second, second === "agent" ? agentChain : deviceChain);
    expect(storedRole()).toBe("device");

    if (first === "agent" && agentChain === LOWER_CHAIN) {
      const authority = await app.inject({ url: "/api/w1bf/two-chain-authority", headers: headers() });
      expect(authority.statusCode).toBe(200);
      expect(authority.json()).toMatchObject({ provenWallet: wallet.address.toLowerCase(), provenWalletVia: "self-link:device" });
      const negotiated = await app.inject({ method: "POST", url: "/api/negotiate/session", headers: headers(),
        payload: { kernelId: KERNEL, capabilityType: "w1bf-missing-capability", userAgentId: wallet.address } });
      expect(negotiated.statusCode).toBe(403);
      expect(negotiated.json()).toEqual(BUYER_PROOF_REQUIRED);
    }
  });
});

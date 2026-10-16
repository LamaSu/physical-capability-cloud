import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, initStore } from "../db.js";
import { bindBuyer, BUYER_PROOF_REQUIRED } from "../auth/buyer-identity.js";
import { authorityOf } from "../auth/kernel-authority.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { walletsRoutes } from "../routes/wallets.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

const KERNEL = "kernel-w1b-buyer";
const JOB = "job-w1b-buyer";
const MISSING_CAPABILITY = "w1b-missing-capability";
const WALLET = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
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
  vi.stubEnv("PCC_ADMIN_KEY", "w1b-buyer-admin");
  closeStore();
  const { repos } = initStore({ seed: true });
  wallet = privateKeyToAccount(generatePrivateKey());
  key = provisionApiKey({ operatorId: wallet.address, scopes: ["*"] });
  repos.kernels.insert({ ...repos.kernels.findAll()[0]!, id: KERNEL, operatorAddress: wallet.address });
  repos.jobs.insert({ ...repos.jobs.findAll()[0]!, id: JOB, kernelId: KERNEL, status: "queued", evidenceBundleId: null });
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiGate);
  await app.register(walletsRoutes);
  await app.register(negotiationRoutes);
  await app.register(paidJobFlowRoutes);
  await app.register(operatorRelayRoutes);
  app.get("/api/w1b/buyer-proof", async req => authorityOf(req));
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function selfLink(role: "agent" | "device") {
  const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers: bearer(),
    payload: { keyType: "secp256k1", address: wallet.address.toLowerCase(), chainId: 84532,
      role, ...(role === "device" ? { kernelId: KERNEL } : {}), label: "w1b-buyer" } });
  expect(created.statusCode).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const signature = await wallet.signMessage({ message: request.message });
  expect((await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/proof`,
    payload: { signature } })).statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/approve`,
    headers: bearer(), payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
  expect(approved.statusCode).toBe(200);
}

const BUYER_ROUTES = [
  ["negotiate", "/api/negotiate/session", "kernel_capability_mismatch"],
  ["submit-from-discovery", "/api/jobs/submit-from-discovery", "capability_not_found"],
] as const;
const buyerRequest = (url: string) => app.inject({ method: "POST", url, headers: headers(),
  payload: { kernelId: KERNEL, capabilityType: MISSING_CAPABILITY, userAgentId: wallet.address } });

describe("self-link role limits buyer binding while retaining DECIDE", () => {
  it.each(BUYER_ROUTES)("device self-link cannot bind a buyer on %s", async (_name, url) => {
    await selfLink("device");
    const response = await buyerRequest(url);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(BUYER_PROOF_REQUIRED);
  });

  it.each(["header", "query", "body"] as const)("device self-link cannot forge buyer provenance via %s", async source => {
    await selfLink("device");
    const response = await app.inject({
      method: "POST",
      url: `/api/negotiate/session${source === "query" ? "?provenWalletVia=self-link:agent" : ""}`,
      headers: { ...headers(), ...(source === "header" ? { "x-pcc-wallet-via": "self-link:agent" } : {}) },
      payload: { kernelId: KERNEL, capabilityType: MISSING_CAPABILITY, userAgentId: wallet.address,
        ...(source === "body" ? { provenWalletVia: "self-link:agent" } : {}) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(BUYER_PROOF_REQUIRED);
  });

  it.each(BUYER_ROUTES)("agent self-link still passes the buyer binding on %s", async (_name, url, error) => {
    await selfLink("agent");
    const response = await buyerRequest(url);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error });
  });

  it.each(["agent", "device"] as const)("carries the stored %s role through authorityOf", async role => {
    await selfLink(role);
    const response = await app.inject({ url: "/api/w1b/buyer-proof", headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provenWallet: wallet.address.toLowerCase(), provenWalletVia: `self-link:${role}` });
  });

  it("device self-link still grants DECIDE for real evidence", async () => {
    await selfLink("device");
    const response = await app.inject({ method: "POST", url: "/api/operator/evidence", headers: headers(),
      payload: { jobId: JOB, evidence: { events: [{ type: "execution_completed", timestamp: new Date().toISOString(),
        source: { deviceId: "w1b-buyer-printer", deviceType: "fdm", kernelId: KERNEL }, payload: { jobId: JOB, ok: true } }] } } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stored: true, jobId: JOB, eventsStored: 1 });
  });
});

describe("bindBuyer provenance allow-list", () => {
  it.each(["self-link:device", "x", undefined, null])("refuses provenance %s before checking a buyer mismatch", provenWalletVia => {
    const authority = { admin: false, provenWallet: WALLET, provenWalletVia };
    for (const named of [WALLET, OTHER]) {
      expect(bindBuyer(authority, named)).toEqual({ ok: false, status: 403, body: BUYER_PROOF_REQUIRED });
    }
  });

  it.each(["self-link:agent", "siwe-session"])("binds provenance %s and preserves the mismatch rule", provenWalletVia => {
    const authority = { admin: false, provenWallet: WALLET, provenWalletVia };
    expect(bindBuyer(authority, WALLET.toUpperCase().replace("0X", "0x"))).toEqual({ ok: true, buyer: WALLET });
    expect(bindBuyer(authority, OTHER)).toMatchObject({ ok: false, status: 403, body: { reason: "buyer_mismatch" } });
    expect(bindBuyer({ ...authority, provenWallet: null }, WALLET)).toEqual({ ok: false, status: 403, body: BUYER_PROOF_REQUIRED });
  });

  it.each(["self-link:device", "x", undefined, null])("keeps the admin binding with provenance %s", provenWalletVia => {
    expect(bindBuyer({ admin: true, provenWallet: null, provenWalletVia }, OTHER)).toEqual({ ok: true, buyer: OTHER });
  });
});

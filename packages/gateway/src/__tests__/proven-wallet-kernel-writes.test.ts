import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import { kernelSigningProofMessage } from "@pcc/kernel";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { provisionRoutes } from "../routes/provision.js";
import { walletsRoutes } from "../routes/wallets.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import * as posthog from "../services/posthog-service.js";

const PATH = "/api/wallets/link-requests";
const KERNEL_A = "kernel-w1b-writes-a";
const ADMIN = "w1b-kernel-writes-admin";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
type Headers = NonNullable<InjectOptions["headers"]>;
type Account = ReturnType<typeof privateKeyToAccount>;
let app: FastifyInstance;
let walletA: Account;
let walletB: Account;
let testNumber = 0;
let remoteAddress: string;

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });
const selected = (key: string, address = walletB.address): Headers => ({ ...bearer(key), "x-pcc-wallet": address });

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  // Provisioning must remain entirely local, regardless of the parent shell's configuration.
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  vi.spyOn(posthog, "trackServerEvent").mockImplementation(() => undefined);
  closeStore();
  initStore({ seed: true });
  walletA = privateKeyToAccount(generatePrivateKey());
  walletB = privateKeyToAccount(generatePrivateKey());
  remoteAddress = `192.0.2.${++testNumber}`;
  seedKernel(KERNEL_A, walletA.address);
  seedJob(KERNEL_A);
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiGate);
  await app.register(provisionRoutes);
  await app.register(kernelRoutes);
  // Preserve production's sibling order: the resolver must also reach earlier routes.
  await app.register(operatorRoutes);
  await app.register(walletsRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function seedKernel(id: string, operatorAddress: string) {
  const repos = getRepos();
  return repos.kernels.insert({
    ...repos.kernels.findAll()[0]!,
    id,
    name: "Original kernel profile",
    operatorAddress,
    status: "offline",
    lastHeartbeat: "2020-01-01T00:00:00.000Z",
    physicalAddress: "Original physical address",
    location: { lat: 47.6, lng: -122.3 },
    maxAssuranceTier: 1,
    signingAddress: null,
    signingKeyAlgorithm: null,
    signingKeyPublicKey: null,
  });
}

function seedJob(kernelId: string) {
  const repos = getRepos();
  const id = `job-${kernelId}`;
  repos.jobs.insert({ ...repos.jobs.findAll()[0]!, id, kernelId, status: "queued", evidenceBundleId: null });
  return id;
}

async function provision(walletAddress: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/provision", remoteAddress,
    payload: { walletAddress } });
  expect(response.statusCode).toBe(201);
  const credential = response.json<{ api_key: string; operator_id: string }>();
  expect(credential.operator_id).toBe(walletAddress);
  return credential.api_key;
}

async function selfLink(key: string, account = walletB) {
  const created = await app.inject({ method: "POST", url: PATH, headers: bearer(key),
    payload: { keyType: "secp256k1", address: account.address.toLowerCase(), chainId: 84532,
      role: "agent", label: "w1b-kernel-writes" } });
  expect(created.statusCode).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const signature = await account.signMessage({ message: request.message });
  expect((await app.inject({ method: "POST", url: `${PATH}/${request.requestId}/proof`,
    payload: { signature } })).statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `${PATH}/${request.requestId}/approve`,
    headers: bearer(key),
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
  expect(approved.statusCode).toBe(200);
}

function evidence(kernelId: string, headers: Headers) {
  const jobId = `job-${kernelId}`;
  return app.inject({ method: "POST", url: "/api/operator/evidence", headers,
    payload: { jobId, evidence: { events: [{ type: "execution_completed", timestamp: new Date().toISOString(),
      source: { deviceId: "w1b-writes-printer", deviceType: "fdm", kernelId }, payload: { jobId, ok: true } }] } } });
}

function policy(kernelId: string, headers: Headers) {
  return app.inject({ method: "PATCH", url: `/api/operator/policy/${kernelId}`, headers,
    payload: { emergencyStop: false } });
}

async function decideRefused(kernelId: string, headers: Headers) {
  for (const response of [await evidence(kernelId, headers), await policy(kernelId, headers)]) {
    expect.soft(response.statusCode).toBe(403);
    expect.soft(response.json()).toMatchObject({ error: "forbidden", reason: "operator_proof_required" });
  }
}

describe("self-linked wallets cannot transfer existing kernel ownership", () => {
  it("(a) refuses B's re-register and both heartbeats on A, then refuses evidence and policy DECIDE", async () => {
    const key = await provision(walletB.address);
    await selfLink(key);
    const headers = selected(key);
    const before = getRepos().kernels.findById(KERNEL_A)!;
    const registered = await app.inject({ method: "POST", url: "/api/kernels", headers,
      payload: { id: KERNEL_A, operatorAddress: walletB.address } });
    expect(getRepos().kernels.findById(KERNEL_A)).toEqual(before);
    expect(registered.statusCode).toBe(403);
    expect(registered.json()).toMatchObject({ error: "FORBIDDEN", message: `Authenticated actor does not own kernel '${KERNEL_A}'` });
    for (const request of [
      { url: `/api/kernels/${KERNEL_A}/heartbeat`, payload: { status: "online", operatorAddress: walletB.address } },
      { url: "/api/operator/heartbeat", payload: { kernelId: KERNEL_A, status: "online", operatorAddress: walletB.address } },
    ]) {
      const heartbeat = await app.inject({ method: "POST", headers, ...request });
      expect(heartbeat.statusCode).toBe(403);
      expect(heartbeat.json()).toMatchObject({ error: "forbidden", reason: "not_kernel_operator" });
      expect(getRepos().kernels.findById(KERNEL_A)).toEqual(before);
    }
    await decideRefused(KERNEL_A, headers);
  });

  it("(b) a key claiming A and self-linked to B re-registers without changing A, and neither header can DECIDE", async () => {
    const key = await provision(walletA.address);
    await selfLink(key);
    const registered = await app.inject({ method: "POST", url: "/api/kernels", headers: selected(key),
      payload: { id: KERNEL_A, operatorAddress: walletB.address, name: "Owner's profile update" } });
    expect(registered.statusCode).toBe(200);
    expect(getRepos().kernels.findById(KERNEL_A)).toMatchObject({ operatorAddress: walletA.address, name: "Owner's profile update" });
    await decideRefused(KERNEL_A, selected(key, walletB.address));
    await decideRefused(KERNEL_A, selected(key, walletA.address));
    expect(getRepos().kernels.findById(KERNEL_A)!.operatorAddress).toBe(walletA.address);
  });

  it.each([
    ["blank owner", "kernel-w1b-writes-u1", ""],
    ["zero-address owner", "kernel-w1b-writes-u2", ZERO_ADDRESS],
  ])("(c) refuses the legacy claim for %s before any profile, location or signer write", async (_name, kernelId, operatorAddress) => {
    const before = seedKernel(kernelId, operatorAddress);
    seedJob(kernelId);
    const key = await provision(walletB.address);
    await selfLink(key);
    const headers = selected(key);
    const signingProof = await walletB.signMessage({ message: kernelSigningProofMessage(kernelId) });
    const registered = await app.inject({ method: "POST", url: "/api/kernels", headers,
      payload: { id: kernelId, operatorAddress: walletB.address, name: "Unauthorized profile change",
        physicalAddress: "Unauthorized physical address", location: { lat: 51.5, lng: -0.1 },
        maxAssuranceTier: 3, signingAddress: walletB.address, signingProof } });
    expect.soft(registered.statusCode).toBe(403);
    expect.soft(registered.json()).toMatchObject({ error: "FORBIDDEN", message: `Authenticated actor does not own kernel '${kernelId}'` });
    expect.soft(getRepos().kernels.findById(kernelId)).toEqual(before);
    await decideRefused(kernelId, headers);
    expect.soft(getRepos().kernels.findById(kernelId)!.operatorAddress).toBe(operatorAddress);
  });

  it("(d) allows B to create a new id owned by B and DECIDE with its self-linked header", async () => {
    const key = await provision(walletB.address);
    await selfLink(key);
    const kernelId = "kernel-w1b-writes-new";
    const headers = selected(key);
    const created = await app.inject({ method: "POST", url: "/api/kernels", headers,
      payload: { id: kernelId, operatorAddress: walletA.address, name: "New B-owned kernel" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ created: true, kernel: { id: kernelId, operatorAddress: walletB.address } });
    expect(getRepos().kernels.findById(kernelId)!.operatorAddress).toBe(walletB.address);
    seedJob(kernelId);
    const stored = await evidence(kernelId, headers);
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ stored: true, jobId: `job-${kernelId}`, eventsStored: 1 });
    const updated = await policy(kernelId, headers);
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ updated: true, policy: { emergencyStop: false } });
    expect(getRepos().kernels.findById(kernelId)!.operatorAddress).toBe(walletB.address);
  });

  it.each(["", ZERO_ADDRESS])("preserves the admin's existing update path for an unowned kernel (%s)", async operatorAddress => {
    const kernelId = "kernel-w1b-writes-admin";
    seedKernel(kernelId, operatorAddress);
    const key = await provision(walletB.address);
    const signingProof = await walletB.signMessage({ message: kernelSigningProofMessage(kernelId) });
    const response = await app.inject({ method: "POST", url: "/api/kernels",
      headers: { ...bearer(key), "x-admin-key": ADMIN },
      payload: { id: kernelId, name: "Admin update", signingAddress: walletB.address, signingProof } });
    expect(response.statusCode).toBe(200);
    expect(getRepos().kernels.findById(kernelId)).toMatchObject({
      operatorAddress: walletB.address, name: "Admin update", signingAddress: walletB.address,
    });
  });

  it.each(["", ZERO_ADDRESS])("preserves actorless updates without claiming an unowned kernel (%s)", async operatorAddress => {
    const kernelId = "kernel-w1b-writes-actorless";
    seedKernel(kernelId, operatorAddress);
    const signingProof = await walletB.signMessage({ message: kernelSigningProofMessage(kernelId) });
    const actorlessApp = Fastify({ logger: false });
    try {
      await actorlessApp.register(kernelRoutes);
      const response = await actorlessApp.inject({ method: "POST", url: "/api/kernels",
        payload: { id: kernelId, operatorAddress: walletB.address, name: "Actorless update",
          signingAddress: walletB.address, signingProof } });
      expect(response.statusCode).toBe(200);
      expect(getRepos().kernels.findById(kernelId)).toMatchObject({
        operatorAddress, name: "Actorless update", signingAddress: walletB.address,
      });
    } finally {
      await actorlessApp.close();
    }
  });
});

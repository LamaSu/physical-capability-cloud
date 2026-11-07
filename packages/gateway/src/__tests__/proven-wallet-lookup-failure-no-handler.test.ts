import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { corsDelegator, irCorsReadProjection } from "../middleware/security-hardening.js";
import { decorateWithReportHint } from "../report-hint.js";
import { jobRoutes } from "../routes/jobs.js";
import { operatorRoutes } from "../routes/operator.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { walletsRoutes } from "../routes/wallets.js";
import { findSelfLinkedWallet } from "../services/wallet-links/repository.js";

// Hoisted module replacement reaches proven-wallet.ts's named import while all
// other wallet-link exports, and every underlying store operation, stay real.
vi.mock("../services/wallet-links/repository.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/wallet-links/repository.js")>(),
  findSelfLinkedWallet: vi.fn(),
}));

const KERNEL = "kernel-w1b-lookup-failure";
const JOB = "job-w1b-lookup-failure";
let app: FastifyInstance;
let wallet: ReturnType<typeof privateKeyToAccount>;
let key: ReturnType<typeof provisionApiKey>;

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  for (const name of ["PCC_ADMIN_KEY", "PCC_DEPLOYMENT_ENV", "RAILWAY_ENVIRONMENT_NAME", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
    vi.stubEnv(name, "");
  }
  vi.mocked(findSelfLinkedWallet).mockReset().mockImplementation(() => {
    throw new Error("self-link lookup unavailable");
  });
  closeStore();
  const { repos } = initStore({ seed: true });
  wallet = privateKeyToAccount(generatePrivateKey());
  key = provisionApiKey({ operatorId: wallet.address, scopes: ["*"] });
  repos.kernels.insert({ ...repos.kernels.findAll()[0]!, id: KERNEL, operatorAddress: wallet.address });
  repos.jobs.insert({ ...repos.jobs.findAll()[0]!, id: JOB, kernelId: KERNEL, status: "queued", evidenceBundleId: null });

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(cors, { delegator: corsDelegator });
  await app.register(apiGate);
  app.addHook("onSend", async (req, reply, payload) => typeof payload === "string"
    ? decorateWithReportHint(payload, { statusCode: reply.statusCode,
      contentType: String(reply.getHeader("content-type") ?? ""), url: req.url, method: req.method })
    : payload);
  app.addHook("onSend", irCorsReadProjection);
  app.addHook("onSend", async (_req, _reply, payload) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return payload;
  });
  // Keep production's sibling order: wallets installs the proof preHandler.
  await app.register(operatorRoutes);
  await app.register(jobRoutes);
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

describe("self-link lookup failure with an asynchronous onSend hook", () => {
  it("T7 returns the exact 503 without reaching the evidence handler or its store write", async () => {
    const repos = getRepos();
    const findJob = vi.spyOn(repos.jobs, "findById");
    const storeEvidence = vi.spyOn(repos.evidence, "insert");
    const response = await app.inject({
      method: "POST", url: "/api/operator/evidence",
      headers: { authorization: `Bearer ${key.rawKey}`, "x-pcc-wallet": wallet.address },
      payload: { jobId: JOB, evidence: { events: [{
        type: "execution_completed", timestamp: new Date().toISOString(),
        source: { deviceId: "w1b-printer", deviceType: "fdm", kernelId: KERNEL },
        payload: { jobId: JOB, ok: true },
      }] } },
    });

    expect(findSelfLinkedWallet).toHaveBeenCalledTimes(1);
    expect(findSelfLinkedWallet).toHaveBeenCalledWith({
      address: wallet.address, apiKeyId: key.record!.id,
      operatorId: wallet.address, now: expect.any(Number),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"wallet_link_unavailable"}');
    // A claimed identity alone cannot decide; the read spy also detects a
    // regressed preHandler that lets the handler run as far as its own refusal.
    expect(findJob).not.toHaveBeenCalled();
    expect(storeEvidence).not.toHaveBeenCalled();
    expect(repos.evidence.findByJob(JOB)).toEqual([]);
    expect(repos.jobs.findById(JOB)?.evidenceBundleId).toBeNull();
  });
});

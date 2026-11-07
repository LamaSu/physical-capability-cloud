import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { createSiweMessage } from "viem/siwe";
import { verifyEvmMessageSignature, type SignatureCheck } from "../auth/evm-signature.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { rateLimiter, __resetRateLimitState } from "../middleware/rate-limiter.js";
import { scopeChecker, __resetScopeCacheForTests } from "../middleware/scope-checker.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { walletsRoutes } from "../routes/wallets.js";
import { getLinkRequest, resolveActiveWalletLink } from "../services/wallet-links/repository.js";

vi.mock("../auth/evm-signature.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth/evm-signature.js")>(),
  verifyEvmMessageSignature: vi.fn(),
}));

const address = "0x1111111111111111111111111111111111111111";
const signature = `0x${"ab".repeat(65)}`;
const path = "/api/wallets/link-requests";
const verifier = vi.mocked(verifyEvmMessageSignature);
type Reason = Extract<SignatureCheck, { ok: false }>["reason"];
const mappings = [
  { reason: "malformed", siweStatus: 400, siweError: "Invalid signature format", proofStatus: 401, proofError: "invalid_proof" },
  { reason: "invalid", siweStatus: 401, siweError: "Invalid signature", proofStatus: 401, proofError: "invalid_proof" },
  { reason: "wrong_chain", siweStatus: 401, siweError: "wrong_chain", proofStatus: 401, proofError: "invalid_proof" },
  { reason: "unconfigured", siweStatus: 503, siweError: "smart_account_signin_unavailable", proofStatus: 503, proofError: "verifier_unavailable" },
  { reason: "unavailable", siweStatus: 503, siweError: "signature_verifier_unavailable", proofStatus: 503, proofError: "verifier_unavailable" },
] satisfies Array<{ reason: Reason; siweStatus: number; siweError: string; proofStatus: number; proofError: string }>;
let apps: FastifyInstance[];
let remoteAddress: string;
let testNumber = 0;

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  for (const name of ["RAILWAY_VOLUME_MOUNT_PATH", "PCC_DEPLOYMENT_ENV", "RAILWAY_ENVIRONMENT_NAME", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
    vi.stubEnv(name, "");
  }
  initStore({ seed: false });
  __resetRateLimitState();
  __resetScopeCacheForTests();
  verifier.mockReset();
  apps = [];
  remoteAddress = `198.18.12.${++testNumber}`;
});

afterEach(async () => {
  for (const app of apps) await app.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function buildSiweApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "signature-reason-mapping-cookie-secret" });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(siweAuthPlugin);
  await app.ready();
  return app;
}

async function buildWalletApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie, { secret: "signature-reason-mapping-cookie-secret" });
  await app.register(rateLimiter);
  await app.register(apiGate);
  await app.register(tenantContext);
  await app.register(scopeChecker);
  await app.register(siweAuthPlugin);
  await app.register(walletsRoutes);
  await app.ready();
  return app;
}

describe("non-ok signature reason mappings", () => {
  it.each(mappings)("SIWE maps $reason without a session and burns its nonce", async ({ reason, siweStatus, siweError }) => {
    verifier.mockResolvedValue({ ok: false, reason });
    const app = await buildSiweApp();
    const nonceResponse = await app.inject({ method: "GET", url: "/api/auth/nonce", remoteAddress });
    expect(nonceResponse.statusCode).toBe(200);
    const message = createSiweMessage({ address, domain: "localhost", uri: "http://localhost", version: "1",
      chainId: 84532, nonce: nonceResponse.json().nonce, issuedAt: new Date(), statement: "Sign in to PCC" });
    const sessionsBefore = getRepos().sessions.countActive();
    const request = { method: "POST" as const, url: "/api/auth/verify", headers: { host: "localhost" },
      payload: { message, signature }, remoteAddress };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(siweStatus);
    expect(response.json()).toEqual({ error: siweError });
    expect(response.headers["retry-after"]).toBe(reason === "unavailable" ? "5" : undefined);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(getRepos().sessions.countActive()).toBe(sessionsBefore);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith({ address, message, signature, chainId: 84532 });
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "Nonce expired or invalid" });
    expect(getRepos().sessions.countActive()).toBe(sessionsBefore);
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it.each(mappings)("W1 maps $reason and burns its proof without a link", async ({ reason, proofStatus, proofError }) => {
    verifier.mockResolvedValue({ ok: false, reason });
    const app = await buildWalletApp();
    const created = await app.inject({ method: "POST", url: path, remoteAddress,
      payload: { keyType: "secp256k1", address, role: "agent", label: "reason-mapping", chainId: 84532 } });
    expect(created.statusCode).toBe(201);
    const request = created.json<{ requestId: string; message: string }>();
    const response = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } });
    expect(response.statusCode).toBe(proofStatus);
    expect(response.json()).toEqual({ error: proofError });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith({ address, message: request.message, signature, chainId: 84532 });
    const poll = await app.inject(`${path}/${request.requestId}`);
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toEqual({ status: "failed" });
    expect(getLinkRequest(request.requestId)?.status).toBe("failed");
    expect(await resolveActiveWalletLink({ address, chainId: 84532 })).toBeNull();
  });
});

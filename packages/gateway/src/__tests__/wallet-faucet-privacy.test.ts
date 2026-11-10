import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, initStore } from "../db.js";
import { hashApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";
import { rateLimiter, __resetRateLimitState } from "../middleware/rate-limiter.js";
import { scopeChecker, __resetScopeCacheForTests } from "../middleware/scope-checker.js";
import { securityMonitorPlugin } from "../middleware/security-monitor.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { walletFaucetRoutes } from "../routes/wallet-faucet.js";
import { walletsRoutes } from "../routes/wallets.js";
import { auditService } from "../services/audit-service.js";
import * as posthog from "../services/posthog-service.js";
import { GATEWAY_LOGGER_OPTIONS, telemetryLookalikeHook } from "../services/telemetry-privacy.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import { writeAuditHook } from "../services/write-audit-hook.js";
import { walletSafeSentryEvent } from "../sentry.js";

const IP = "203.0.113.67";
const DUMMY_ID = "dummy-faucet-privacy-id";
const DUMMY_SECRET = "dummy-faucet-privacy-secret";
const owner = { authorization: "Bearer pcc_test_faucet_privacy_owner" };
const env = { PCC_FAUCET_CDP_API_KEY_ID: DUMMY_ID, PCC_FAUCET_CDP_API_KEY_SECRET: DUMMY_SECRET };
const requestPath = "/api/wallets/link-requests";
let app: FastifyInstance | undefined;
let logs: string[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  vi.stubEnv("PCC_NETWORK", "base-sepolia");
  vi.stubEnv("CDP_NETWORK", "");
  vi.stubEnv("PCC_X402_CHAIN", "");
  for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  __resetRateLimitState();
  __resetScopeCacheForTests();
  logs = [];
  const store = initStore({ seed: false });
  const token = owner.authorization.slice("Bearer ".length);
  store.repos.apiKeys.insert({
    id: "faucet-privacy-owner", keyHash: hashApiKey(token), keyPrefix: token.slice(0, 12),
    operatorId: "account-faucet-privacy", name: null, description: null, scopes: "[]",
    rateLimit: "1000/hour", usageCount: "0", createdAt: new Date().toISOString(),
    expiresAt: null, metadata: null, publicKey: null,
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function buildApp(client: { isMock?: boolean; requestFaucet(address: string, token: "eth" | "usdc"): Promise<{ transactionHash: string }> }) {
  app = Fastify({
    trustProxy: true,
    logger: { ...GATEWAY_LOGGER_OPTIONS, level: "info", stream: { write: (line: string) => { logs.push(line); } } },
  });
  app.addHook("onRequest", telemetryLookalikeHook);
  app.addHook("onResponse", writeAuditHook);
  await app.register(cookie);
  // Match server.ts: the monitor is encapsulated and the route plugins are siblings.
  await app.register(securityMonitorPlugin);
  await app.register(rateLimiter);
  await app.register(apiGate);
  await app.register(tenantContext);
  await app.register(scopeChecker);
  await app.register(walletsRoutes);
  await app.register(walletFaucetRoutes, { client, env });
  await app.ready();
  return app;
}

async function approvedLink(instance: FastifyInstance) {
  const account = privateKeyToAccount(generatePrivateKey());
  const created = await instance.inject({
    method: "POST", url: requestPath, remoteAddress: IP,
    payload: { keyType: "secp256k1", address: account.address.toLowerCase(), role: "agent", label: "privacy-cli", chainId: 84532 },
  });
  expect(created.statusCode).toBe(201);
  const request = created.json() as { requestId: string; userCode: string; message: string };
  const proof = await instance.inject({
    method: "POST", url: `${requestPath}/${request.requestId}/proof`, remoteAddress: IP,
    payload: { signature: await account.signMessage({ message: request.message }) },
  });
  expect(proof.statusCode).toBe(200);
  const approved = await instance.inject({
    method: "POST", url: `${requestPath}/${request.requestId}/approve`, headers: owner, remoteAddress: IP,
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 },
  });
  expect(approved.statusCode).toBe(200);
  return { account, requestId: request.requestId, linkId: approved.json().linkId as string };
}

describe("linked-wallet faucet privacy", () => {
  it.each(["funded", "error"] as const)("%s call exposes no private values to logs, audit or PostHog", async outcome => {
    const hashes: string[] = [];
    let privateValues: string[] = [];
    const faucet = vi.fn(async (address: string, _token: "eth" | "usdc") => {
      if (outcome === "error") {
        throw Object.assign(new Error(`CDP private message ${[address, ...privateValues].join(" ")}`), { errorType: "faucet_limit_exceeded" });
      }
      const transactionHash = `0x${randomBytes(32).toString("hex")}`;
      hashes.push(transactionHash);
      return { transactionHash };
    });
    const audit = vi.spyOn(auditService, "log").mockImplementation(() => true);
    const analytics = vi.spyOn(posthog, "trackServerEvent").mockImplementation(() => undefined);
    const instance = await buildApp({ isMock: false, requestFaucet: faucet });
    const linked = await approvedLink(instance);
    privateValues = [linked.account.address, linked.account.address.toLowerCase(), linked.requestId, linked.linkId, IP, DUMMY_ID, DUMMY_SECRET];
    logs.length = 0;
    audit.mockClear();
    analytics.mockClear();
    const response = await instance.inject({
      method: "POST", url: `${requestPath}/${linked.requestId}/fund`, remoteAddress: IP,
      headers: { "x-forwarded-for": IP, "user-agent": "privacy-cli" },
    });
    expect(response.statusCode).toBe(outcome === "funded" ? 200 : 502);
    if (outcome === "funded") expect(response.json().status).toBe("funded");
    else expect(response.json()).toEqual({ error: "faucet_error", errorClass: "faucet_limit_exceeded" });
    expect(faucet).toHaveBeenCalledTimes(6);
    expect(logs.length).toBeGreaterThan(0);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]![0]).toEqual({
      eventType: "http.write", action: "wallet_ceremony",
      metadata: { route: "/api/wallets/link-requests/:id/fund", outcome: outcome === "funded" ? "success" : "error", count: 1 },
    });
    const sinks = `${logs.join("")} ${JSON.stringify(audit.mock.calls)} ${JSON.stringify(analytics.mock.calls)}`;
    for (const value of [...privateValues, ...hashes, "CDP private message"]) expect(sinks).not.toContain(value);
    expect(analytics).not.toHaveBeenCalled();
    if (outcome === "error") for (const value of privateValues) expect(response.body).not.toContain(value);
    expect(walletSafeSentryEvent({
      request: { url: `https://capability.network${requestPath}/${linked.requestId}/fund` },
      extra: { address: linked.account.address, linkId: linked.linkId, message: privateValues.join(" "), hashes },
    })).toBeNull();
  });

  it("faucet production source contains no equipment identity fields or logging calls", () => {
    const files = [
      "../routes/wallet-faucet.ts",
      "../services/wallet-faucet/config.ts",
      "../services/wallet-faucet/plan.ts",
      "../services/wallet-faucet/client.ts",
      "../services/wallet-faucet/repository.ts",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/\b(?:kernel_id|subject_id|kernelId)\b/);
      expect(source, file).not.toMatch(/\bconsole\s*(?:\.|\[)|\b(?:app|req|request|reply)\s*\.\s*log\b|\blogger\s*(?:\.|\[)/);
    }
  });
});

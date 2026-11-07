import Fastify, { type FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStore, getRepos, initStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { apiGate } from "../middleware/api-gate.js";
import { walletsRoutes } from "../routes/wallets.js";
import { kernelRoutes } from "../routes/kernels.js";
import { provisionRoutes } from "../routes/provision.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import { initPostHog } from "../services/posthog-service.js";
import { writeAuditHook } from "../services/write-audit-hook.js";

const sdk = vi.hoisted(() => ({ capture: vi.fn(), identify: vi.fn(), constructed: vi.fn() }));
vi.mock("posthog-node", () => ({ PostHog: class {
  capture = sdk.capture;
  identify = sdk.identify;
  constructor() { sdk.constructed(); }
} }));

let app: FastifyInstance;
let wallet: ReturnType<typeof privateKeyToAccount>;
let headers: Record<string, string>;
const OPERATOR = "w1b-sinks@example.test";

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("POSTHOG_API_KEY", "mock-only");
  vi.stubEnv("PCC_FUNNEL_ENABLED", "false");
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  sdk.capture.mockClear();
  sdk.identify.mockClear();
  sdk.constructed.mockClear();
  initPostHog();
  await vi.waitFor(() => expect(sdk.constructed).toHaveBeenCalledOnce());
  closeStore();
  initStore({ seed: false });
  wallet = privateKeyToAccount(generatePrivateKey());
  const key = provisionApiKey({ operatorId: OPERATOR, scopes: ["*"] });
  headers = { authorization: `Bearer ${key.rawKey}` };
  app = Fastify({ logger: false });
  await app.register(apiGate);
  app.addHook("onResponse", writeAuditHook);
  await app.register(kernelRoutes);
  await app.register(provisionRoutes);
  await app.register(walletsRoutes);
  await app.ready();
  const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers,
    payload: { keyType: "secp256k1", address: wallet.address.toLowerCase(), chainId: 84532, role: "agent", label: "w1b-sinks" } });
  expect(created.statusCode).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const signature = await wallet.signMessage({ message: request.message });
  expect((await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/proof`, payload: { signature } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/approve`, headers,
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } })).statusCode).toBe(200);
});

afterEach(async () => {
  await app?.close();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function register(id: string, selected?: string) {
  return app.inject({ method: "POST", url: "/api/kernels",
    headers: { ...headers, ...(selected === undefined ? {} : { "x-pcc-wallet": selected }) },
    payload: { id, name: "W1b sink test", location: { lat: 1, lng: 1 } } });
}

describe("wallet header preserves normal telemetry sinks", () => {
  it("15 preserves facade audit and PostHog events for a self-linked wallet header", async () => {
    expect((await register("kernel-w1b-private", wallet.address)).statusCode).toBe(201);
    const audit = getRepos().auditLog.query({ limit: 100 });
    expect(getRepos().auditLog.query({ resourceId: "kernel-w1b-private" })[0]).toMatchObject({ actor: OPERATOR, ip: "127.0.0.1" });
    expect(sdk.capture).toHaveBeenCalledOnce();
    expect(sdk.capture.mock.calls[0]![0]).toMatchObject({ event: "kernel_registered",
      properties: { kernelId: "kernel-w1b-private", operatorAddress: OPERATOR } });
    const sinks = JSON.stringify([audit, sdk.capture.mock.calls, sdk.identify.mock.calls]);
    expect(sinks.toLowerCase()).not.toContain(wallet.address.toLowerCase());
  });

  it("15 preserves audit and PostHog events even when the wallet header is malformed", async () => {
    const selected = "wallet-header-sensitive-marker";
    expect((await register("kernel-w1b-malformed", selected)).statusCode).toBe(201);
    expect(getRepos().auditLog.query({ resourceId: "kernel-w1b-malformed" })[0]).toMatchObject({ actor: OPERATOR, ip: "127.0.0.1" });
    const sinks = JSON.stringify([getRepos().auditLog.query({ limit: 100 }), sdk.capture.mock.calls]);
    expect(sinks).not.toContain(selected);
    expect(sdk.capture).toHaveBeenCalledOnce();
    expect(sdk.capture.mock.calls[0]![0]).toMatchObject({ event: "kernel_registered",
      properties: { operatorAddress: OPERATOR } });
  });

  it("keeps ordinary audit and PostHog behavior without a header", async () => {
    expect((await register("kernel-w1b-ordinary")).statusCode).toBe(201);
    expect(sdk.capture).toHaveBeenCalledOnce();
    expect(sdk.capture.mock.calls[0]![0]).toMatchObject({ event: "kernel_registered",
      properties: { operatorAddress: OPERATOR } });
    expect(getRepos().auditLog.query({ resourceId: "kernel-w1b-ordinary" })[0]?.actor).toBe(OPERATOR);
  });

  it("preserves telemetry for concurrent header and ordinary requests", async () => {
    const responses = await Promise.all([register("kernel-w1b-concurrent-private", wallet.address), register("kernel-w1b-concurrent-ordinary")]);
    expect(responses.map(response => response.statusCode)).toEqual([201, 201]);
    expect(sdk.capture).toHaveBeenCalledTimes(2);
    expect(sdk.capture.mock.calls.map(([event]) => event.properties.kernelId).sort()).toEqual([
      "kernel-w1b-concurrent-ordinary", "kernel-w1b-concurrent-private",
    ]);
    expect(getRepos().auditLog.query({ resourceId: "kernel-w1b-concurrent-private" })[0]?.actor).toBe(OPERATOR);
    expect(getRepos().auditLog.query({ resourceId: "kernel-w1b-concurrent-ordinary" })[0]?.actor).toBe(OPERATOR);
    expect(JSON.stringify([getRepos().auditLog.query({ limit: 100 }), sdk.capture.mock.calls]).toLowerCase()).not.toContain(wallet.address.toLowerCase());
  });

  it.each(["valid", "malformed"])("15 preserves normal audit and PostHog on an anonymous public POST with a %s header", async kind => {
    const selected = kind === "valid" ? wallet.address : "wallet-header-sensitive-marker";
    const response = await app.inject({ method: "POST", url: "/api/auth/provision",
      headers: { "x-pcc-wallet": selected, "user-agent": "w1b-public-client" },
      remoteAddress: "192.0.2.15", payload: { email: "w1b-public@example.test" } });
    expect(response.statusCode).toBe(201);
    expect(getRepos().auditLog.query({ eventType: "http.write" }).find(row =>
      (row.metadata as Record<string, unknown> | null)?.url === "/api/auth/provision")).toMatchObject({
      actor: "anonymous", ip: "192.0.2.15", userAgent: "w1b-public-client", action: "post",
      metadata: { method: "POST", url: "/api/auth/provision", statusCode: 201 },
    });
    expect(getRepos().auditLog.query({ eventType: "auth.key_provisioned" })[0]).toMatchObject({
      actor: "w1b-public@example.test", ip: "192.0.2.15", userAgent: "w1b-public-client",
    });
    expect(sdk.capture).toHaveBeenCalledOnce();
    expect(sdk.capture.mock.calls[0]![0]).toMatchObject({ event: "api_key_provisioned" });
    expect(JSON.stringify([getRepos().auditLog.query({ limit: 100 }), sdk.capture.mock.calls])).not.toContain(selected);
  });
});

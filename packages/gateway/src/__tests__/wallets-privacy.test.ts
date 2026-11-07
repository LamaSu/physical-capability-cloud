import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeStore, initStore } from "../db.js";
import { auditService } from "../services/audit-service.js";
import * as privacy from "../services/telemetry-privacy.js";
import { writeAuditHook } from "../services/write-audit-hook.js";
import { securityMonitorPlugin } from "../middleware/security-monitor.js";
import { apiGate } from "../middleware/api-gate.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { hashApiKey } from "../auth/api-key-auth.js";
import { walletsRoutes } from "../routes/wallets.js";
import * as posthog from "../services/posthog-service.js";
import * as sentry from "../sentry.js";

const ADDRESS = "0x1111222233334444555566667777888899990000";
const CODE = "BCDF-GHJK";
const IP = "203.0.113.67";
const SIGNATURE = "signature-sensitive-marker";
const LABEL = "label-sensitive-marker";
const OWNER = "owner-sensitive-marker";
let app: FastifyInstance | undefined;
const oldDb = process.env.PCC_DB_PATH;
const oldDatabaseUrl = process.env.DATABASE_URL;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  closeStore();
  if (oldDb === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = oldDb;
  if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldDatabaseUrl;
});

describe("wallet ceremony global privacy", () => {
  it.each(["/api/walletsX", "/api/walletsX/link-requests", "https://capability.network/api/walletsX", "POST /api/walletsX"])("wallet prefix excludes unrelated path: %s", (url) => {
    expect(privacy.isWalletRequest(url)).toBe(false);
  });

  it.each(["/api/wallets", "/api/wallets?anything=1", "/api/wallets/link-requests", "https://capability.network/api/wallets", "POST /api/wallets/link-requests/:id/approve"])("wallet prefix includes its root and children: %s", (url) => {
    expect(privacy.isWalletRequest(url)).toBe(true);
  });

  it.each([
    `/api/wallets/link-requests/by-code/${CODE}?address=${ADDRESS}`,
    `/api/wallets//${LABEL}`,
    `/api/%77allets/${LABEL}`,
    `/api/%77allets/%E0%A4%A/${LABEL}`,
  ])("request serializer records only a route template: %s", (url) => {
    const result = privacy.requestLogSerializer({
      method: "GET", url, ip: IP, hostname: LABEL,
      headers: { authorization: SIGNATURE, "user-agent": LABEL },
    });
    expect(result).toEqual({ method: "GET", url: "/api/wallets" });
    const encoded = JSON.stringify(result);
    for (const value of [ADDRESS, CODE, IP, SIGNATURE, LABEL]) expect(encoded).not.toContain(value);
  });

  it("write audit records route, outcome and count without owner or request values", async () => {
    delete process.env.DATABASE_URL;
    process.env.PCC_DB_PATH = ":memory:";
    closeStore();
    initStore({ seed: false });
    const audit = vi.spyOn(auditService, "log").mockImplementation(() => true);
    app = Fastify({ logger: false, trustProxy: true });
    app.addHook("onRequest", async (req) => {
      (req as FastifyRequest & { operatorId: string }).operatorId = OWNER;
    });
    app.addHook("onResponse", writeAuditHook);
    app.post("/api/wallets/link-requests/:id/approve", async () => ({ status: "approved" }));
    await app.inject({
      method: "POST", url: `/api/wallets/link-requests/${LABEL}/approve?address=${ADDRESS}`,
      headers: { "x-forwarded-for": IP, "user-agent": SIGNATURE },
      payload: { userCode: CODE, signature: SIGNATURE },
    });
    expect(audit).toHaveBeenCalledOnce();
    const row = audit.mock.calls[0]![0];
    expect(row.metadata).toEqual({
      route: "/api/wallets/link-requests/:id/approve", outcome: "success", count: 1,
    });
    for (const value of [ADDRESS, CODE, IP, SIGNATURE, LABEL, OWNER]) {
      expect(JSON.stringify(row)).not.toContain(value);
    }
  });

  it("non-wallet sibling route accepts ordinary job prose with the monitor encapsulated", async () => {
    vi.spyOn(posthog, "trackServerEvent").mockImplementation(() => undefined);
    delete process.env.DATABASE_URL;
    process.env.PCC_DB_PATH = ":memory:";
    closeStore();
    const store = initStore({ seed: false });
    const token = "pcc_test_w1_monitor_regression";
    store.repos.apiKeys.insert({
      id: "w1-monitor-regression", keyHash: hashApiKey(token), keyPrefix: token.slice(0, 12), operatorId: OWNER,
      name: null, description: null, scopes: '["*"]', rateLimit: "1000/hour", usageCount: "0",
      createdAt: new Date().toISOString(), expiresAt: null, metadata: null, publicKey: null,
    });
    app = Fastify({ logger: false });
    // Match server.ts: monitor, API gate, job routes, then wallet routes, all siblings.
    await app.register(securityMonitorPlugin);
    await app.register(apiGate);
    await app.register(async jobApp => {
      jobApp.post("/api/jobs/w1-monitor-control", async req => req.body);
    });
    await app.register(walletsRoutes);
    const payload = { instructions: "Please select the black filament from the shelf and update the label where it says PLA." };
    const response = await app.inject({
      method: "POST", url: "/api/jobs/w1-monitor-control",
      headers: { authorization: `Bearer ${token}` }, payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(payload);
  });

  it("tenant context is available to later onRequest hooks on wallet owner routes", async () => {
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      req.apiKeyId = "key-privacy-owner";
      req.operatorId = OWNER;
    });
    await app.register(tenantContext);
    let earlyTenant: string | null | undefined;
    app.addHook("onRequest", async (req) => { earlyTenant = req.tenantId; });
    app.post("/api/wallets/link-requests/lookup", async () => ({ ok: true }));
    const response = await app.inject({ method: "POST", url: "/api/wallets/link-requests/lookup", payload: { userCode: CODE } });
    expect(response.statusCode).toBe(200);
    expect(earlyTenant).toBe(OWNER);
  });

  it("wallet lookalikes have a fixed 404 without raw request values", async () => {
    const logs: string[] = [];
    app = Fastify({ logger: { ...privacy.GATEWAY_LOGGER_OPTIONS, level: "info", stream: { write: (line: string) => logs.push(line) } } });
    app.addHook("onRequest", privacy.telemetryLookalikeHook);
    const response = await app.inject({ method: "GET", url: `/api/wallets/${LABEL}/${CODE}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
    for (const value of [LABEL, CODE]) expect(logs.join("")).not.toContain(value);
  });

  it("Sentry drops wallet errors and transactions including absolute URLs", () => {
    const filter = sentry.walletSafeSentryEvent;
    expect(filter).toBeTypeOf("function");
    const values = [
      { request: { url: `https://capability.network/api/wallets/link-requests/by-code/${CODE}` }, extra: { signature: SIGNATURE } },
      { extra: { url: `/api/%77allets/${LABEL}`, address: ADDRESS } },
      { transaction: "POST /api/wallets/link-requests/:id/proof", extra: { signature: SIGNATURE } },
    ];
    for (const event of values) expect(filter(event)).toBeNull();
    const unrelated = { request: { url: "/api/health" } };
    expect(filter(unrelated)).toBe(unrelated);
  });
});

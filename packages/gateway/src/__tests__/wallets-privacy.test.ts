import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeStore, initStore } from "../db.js";
import { auditService } from "../services/audit-service.js";
import * as privacy from "../services/telemetry-privacy.js";
import { writeAuditHook } from "../services/write-audit-hook.js";
import { securityMonitorPlugin } from "../middleware/security-monitor.js";
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

  it("security monitor emits no wallet request fingerprints or values", async () => {
    const analytics = vi.spyOn(posthog, "trackServerEvent").mockImplementation(() => undefined);
    const logs: string[] = [];
    app = Fastify({ logger: { level: "warn", stream: { write: (line: string) => logs.push(line) } }, trustProxy: true });
    await securityMonitorPlugin(app);
    app.post("/api/wallets/link-requests", async () => ({ ok: true }));
    const response = await app.inject({
      method: "POST", url: "/api/wallets/link-requests",
      headers: { "x-forwarded-for": IP, "user-agent": "python-requests/2.0" },
      payload: { label: LABEL, signature: `<script>${SIGNATURE}</script>` },
    });
    expect(response.statusCode).toBe(200);
    expect(analytics).not.toHaveBeenCalled();
    for (const value of [IP, SIGNATURE, LABEL]) expect(logs.join("")).not.toContain(value);
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

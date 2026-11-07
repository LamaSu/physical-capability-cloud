import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import * as Sentry from "@sentry/node";
import { siweAuthPlugin, __resetSignInIssueForTests } from "../auth/siwe-auth.js";
import { closeStore, initStore } from "../db.js";
import { GATEWAY_LOGGER_OPTIONS, requestLogSerializer, isWalletRequest } from "../services/telemetry-privacy.js";

vi.mock("@sentry/node", () => ({ init: vi.fn() }));

const ADDRESS = "0x1111222233334444555566667777888899990000";
const IP = "203.0.113.77";
const ISSUE_URL = `/api/auth/nonce?address=${ADDRESS}`;
const TARGETS = [ISSUE_URL, `https://capability.network${ISSUE_URL}`, `GET ${ISSUE_URL}`,
  `/API//auth/%6eonce?address=${ADDRESS}`];
let app: FastifyInstance | undefined;
let sentry: typeof import("../sentry.js");
let options: NonNullable<Parameters<typeof Sentry.init>[0]>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_SIGVERIFY_CHAIN_ID", "84532");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "");
  closeStore();
  initStore({ seed: false });
  __resetSignInIssueForTests();
  vi.mocked(Sentry.init).mockClear();
  sentry = await import("../sentry.js");
  sentry.initSentry();
  expect(Sentry.init).toHaveBeenCalledOnce();
  options = vi.mocked(Sentry.init).mock.calls[0]![0]!;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  closeStore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sign-in issue sink privacy", () => {
  it("F1 cell 1: the request serializer retains only method and issue path", () => {
    for (const url of [...TARGETS, "/api/auth/nonce"]) {
      const output = requestLogSerializer({ method: "GET", url, ip: IP, hostname: "gateway.test",
        headers: { "user-agent": ADDRESS }, socket: { remotePort: 12345 } });
      expect(output).toEqual({ method: "GET", url: "/api/auth/nonce" });
      expect(JSON.stringify(output)).not.toContain(ADDRESS);
      expect(JSON.stringify(output)).not.toContain(IP);
      expect(isWalletRequest(url)).toBe(false);
    }
    expect(requestLogSerializer({ method: "GET", url: "/api/auth/nonces", ip: IP }))
      .toMatchObject({ method: "GET", url: "/api/auth/nonces", remoteAddress: IP });
  });

  it("F1 cell 2: the real issue route writes no wallet address or IP to the gateway logger", async () => {
    const lines: string[] = [];
    app = Fastify({ logger: { ...GATEWAY_LOGGER_OPTIONS, stream: { write: (line: string) => { lines.push(line); } } } });
    await app.register(siweAuthPlugin);
    const response = await app.inject({ method: "GET", url: ISSUE_URL, remoteAddress: IP });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().message.split("\n")[1]).toBe(ADDRESS);
    const incoming = lines.map(line => JSON.parse(line)).find(line => line.msg === "incoming request");
    expect(incoming).toBeDefined();
    expect(lines.join("\n")).not.toContain(ADDRESS);
    expect(lines.join("\n")).not.toContain(IP);
    expect(incoming.req).toEqual({ method: "GET", url: "/api/auth/nonce" });
  });

  it("F1 cell 3: Sentry drops issue events and breadcrumbs and redacts issue spans", async () => {
    for (const url of TARGETS) {
      for (const event of [
        { request: { url, query_string: `address=${ADDRESS}` } },
        { extra: { url } },
        { transaction: url },
      ]) expect(sentry.walletSafeSentryEvent(event)).toBeNull();
      const event = { request: { url, query_string: `address=${ADDRESS}` } };
      expect(await options.beforeSend!(event, {})).toBeNull();
      expect(await options.beforeSendTransaction!({ ...event, type: "transaction", transaction: "GET /api/auth/nonce" }, {})).toBeNull();
      for (const breadcrumb of [{ data: { url } }, { data: { request_url: url } }, { message: url }]) {
        expect(options.beforeBreadcrumb!(breadcrumb, {})).toBeNull();
      }
      for (const field of ["description", "url.full", "http.url", "http.target", "url.path", "http.route"]) {
        const span = { op: "http.server", description: field === "description" ? url : "request",
          span_id: "1234567890abcdef", trace_id: "1234567890abcdef1234567890abcdef", start_timestamp: 1, timestamp: 2,
          data: { [field]: url, "url.query": `address=${ADDRESS}`, "client.address": IP } };
        const result = options.beforeSendSpan!(span);
        expect(result).toEqual({ ...span, description: "/api/auth/nonce", data: {} });
        expect(JSON.stringify(result)).not.toContain(ADDRESS);
        expect(JSON.stringify(result)).not.toContain(IP);
      }
    }
  });
});

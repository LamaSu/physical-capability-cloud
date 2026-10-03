/**
 * Cross-family review r6 of #441 (rm-px7-441-r6-57233724, DO-NOT-SHIP), MEDIUM 3: encoded
 * separators (%3F, %23, and %26 or %3D after one) bypassed the value-free rule in strings, the
 * request log and the audit row. The redactors stay as defence in depth under the PR steward's
 * strict ruling (#5315, #5319); the closed producer schema that the ruling asks for is built in
 * #514 (N107), which #441 rebases onto.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";

const captured = vi.hoisted(() => ({ logs: [] as string[], posthog: [] as unknown[] }));

vi.mock("fastify", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown> & { default: (opts?: Record<string, unknown>) => unknown };
  const { Writable } = await import("node:stream");
  const sink = new Writable({
    write(chunk, _encoding, done) {
      captured.logs.push(String(chunk));
      done();
    },
  });
  const fastify = (opts: Record<string, unknown> = {}) => {
    const logger =
      opts.logger === true
        ? { level: "info", stream: sink }
        : opts.logger && typeof opts.logger === "object"
          ? { ...(opts.logger as Record<string, unknown>), stream: sink }
          : opts.logger;
    return real.default({ ...opts, logger });
  };
  return { ...real, default: fastify, fastify };
});
// The PostHog client: the gateway's own posthog-service runs, and its client captures.
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(event: unknown) {
      captured.posthog.push(event);
    }
    identify(event: unknown) {
      captured.posthog.push(event);
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.setConfig({ testTimeout: 60_000 });

// Every marker is built at runtime, so no literal here looks like a secret.
const mark = (name: string) => ["px7", "r7", name, "5c1d"].join("-");
const DSN = "https://public@o0.ingest.sentry.io/0";

const sentryBodies: string[] = [];
let port = 0;
let app: { close(): Promise<unknown>; listen(o: { port: number; host: string }): Promise<string>; server: http.Server };

const request = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

beforeAll(async () => {
  delete process.env.SENTRY_DSN;
  delete process.env.VITE_SENTRY_DSN;
  delete process.env.TENANT_ENFORCE;
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ["px7", "r7", "admin"].join("-");
  process.env.MOCK_SETTLEMENT = "true";
  process.env.POSTHOG_API_KEY = ["px7", "r7", "posthog"].join("-");
  // The gateway's own Sentry options; only the transport is a capture. Dedupe is off, as in r5:
  // it would hide the gateway's own capture behind the SDK's capture of the same error.
  const { sentryOptions } = await import("../sentry.js");
  const options = sentryOptions(DSN);
  Sentry.init({
    ...options,
    integrations: (defaults) => {
      const own = typeof options.integrations === "function" ? options.integrations(defaults) : defaults;
      return own.filter((integration) => integration.name !== "Dedupe");
    },
    transport: (transportOptions) =>
      Sentry.createTransport(transportOptions, async (req) => {
        sentryBodies.push(typeof req.body === "string" ? req.body : Buffer.from(req.body).toString("utf8"));
        return { statusCode: 200 };
      }),
  });
  const { createGateway } = await import("../server.js");
  const gateway = await createGateway(0);
  app = gateway.app as unknown as typeof app;
  // Stand-ins for any route that fails on a request (outside /api/, so no API gate).
  const routes = gateway.app as unknown as { post(path: string, handler: () => Promise<unknown>): void };
  routes.post("/px7-r7/throws", async () => {
    throw new Error("px7-r7 forced failure");
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  // posthog-service starts its client without awaiting it: wait until it is up.
  const { trackServerEvent } = await import("../services/posthog-service.js");
  for (let i = 0; i < 50 && captured.posthog.length === 0; i++) {
    trackServerEvent("px7_r7_ready", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(captured.posthog.length, "PostHog's client is up").toBeGreaterThan(0);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Sentry.close(2000);
  (await import("../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.MOCK_SETTLEMENT;
  delete process.env.POSTHOG_API_KEY;
});


describe("MEDIUM 3 (review r6 of #441): an encoded separator is a separator", () => {
  it("the verdict's reproduction, and the same in withoutQueryValues, a text token and a whole encoded form", async () => {
    const { redactCredentials, withoutQueryValues } = await import("../observability-redact.js");
    const MARKER = mark("encoded");
    expect(JSON.stringify(redactCredentials({ url: `/cb%3Fzq1%3D${MARKER}` }))).not.toContain(MARKER);
    for (const url of [
      `/cb%3Fzq1%3D${MARKER}`,
      `/cb%3fzq1%3d${MARKER}`,
      `/cb%23zq1%3D${MARKER}`,
      `/cb%3Fa%3D1%26x_custom%3D${MARKER}`,
      `/cb%3F${MARKER}`,
      `/cb?a=1%26code%3D${MARKER}`,
    ]) {
      expect(withoutQueryValues(url), url).not.toContain(MARKER);
      expect(JSON.stringify(redactCredentials({ message: `GET ${url} failed` })), url).not.toContain(MARKER);
    }
    expect(JSON.stringify(redactCredentials({ form: `zq1%3D${MARKER}%26b%3D2` }))).not.toContain(MARKER);
    // The path is kept.
    expect(withoutQueryValues(`/cb%3Fzq1%3D${MARKER}`)).toContain("/cb");
  });

  it("an encoded separator in a request's URL reaches neither the request log nor the audit row", async () => {
    const MARKER = mark("encoded-sink");
    const before = captured.logs.length;
    await request("GET", `/px7-r7-none%3Fzq1%3D${MARKER}`, {});
    await request("POST", `/api/px7-r7-none%3Fzq1%3D${MARKER}`, { "content-type": "application/json" }, "{}");
    const logged = captured.logs.slice(before).join("");
    expect(logged).toContain("px7-r7-none");
    expect(logged).not.toContain(MARKER);
    const { auditService } = await import("../services/audit-service.js");
    const rows = JSON.stringify(auditService.query({ eventType: "http.write", limit: 500 }));
    expect(rows).toContain("/api/px7-r7-none");
    expect(rows).not.toContain(MARKER);
  });
});

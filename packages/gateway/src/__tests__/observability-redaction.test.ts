/**
 * Cross-family review r4 of #441 (rm-px7-441-r4-3c6783bc). Request credentials must not leave the
 * process through any observability sink, on the PRODUCTION path:
 *   CRITICAL 1  a query credential reached Sentry's extra.url (the gateway's own error handler) and
 *               the Fastify request log;
 *   MEDIUM 2    signature headers (payment-signature, x-hmac-signature, lob-signature) are not
 *               credential-named, so a name-based scrub let them through;
 *   MEDIUM 3    the verifier key is pinned through the real API gate: alone it is refused 401, and
 *               with an ordinary API credential it reads the envelope.
 * This boots the real gateway (createGateway) with the gateway's own Sentry options and its own
 * logger options. Only the destinations change: Sentry's transport becomes a capture, and the
 * logger's stream a buffer. Every byte that would leave the process is searched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";

const captured = vi.hoisted(() => ({ logs: [] as string[] }));

vi.mock("fastify", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown> & { default: (opts?: Record<string, unknown>) => unknown };
  const { Writable } = await import("node:stream");
  const sink = new Writable({
    write(chunk, _encoding, done) {
      captured.logs.push(String(chunk));
      done();
    },
  });
  // The gateway's logger options with only the destination changed. `logger: true` is pino at level
  // info with Fastify's default serializers, the same as an options object without a stream.
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
vi.mock("../services/posthog-service.js", () => ({
  initPostHog: vi.fn(),
  trackServerEvent: vi.fn(),
  identifyAgent: vi.fn(),
  shutdownPostHog: vi.fn().mockResolvedValue(undefined),
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

// Every credential is built at runtime, so no literal here looks like a secret.
const mark = (name: string) => ["px7", "r5", name, "4f2a9c7e1b"].join("-");
const VERIFIER = ["px7", "r5", "verifier", "0123456789abcdef0123456789"].join("-");
const HEX = "5a".repeat(32);
const PRIVATE_NOTE = "px7-r5-private-note";
const DSN = "https://public@o0.ingest.sentry.io/0";

const sentryBodies: string[] = [];
let port = 0;
let app: { close(): Promise<unknown>; listen(o: { port: number; host: string }): Promise<string>; server: http.Server };
let repos: any;
let bearer = "";

/** Every JSON value in a Sentry envelope or a log stream, one per line. */
const jsonLines = (text: string): unknown[] =>
  text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

/** The paths, in a list of JSON values, of every string that contains `needle`. */
function pathsOf(values: unknown[], needle: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (value.includes(needle)) out.push(path);
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k.includes(needle)) out.push(`${path}.<key ${k}>`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  values.forEach((v, i) => walk(v, `#${i}`));
  return out;
}

/** Where each named secret appears: [] when none does. */
const leaks = (text: string, secrets: Record<string, string>) =>
  Object.entries(secrets).flatMap(([name, secret]) => [
    ...pathsOf(jsonLines(text), secret).map((p) => `${name} at ${p}`),
    // A secret in a line that is not JSON is a leak too.
    ...text.split("\n").filter((l) => l.includes(secret) && jsonLines(l).length === 0).map(() => `${name} in a non-JSON line`),
  ]);

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
  process.env.PCC_ADMIN_KEY = ["px7", "r5", "admin"].join("-");
  process.env.MOCK_SETTLEMENT = "true";
  process.env.PCC_VERIFIER_READ_KEY = VERIFIER;
  // The gateway's own Sentry options; only the transport is a capture, so nothing is sent. The
  // Dedupe integration is off: it drops an event equal to the one just before it, so it would hide
  // the gateway's own capture of an error (with its extra.url) behind the SDK's Fastify capture of
  // the same error. In production the two are separate events whenever another error comes between.
  const { sentryOptions } = await import("../sentry.js");
  const options = sentryOptions(DSN);
  Sentry.init({
    ...options,
    // The gateway's own integrations (no request body collected), with Dedupe off.
    integrations: (defaults) =>
      (typeof options.integrations === "function" ? options.integrations(defaults) : defaults).filter(
        (integration) => integration.name !== "Dedupe",
      ),
    transport: (transportOptions) =>
      Sentry.createTransport(transportOptions, async (req) => {
        sentryBodies.push(typeof req.body === "string" ? req.body : Buffer.from(req.body).toString("utf8"));
        return { statusCode: 200 };
      }),
  });
  const { createGateway } = await import("../server.js");
  const gateway = await createGateway(0);
  app = gateway.app as unknown as typeof app;
  // A stand-in for any route that sets a 4xx status and then throws (outside /api/, so no API gate).
  (gateway.app as unknown as { get(path: string, handler: (req: unknown, reply: { code(status: number): unknown }) => Promise<unknown>): void }).get(
    "/px7-r5/throws-after-4xx",
    async (_req, reply) => {
      reply.code(404);
      throw new Error("px7-r5 thrown after a 4xx status");
    },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;

  const { getStore } = await import("../db.js");
  repos = getStore().repos as any;
  const now = new Date().toISOString();
  repos.evidence.insert({
    id: "bun-px7-r5", jobId: "job-001", stepId: "step-1", kernelId: "kernel-nyc", assuranceTier: 1, tenantId: null,
    bundleHash: `sha256:${HEX}`, kernelSignature: { signer: "0x1111111111111111111111111111111111111111", algorithm: "secp256k1", value: "sig" },
    createdAt: now,
  });
  repos.evidence.insertEvents([
    { id: "bun-px7-r5-ev", bundleId: "bun-px7-r5", type: "execution_completed", timestamp: now,
      source: { deviceId: "dev-fdm-prusa-mk4", deviceType: "controller", kernelId: "kernel-nyc" }, payload: { note: PRIVATE_NOTE }, hash: "e".repeat(64) },
  ]);
  // An ordinary API credential, from the public provisioning route.
  const provisioned = await request("POST", "/api/auth/provision", { "content-type": "application/json" },
    JSON.stringify({ email: "px7-r5@example.test", name: "px7 r5" }));
  expect(provisioned.status, provisioned.body).toBe(201);
  bearer = JSON.parse(provisioned.body).api_key;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Sentry.close(2000);
  (await import("../db.js")).closeStore();
  delete process.env.PCC_VERIFIER_READ_KEY;
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.MOCK_SETTLEMENT;
});

describe("CRITICAL 1 and MEDIUM 2 (review r4 of #441): a failing request's credentials reach no sink", () => {
  it("query credentials, signature headers and the API credentials are in neither Sentry's envelope nor the request log", async () => {
    const secrets = {
      "query token": mark("token"),
      "query access_token": mark("access"),
      "query api_key": mark("apikey"),
      "payment-signature": mark("payment"),
      "x-hmac-signature": mark("hmac"),
      "lob-signature": mark("lob"),
      "Authorization bearer": bearer,
      "X-Verifier-Key": VERIFIER,
    };
    const failing = vi.spyOn(repos.evidence, "findEventsByBundle").mockImplementation(() => {
      throw new Error("px7-r5 forced evidence read failure");
    });
    const before = { sentry: sentryBodies.length, logs: captured.logs.length };
    let res: { status: number; body: string };
    try {
      res = await request(
        "GET",
        `/api/evidence/sha256:${HEX}?token=${secrets["query token"]}&access_token=${secrets["query access_token"]}&api_key=${secrets["query api_key"]}`,
        {
          authorization: `Bearer ${bearer}`,
          "x-verifier-key": VERIFIER,
          "payment-signature": secrets["payment-signature"],
          "x-hmac-signature": secrets["x-hmac-signature"],
          "lob-signature": secrets["lob-signature"],
        },
      );
    } finally {
      failing.mockRestore();
    }
    expect(res.status).toBe(500);
    await Sentry.flush(5000);
    const sent = sentryBodies.slice(before.sentry).join("\n");
    const logged = captured.logs.slice(before.logs).join("");
    // The failure did reach both sinks, so their silence about the secrets means something.
    expect(sent).toContain("px7-r5 forced evidence read failure");
    expect(logged).toContain("/api/evidence/sha256:");
    expect({ sentry: leaks(sent, secrets), log: leaks(logged, secrets) }).toEqual({ sentry: [], log: [] });
  });

  it("the gateway's own capture of an error the SDK's Fastify hook skipped (a 4xx status set before the throw) sends no query credential", async () => {
    // Fastify runs onError hooks before the error handler, and the SDK's hook skips an error whose
    // reply already has a 3xx or 4xx status. The gateway's handler then captures it itself, with extra.url.
    const secret = mark("extra");
    const before = { sentry: sentryBodies.length, logs: captured.logs.length };
    const res = await request("GET", `/px7-r5/throws-after-4xx?token=${secret}`, {});
    expect(res.status).toBe(500);
    await Sentry.flush(5000);
    const sent = sentryBodies.slice(before.sentry).join("\n");
    const logged = captured.logs.slice(before.logs).join("");
    expect(sent).toContain("px7-r5 thrown after a 4xx status");
    expect(jsonLines(sent).some((v) => (v as { extra?: { method?: unknown } })?.extra?.method === "GET")).toBe(true);
    expect({ sentry: leaks(sent, { "extra token": secret }), log: leaks(logged, { "extra token": secret }) }).toEqual({ sentry: [], log: [] });
  });

  it("a write request's query credential is not stored in the audit log", async () => {
    const secret = mark("audit");
    await request("POST", `/api/px7-r5-no-such-route?token=${secret}`, { "content-type": "application/json" }, "{}");
    const { auditService } = await import("../services/audit-service.js");
    const rows = auditService.query({ eventType: "http.write", limit: 200 });
    const urls = rows.map((r) => String((r.metadata as { url?: unknown } | undefined)?.url ?? ""));
    expect(urls.some((u) => u.startsWith("/api/px7-r5-no-such-route"))).toBe(true);
    expect(leaks(JSON.stringify(rows), { "audit token": secret })).toEqual([]);
  });
});

describe("MEDIUM 3 (review r4 of #441): the verifier key goes through the real API gate", () => {
  const url = `/api/evidence/sha256:${HEX}`;

  it("the verifier key alone is refused 401", async () => {
    const res = await request("GET", url, { "x-verifier-key": VERIFIER });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(PRIVATE_NOTE);
  });

  it("an ordinary API credential with the verifier key reads the envelope", async () => {
    const res = await request("GET", url, { authorization: `Bearer ${bearer}`, "x-verifier-key": VERIFIER });
    expect(res.status).toBe(200);
    expect(res.body).toContain(PRIVATE_NOTE);
  });

  it("the API credential alone, with no proven wallet and no verifier key, does not read it", async () => {
    const res = await request("GET", url, { authorization: `Bearer ${bearer}` });
    expect(res.status).not.toBe(200);
    expect(res.body).not.toContain(PRIVATE_NOTE);
  });
});

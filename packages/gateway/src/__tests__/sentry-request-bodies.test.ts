import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Event } from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sentry = vi.hoisted(() => {
  process.env.SENTRY_DSN = "https://abc123@example.com/1";
  process.env.SENTRY_RELEASE = "beta-signup";
  return {
    envelopes: [] as unknown[],
    httpOptions: [] as unknown[],
    options: undefined as Parameters<typeof import("@sentry/node").init>[0],
  };
});

vi.mock("@sentry/node", async original => {
  const real = await original<typeof import("@sentry/node")>();
  return {
    ...real,
    httpIntegration: (options: Parameters<typeof real.httpIntegration>[0]) => {
      sentry.httpOptions.push(options);
      return real.httpIntegration(options);
    },
    init: (options: Parameters<typeof real.init>[0]) => {
      sentry.options = options;
      return real.init({
        ...options,
        transport: () => ({
          send: async envelope => {
            sentry.envelopes.push(envelope);
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      });
    },
  };
});

let app: FastifyInstance;
let Sentry: typeof import("@sentry/node");
let tmpDir: string;
const KEY = "pcc_test_beta-signup";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "beta-signup"));
  vi.stubEnv("PCC_DB_PATH", join(tmpDir, "pcc.sqlite"));
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  vi.stubEnv("POSTHOG_API_KEY", "");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("beta body control"));
  const sentryModule = await import("../sentry.js");
  sentryModule.initSentry();
  Sentry = sentryModule.Sentry;
  const { auditService } = await import("../services/audit-service.js");
  vi.spyOn(auditService, "log").mockReturnValue(true);
  const { createGateway } = await import("../server.js");
  ({ app } = await createGateway(0));
  const { getRepos } = await import("../db.js");
  const { hashApiKey } = await import("../auth/api-key-auth.js");
  getRepos().apiKeys.insert({
    id: "beta-signup", keyHash: hashApiKey(KEY), keyPrefix: KEY.slice(0, 12), operatorId: "beta-signup",
    scopes: '["*"]', rateLimit: "1000/hour", usageCount: "0", createdAt: new Date().toISOString(),
  } as never);
  app.post("/api/ordinary/body-error", async () => { throw new Error("beta body control"); });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Sentry?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("Sentry and incoming request bodies", () => {
  it("Sentry's http integration buffers no incoming request body", () => {
    expect(sentry.httpOptions).toEqual([{ maxIncomingRequestBodySize: "none" }]);
    expect(sentry.options?.integrations).toEqual([expect.objectContaining({ name: "Http" })]);
  });

  it("no request body reaches a Sentry envelope, and a server error keeps its method, route and stack", async () => {
    for (const name of ["RequestData", "Http"]) expect(Sentry.getClient()!.getIntegrationByName(name)).toBeDefined();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const send = (path: string, body: unknown): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = httpRequest({ host: "127.0.0.1", port, method: "POST", path, headers: {
        authorization: `Bearer ${KEY}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)),
      } }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      });
      request.on("error", reject);
      request.end(payload);
    });
    expect(await Sentry.flush(3000)).toBe(true);
    sentry.envelopes.length = 0;
    expect((await send("/api/ordinary/body-error", { note: "beta-body-marker" })).status).toBe(500);
    const signup = await send("/api/beta-apply", { name: "Ann", email: "beta-marker@example.com", role: "admin" });
    expect(await Sentry.flush(3000)).toBe(true);
    const items = (sentry.envelopes as Array<[unknown, Array<[{ type: string }, Event]>]>).flatMap(([, items]) => items);
    const error = items.find(([header, event]) => header.type === "event"
      && event.exception?.values?.some(value => value.value === "beta body control"))?.[1];
    expect(error).toBeDefined();
    expect(error!.request).toMatchObject({ method: "POST", url: expect.stringContaining("/api/ordinary/body-error") });
    expect(error!.transaction).toBe("POST /api/ordinary/body-error");
    expect(error!.exception!.values!.some(value => (value.stacktrace?.frames?.length ?? 0) > 0)).toBe(true);
    const output = JSON.stringify(sentry.envelopes);
    expect(output).not.toContain("beta-body-marker");
    expect(output).not.toContain("beta-marker@example.com");
    expect(signup.status).toBe(400);
    expect(signup.text).toBe('{"error":"bad_request"}');
  });
});

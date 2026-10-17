import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Event } from "@sentry/node";
import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const sinks = vi.hoisted(() => {
  process.env.SENTRY_DSN = "https://abc123@example.invalid/1";
  // A release enables request-session aggregates in CI and production. Exercise
  // that envelope shape locally too, without excluding it from the leak scan.
  process.env.SENTRY_RELEASE = "wallet-faucet-sink-test";
  return {
    envelopes: [] as unknown[],
    options: undefined as Parameters<typeof import("@sentry/node").init>[0],
  };
});

// Keep the real SDK, default integrations and all privacy processors; replace
// only its transport so no envelope leaves the process.
vi.mock("@sentry/node", async original => {
  const real = await original<typeof import("@sentry/node")>();
  return {
    ...real,
    init: (options: Parameters<typeof real.init>[0]) => {
      sinks.options = options;
      return real.init({
        ...options,
        transport: () => ({
          send: async envelope => {
            sinks.envelopes.push(envelope);
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      });
    },
  };
});
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = vi.fn();
    identify = vi.fn();
    shutdown = async () => undefined;
  },
}));
vi.mock("../services/telemetry-privacy.js", async original => {
  const real = await original<typeof import("../services/telemetry-privacy.js")>();
  return {
    ...real,
    GATEWAY_LOGGER_OPTIONS: {
      ...real.GATEWAY_LOGGER_OPTIONS,
      stream: { write: () => undefined },
    },
  };
});

const PATH = "/api/wallets/link-requests";
const MARKER = "tr_aa11bb22cc33dd44ee55ff6677889900";
const KEY = `pcc_test_faucet_sink_${MARKER}`;
const FUND_ROUTES = ["/api/wallets/link-requests/:id/fund", "/api/wallets/:linkId/fund"] as const;
const seenFundRoutes: string[] = [];
let app: FastifyInstance;
let Sentry: typeof import("@sentry/node");

beforeAll(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  vi.stubEnv("PCC_NETWORK", "base-sepolia");
  // Exercise unavailable-faucet responses without opening a credentials file
  // or constructing a client backed by any ambient CDP credentials.
  for (const name of ["CDP_NETWORK", "PCC_X402_CHAIN", "CDP_API_KEY_ID", "CDP_API_KEY_NAME",
    "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "PCC_FAUCET_CDP_API_KEY_ID",
    "PCC_FAUCET_CDP_API_KEY_SECRET", "PCC_FAUCET_CDP_ENV_FILE"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network_disabled_in_wallet_faucet_sink_test"));
  const { auditService } = await import("../services/audit-service.js");
  vi.spyOn(auditService, "log").mockImplementation(() => true);
  const { createGateway } = await import("../server.js");
  ({ app } = await createGateway(0));
  ({ Sentry } = await import("../sentry.js"));
  const { getRepos } = await import("../db.js");
  const { hashApiKey } = await import("../auth/api-key-auth.js");
  getRepos().apiKeys.insert({
    id: "wallet-faucet-sink-owner", keyHash: hashApiKey(KEY), keyPrefix: KEY.slice(0, 12),
    operatorId: "wallet-faucet-sink-owner", scopes: '["*"]', rateLimit: "1000/hour",
    usageCount: "0", createdAt: new Date().toISOString(),
  } as never);
  app.addHook("onResponse", async req => {
    const route = req.routeOptions.url;
    if (req.method === "POST" && FUND_ROUTES.some(template => template === route)) seenFundRoutes.push(route!);
    // Also expose raw request data to the real breadcrumb and child-span
    // processors, as in the existing wallet sink harness.
    Sentry.addBreadcrumb({ category: "http", message: req.url, data: {
      url: req.url, headers: req.headers, body: req.body,
    } });
    const span = Sentry.startInactiveSpan({ name: req.url, op: "http.client", attributes: {
      "url.full": req.url, "http.url": req.url, "http.route": route ?? req.url,
      "request.headers": JSON.stringify(req.headers), "request.body": JSON.stringify(req.body) ?? "",
    } });
    span.end();
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("W2 faucet routes keep request values out of Sentry", () => {
  it.each(FUND_ROUTES)("preserves the registered %s span template", route => {
    expect(app.hasRoute({ method: "POST", url: route })).toBe(true);
    const raw = route.replace(/:id|:linkId/, MARKER);
    const scrubbed = sinks.options!.beforeSendSpan!({
      description: `POST ${raw}?marker=${MARKER}`,
      data: {
        "http.route": route, "url.full": `http://127.0.0.1${raw}?marker=${MARKER}`,
        "http.target": raw, "http.request.header.user_agent": MARKER,
      },
    } as never);
    expect(scrubbed).toEqual({ description: route, data: {} });
    expect(JSON.stringify(scrubbed)).not.toContain(MARKER);
  });

  it("drops both fund routes over real sockets and scans every captured envelope for request values", async () => {
    const client = Sentry.getClient()!;
    for (const integration of ["RequestData", "Http", "Console"]) {
      expect(client.getIntegrationByName(integration), integration).toBeDefined();
    }
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const send = (method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const request = httpRequest({ host: "127.0.0.1", port, method, path, headers: {
          ...headers,
          ...(payload === undefined ? {} : {
            "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)),
          }),
        } }, response => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { text += chunk; });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
        });
        request.on("error", reject);
        if (payload !== undefined) request.write(payload);
        request.end();
      });
    const control = "ctrl_99887766554433221100ffeeddccbbaa";
    const marked = {
      authorization: `Bearer ${KEY}`, "user-agent": MARKER, "x-request-id": MARKER,
      referer: `https://example.invalid/${MARKER}`, "x-review-marker": MARKER,
      origin: "https://capability.network",
    };
    expect(await Sentry.flush(3000)).toBe(true);
    sinks.envelopes.length = 0;
    seenFundRoutes.length = 0;
    const account = privateKeyToAccount(generatePrivateKey());
    const created = await send("POST", `${PATH}?marker=${MARKER}`, marked, {
      keyType: "secp256k1", address: account.address, role: "device", label: MARKER, chainId: 84532,
    });
    expect(created.status, created.text).toBe(201);
    const request = JSON.parse(created.text) as { requestId: string; userCode: string; message: string };
    const signature = await account.signMessage({ message: request.message });
    const proof = await send("POST", `${PATH}/${request.requestId}/proof?marker=${MARKER}`, marked, { signature });
    expect(proof.status, proof.text).toBe(200);
    const { CONSENT_SHA256 } = await import("../services/wallet-links/consent.js");
    const approved = await send("POST", `${PATH}/${request.requestId}/approve?marker=${MARKER}`, marked, {
      userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256,
    });
    expect(approved.status, approved.text).toBe(200);
    const { linkId } = JSON.parse(approved.text) as { linkId: string };
    for (const url of [`${PATH}/${request.requestId}/fund`, `/api/wallets/${linkId}/fund`]) {
      const response = await send("POST", `${url}?marker=${MARKER}`, marked, {});
      expect(response.status, response.text).toBe(503);
      expect(JSON.parse(response.text)).toEqual({ error: "faucet_unavailable" });
    }
    const unknown = await send("POST", `/api/wallets/${MARKER}/fund?marker=${MARKER}`, marked, {});
    expect(unknown.status, unknown.text).toBe(404);
    expect(JSON.parse(unknown.text)).toEqual({ error: "link_not_found" });
    expect(new Set(seenFundRoutes)).toEqual(new Set(FUND_ROUTES));
    expect(await Sentry.flush(3000)).toBe(true);
    const walletItems = (sinks.envelopes as Array<[unknown, Array<[{ type: string }, unknown]>]>)
      .flatMap(([, items]) => items);
    // A release can add sessions, and discarded-event counts can add a
    // client_report. Scan those too below; only their types are exempt here.
    expect(walletItems.filter(([header]) => header.type !== "client_report" && header.type !== "sessions")).toEqual([]);

    const health = await send("GET", `/api/health?marker=${control}`, { "user-agent": control });
    expect(health.status, health.text).toBe(200);
    expect(await Sentry.flush(3000)).toBe(true);
    const captured = JSON.stringify(sinks.envelopes);
    const controlItems = (sinks.envelopes as Array<[unknown, Array<[{ type: string }, Event]>]>)
      .flatMap(([, items]) => items);
    expect(controlItems.some(([header, event]) => header.type === "transaction"
      && event.transaction === "GET /api/health"
      && event.contexts?.trace?.op === "http.server"
      && Object.entries(event.request?.headers ?? {})
        .find(([name]) => name.toLowerCase() === "user-agent")?.[1] === control),
    "a real HTTP control must capture request data so the wallet assertion is not vacuous").toBe(true);
    expect(captured).toContain(control);
    const secrets = [MARKER, KEY, request.requestId, request.userCode, request.userCode.replace("-", ""),
      linkId, account.address, account.address.toLowerCase(), signature];
    expect(secrets.filter(value => captured.includes(value))).toEqual([]);
  }, 120_000);
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Event } from "@sentry/node";
import type { FastifyInstance, InjectOptions } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const sinks = vi.hoisted(() => {
  process.env.SENTRY_DSN = "https://abc123@example.invalid/1";
  process.env.POSTHOG_API_KEY = "wallet-privacy-test";
  return {
    sentry: [] as unknown[],
    pino: [] as string[],
    capture: vi.fn(),
    options: undefined as Parameters<typeof import("@sentry/node").init>[0],
  };
});

// Run the real SDK's event/breadcrumb/span processors, replacing only the
// transport. An ordinary parent transaction ensures wallet child spans and
// breadcrumbs are observable even though wallet events themselves are dropped.
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
            sinks.sentry.push(envelope);
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
    capture = sinks.capture;
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
      stream: { write: (line: string) => void sinks.pino.push(line) },
    },
  };
});

const MARKER = "tr_1234567890abcdef1234567890abcdef";
const PATH = "/api/wallets/link-requests";
const KEY = `pcc_test_${MARKER}`;
let app: FastifyInstance;
let Sentry: typeof import("@sentry/node");
let audit: ReturnType<typeof vi.spyOn>;
const consoleCalls: unknown[][] = [];
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeAll(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  vi.stubEnv("PCC_FUNNEL_ENABLED", "true");
  // Console includes more than log/warn/error: assert, dir, table, trace,
  // counters and timers can all accidentally become request-value sinks.
  for (const method of Object.keys(console)) {
    if (method.startsWith("_") || method === "Console" || typeof (console as unknown as Record<string, unknown>)[method] !== "function") continue;
    consoleSpies.push(vi.spyOn(console, method as keyof Console).mockImplementation((...values: unknown[]) => {
      consoleCalls.push(values);
    }));
  }
  // Gateway boot and injection must not contact external services.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network_disabled_in_wallet_sink_test"));
  const auditModule = await import("../services/audit-service.js");
  audit = vi.spyOn(auditModule.auditService, "log").mockImplementation(() => true);
  const { createGateway } = await import("../server.js");
  ({ app } = await createGateway(0));
  ({ Sentry } = await import("../sentry.js"));
  const { getRepos } = await import("../db.js");
  const { hashApiKey } = await import("../auth/api-key-auth.js");
  getRepos().apiKeys.insert({
    id: "wallet-sink-owner", keyHash: hashApiKey(KEY), keyPrefix: KEY.slice(0, 12), operatorId: "wallet-sink-owner",
    scopes: '["*"]', rateLimit: "1000/hour", usageCount: "0", createdAt: new Date().toISOString(),
  } as never);

  // Root failures reach server.ts's handler; the actual wallet route plugin
  // has its own handler and cannot exercise that separate boundary by itself.
  app.get("/api/wallets/sink-root-error/:id", async () => { throw new Error(MARKER); });
  app.get("/api/ordinary/query-error", async () => { throw new Error("ordinary query control"); });
  app.addHook("onResponse", async req => {
    Sentry.addBreadcrumb({ category: "http", message: req.url, data: {
      url: req.url, headers: req.headers, body: req.body,
    } });
    const span = Sentry.startInactiveSpan({ name: req.url, op: "http.client", attributes: {
      "url.full": req.url,
      "http.url": req.url,
      "http.route": req.routeOptions.url ?? req.url,
      "request.headers": JSON.stringify(req.headers),
      "request.body": JSON.stringify(req.body) ?? "",
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

describe("wallet request values never reach gateway sinks", () => {
  it.each(["description", "url.full", "http.url", "http.target", "url.path", "http.route"])(
    "detects a wallet target in %s alone and removes every raw target field", attribute => {
      const raw = `/api/wallets/${MARKER}?query=${MARKER}#${MARKER}`;
      const span = { description: "request", data: { [attribute]: raw } };
      if (attribute === "description") { span.description = raw; span.data = {}; }
      const scrubbed = sinks.options!.beforeSendSpan!(span as never);
      expect(scrubbed).toMatchObject({ description: "/api/wallets/<redacted>", data: {} });
      expect(JSON.stringify(scrubbed)).not.toContain(MARKER);

      const allTargets = { description: raw, data: Object.fromEntries(
        ["url.full", "http.url", "http.target", "url.path", "url.query", "http.route"].map(key => [key, raw])) };
      allTargets.data["http.route"] = "/api/wallets/link-requests/:id/proof";
      expect(sinks.options!.beforeSendSpan!(allTargets as never))
        .toMatchObject({ description: "/api/wallets/link-requests/:id/proof", data: {} });
    });

  it("preserves a non-wallet span when only url.query contains a wallet path", () => {
    const span = { description: "request", data: { "url.query": `/api/wallets/${MARKER}` } };
    const original = structuredClone(span);
    expect(sinks.options!.beforeSendSpan!(span as never)).toBe(span);
    expect(span).toEqual(original);
  });

  it.each(["description", "url.full", "http.url", "http.target", "url.path", "http.route"])(
    "preserves an ordinary path with a wallet query in %s", attribute => {
      const target = "/api/ordinary?/api/wallets";
      const span = { description: "request", data: { [attribute]: target, "url.query": "/api/wallets" } };
      if (attribute === "description") { span.description = `GET ${target}`; }
      if (attribute === "url.full" || attribute === "http.url") {
        span.data[attribute] = `https://capability.network${target}`;
      }
      const original = structuredClone(span);
      expect(sinks.options!.beforeSendSpan!(span as never)).toBe(span);
      expect(span).toEqual(original);
    });

  it("drops wallet event/transaction URLs with queries and wallet breadcrumbs, preserving other routes", () => {
    const raw = `/api/wallets/${MARKER}?query=${MARKER}#${MARKER}`;
    for (const event of [
      { request: { url: raw, query_string: MARKER } },
      { request: { url: `https://capability.network${raw}`, query_string: MARKER } },
      { transaction: `GET ${raw}` },
    ]) {
      expect(sinks.options!.beforeSend!(event as never, {})).toBeNull();
      expect(sinks.options!.beforeSendTransaction!(event as never, {})).toBeNull();
    }
    expect(sinks.options!.beforeBreadcrumb!({ data: { url: raw } }, {})).toBeNull();
    const ordinary = { description: `/api/ordinary/${MARKER}`, data: { "url.path": `/api/ordinary/${MARKER}` } };
    expect(sinks.options!.beforeSendSpan!(ordinary as never)).toBe(ordinary);
    const event = { request: { url: `/api/ordinary/${MARKER}`, query_string: MARKER } };
    expect(sinks.options!.beforeSend!(event as never, {})).toBe(event);
    expect(sinks.options!.beforeSendTransaction!(event as never, {})).toBe(event);
  });

  it("preserves requestData-shaped events and transactions when only query_string contains a wallet path", () => {
    for (const event of [
      { request: { query_string: "/api/wallets" } },
      { request: { url: "https://capability.network/api/ordinary", query_string: "/api/wallets" },
        transaction: "GET /api/ordinary?/api/wallets", contexts: { response: { status_code: 500 } } },
    ]) {
      const original = structuredClone(event);
      expect(sinks.options!.beforeSend!(event as never, {})).toBe(event);
      expect(sinks.options!.beforeSendTransaction!(event as never, {})).toBe(event);
      expect(event).toEqual(original);
    }
  });

  it("keeps an ordinary route's 5xx event, transaction and span with default integrations and a wallet query", async () => {
    const client = Sentry.getClient()!;
    for (const integration of ["RequestData", "Http", "Console"]) {
      expect(client.getIntegrationByName(integration), integration).toBeDefined();
    }
    sinks.sentry.length = 0;
    const url = "/api/ordinary/query-error?/api/wallets";
    const response = await Sentry.withIsolationScope(scope => {
      // inject() uses no HTTP socket, so supply the normalized request that the
      // HTTP integration would attach. The real RequestData processor copies it
      // onto both the error event and the transaction before our filters run.
      scope.setSDKProcessingMetadata({ normalizedRequest: {
        method: "GET", url: "https://capability.network/api/ordinary/query-error", query_string: "/api/wallets",
      } });
      return Sentry.startSpan({ name: `GET ${url}`, op: "test", attributes: {
        "url.full": `https://capability.network${url}`,
        "url.query": "/api/wallets",
      } }, () => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${KEY}` } }));
    });
    expect(response.statusCode).toBe(500);
    await Sentry.flush(2000);
    const items = (sinks.sentry as Array<[unknown, Array<[{ type: string }, Event]>]>)
      .flatMap(([, items]) => items);
    const error = items.find(([header, event]) => header.type === "event"
      && event.exception?.values?.some(value => value.value === "ordinary query control"))?.[1];
    expect(error).toBeDefined();
    expect(error!.request).toMatchObject({ url: expect.stringContaining("/api/ordinary/query-error"), query_string: "/api/wallets" });
    const transaction = items.find(([header, event]) => header.type === "transaction" && event.transaction === `GET ${url}`)?.[1];
    expect(transaction).toBeDefined();
    expect(transaction!.request).toMatchObject({ url: "https://capability.network/api/ordinary/query-error", query_string: "/api/wallets" });
    expect(transaction!.contexts?.trace?.data).toMatchObject({
      "url.full": `https://capability.network${url}`, "url.query": "/api/wallets",
    });
    const span = transaction!.spans?.find(span => span.op === "http.client" && span.description === url);
    expect(span).toBeDefined();
    expect(span!.data).toMatchObject({ "url.full": url, "http.url": url, "http.route": "/api/ordinary/query-error" });
  });

  it("covers the real ceremony, poisoned headers/paths/bodies, and root and local errors", async () => {
    const owner = { authorization: `Bearer ${KEY}` };
    const markedHeaders = {
      ...owner,
      host: `${MARKER}.example.invalid`,
      "user-agent": MARKER,
      accept: `application/json; ${MARKER}`,
      "content-type": `application/json; wallet-marker=${MARKER}`,
      cookie: `wallet_sink=${MARKER}`,
      origin: `https://${MARKER}.example.invalid`,
      referer: `https://example.invalid/${MARKER}`,
      "x-pcc-trace-id": MARKER,
      "x-forwarded-for": MARKER,
      "x-forwarded-host": `${MARKER}.example.invalid`,
      "x-forwarded-proto": MARKER,
      "x-request-id": MARKER,
    };
    const results: Array<{ body: string; headers: Record<string, unknown> }> = [];
    const inject = async (options: InjectOptions) => {
      const response = await Sentry.startSpan({ name: "wallet privacy observer", op: "test" }, () => app.inject(options));
      results.push(response);
      expect(response.headers["x-pcc-trace-id"]).not.toBe(MARKER);
      return response;
    };
    sinks.sentry.length = 0;
    sinks.pino.length = 0;
    sinks.capture.mockClear();
    audit.mockClear();
    consoleCalls.length = 0;

    const account = privateKeyToAccount(generatePrivateKey());
    const created = await inject({ method: "POST", url: `${PATH}?marker=${MARKER}`, headers: markedHeaders,
      payload: { keyType: "secp256k1", address: account.address, role: "device", label: MARKER, chainId: 84532 } });
    expect(created.statusCode, created.body).toBe(201);
    const request = created.json();
    const proof = await inject({ method: "POST", url: `${PATH}/${request.requestId}/proof?marker=${MARKER}`, headers: markedHeaders,
      payload: { signature: await account.signMessage({ message: request.message }) } });
    expect(proof.statusCode).toBe(200);
    for (const method of ["GET", "HEAD"] as const) {
      expect((await inject({ method, url: `${PATH}/${request.requestId}?marker=${MARKER}`, headers: markedHeaders })).statusCode).toBe(200);
    }
    expect((await inject({ method: "POST", url: `${PATH}/lookup?marker=${MARKER}`, headers: markedHeaders,
      payload: { userCode: request.userCode } })).statusCode).toBe(200);
    const { CONSENT_SHA256 } = await import("../services/wallet-links/consent.js");
    const approved = await inject({ method: "POST", url: `${PATH}/${request.requestId}/approve?marker=${MARKER}`, headers: markedHeaders,
      payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
    expect(approved.statusCode).toBe(200);
    const linkId = approved.json().linkId;
    expect((await inject({ method: "GET", url: `/api/wallets?marker=${MARKER}`, headers: markedHeaders })).statusCode).toBe(200);
    expect((await inject({ method: "POST", url: `/api/wallets/${linkId}/revoke?marker=${MARKER}`, headers: markedHeaders, payload: {} })).statusCode).toBe(200);

    // Body and path markers also cross each failure path, including GET/HEAD
    // bodies. All supplied headers contain the marker (content-length is the
    // transport-generated numeric exception).
    const cases: InjectOptions[] = [
      { method: "POST", url: PATH, payload: { marker: MARKER } },
      { method: "POST", url: `${PATH}/${MARKER}/proof`, payload: { signature: MARKER } },
      { method: "GET", url: `${PATH}/${MARKER}`, payload: { marker: MARKER } },
      { method: "HEAD", url: `${PATH}/${MARKER}`, payload: { marker: MARKER } },
      { method: "POST", url: `${PATH}/lookup`, payload: { userCode: MARKER } },
      { method: "POST", url: `${PATH}/${MARKER}/approve`, payload: { userCode: MARKER, decision: "approve", consentSha256: CONSENT_SHA256, marker: MARKER } },
      { method: "GET", url: "/api/wallets", payload: { marker: MARKER } },
      { method: "POST", url: `/api/wallets/${MARKER}/revoke`, payload: { reason: MARKER, marker: MARKER } },
      { method: "GET", url: `/api/wallets/unrouted/${MARKER}` },
    ];
    for (const options of cases) await inject({ ...options, url: `${options.url}?marker=${MARKER}`, headers: markedHeaders });
    // A content-type with the marker as the MIME subtype reaches the parser's
    // unsupported-media-type failure rather than merely parameter handling.
    expect((await inject({ method: "POST", url: `${PATH}?marker=${MARKER}`, headers: {
      ...markedHeaders, "content-type": `application/${MARKER}`,
    }, payload: MARKER })).statusCode).toBe(400);

    const rootError = await inject({ method: "GET", url: `/api/wallets/sink-root-error/${MARKER}?marker=${MARKER}`, headers: markedHeaders });
    expect(rootError.statusCode).toBe(500);
    expect(rootError.json()).toEqual({ error: "internal_error" });
    const repository = await import("../services/wallet-links/repository.js");
    const claim = vi.spyOn(repository, "claimLinkProof").mockImplementation(() => { throw new Error(MARKER); });
    const localError = await inject({ method: "POST", url: `${PATH}/${MARKER}/proof?marker=${MARKER}`, headers: markedHeaders, payload: { signature: MARKER } });
    claim.mockRestore();
    expect(localError.statusCode).toBe(500);
    expect(localError.json()).toEqual({ error: "internal_error" });

    // Control outputs prove the collector is live; wallet-only event dropping
    // must not hide a missing breadcrumb or child-span filter.
    Sentry.captureMessage("wallet sink control");
    const { trackServerEvent } = await import("../services/posthog-service.js");
    trackServerEvent("wallet_sink_control", { count: 1 });
    await Sentry.flush(2000);
    expect(sinks.sentry.length, JSON.stringify(consoleCalls)).toBeGreaterThan(0);
    expect(JSON.stringify(sinks.sentry)).toContain("wallet privacy observer");
    expect(JSON.stringify(sinks.sentry)).toContain('"spans"');
    expect(sinks.capture).toHaveBeenCalled();
    expect(audit).toHaveBeenCalled();
    expect(sinks.pino.length).toBeGreaterThan(0);
    const outputs = {
      sentry: sinks.sentry,
      posthog: sinks.capture.mock.calls,
      audit: audit.mock.calls,
      pino: sinks.pino,
      console: consoleCalls,
    };
    for (const [sink, output] of Object.entries(outputs)) {
      const leaks: string[] = [];
      const scan = (value: unknown, path: string) => {
        if (typeof value === "string" && value.includes(MARKER)) leaks.push(`${path}: ${value.slice(0, 150)}`);
        else if (value && typeof value === "object") for (const [key, nested] of Object.entries(value)) scan(nested, `${path}.${key}`);
      };
      scan(output, sink);
      expect(leaks, sink).toEqual([]);
    }
  }, 120_000);
});

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Event } from "@sentry/node";
import { isOutboundSecretUrl, registerOutboundSecretUrl } from "../services/outbound-secrets.js";

const sinks = vi.hoisted(() => {
  process.env.SENTRY_DSN = "https://abc123@example.invalid/1";
  return {
    envelopes: [] as unknown[],
    options: undefined as Parameters<typeof import("@sentry/node").init>[0],
  };
});

// Use the real SDK processors; only its outbound transport is replaced.
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

const TOKEN = randomBytes(16).toString("hex");
const SECRET_URL = `https://sigverify.invalid/v2/${TOKEN}`;
const ORDINARY_URL = "https://ordinary.invalid/status";
let Sentry: typeof import("@sentry/node");

beforeAll(async () => {
  registerOutboundSecretUrl(SECRET_URL);
  const sentry = await import("../sentry.js");
  Sentry = sentry.Sentry;
  sentry.initSentry();
});

afterAll(async () => { await Sentry?.close(2000); });

describe("registered outbound secrets", () => {
  it("matches the full URL, path and key, without matching ordinary values", () => {
    registerOutboundSecretUrl(SECRET_URL);
    registerOutboundSecretUrl(SECRET_URL);
    for (const value of [SECRET_URL, `/v2/${TOKEN}`, TOKEN, `request failed: ${SECRET_URL}`]) {
      expect(isOutboundSecretUrl(value)).toBe(true);
    }
    for (const value of [ORDINARY_URL, "/v2/ordinary", "short", "", null, undefined, 12, {}]) {
      expect(isOutboundSecretUrl(value)).toBe(false);
    }
  });

  it("matches a trailing-slash token and a 16-character query value", () => {
    const pathToken = randomBytes(16).toString("hex");
    const queryToken = randomBytes(8).toString("hex");
    registerOutboundSecretUrl(`https://path.invalid/${pathToken}/`);
    registerOutboundSecretUrl(`https://query.invalid/rpc?apiKey=${queryToken}`);
    expect(isOutboundSecretUrl(pathToken)).toBe(true);
    expect(isOutboundSecretUrl(queryToken)).toBe(true);
    expect(isOutboundSecretUrl("apiKey")).toBe(false);
  });

  it.each(["request.url", "message", "exception.value"])("drops an event whose %s contains a secret", field => {
    const event = field === "request.url" ? { request: { url: SECRET_URL } }
      : field === "message" ? { message: `request ${TOKEN} failed` }
      : { exception: { values: [{ value: "ordinary" }, { value: `request ${SECRET_URL} failed` }] } };
    expect(sinks.options!.beforeSend!(event as never, {})).toBeNull();
    expect(sinks.options!.beforeSendTransaction!(event as never, {})).toBeNull();
    const ordinary = { request: { url: ORDINARY_URL }, message: "ordinary" };
    expect(sinks.options!.beforeSend!(ordinary as never, {})).toBe(ordinary);
  });

  it.each(["url", "request_url", "message"])("drops a breadcrumb whose %s contains a secret", field => {
    const breadcrumb = field === "message" ? { message: SECRET_URL } : { data: { [field]: SECRET_URL } };
    expect(sinks.options!.beforeBreadcrumb!(breadcrumb, {})).toBeNull();
    const ordinary = { message: ORDINARY_URL, data: { [field]: ORDINARY_URL } };
    expect(sinks.options!.beforeBreadcrumb!(ordinary, {})).toBe(ordinary);
  });

  it.each(["description", "url.full", "http.url", "http.target", "url.path", "http.route"])(
    "redacts a span whose %s contains a secret", field => {
      const span = field === "description" ? { description: SECRET_URL, data: { headers: TOKEN } }
        : { description: "outbound", data: { [field]: SECRET_URL, headers: TOKEN } };
      expect(sinks.options!.beforeSendSpan!(span as never)).toMatchObject({ description: "outbound/<redacted>", data: {} });
      const ordinary = { description: ORDINARY_URL, data: { [field]: ORDINARY_URL } };
      expect(sinks.options!.beforeSendSpan!(ordinary as never)).toBe(ordinary);
    });

  it("runs real breadcrumb, http.client span and error processors with a stub transport", async () => {
    sinks.envelopes.length = 0;
    await Sentry.withIsolationScope(async () => {
      Sentry.addBreadcrumb({ category: "http", data: { url: SECRET_URL } });
      Sentry.addBreadcrumb({ category: "http", data: { url: ORDINARY_URL } });
      await Sentry.startSpan({ name: "outbound secret observer", op: "test" }, async () => {
        const secretSpan = Sentry.startInactiveSpan({ name: SECRET_URL, op: "http.client", attributes: {
          "url.full": SECRET_URL, "request.headers": TOKEN,
        } });
        secretSpan.end();
        const ordinarySpan = Sentry.startInactiveSpan({ name: ORDINARY_URL, op: "http.client", attributes: {
          "url.full": ORDINARY_URL,
        } });
        ordinarySpan.end();
        Sentry.captureException(new Error(`outbound failure ${SECRET_URL}`));
        Sentry.captureException(new Error(`ordinary failure ${ORDINARY_URL}`));
      });
    });
    await Sentry.flush(2000);
    const items = (sinks.envelopes as Array<[unknown, Array<[{ type: string }, Event]>]>)
      .flatMap(([, envelopeItems]) => envelopeItems);
    expect(JSON.stringify(items)).not.toContain(TOKEN);
    const error = items.find(([header, event]) => header.type === "event"
      && event.exception?.values?.some(value => value.value === `ordinary failure ${ORDINARY_URL}`))?.[1];
    expect(error).toBeDefined();
    expect(error!.breadcrumbs?.some(breadcrumb => breadcrumb.data?.url === ORDINARY_URL)).toBe(true);
    const transaction = items.find(([header, event]) => header.type === "transaction"
      && event.transaction === "outbound secret observer")?.[1];
    expect(transaction).toBeDefined();
    expect(transaction!.spans?.some(span => span.description === "outbound/<redacted>"
      && JSON.stringify(span.data) === "{}")).toBe(true);
    expect(transaction!.spans?.some(span => span.description === ORDINARY_URL
      && span.data?.["url.full"] === ORDINARY_URL)).toBe(true);
  });
});

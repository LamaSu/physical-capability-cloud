import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { requestLogSerializer } from "../services/telemetry-privacy.js";

vi.mock("@sentry/node", () => ({ init: vi.fn() }));

const ADDRESS = "0x1111222233334444555566667777888899990000";
const MALFORMED = "wallet-header-sensitive-marker";
let sentry: typeof import("../sentry.js");
let options: NonNullable<Parameters<typeof Sentry.init>[0]>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
  vi.mocked(Sentry.init).mockClear();
  sentry = await import("../sentry.js");
  sentry.initSentry();
  expect(Sentry.init).toHaveBeenCalledOnce();
  options = vi.mocked(Sentry.init).mock.calls[0]![0]!;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("X-PCC-Wallet sink privacy", () => {
  it("request logger allows only declared request fields on ordinary operator routes", () => {
    const output = requestLogSerializer({
      method: "POST", url: "/api/operator/evidence", hostname: "gateway.test", ip: "127.0.0.1",
      headers: { "x-pcc-wallet": ADDRESS, "X-PCC-Wallet": MALFORMED, "accept-version": "1" },
      socket: { remotePort: 12345 },
    });
    expect(output).toEqual({
      method: "POST", url: "/api/operator/evidence", version: "1", hostname: "gateway.test",
      remoteAddress: "127.0.0.1", remotePort: 12345,
    });
    expect(JSON.stringify(output)).not.toContain(ADDRESS);
    expect(JSON.stringify(output)).not.toContain(MALFORMED);
  });

  it.each(["x-pcc-wallet", "X-PCC-Wallet", "X-Pcc-Wallet"])(
    "Sentry ordinary error event removes only the wallet request header: %s", (name) => {
      const event = { request: { url: "/api/operator/evidence", method: "POST", headers: {
        [name]: ADDRESS, "unknown-private-header": MALFORMED, "content-type": "application/json",
      } }, extra: { method: "POST" } };
      const result = sentry.walletSafeSentryEvent(event);
      expect(result).not.toBeNull();
      expect(result?.request).toEqual({ url: "/api/operator/evidence", method: "POST", headers: {
        "unknown-private-header": MALFORMED, "content-type": "application/json",
      } });
      expect(JSON.stringify(result)).not.toContain(ADDRESS);
      expect(event.request.headers[name]).toBe(ADDRESS);
    },
  );

  it("Sentry transaction hook removes only the wallet request header on an ordinary operator route", async () => {
    const event = { type: "transaction" as const, transaction: "POST /api/operator/evidence",
      request: { url: "/api/operator/evidence", headers: { "x-pcc-wallet": ADDRESS, "content-type": "application/json" } } };
    const result = await options.beforeSendTransaction!(event, {});
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(ADDRESS);
    expect(JSON.stringify(result)).not.toContain("x-pcc-wallet");
    expect(result?.request?.headers).toEqual({ "content-type": "application/json" });
  });

  it("Sentry error hook removes only the wallet request header on an ordinary operator route", async () => {
    const event = { type: undefined, request: { url: "/api/operator/evidence", headers: {
      "x-pcc-wallet": ADDRESS, "content-type": "application/json",
    } } };
    const result = await options.beforeSend!(event, {});
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(ADDRESS);
    expect(result?.request?.headers).toEqual({ "content-type": "application/json" });
  });

  it.each(["headers", "request_headers", "Request_Headers"])(
    "Sentry breadcrumbs remove only the wallet header from nested containers: %s", (container) => {
      const breadcrumb = { category: "http", data: { url: "/api/operator/evidence", method: "POST",
        [container]: { "X-PCC-Wallet": ADDRESS, "unknown-private-header": MALFORMED },
        request: { headers: { "x-pcc-wallet": ADDRESS, "content-type": "application/json" } },
      } };
      const result = options.beforeBreadcrumb!(breadcrumb, {});
      expect(result).not.toBeNull();
      expect(result?.data?.url).toBe("/api/operator/evidence");
      expect(JSON.stringify(result)).not.toContain(ADDRESS);
      expect(result?.data?.[container]).toEqual({ "unknown-private-header": MALFORMED });
      expect(result?.data?.request).toEqual({ headers: { "content-type": "application/json" } });
    },
  );

  it("Sentry events scrub wallet headers in previously attached breadcrumbs while preserving other values", () => {
    const event = { request: { url: "/api/operator/evidence" }, breadcrumbs: [{ category: "http",
      data: { url: "/api/operator/evidence", request_headers: { "x-pcc-wallet": ADDRESS, "content-type": "application/json" } },
    }] };
    const result = sentry.walletSafeSentryEvent(event);
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(ADDRESS);
    expect(result?.breadcrumbs[0]?.data.request_headers).toEqual({ "content-type": "application/json" });
  });

  it("Sentry span hook removes only the wallet header attribute on ordinary operator routes", () => {
    const span = { op: "http.server", description: "POST /api/operator/evidence", span_id: "1234567890abcdef",
      trace_id: "1234567890abcdef1234567890abcdef", start_timestamp: 1, timestamp: 2,
      data: { "http.route": "/api/operator/evidence", "http.request.header.x-pcc-wallet": ADDRESS,
        "http.request.header.content-type": "application/json", "http.request.headers": "content-type: application/json",
        headers_count: 2, provenWallet: "existing-principal",
      },
    };
    const result = options.beforeSendSpan!(span);
    expect(result.data).toEqual({
      "http.route": "/api/operator/evidence", "http.request.header.content-type": "application/json",
      "http.request.headers": "content-type: application/json", headers_count: 2, provenWallet: "existing-principal",
    });
    expect(JSON.stringify(result)).not.toContain(ADDRESS);
  });

  it("preserves all other headers and keys on a non-wallet Sentry event", () => {
    const event = { request: { url: "/api/health", headers: {
      "content-type": "application/json", "x-request-id": "health-check", "x-pcc-wallet": ADDRESS,
    } }, extra: { requestheaders: "metadata", rawHeaders: ["content-type", "application/json"], provenWallet: "existing-principal" },
    spans: [{ data: { "http.request.header.content-type": "application/json", "http.response.header.cache-control": "no-cache" } }] };
    const result = sentry.walletSafeSentryEvent(event);
    expect(result).toEqual({
      ...event, request: { url: "/api/health", headers: { "content-type": "application/json", "x-request-id": "health-check" } },
    });
    expect(result?.extra).toBe(event.extra);
    expect(result?.spans).toBe(event.spans);
    expect(JSON.stringify(result)).not.toContain(ADDRESS);
  });

  it("preserves an unrelated Sentry event that has no request headers", () => {
    const event = { request: { url: "/api/health" }, extra: { count: 1 } };
    expect(sentry.walletSafeSentryEvent(event)).toBe(event);
  });
});

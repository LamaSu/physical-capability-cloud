/**
 * N50: session recording never carries the API key.
 *
 * PostHog records request and response headers and bodies when its project
 * settings say so, and requests carry the key while responses carry newly
 * issued keys and recovery phrases. initTelemetry() switches both off on the
 * client, which the project settings can't override. Sentry Replay masks all
 * text and records no network details by default; initTelemetry() must not
 * loosen either.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { posthogInit, sentryInit, replayIntegration, browserTracingIntegration } = vi.hoisted(() => ({
  posthogInit: vi.fn(),
  sentryInit: vi.fn(),
  replayIntegration: vi.fn((options?: Record<string, unknown>) => ({ name: "Replay", options })),
  browserTracingIntegration: vi.fn((options?: Record<string, unknown>) => ({ name: "BrowserTracing", options })),
}));

vi.mock("posthog-js", () => ({ default: { init: posthogInit, capture: vi.fn(), identify: vi.fn() } }));
vi.mock("@sentry/react", () => ({
  init: sentryInit,
  browserTracingIntegration,
  replayIntegration,
  setUser: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const WALLET_LINK_URLS = [
  "/api/wallets/link-requests/by-code/WDJBMJHT",
  "https://gateway.example/api/wallets/link-requests/by-code/WDJBMJHT",
  "/api/wallets/link-requests/req_private/approve",
  "https://gateway.example/api/wallets/link-requests/req_private/approve",
];

describe("wallet link codes and request IDs stay out of network telemetry", () => {
  it("excludes wallet link requests from PostHog network recordings", async () => {
    await initWith({ VITE_POSTHOG_KEY: "phc_test", VITE_SENTRY_DSN: "" });
    const config = posthogInit.mock.calls[0]![1] as { session_recording: Record<string, unknown> };
    const mask = config.session_recording.maskCapturedNetworkRequestFn as (request: { name: string }) => unknown;
    expect(mask).toBeTypeOf("function");
    for (const name of WALLET_LINK_URLS) expect(mask({ name })).toBeNull();
    const ordinary = { name: "/api/jobs", duration: 12 };
    expect(mask(ordinary)).toBe(ordinary);
  });

  it("excludes wallet link URLs from Sentry fetch spans and breadcrumbs", async () => {
    await initWith({ VITE_POSTHOG_KEY: "", VITE_SENTRY_DSN: "https://public@o0.ingest.sentry.io/0" });
    const tracing = browserTracingIntegration.mock.calls[0]?.[0] ?? {};
    const shouldTrace = tracing.shouldCreateSpanForRequest as (url: string) => boolean;
    const config = sentryInit.mock.calls[0]![0] as Record<string, unknown>;
    const beforeBreadcrumb = config.beforeBreadcrumb as (crumb: { category?: string; data?: { url: string } }) => unknown;
    expect(shouldTrace).toBeTypeOf("function");
    expect(beforeBreadcrumb).toBeTypeOf("function");
    for (const url of WALLET_LINK_URLS) {
      expect(shouldTrace(url)).toBe(false);
      expect(beforeBreadcrumb({ category: "fetch", data: { url } })).toBeNull();
    }
    expect(shouldTrace("/api/jobs")).toBe(true);
    const ordinary = { category: "fetch", data: { url: "/api/jobs" } };
    expect(beforeBreadcrumb(ordinary)).toBe(ordinary);
    const click = { category: "ui.click" };
    expect(beforeBreadcrumb(click)).toBe(click);
  });

  it("excludes wallet link URLs from Sentry replay network events", async () => {
    await initWith({ VITE_POSTHOG_KEY: "", VITE_SENTRY_DSN: "https://public@o0.ingest.sentry.io/0" });
    const options = replayIntegration.mock.calls[0]?.[0] ?? {};
    const beforeEvent = options.beforeAddRecordingEvent as (event: unknown) => unknown;
    expect(beforeEvent).toBeTypeOf("function");
    for (const url of WALLET_LINK_URLS) {
      expect(beforeEvent({ type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { op: "resource.fetch", description: url } } })).toBeNull();
      expect(beforeEvent({ type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "fetch", data: { url } } } })).toBeNull();
    }
    const ordinary = { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { description: "/api/jobs" } } };
    expect(beforeEvent(ordinary)).toBe(ordinary);
    const snapshot = { type: 2, timestamp: 1, data: { node: {} } };
    expect(beforeEvent(snapshot)).toBe(snapshot);
  });
});

async function initWith(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  const { initTelemetry } = await import("../telemetry.js");
  initTelemetry();
}

describe("telemetry never records the API key (N50)", () => {
  it("PostHog session recording records no request or response headers or bodies", async () => {
    await initWith({ VITE_POSTHOG_KEY: "phc_test" });
    expect(posthogInit).toHaveBeenCalledTimes(1);
    const recording = (posthogInit.mock.calls[0]![1] as { session_recording?: Record<string, unknown> }).session_recording;
    expect(recording?.recordHeaders).toBe(false);
    expect(recording?.recordBody).toBe(false);
    expect(recording).not.toHaveProperty("networkPayloadCapture");
    // Elements marked ph-no-capture (the Earn page's key and recovery words) stay blocked.
    expect(recording).not.toHaveProperty("blockClass");
    expect(recording).not.toHaveProperty("blockSelector");
  });

  it("Sentry Replay keeps its defaults: all text masked, no network details", async () => {
    await initWith({ VITE_SENTRY_DSN: "https://public@o0.ingest.sentry.io/0" });
    expect(sentryInit).toHaveBeenCalledTimes(1);
    expect(replayIntegration).toHaveBeenCalledTimes(1);
    const options = replayIntegration.mock.calls[0]?.[0] ?? {};
    expect(options.maskAllText).not.toBe(false);
    expect(options.maskAllInputs).not.toBe(false);
    expect(options).not.toHaveProperty("unmask");
    expect(options).not.toHaveProperty("networkDetailAllowUrls");
  });
});

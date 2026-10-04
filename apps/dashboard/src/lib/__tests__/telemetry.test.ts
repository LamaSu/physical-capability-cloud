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

const { posthogInit, sentryInit, replayIntegration } = vi.hoisted(() => ({
  posthogInit: vi.fn(),
  sentryInit: vi.fn(),
  replayIntegration: vi.fn((options?: Record<string, unknown>) => ({ name: "Replay", options })),
}));

vi.mock("posthog-js", () => ({ default: { init: posthogInit, capture: vi.fn(), identify: vi.fn() } }));
vi.mock("@sentry/react", () => ({
  init: sentryInit,
  browserTracingIntegration: vi.fn(() => ({ name: "BrowserTracing" })),
  replayIntegration,
  setUser: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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

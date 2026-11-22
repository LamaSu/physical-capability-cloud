// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  posthogInit: vi.fn(), capture: vi.fn(), sentryInit: vi.fn(), tracing: vi.fn(), replay: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: { init: mocks.posthogInit, capture: mocks.capture } }));
vi.mock("@sentry/react", () => ({ init: mocks.sentryInit, browserTracingIntegration: mocks.tracing, replayIntegration: mocks.replay }));

beforeEach(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "test-telemetry");
  vi.stubEnv("VITE_SENTRY_DSN", "https://public@example.invalid/1");
  vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TEST");
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); document.head.querySelectorAll("script").forEach((s) => s.remove()); });

describe("funding telemetry", () => {
  const paths = [
    ["/api/buyer-funding", true], ["/api/buyer-funding/scopes/s/prepare", true],
    ["/api/jobs/j/funding", true], ["/api/jobs/j/funding/", true],
    ["/api/jobs", false], ["/api/jobs/j", false], ["/api/jobs/j/fundingx", false],
    ["/api/jobs/j/funding/x", false], ["/api/buyer-fundingx", false], ["/api/jobs/j/x/funding", false],
  ] as const;
  it.each(paths.flatMap(([path, excluded]) => [[path, excluded], [`https://gateway.example${path}`, excluded]] as const))(
    "C13: all network capture filters for %s (excluded=%s)", async (url, excluded) => {
      const { initTelemetry } = await import("../telemetry.js");
      initTelemetry();
      const posthog = mocks.posthogInit.mock.calls[0][1] as { session_recording: { maskCapturedNetworkRequestFn: (r: { name: string }) => unknown } };
      const tracing = mocks.tracing.mock.calls[0][0] as { shouldCreateSpanForRequest: (url: string) => boolean };
      const sentry = mocks.sentryInit.mock.calls[0][0] as { beforeBreadcrumb: (v: unknown) => unknown };
      const replay = mocks.replay.mock.calls[0][0] as { beforeAddRecordingEvent: (v: unknown) => unknown };
      const request = { name: url };
      const crumb = { category: "fetch", data: { url } };
      expect(posthog.session_recording.maskCapturedNetworkRequestFn(request)).toBe(excluded ? null : request);
      expect(tracing.shouldCreateSpanForRequest(url)).toBe(!excluded);
      expect(sentry.beforeBreadcrumb(crumb)).toBe(excluded ? null : crumb);
      for (const [tag, payload] of [["performanceSpan", { description: url }], ["breadcrumb", crumb]]) {
        const event = { type: 5, data: { tag, payload } };
        expect(replay.beforeAddRecordingEvent(event)).toBe(excluded ? null : event);
      }
    },
  );
  it.each([["/fund/abc", "/fund/:jobId"], ["/fund/abc/", "/fund/:jobId"], ["/fund/a%2Fb", "/fund/:jobId"], ["/wallets", "/wallets"], ["/fund/abc/x", "/fund/abc/x"]])(
    "C14: page view %s becomes %s", async (path, expected) => {
      const { trackPageView } = await import("../telemetry.js");
      const gtag = vi.fn();
      window.gtag = gtag;
      trackPageView(path);
      expect(mocks.capture).toHaveBeenCalledTimes(1);
      expect(mocks.capture).toHaveBeenCalledWith("$pageview", { $current_url: window.location.origin + expected });
      expect(gtag).toHaveBeenCalledTimes(1);
      expect(gtag).toHaveBeenCalledWith("event", "page_view", { page_path: expected, page_title: document.title });
    },
  );
});

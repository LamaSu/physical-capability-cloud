import posthog from "posthog-js";
import * as Sentry from "@sentry/react";

// ---------------------------------------------------------------------------
// Config — all values read from VITE_ env vars at build/runtime.
// If an env var is missing/empty, that service is silently disabled.
// ---------------------------------------------------------------------------

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY || "";
const POSTHOG_HOST =
  import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
const GA_MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID || "";
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || "";
const IS_PROD = import.meta.env.PROD;

// ---------------------------------------------------------------------------
// initTelemetry — call once before ReactDOM.createRoot()
// ---------------------------------------------------------------------------

export function initTelemetry(): void {
  // --- PostHog ---
  if (POSTHOG_KEY) {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: false, // We handle SPA page views via usePageTracking
      capture_pageleave: true,
      autocapture: true,
      // Event night: 100% session recording, heatmaps, dead click detection
      disable_session_recording: false,
      enable_recording_console_log: true,
      enable_heatmaps: true,
      capture_dead_clicks: true,
      capture_performance: true,
      session_recording: {
        recordCrossOriginIframes: true,
        // networkPayloadCapture is a runtime-supported feature not yet in the PostHog TS types
        networkPayloadCapture: { recordBody: true, recordHeaders: true },
      } as any,
      loaded: (ph) => {
        ph.register({
          app: "pcc-dashboard",
          environment: IS_PROD ? "production" : "development",
        });
      },
    });
  }

  // --- Sentry ---
  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: IS_PROD ? "production" : "development",
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration(),
      ],
      tracesSampleRate: 1.0, // 100% — event night, capture everything
      replaysSessionSampleRate: 1.0, // 100% — record every session
      replaysOnErrorSampleRate: 1.0,
    });
  }

  // --- GA4 — dynamically inject gtag.js so we only load it when the ID is set ---
  if (GA_MEASUREMENT_ID) {
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];
    // eslint-disable-next-line prefer-rest-params
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    // send_page_view: false — the SPA handles page views via usePageTracking
    window.gtag("config", GA_MEASUREMENT_ID, { send_page_view: false });
  }
}

// ---------------------------------------------------------------------------
// trackPageView — call on every route change
// ---------------------------------------------------------------------------

export function trackPageView(path: string): void {
  // PostHog
  if (POSTHOG_KEY) {
    posthog.capture("$pageview", {
      $current_url: window.location.origin + path,
    });
  }

  // GA4
  if (GA_MEASUREMENT_ID && typeof window.gtag === "function") {
    window.gtag("event", "page_view", {
      page_path: path,
      page_title: document.title,
    });
  }
}

// ---------------------------------------------------------------------------
// trackEvent — custom event across PostHog and GA4
// ---------------------------------------------------------------------------

export function trackEvent(
  name: string,
  properties?: Record<string, unknown>,
): void {
  if (POSTHOG_KEY) {
    posthog.capture(name, properties);
  }
  if (GA_MEASUREMENT_ID && typeof window.gtag === "function") {
    window.gtag("event", name, properties as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// identifyUser — tie a user identity to all three services
// ---------------------------------------------------------------------------

export function identifyUser(
  userId: string,
  traits?: Record<string, unknown>,
): void {
  if (POSTHOG_KEY) {
    posthog.identify(userId, traits);
  }
  if (GA_MEASUREMENT_ID && typeof window.gtag === "function") {
    window.gtag("set", { user_id: userId });
  }
  if (SENTRY_DSN) {
    Sentry.setUser({ id: userId, ...traits });
  }
}

// ---------------------------------------------------------------------------
// Re-export service clients for direct use
// ---------------------------------------------------------------------------

export { posthog, Sentry };

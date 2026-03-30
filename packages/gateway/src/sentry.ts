/**
 * Sentry server-side initialisation for the PCC Gateway.
 *
 * Import and call initSentry() at the very top of server.ts (before any other
 * side-effectful imports) so that Sentry's auto-instrumentation patches are
 * applied before the first HTTP request arrives.
 *
 * The DSN can be provided via:
 *   SENTRY_DSN          — server-side env var (preferred)
 *   VITE_SENTRY_DSN     — shared with the dashboard build (fallback)
 */

import * as Sentry from "@sentry/node";

const SENTRY_DSN =
  process.env.SENTRY_DSN ||
  process.env.VITE_SENTRY_DSN ||
  "";

let _initialized = false;

export function initSentry(): void {
  if (process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN) {
    console.log("[sentry] Active — DSN configured");
  } else {
    console.warn("[sentry] INACTIVE — no SENTRY_DSN in environment. Set it in Railway dashboard.");
  }

  if (!SENTRY_DSN) {
    return;
  }
  if (_initialized) return;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    // 100 % sample rate for the hackathon demo; reduce in production
    tracesSampleRate: 1.0,
    profilesSampleRate: 0.1,
    // Tag every event with the service name so Sentry dashboards can filter
    initialScope: {
      tags: { service: "pcc-gateway" },
    },
  });

  _initialized = true;
  console.log("[sentry] Distributed tracing initialised (dsn=…" + SENTRY_DSN.slice(-12) + ")");
}

export function isSentryEnabled(): boolean {
  return _initialized;
}

export { Sentry };

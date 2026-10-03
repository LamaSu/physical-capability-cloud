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
import { redactCredentials } from "./observability-redact.js";

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

  Sentry.init(sentryOptions(SENTRY_DSN));

  _initialized = true;
  console.log("[sentry] Distributed tracing initialised (dsn=…" + SENTRY_DSN.slice(-12) + ")");
}

/**
 * The gateway's Sentry options: no default PII, and every record redacted as a whole before it is
 * sent (observability-redact.ts; cross-family reviews r3 and r4 of #441). The installed SDK copies
 * every request header and the request body into an error event, records the request's URL and
 * headers as span attributes on a transaction, and keeps outgoing URLs in breadcrumbs; so error
 * events, transactions, each span and each breadcrumb go through the same redaction.
 */
export function sentryOptions(dsn: string): Sentry.NodeOptions {
  return {
    dsn,
    environment: process.env.NODE_ENV || "development",
    // 100 % sample rate for the hackathon demo; reduce in production
    tracesSampleRate: 1.0,
    profilesSampleRate: 0.1,
    // Tag every event with the service name so Sentry dashboards can filter
    initialScope: {
      tags: { service: "pcc-gateway" },
    },
    sendDefaultPii: false,
    beforeSend: (event) => redactCredentials(event),
    beforeSendTransaction: (event) => redactCredentials(event),
    beforeSendSpan: (span) => redactCredentials(span),
    beforeBreadcrumb: (breadcrumb) => redactCredentials(breadcrumb),
  };
}

export function isSentryEnabled(): boolean {
  return _initialized;
}

export { Sentry };

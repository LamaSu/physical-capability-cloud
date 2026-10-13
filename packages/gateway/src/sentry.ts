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
import { isWalletRequest } from "./services/telemetry-privacy.js";

/** Drop ceremony events before Sentry's transport receives request context. */
export function walletSafeSentryEvent<T extends {
  request?: { url?: string };
  extra?: Record<string, unknown>;
  transaction?: string;
}>(event: T): T | null {
  const urls = [event.request?.url, event.extra?.url, event.transaction];
  return urls.some((url) => typeof url === "string" && isWalletRequest(url)) ? null : event;
}

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
    beforeSend: walletSafeSentryEvent,
    beforeSendTransaction: walletSafeSentryEvent,
    beforeBreadcrumb(breadcrumb) {
      const urls = [breadcrumb.data?.url, breadcrumb.data?.request_url, breadcrumb.message];
      return urls.some((url) => typeof url === "string" && isWalletRequest(url)) ? null : breadcrumb;
    },
    beforeSendSpan(span) {
      const urls = [span.description, span.data["url.full"], span.data["http.url"], span.data["http.route"]];
      return urls.some((url) => typeof url === "string" && isWalletRequest(url))
        ? { ...span, description: "/api/wallets", data: {} }
        : span;
    },
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

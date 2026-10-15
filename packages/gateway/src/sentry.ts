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

/** Remove only the wallet header and its Sentry HTTP span attribute. */
function withoutWalletHeader<T>(value: T, seen = new WeakMap<object, object>()): T {
  if (value === null || typeof value !== "object") return value;
  const previous = seen.get(value);
  if (previous) return previous as T;

  const output: Record<string, unknown> = Array.isArray(value) ? [] as unknown as Record<string, unknown> : {};
  seen.set(value, output);
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "x-pcc-wallet" || lowerKey === "http.request.header.x-pcc-wallet") {
      changed = true;
      continue;
    }
    const safe = withoutWalletHeader(item, seen);
    output[key] = safe;
    if (safe !== item) changed = true;
  }
  if (!changed) {
    seen.set(value, value);
    return value;
  }
  return output as T;
}

/** Drop ceremony events before Sentry's transport receives request context. */
export function walletSafeSentryEvent<T extends {
  request?: { url?: string; query_string?: unknown };
  extra?: Record<string, unknown>;
  transaction?: string;
}>(event: T): T | null {
  const urls = [event.request?.url, event.extra?.url, event.transaction];
  return urls.some((url) => typeof url === "string" && isWalletRequest(url)) ? null : withoutWalletHeader(event);
}

// OTel and Sentry integrations use different request-target attribute names.
// Detect only on path-bearing fields, then discard the entire data bag (including headers
// and bodies). Only registered templates are safe to retain as descriptions.
const WALLET_TARGET_ATTRIBUTES = ["url.full", "http.url", "http.target", "url.path", "http.route"] as const;
const WALLET_ROUTE_TEMPLATES = new Set([
  "/api/wallets", "/api/wallets/link-requests", "/api/wallets/link-requests/lookup",
  "/api/wallets/link-requests/:id", "/api/wallets/link-requests/:id/proof",
  "/api/wallets/link-requests/:id/approve", "/api/wallets/:linkId/revoke",
]);

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
      return urls.some((url) => typeof url === "string" && isWalletRequest(url)) ? null : withoutWalletHeader(breadcrumb);
    },
    beforeSendSpan(span) {
      const urls = [span.description, ...WALLET_TARGET_ATTRIBUTES.map(key => span.data[key])];
      const route = span.data["http.route"];
      return urls.some((url) => typeof url === "string" && isWalletRequest(url))
        ? { ...span, description: typeof route === "string" && WALLET_ROUTE_TEMPLATES.has(route)
          ? route : "/api/wallets/<redacted>", data: {} }
        : withoutWalletHeader(span);
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

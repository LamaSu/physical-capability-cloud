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

  Sentry.init(sentryOptions(SENTRY_DSN));

  _initialized = true;
  console.log("[sentry] Distributed tracing initialised (dsn=…" + SENTRY_DSN.slice(-12) + ")");
}

/**
 * Header and query-parameter names whose values are credentials or session secrets. It is the
 * SDK's own list for span attributes (@sentry/core utils/request.js SENSITIVE_HEADER_SNIPPETS),
 * which the SDK does not apply to an error event's request headers.
 */
const SECRET_NAME = /auth|token|secret|session|password|passwd|pwd|key|jwt|bearer|sso|saml|csrf|xsrf|credential|cookie/i;
const REDACTED = "[redacted]";

/** A query string with every credential-named parameter's value redacted. */
function scrubQuery(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // an undecodable name is judged as written
      }
      return eq !== -1 && SECRET_NAME.test(decoded) ? `${name}=${REDACTED}` : pair;
    })
    .join("&");
}

/**
 * Removes request credentials from an event before Sentry sends it (cross-family review r3 of
 * #441, CRITICAL). The installed SDK's request-data integration copies every request header into
 * an error event, so an error in a request carrying X-Verifier-Key, X-Admin-Key, Authorization or
 * a session cookie would send them. Redacted: every header whose name is credential-like, the
 * cookies, and credential-named query parameters in the query string and in the URL.
 */
export function scrubSentryEvent<T extends { request?: Record<string, unknown> }>(event: T): T {
  const request = event.request;
  if (!request || typeof request !== "object") return event;
  const headers = request.headers;
  if (headers && typeof headers === "object") {
    for (const name of Object.keys(headers as Record<string, unknown>)) {
      if (SECRET_NAME.test(name)) (headers as Record<string, unknown>)[name] = REDACTED;
    }
  }
  if ("cookies" in request) request.cookies = REDACTED;
  if (typeof request.query_string === "string") request.query_string = scrubQuery(request.query_string);
  else if (request.query_string !== undefined) request.query_string = REDACTED;
  if (typeof request.url === "string") {
    const q = request.url.indexOf("?");
    if (q !== -1) request.url = request.url.slice(0, q + 1) + scrubQuery(request.url.slice(q + 1));
  }
  return event;
}

/** The gateway's Sentry options: no default PII, and every event scrubbed before it is sent. */
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
    beforeSend: (event) => scrubSentryEvent(event as never),
    beforeSendTransaction: (event) => scrubSentryEvent(event as never),
  };
}

export function isSentryEnabled(): boolean {
  return _initialized;
}

export { Sentry };

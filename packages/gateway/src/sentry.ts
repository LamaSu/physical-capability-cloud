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
import {
  propagation,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api";
import {
  closedBreadcrumb,
  closedSentryEvent,
  closedSentrySpan,
  closedSentryTransaction,
  type SentryServerValues,
} from "./observability/closed-sinks.js";

const SENTRY_DSN =
  process.env.SENTRY_DSN ||
  process.env.VITE_SENTRY_DSN ||
  "";

let _initialized = false;

/** The tags the gateway sets on every event (initialScope): the only tag values that leave as text. */
const SERVER_TAGS = { service: "pcc-gateway" } as const;

/** What the server itself sets on every event, read from the running client when an event leaves. */
function serverValues(): SentryServerValues {
  const client = Sentry.getClient();
  const options = client?.getOptions();
  return {
    publicKey: client?.getDsn()?.publicKey,
    environment: options?.environment,
    release: options?.release,
    sampleRate: options?.tracesSampleRate,
    tags: SERVER_TAGS,
  };
}

/**
 * The gateway's Sentry options (N107b, the closed observability schema). The SDK collects no
 * request data at all (no URL, query string, headers, cookies, body or address), and every outbound
 * record is rebuilt from closed fields before it is sent: error events, transactions, standalone
 * spans and breadcrumbs (observability/closed-sinks.ts), with trace and span ids remapped under the
 * telemetry key and the envelope's sampling context rebuilt from the server's own values.
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
      tags: { ...SERVER_TAGS },
    },
    sendDefaultPii: false,
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== "Http" && integration.name !== "RequestData"),
      Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" }),
      Sentry.requestDataIntegration({
        include: { cookies: false, data: false, headers: false, ip: false, query_string: false, url: false },
      }),
    ],
    beforeSend: (event) => closedSentryEvent(event, serverValues()),
    beforeSendTransaction: (event) => closedSentryTransaction(event, serverValues()),
    beforeSendSpan: (span) => closedSentrySpan(span),
    beforeBreadcrumb: (breadcrumb) => closedBreadcrumb(breadcrumb),
  };
}

/**
 * The propagator Sentry.init registers, behind one that never reads a request's trace headers
 * (round 2, CRITICAL 1). No SDK option does this: strictTraceContinuation only compares the
 * baggage's org id, which a caller can send. Every incoming request (Sentry's http server
 * integration and @fastify/otel both extract through the global propagator) is treated as one with
 * no sentry-trace or baggage header, so it starts a new trace. Outgoing propagation is unchanged.
 */
class NoIncomingTracePropagator implements TextMapPropagator {
  constructor(private readonly registered: TextMapPropagator) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    this.registered.inject(context, carrier, setter);
  }

  extract(context: Context, _carrier: unknown, getter: TextMapGetter): Context {
    return this.registered.extract(context, {}, getter);
  }

  fields(): string[] {
    return this.registered.fields();
  }
}

/** Puts the registered propagator behind NoIncomingTracePropagator; false when there is none to wrap. */
export function closeIncomingTraces(): boolean {
  // The OpenTelemetry API keeps the global propagator behind this accessor; it has no public getter.
  const api = propagation as unknown as { _getGlobalPropagator?: () => TextMapPropagator };
  const registered = api._getGlobalPropagator?.();
  if (!registered || registered instanceof NoIncomingTracePropagator) return false;
  propagation.disable();
  return propagation.setGlobalPropagator(new NoIncomingTracePropagator(registered));
}

/** Starts the SDK with these options and closes incoming trace continuation: the gateway's one init path. */
export function startSentry(options: Sentry.NodeOptions): void {
  Sentry.init(options);
  closeIncomingTraces();
}

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

  startSentry(sentryOptions(SENTRY_DSN));

  _initialized = true;
  console.log("[sentry] Distributed tracing initialised (dsn=…" + SENTRY_DSN.slice(-12) + ")");
}

export function isSentryEnabled(): boolean {
  return _initialized;
}

export { Sentry };

/**
 * OpenTelemetry initialization for pcc-gateway.
 *
 * MUST be imported and initOtel() called BEFORE Sentry and before Fastify.
 * Sentry SDK v8+ hooks into OTel's global TracerProvider on init — if OTel
 * hasn't registered first, they will conflict.
 *
 * Dev (no OTEL_EXPORTER_OTLP_ENDPOINT): ConsoleSpanExporter
 * Prod (OTEL_EXPORTER_OTLP_ENDPOINT set): OTLPTraceExporter
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace, type Tracer } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Exporter selection
// ---------------------------------------------------------------------------

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const isProd = !!otlpEndpoint;

const traceExporter = isProd
  ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
  : new ConsoleSpanExporter();

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

export const otelSdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "pcc-gateway",
    [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION ?? "2.0.0",
  }),
  traceExporter,
  // No auto-instrumentations — manual spans only for facades and A2A messages.
  // Auto-instrumentation requires the ESM loader hook which is incompatible with
  // tsx watch mode and Railway's current deploy setup.
  instrumentations: [],
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let _initialized = false;

/**
 * Initialize the OTel SDK.
 * Must be called as the VERY FIRST thing in server.ts before any other import
 * has side effects (Sentry, Fastify, etc.).
 */
export function initOtel(): void {
  if (_initialized) return;
  _initialized = true;

  otelSdk.start();

  if (!isProd) {
    console.log("[otel] Initialized with ConsoleSpanExporter (dev mode)");
  } else {
    console.log(`[otel] Initialized with OTLP exporter → ${otlpEndpoint}`);
  }
}

/**
 * Gracefully flush and shut down the OTel SDK.
 * Should be called in the server close hook.
 */
export async function shutdownOtel(): Promise<void> {
  if (!_initialized) return;
  try {
    await otelSdk.shutdown();
  } catch (err) {
    console.error("[otel] Shutdown error", err);
  }
}

// ---------------------------------------------------------------------------
// Tracer factory
// ---------------------------------------------------------------------------

/**
 * Get a named tracer. Shorthand for trace.getTracer().
 * Safe to call before initOtel() — returns a NOOP tracer until the SDK starts.
 */
export function getTracer(name: string, version = "2.0.0"): Tracer {
  return trace.getTracer(name, version);
}

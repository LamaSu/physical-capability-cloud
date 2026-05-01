/**
 * Wave 4.4 — bridge orchestrator-sdk's eventBus into PCC's existing OTel
 * pipeline. Every emit() on the SDK's bus becomes a one-shot OTel span via
 * the existing tracer factory in ./otel.ts. No new dependency: PCC already
 * has the OTel SDK, OTLP exporter, and tracer factory wired (see otel.ts).
 *
 * Lifecycle:
 *   - call startEventBusOtelBridge() once at boot AFTER initOtel()
 *   - the returned function unsubscribes; call it during graceful shutdown
 *
 * The bridge is conservative on errors — a failure inside OTel must not
 * break the bus. event-bus's own subscriber-isolation already swallows
 * synchronous throws, so this code can be naive about exceptions.
 */

import { subscribe, type AppEvent } from "@pcc/orchestrator-sdk";
import { getTracer } from "../otel.js";

const TRACER_NAME = "orchestrator-sdk.event-bus";

/**
 * Map an event-bus level to an OTel span status code. Errors flag the span
 * red in tracing UIs; everything else is OK so per-tool latency aggregates
 * stay clean.
 */
function statusForLevel(level?: AppEvent["level"]): "OK" | "ERROR" {
  return level === "err" ? "ERROR" : "OK";
}

/**
 * Subscribe to eventBus and emit a one-shot span per event. Returns an
 * unsubscribe function the caller can hold for graceful shutdown.
 */
export function startEventBusOtelBridge(): () => void {
  const tracer = getTracer(TRACER_NAME);
  return subscribe((e: AppEvent) => {
    // Span name follows the existing facade convention: "<sponsor>.<kind>"
    // so traces group naturally by integration in the UI.
    const span = tracer.startSpan(`${e.sponsor}.${e.kind}`, {
      startTime: e.t,
      attributes: {
        "event.kind": e.kind,
        "event.sponsor": e.sponsor,
        "event.level": e.level ?? "info",
        ...(e.session_id ? { "event.session_id": e.session_id } : {}),
        ...(e.duration_ms !== undefined ? { "event.duration_ms": e.duration_ms } : {}),
        // Text lands as a span attribute rather than a span event so that
        // OTel exporters (Honeycomb, Tempo, etc.) which index attributes
        // can search on it. Already redacted by the bus per T1.6.
        "event.text": e.text.length > 1024 ? `${e.text.slice(0, 1021)}...` : e.text,
      },
    });
    if (statusForLevel(e.level) === "ERROR") {
      // recordException accepts any thrown-shape; we synthesize a minimal
      // error so tracing UIs render an error chip without us needing to
      // attach the raw payload (which may be large or sensitive).
      span.recordException({ name: `${e.sponsor}.${e.kind}`, message: e.text });
      span.setStatus({ code: 2, message: e.text });
    }
    // End immediately — events are already-completed milestones. If a
    // future iteration wants to model a "begin → end" pair as one parent
    // span, that's the `tracked()` helper's job, not this bridge's.
    span.end(e.duration_ms ? e.t + e.duration_ms : e.t);
  });
}

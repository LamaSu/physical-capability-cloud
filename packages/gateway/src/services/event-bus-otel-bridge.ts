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
import { declare, lit } from "../observability/closed-schema.js";
import { addClosedEvent, startClosedSpan } from "../observability/closed-otel.js";

const TRACER_NAME = "orchestrator-sdk.event-bus";
const LEVELS: readonly string[] = ["info", "ok", "warn", "err"];

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
  const tracer = getTracer(lit(TRACER_NAME));
  return subscribe((e: AppEvent) => {
    // Every span has one declared name, and each event field leaves as the closed schema declares
    // it (N107b, #538 round 3): an emitter's kind, sponsor, session, text and reported duration
    // are its values, so they leave keyed (equal values still group and match); the level is from
    // the bus's own vocabulary; t is the bus's clock (emit() sets it). The payload is not sent.
    // No start or end time is passed: the tracing SDK's own clock times every span (N107b round 4,
    // C11; sentry-timing-ratchet.test.ts).
    const span = startClosedSpan(tracer, lit("event-bus.event"), {
      "event.t": declare.serverTime(e.t),
      "event.kind": declare.id(e.kind),
      "event.sponsor": declare.id(e.sponsor),
      "event.level": declare.code(e.level ?? "info", LEVELS),
      ...(e.session_id ? { "event.session_id": declare.id(e.session_id) } : {}),
      ...(e.duration_ms !== undefined ? { "event.duration_ms": declare.id(e.duration_ms) } : {}),
      "event.text": declare.id(e.text),
    });
    if (statusForLevel(e.level) === "ERROR") {
      // The exception event tracing UIs render as an error chip, with declared fields (the
      // emitter's text keyed); the status is its code alone.
      addClosedEvent(span, lit("exception"), {
        "exception.type": lit("EventBusError"),
        "exception.message": declare.id(e.text),
      });
      span.setStatus({ code: 2 });
    }
    // End immediately — events are already-completed milestones. If a
    // future iteration wants to model a "begin → end" pair as one parent
    // span, that's the `tracked()` helper's job, not this bridge's.
    span.end();
  });
}

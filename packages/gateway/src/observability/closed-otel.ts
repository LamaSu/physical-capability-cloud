/**
 * The closed schema on the OpenTelemetry path (#538 round 3, astra source pack, MEDIUM). otel.ts
 * exports spans (OTLP in production, the console otherwise) through ClosedSpanExporter, which
 * rebuilds every span from closed fields before the exporter it wraps serializes it: Sentry's
 * beforeSendSpan is no boundary for that path.
 *
 * What leaves as itself is what a producer declared:
 *   - a span, event or tracer name (or tracer version) passed through otelName(): a compile-time
 *     literal or another declared value, kept in the vocabulary NAMES;
 *   - an attribute that startClosedSpan or startDeclaredSpan recorded for that span object, or
 *     addClosedEvent for that event object, while the span still carries the declared value.
 * Every other name, attribute key and value, event, link attribute and status message leaves as
 * its keyed hash; a status leaves as its code alone; trace, span and parent ids are remapped under
 * the server key (no trace state); the resource is the one the server configured. The span's and
 * its events' times are the SDK's clock: no gateway code passes a time to a span API
 * (sentry-timing-ratchet.test.ts), as for Sentry's span times.
 */
import type { Attributes, AttributeValue, Link, Span, SpanContext, SpanStatus, Tracer } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-node";
import { emitted, isDeclared, keyedHash, keyedHexId, type Declared } from "./closed-schema.js";

/** Fields a producer declares for a span or an event: each value made by declare or lit. */
export type DeclaredFields = Readonly<Record<string, Declared>>;

/** Names a producer declared. Only otelName adds to it, and only a declared value's emitted form. */
const NAMES = new Set<string>();
const NAMES_LIMIT = 10_000;

/** A declared value as text (anything else as its keyed hash). */
const textOf = (value: unknown): string => (isDeclared(value) ? String(emitted(value)) : keyedHash(value));

/** A span, event or tracer name a producer declared, as it leaves; the exporter keeps it as itself. */
export function otelName(name: Declared): string {
  const text = textOf(name);
  if (isDeclared(name) && NAMES.size < NAMES_LIMIT) NAMES.add(text);
  return text;
}

/** A name as the exporter sends it: a declared one as itself, any other as its keyed hash. */
const closedName = (name: unknown): string => (typeof name === "string" && NAMES.has(name) ? name : keyedHash(name));

/** A value OpenTelemetry can carry as an attribute (a primitive or a homogeneous list of them), else undefined. */
function attributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.length > 0) {
    const kind = typeof value[0];
    if ((kind === "string" || kind === "number" || kind === "boolean") && value.every((item) => typeof item === kind)) {
      return [...value] as AttributeValue;
    }
  }
  return undefined;
}

/** What declared fields set on a span or an event, and the record the exporter checks them against. */
function declaredAttributes(fields: DeclaredFields | undefined): { attributes: Attributes; declared: Map<string, AttributeValue> } {
  const attributes: Attributes = {};
  const declared = new Map<string, AttributeValue>();
  for (const key of Object.keys(fields ?? {})) {
    const field: unknown = fields![key];
    if (isDeclared(field)) {
      const value = attributeValue(emitted(field));
      if (value === undefined) continue;
      attributes[key] = value;
      declared.set(key, value);
    } else if (field !== undefined && field !== null) {
      attributes[keyedHash(key)] = keyedHash(field);
    }
  }
  return { attributes, declared };
}

/** The attributes a producer declared, per span object (the SDK hands its exporter that same object). */
const SPANS = new WeakMap<object, Map<string, AttributeValue>>();
/** The attributes a producer declared, per event object (an SDK span's events). */
const EVENTS = new WeakMap<object, Map<string, AttributeValue>>();

function record(span: unknown, declared: ReadonlyMap<string, AttributeValue>): void {
  if (typeof span !== "object" || span === null) return;
  const known = SPANS.get(span) ?? new Map<string, AttributeValue>();
  for (const [key, value] of declared) known.set(key, value);
  SPANS.set(span, known);
}

/** Starts an OpenTelemetry span with a declared name and declared attributes. */
export function startClosedSpan(tracer: Tracer, name: Declared, fields?: DeclaredFields): Span {
  const { attributes, declared } = declaredAttributes(fields);
  const span = tracer.startSpan(otelName(name), { attributes });
  record(span, declared);
  return span;
}

/** Adds an event with a declared name and declared attributes to a span. */
export function addClosedEvent(span: Span, name: Declared, fields?: DeclaredFields): void {
  const text = otelName(name);
  const { attributes, declared } = declaredAttributes(fields);
  span.addEvent(text, attributes);
  const events: unknown = (span as { events?: unknown }).events;
  const event: unknown = Array.isArray(events) ? events[events.length - 1] : undefined;
  if (typeof event === "object" && event !== null && (event as { name?: unknown }).name === text) EVENTS.set(event, declared);
}

/** Sentry's span options, as Sentry.startSpan and Sentry.startSpanManual take them. */
interface SentrySpanOptions {
  name: string;
  op?: string;
  attributes?: Attributes;
}

/**
 * Starts a span through Sentry's span API (Sentry.startSpan or Sentry.startSpanManual) with a
 * declared name, op and attributes. The options carry them as they leave, and the span Sentry
 * hands the callback (an OpenTelemetry span when Sentry runs on OpenTelemetry) is recorded as
 * declaring them, with the op that Sentry sets as its sentry.op attribute.
 */
export function startDeclaredSpan<S, R>(
  start: (options: SentrySpanOptions, callback: (span: S) => R) => R,
  name: Declared,
  op: Declared,
  fields: DeclaredFields,
  callback: (span: S) => R,
): R {
  const { attributes, declared } = declaredAttributes(fields);
  const opText = textOf(op);
  declared.set("sentry.op", opText);
  return start({ name: otelName(name), op: opText, attributes }, (span) => {
    record(span, declared);
    return callback(span);
  });
}

// ── The exporter ───────────────────────────────────────────────────────────

/** SpanKind (INTERNAL, SERVER, CLIENT, PRODUCER, CONSUMER) and SpanStatusCode (UNSET, OK, ERROR). */
const SPAN_KINDS: ReadonlySet<unknown> = new Set([0, 1, 2, 3, 4]);
const STATUS_CODES: ReadonlySet<unknown> = new Set([0, 1, 2]);
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

function sameValue(declared: AttributeValue | undefined, value: unknown): boolean {
  if (Array.isArray(declared)) {
    return Array.isArray(value) && value.length === declared.length && declared.every((item, i) => item === value[i]);
  }
  return declared !== undefined && declared === value;
}

/** Attributes as the exporter sends them: a declared one as itself, any other key and value keyed. */
function closedAttributes(attributes: unknown, declared: ReadonlyMap<string, AttributeValue> | undefined): Attributes {
  const out: Attributes = {};
  if (typeof attributes !== "object" || attributes === null) return out;
  for (const key of Object.keys(attributes)) {
    const value: unknown = (attributes as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (declared !== undefined && declared.has(key) && sameValue(declared.get(key), value)) {
      out[key] = Array.isArray(value) ? ([...value] as AttributeValue) : (value as AttributeValue);
    } else {
      out[keyedHash(key)] = keyedHash(value);
    }
  }
  return out;
}

/** A span context with its ids remapped under the server key, its sampled bit and no trace state. */
function closedContext(context: SpanContext): SpanContext {
  return {
    traceId: keyedHexId(context?.traceId, 32) ?? INVALID_TRACE_ID,
    spanId: keyedHexId(context?.spanId, 16) ?? INVALID_SPAN_ID,
    traceFlags: typeof context?.traceFlags === "number" && (context.traceFlags & 1) === 1 ? 1 : 0,
    isRemote: context?.isRemote === true,
  };
}

const count = (n: unknown): number => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0);

function closedEvent(event: TimedEvent): TimedEvent {
  return {
    name: closedName(event.name),
    time: event.time,
    attributes: closedAttributes(event.attributes, EVENTS.get(event)),
    droppedAttributesCount: count(event.droppedAttributesCount),
  };
}

function closedLink(link: Link): Link {
  return {
    context: closedContext(link.context),
    attributes: closedAttributes(link.attributes, undefined),
    droppedAttributesCount: count(link.droppedAttributesCount),
  };
}

/** A span rebuilt from closed fields (see the module comment). */
export function closedReadableSpan(span: ReadableSpan, resource: Resource): ReadableSpan {
  const context = closedContext(span.spanContext());
  const status: SpanStatus = { code: STATUS_CODES.has(span.status?.code) ? span.status.code : 0 };
  return {
    name: closedName(span.name),
    kind: SPAN_KINDS.has(span.kind) ? span.kind : 0,
    spanContext: () => context,
    parentSpanContext: span.parentSpanContext ? closedContext(span.parentSpanContext) : undefined,
    startTime: span.startTime,
    endTime: span.endTime,
    status,
    attributes: closedAttributes(span.attributes, SPANS.get(span)),
    links: (span.links ?? []).map(closedLink),
    events: (span.events ?? []).map(closedEvent),
    duration: span.duration,
    ended: span.ended === true,
    resource,
    instrumentationScope: {
      name: closedName(span.instrumentationScope?.name),
      ...(span.instrumentationScope?.version === undefined ? {} : { version: closedName(span.instrumentationScope.version) }),
    },
    droppedAttributesCount: count(span.droppedAttributesCount),
    droppedEventsCount: count(span.droppedEventsCount),
    droppedLinksCount: count(span.droppedLinksCount),
  };
}

/**
 * The exporter otel.ts puts in front of OTLP (and the console): every span leaves rebuilt by
 * closedReadableSpan, under the server's own resource. A batch it cannot close is reported as
 * failed, never sent as it was.
 */
export class ClosedSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly resource: Resource,
  ) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    let closed: ReadableSpan[];
    try {
      closed = spans.map((span) => closedReadableSpan(span, this.resource));
    } catch {
      resultCallback({ code: 1 });
      return;
    }
    this.inner.export(closed, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

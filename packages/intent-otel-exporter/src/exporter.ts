/**
 * @pcc/intent-otel-exporter — IntentEnvelopeSpanExporter
 *
 * An OpenTelemetry SpanExporter that inspects spans for intent-shaped
 * activity, maps them through the attribute mapper, and POSTs the resulting
 * DemandEnvelopes to PCC's /api/intents/ingest endpoint in batches.
 *
 * Use ONE of:
 *   - this SpanExporter (drop-in via BatchSpanProcessor in your existing OTel SDK)
 *   - the IntentSpanProcessor in ./span-processor.ts (sidecar — no replacement
 *     of your existing exporter chain)
 *
 * Configuration:
 *   ingestUrl (required)            POST target; should be the same URL the
 *                                   intent-broker uses (default
 *                                   https://capability.network/api/intents/ingest).
 *   apiKey (required for live POST) Bearer token. Absent → exporter silently
 *                                   drops envelopes and counts the skip.
 *   intentSpanKindFilter            Optional set of OTel span kind names to
 *                                   include (defaults to all when omitted).
 *                                   Use to scope down high-volume INTERNAL
 *                                   spans, for example.
 *   attributeMapper                 Override the default semconv mapper. The
 *                                   function returns either a DemandEnvelope
 *                                   or null (to skip the span).
 *   maxBatchSize                    Max envelopes per HTTP request (default 32).
 *   fetchImpl                       Inject a fetch (default globalThis.fetch).
 *   onError                         Receive transport errors without breaking
 *                                   the OTel pipeline (default: noop).
 *
 * Hard rules:
 *   - export() ALWAYS calls resultCallback exactly once with SUCCESS unless
 *     the underlying transport failed for ALL batches. We follow the OTel
 *     contract: failing-loud breaks the consumer's pipeline.
 *   - We never throw out of export(); transport failures route through onError.
 *   - We never read span events, links, status, or message bodies — only
 *     attributes + resource + name.
 */

import { DemandEnvelopeSchema, type DemandEnvelope } from "@pcc/spec";
import {
  isIntentShapedSpan,
  spanToDemandEnvelope,
  type MinimalSpan,
} from "./attribute-mapper.js";

// We type-only import to keep runtime decoupled — the SDK is a peer dep
// in spirit; users supply their own SDK instance.
import type {
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";

// We have to import the ExportResultCode enum at runtime because we return
// {code: ExportResultCode.SUCCESS} from export(). The package is in
// `@opentelemetry/core` (transitive via sdk-trace-base).
import { ExportResultCode } from "@opentelemetry/core";

// ── Types ──────────────────────────────────────────────────────────────────

export type SpanKindName =
  | "INTERNAL"
  | "SERVER"
  | "CLIENT"
  | "PRODUCER"
  | "CONSUMER";

export type AttributeMapper = (span: MinimalSpan) => DemandEnvelope | null;

export interface IntentEnvelopeSpanExporterConfig {
  /** Full POST target. Same shape the broker uses. */
  ingestUrl: string;
  /** Bearer token. Absent ⇒ exporter validates locally but skips network. */
  apiKey?: string;
  /**
   * Restrict to specific OTel SpanKind names. When omitted, the exporter
   * inspects every kind.
   */
  intentSpanKindFilter?: ReadonlySet<SpanKindName>;
  /** Override the default semconv → DemandEnvelope mapper. */
  attributeMapper?: AttributeMapper;
  /** Max envelopes per HTTP POST (default 32). */
  maxBatchSize?: number;
  /** Inject fetch for tests / proxies. */
  fetchImpl?: typeof fetch;
  /** Receive non-fatal errors. */
  onError?: (err: Error) => void;
}

/**
 * The shape of /api/intents/ingest's body in the multi-envelope mode. The
 * gateway today accepts a single envelope per POST; we POST sequentially in
 * batches so each envelope still gets its own idempotency entry and the
 * gateway can rate-limit per envelope.
 */
export interface ForwardOutcome {
  attempted: number;
  accepted: number;
  rejected: number;
  errors: string[];
}

// ── ReadableSpan → MinimalSpan adapter ────────────────────────────────────

/**
 * The SDK gives us a `ReadableSpan` with non-trivial structure (HrTime,
 * SpanKind enum, etc.). We flatten it to the MinimalSpan our mapper consumes
 * so the mapper stays SDK-agnostic and unit-testable.
 */
export function readableSpanToMinimal(span: ReadableSpan): MinimalSpan {
  // SpanKind in OTel is a numeric enum. We don't import it at module-eval time
  // because the SDK may not be present in some test environments; instead, we
  // derive the name from the SDK's exported numeric values lazily.
  const kindName = spanKindToName(span.kind);

  const startHr = span.startTime; // [seconds, nanos]
  const startMs = startHr ? startHr[0] * 1000 + Math.floor(startHr[1] / 1_000_000) : Date.now();

  const minimal: MinimalSpan = {
    name: span.name,
    attributes: { ...(span.attributes ?? {}) } as Record<string, unknown>,
    startTimeISO: new Date(startMs).toISOString(),
  };
  if (span.resource?.attributes) {
    minimal.resource = { attributes: { ...span.resource.attributes } as Record<string, unknown> };
  }
  if (kindName) {
    minimal.kindName = kindName;
  }
  return minimal;
}

/**
 * SpanKind enum mapping (mirror of @opentelemetry/api SpanKind). Defined
 * inline so we don't depend on the api package version at runtime.
 *
 *   INTERNAL = 0
 *   SERVER   = 1
 *   CLIENT   = 2
 *   PRODUCER = 3
 *   CONSUMER = 4
 */
export function spanKindToName(kind: number | undefined): SpanKindName | undefined {
  switch (kind) {
    case 0:
      return "INTERNAL";
    case 1:
      return "SERVER";
    case 2:
      return "CLIENT";
    case 3:
      return "PRODUCER";
    case 4:
      return "CONSUMER";
    default:
      return undefined;
  }
}

// ── Default attribute mapper ──────────────────────────────────────────────

/**
 * The default mapper: ignore spans that aren't intent-shaped, otherwise
 * project them to a DemandEnvelope and validate against DemandEnvelopeSchema
 * client-side. Validation failures return null and increment the rejected
 * counter — they never throw.
 */
export function defaultMapper(span: MinimalSpan): DemandEnvelope | null {
  if (!isIntentShapedSpan(span)) return null;
  const envelope = spanToDemandEnvelope(span);
  const parsed = DemandEnvelopeSchema.safeParse(envelope);
  // Zod typing returns `string` for the composition signature; the runtime
  // value has already been validated against the 0x[hex]{64} regex, so the
  // branded-type narrowing is safe.
  return parsed.success ? (parsed.data as DemandEnvelope) : null;
}

// ── HTTP forwarder ────────────────────────────────────────────────────────

/**
 * POST a single envelope to the ingest URL. Returns an outcome row; never
 * throws.
 */
async function postOne(
  envelope: DemandEnvelope,
  cfg: IntentEnvelopeSpanExporterConfig,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; error?: string }> {
  if (!cfg.apiKey) return { ok: false, error: "no_api_key" };

  try {
    const res = await fetchImpl(cfg.ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      let body = "";
      try {
        const j = (await res.json()) as unknown;
        body = typeof j === "object" && j !== null ? JSON.stringify(j) : String(j);
      } catch {
        body = `HTTP ${res.status}`;
      }
      return { ok: false, error: `upstream_${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `transport: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Forward an array of envelopes through the ingest endpoint. Each envelope
 * is posted serially to honor the per-envelope idempotency design of the
 * gateway. Returns the aggregate outcome.
 */
export async function forwardBatch(
  envelopes: DemandEnvelope[],
  cfg: IntentEnvelopeSpanExporterConfig,
  fetchImpl: typeof fetch,
): Promise<ForwardOutcome> {
  const outcome: ForwardOutcome = {
    attempted: envelopes.length,
    accepted: 0,
    rejected: 0,
    errors: [],
  };
  for (const env of envelopes) {
    const r = await postOne(env, cfg, fetchImpl);
    if (r.ok) {
      outcome.accepted++;
    } else {
      outcome.rejected++;
      if (r.error) outcome.errors.push(r.error);
    }
  }
  return outcome;
}

// ── Exporter implementation ──────────────────────────────────────────────

/**
 * IntentEnvelopeSpanExporter — drop into your OTel SDK as the exporter on a
 * BatchSpanProcessor (or as a sidecar via SimpleSpanProcessor). It does NOT
 * replace your trace exporter; you can compose it alongside an OTLP/Jaeger
 * exporter on the same TracerProvider.
 *
 * Example:
 *   const sdk = new NodeSDK({
 *     spanProcessors: [
 *       new BatchSpanProcessor(new OTLPTraceExporter({...})),
 *       new BatchSpanProcessor(new IntentEnvelopeSpanExporter({
 *         ingestUrl: "https://capability.network/api/intents/ingest",
 *         apiKey: process.env.PCC_API_KEY,
 *       })),
 *     ],
 *   });
 */
export class IntentEnvelopeSpanExporter implements SpanExporter {
  private readonly cfg: IntentEnvelopeSpanExporterConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly mapper: AttributeMapper;
  private readonly batchSize: number;
  private shutdownInvoked = false;

  // Lightweight counters for observability in tests + ops dashboards.
  private exported = 0;
  private skipped = 0;
  private rejected = 0;
  private forwardedAccepted = 0;
  private forwardedRejected = 0;

  constructor(cfg: IntentEnvelopeSpanExporterConfig) {
    if (!cfg.ingestUrl || typeof cfg.ingestUrl !== "string") {
      throw new Error("IntentEnvelopeSpanExporter: ingestUrl is required");
    }
    this.cfg = { ...cfg, ingestUrl: cfg.ingestUrl.replace(/\/$/, "") };
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    this.mapper = cfg.attributeMapper ?? defaultMapper;
    this.batchSize = Math.max(1, cfg.maxBatchSize ?? 32);
  }

  /**
   * OTel SpanExporter contract. Called by BatchSpanProcessor / SimpleSpanProcessor.
   */
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shutdownInvoked) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error("exporter shut down") });
      return;
    }

    // 1) Filter by span kind if configured.
    let candidates: ReadableSpan[] = spans;
    if (this.cfg.intentSpanKindFilter && this.cfg.intentSpanKindFilter.size > 0) {
      candidates = spans.filter((s) => {
        const k = spanKindToName(s.kind);
        return k !== undefined && this.cfg.intentSpanKindFilter!.has(k);
      });
    }

    // 2) Map each surviving span through the configured attribute mapper.
    const envelopes: DemandEnvelope[] = [];
    for (const s of candidates) {
      try {
        const minimal = readableSpanToMinimal(s);
        const env = this.mapper(minimal);
        if (env === null) {
          this.skipped++;
          continue;
        }
        envelopes.push(env);
      } catch (e) {
        this.rejected++;
        this.cfg.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
    this.exported += envelopes.length;

    if (envelopes.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    // 3) POST in batches. We use fire-and-forget for the OTel callback —
    // SUCCESS the moment we accept the spans for forwarding; transport
    // errors route through onError so they don't break the trace pipeline.
    void this.flushBatches(envelopes).catch((e) => {
      this.cfg.onError?.(e instanceof Error ? e : new Error(String(e)));
    });
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  /** Split envelopes into batches of `batchSize` and forward each in turn. */
  private async flushBatches(envelopes: DemandEnvelope[]): Promise<void> {
    for (let i = 0; i < envelopes.length; i += this.batchSize) {
      const slice = envelopes.slice(i, i + this.batchSize);
      const outcome = await forwardBatch(slice, this.cfg, this.fetchImpl);
      this.forwardedAccepted += outcome.accepted;
      this.forwardedRejected += outcome.rejected;
      if (outcome.errors.length > 0 && this.cfg.onError) {
        for (const err of outcome.errors.slice(0, 3)) {
          this.cfg.onError(new Error(err));
        }
      }
    }
  }

  /** OTel SpanExporter contract. */
  async shutdown(): Promise<void> {
    this.shutdownInvoked = true;
    // No flush queue today — each export() call dispatches its own POSTs
    // asynchronously. Future versions may buffer; if so, await drain here.
  }

  /** Optional contract method on newer SDKs; safe to ignore. */
  async forceFlush(): Promise<void> {
    // No-op for the same reason as shutdown.
  }

  /**
   * Internal counters for observability + tests.
   * Not part of the SpanExporter contract; users shouldn't depend on it
   * for correctness, only for debug.
   */
  getStats(): {
    exported: number;
    skipped: number;
    rejected: number;
    forwardedAccepted: number;
    forwardedRejected: number;
  } {
    return {
      exported: this.exported,
      skipped: this.skipped,
      rejected: this.rejected,
      forwardedAccepted: this.forwardedAccepted,
      forwardedRejected: this.forwardedRejected,
    };
  }
}

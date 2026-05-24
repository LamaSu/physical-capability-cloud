/**
 * @pcc/intent-otel-exporter — IntentSpanProcessor (sidecar alternative)
 *
 * Most OTel SDK users compose their telemetry as `[SpanProcessor → SpanExporter]`.
 * Some have already wired a BatchSpanProcessor + OTLP exporter and don't want
 * to swap or compose exporters. For them, this SpanProcessor captures intents
 * in `onEnd()` and forwards them out-of-band — your existing telemetry path
 * stays untouched.
 *
 * Use IntentSpanProcessor OR IntentEnvelopeSpanExporter, not both: doing both
 * double-counts the same span.
 *
 * Example:
 *   const sdk = new NodeSDK({
 *     spanProcessors: [
 *       new BatchSpanProcessor(new OTLPTraceExporter({...})),  // your existing OTel
 *       new IntentSpanProcessor({                              // PCC sidecar
 *         ingestUrl: "https://capability.network/api/intents/ingest",
 *         apiKey: process.env.PCC_API_KEY,
 *       }),
 *     ],
 *   });
 */

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { DemandEnvelopeSchema, type DemandEnvelope } from "@pcc/spec";
import {
  defaultMapper,
  forwardBatch,
  readableSpanToMinimal,
  spanKindToName,
  type AttributeMapper,
  type IntentEnvelopeSpanExporterConfig,
  type SpanKindName,
} from "./exporter.js";

// ── Config ─────────────────────────────────────────────────────────────────

export type IntentSpanProcessorConfig = IntentEnvelopeSpanExporterConfig & {
  /**
   * How long to wait between flushes when bufferring envelopes (default
   * 5000ms). Set to 0 to forward on every onEnd (more network chatter).
   */
  flushIntervalMs?: number;
};

// ── Processor ─────────────────────────────────────────────────────────────

export class IntentSpanProcessor implements SpanProcessor {
  private readonly cfg: IntentSpanProcessorConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly mapper: AttributeMapper;
  private readonly intentSpanKindFilter: ReadonlySet<SpanKindName> | undefined;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly buffer: DemandEnvelope[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private shutdownInvoked = false;

  // Counters (mirrors exporter)
  private exported = 0;
  private skipped = 0;
  private rejected = 0;
  private forwardedAccepted = 0;
  private forwardedRejected = 0;

  constructor(cfg: IntentSpanProcessorConfig) {
    if (!cfg.ingestUrl || typeof cfg.ingestUrl !== "string") {
      throw new Error("IntentSpanProcessor: ingestUrl is required");
    }
    this.cfg = { ...cfg, ingestUrl: cfg.ingestUrl.replace(/\/$/, "") };
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    this.mapper = cfg.attributeMapper ?? defaultMapper;
    this.intentSpanKindFilter = cfg.intentSpanKindFilter;
    this.batchSize = Math.max(1, cfg.maxBatchSize ?? 32);
    this.flushIntervalMs = Math.max(0, cfg.flushIntervalMs ?? 5000);
  }

  /** OTel hook: span started. We don't sample on start. */
  onStart(_span: Span, _parentContext: Context): void {
    // intentionally empty
  }

  /** OTel hook: span ended. Map, validate, buffer (or flush immediately). */
  onEnd(span: ReadableSpan): void {
    if (this.shutdownInvoked) return;

    // Optional span-kind filter
    if (this.intentSpanKindFilter && this.intentSpanKindFilter.size > 0) {
      const k = spanKindToName(span.kind);
      if (!k || !this.intentSpanKindFilter.has(k)) return;
    }

    let envelope: DemandEnvelope | null;
    try {
      envelope = this.mapper(readableSpanToMinimal(span));
    } catch (e) {
      this.rejected++;
      this.cfg.onError?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    if (envelope === null) {
      this.skipped++;
      return;
    }

    // Final validation — same belt-and-braces as the exporter.
    const parsed = DemandEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      this.rejected++;
      this.cfg.onError?.(new Error(`invalid_envelope: ${parsed.error.message}`));
      return;
    }

    this.buffer.push(parsed.data);
    this.exported++;

    if (this.flushIntervalMs === 0 || this.buffer.length >= this.batchSize) {
      void this.flush().catch((e) => this.cfg.onError?.(e instanceof Error ? e : new Error(String(e))));
    } else {
      this.scheduleFlush();
    }
  }

  /** Force pending envelopes to flush right now (OTel hook + manual). */
  async forceFlush(): Promise<void> {
    await this.flush();
  }

  /** OTel hook: shutdown. Cancel timers, drain buffer. */
  async shutdown(): Promise<void> {
    this.shutdownInvoked = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** Counters (debug surface; same shape as exporter.getStats). */
  getStats(): {
    exported: number;
    skipped: number;
    rejected: number;
    forwardedAccepted: number;
    forwardedRejected: number;
    pending: number;
  } {
    return {
      exported: this.exported,
      skipped: this.skipped,
      rejected: this.rejected,
      forwardedAccepted: this.forwardedAccepted,
      forwardedRejected: this.forwardedRejected,
      pending: this.buffer.length,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((e) =>
        this.cfg.onError?.(e instanceof Error ? e : new Error(String(e))),
      );
    }, this.flushIntervalMs);
    // Don't keep the Node event loop alive purely for this timer.
    if (typeof (this.flushTimer as { unref?: () => void }).unref === "function") {
      (this.flushTimer as { unref: () => void }).unref();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const drain = this.buffer.splice(0, this.buffer.length);
    for (let i = 0; i < drain.length; i += this.batchSize) {
      const slice = drain.slice(i, i + this.batchSize);
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
}

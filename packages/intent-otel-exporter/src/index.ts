/**
 * @pcc/intent-otel-exporter — public surface.
 *
 * Two integration paths:
 *   1. `IntentEnvelopeSpanExporter` — drop in as another exporter via
 *      `BatchSpanProcessor(new IntentEnvelopeSpanExporter({...}))`. Use this
 *      when you're building a fresh OTel pipeline OR you want intent capture
 *      coupled to your existing trace export cadence.
 *   2. `IntentSpanProcessor` — add as a sidecar `SpanProcessor`. Use this
 *      when you already have a `[BatchSpanProcessor → OTLPExporter]` chain
 *      and don't want to touch it.
 *
 * Both honor the same `DemandEnvelope` contract from `@pcc/spec` and POST
 * to PCC's `/api/intents/ingest` endpoint with `Authorization: Bearer
 * <PCC_API_KEY>`.
 */

export {
  IntentEnvelopeSpanExporter,
  defaultMapper,
  forwardBatch,
  readableSpanToMinimal,
  spanKindToName,
  type AttributeMapper,
  type ForwardOutcome,
  type IntentEnvelopeSpanExporterConfig,
  type SpanKindName,
} from "./exporter.js";

export {
  IntentSpanProcessor,
  type IntentSpanProcessorConfig,
} from "./span-processor.js";

export {
  isIntentShapedSpan,
  spanToDemandEnvelope,
  type MapOptions,
  type MinimalSpan,
} from "./attribute-mapper.js";

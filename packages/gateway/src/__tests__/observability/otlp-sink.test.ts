/**
 * #538 round 3 (astra, source pack, MEDIUM): the OTLP path. otel.ts builds an OpenTelemetry NodeSDK
 * whose exporter (OTLP in production, the console otherwise) sends every span as the producers made
 * it; Sentry's beforeSendSpan is no boundary for it. This drives that path with an in-memory
 * exporter and a marker in every field the gateway's producers hand to OpenTelemetry:
 *   - the event-bus bridge: every AppEvent field (kind, sponsor, text, session_id, payload,
 *     duration_ms), its error status and its exception;
 *   - the kernel's job.lifecycle span and the settlement pipeline's spans. They reach OpenTelemetry
 *     through Sentry's span API; here that API is an OpenTelemetry-backed stand-in, as the SDK runs
 *     it once it is initialized (its spans are OpenTelemetry spans with the caller's attributes);
 * and asserts that no exported field (name, attributes, events, status, links) carries the marker.
 * A declared field stays readable (positive control).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { trace, type Span, type Tracer } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafy-otlp-test" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafy-otlp-enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xotlp_evidence_tx" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xotlp_release_tx" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));
vi.mock("../../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));
// Sentry's span API as the initialized SDK runs it: an OpenTelemetry span from the global tracer,
// carrying the options' attributes (and its op), ended when the callback settles (startSpan) or by
// the caller (startSpanManual).
vi.mock("../../sentry.js", async () => {
  const api = await import("@opentelemetry/api");
  const tracer = () => api.trace.getTracer("@sentry/opentelemetry");
  const optionsOf = (options: { attributes?: Record<string, unknown>; op?: string }) => ({
    attributes: { ...(options.attributes ?? {}), ...(options.op ? { "sentry.op": options.op } : {}) } as never,
  });
  return {
    initSentry: vi.fn(),
    isSentryEnabled: vi.fn().mockReturnValue(false),
    Sentry: {
      startSpan: (options: { name: string }, callback: (span: unknown) => unknown) =>
        tracer().startActiveSpan(options.name, optionsOf(options), (span) => {
          try {
            const result = callback(span);
            return result instanceof Promise ? result.finally(() => span.end()) : (span.end(), result);
          } catch (error) {
            span.end();
            throw error;
          }
        }),
      startSpanManual: (options: { name: string }, callback: (span: unknown) => unknown) =>
        tracer().startActiveSpan(options.name, optionsOf(options), (span) => callback(span)),
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      flush: vi.fn().mockResolvedValue(true),
      withScope: vi.fn().mockImplementation((cb: (scope: object) => void) => cb({ setTag: vi.fn(), setExtra: vi.fn() })),
    },
  };
});

vi.setConfig({ testTimeout: 120_000 });

const MARK = ["Zq", "8675309", "mk"].join("");
const NUM = 8675309;
const M = (field: string) => `${MARK}-${field}`;
const markerIn = (text: string) => [
  ...(/zq8675309mk/i.test(text) ? ["string"] : []),
  ...(/(?<![0-9A-Za-z])8675309(?![0-9A-Za-z])/.test(text) ? ["number"] : []),
];

/** What an OTLP exporter serializes from a span (the fields @opentelemetry/otlp-transformer reads). */
function exportedFields(span: ReadableSpan) {
  return {
    name: span.name,
    kind: span.kind,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    traceState: span.spanContext().traceState?.serialize(),
    parentSpanId: span.parentSpanContext?.spanId,
    attributes: span.attributes,
    events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    status: span.status,
    links: span.links.map((link) => ({ traceId: link.context.traceId, spanId: link.context.spanId, attributes: link.attributes })),
    resource: span.resource.attributes,
    scope: span.instrumentationScope,
  };
}

const memory = new InMemorySpanExporter();
let sdk: NodeSDK;

/** The SDK otel.ts builds, around the in-memory exporter (its own builder when it has one). */
async function otelPath(): Promise<NodeSDK> {
  const otel = (await import("../../otel.js")) as { createOtelSdk?: (exporter: SpanExporter) => NodeSDK };
  if (typeof otel.createOtelSdk === "function") return otel.createOtelSdk(memory);
  // 94e0c710..b5718ecb: otel.ts builds `new NodeSDK({ resource, traceExporter, instrumentations: [] })`.
  return new NodeSDK({ resource: resourceFromAttributes({ "service.name": "pcc-gateway" }), traceExporter: memory, instrumentations: [] });
}

async function flushed(): Promise<ReadableSpan[]> {
  const provider = trace.getTracerProvider() as unknown as { getDelegate?: () => { forceFlush?: () => Promise<void> } };
  await provider.getDelegate?.().forceFlush?.();
  return memory.getFinishedSpans();
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  sdk = await otelPath();
  sdk.start();
}, 60_000);

afterAll(async () => {
  await sdk?.shutdown();
});

describe("#538 r3: the OTLP path carries no marker from any producer's span", () => {
  it("the event-bus bridge, the kernel's job.lifecycle span and the settlement pipeline's spans", async () => {
    memory.reset();
    // The event-bus bridge: a marker in every AppEvent field, at the error level (status and exception).
    const { startEventBusOtelBridge } = await import("../../services/event-bus-otel-bridge.js");
    const { emit } = await import("@pcc/orchestrator-sdk");
    const off = startEventBusOtelBridge();
    emit({ kind: M("kind"), sponsor: M("sponsor"), text: M("text"), session_id: M("session"), level: "err", payload: { [M("pk")]: M("pv"), n: NUM }, duration_ms: NUM });
    emit({ kind: M("kind2"), sponsor: M("sponsor2"), text: `a tool said ${M("text2")}`, level: "ok", duration_ms: NUM });
    off();

    // The settlement pipeline: its job id, bundle id, step, kernel and contract address.
    const db = await import("../../db.js");
    db.initStore({ seed: false });
    const { SettlementService } = await import("../../services/settlement-service.js");
    await new SettlementService().processEvidence(
      {
        id: M("bundle"),
        jobId: M("bundlejob"),
        stepId: M("step"),
        kernelId: M("kernel"),
        assuranceTier: 0,
        bundleHash: `sha256:${"ab".repeat(32)}` as `sha256:${string}`,
        kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "mock" },
        createdAt: new Date().toISOString(),
        events: [],
      } as never,
      M("job"),
      { contractAddress: M("contract"), autoRelease: true },
    );

    // The kernel's job.lifecycle span: its job id and step.
    const { initKernelService, getKernelService, resetKernelService } = await import("../../services/kernel-service.js");
    initKernelService({
      kernelId: "kernel-otlp-test",
      mockMode: true,
      devices: [
        { id: "dev-otlp-machine", type: "machine", adapterType: "mock", config: { kernelId: "kernel-otlp-test", jobDurationMs: 30 } },
        { id: "dev-otlp-sensor", type: "sensor", adapterType: "mock", config: { kernelId: "kernel-otlp-test" } },
        { id: "dev-otlp-camera", type: "camera", adapterType: "mock", config: { kernelId: "kernel-otlp-test" } },
      ],
    } as never);
    await getKernelService().submitJob({ jobId: M("kjob"), stepId: M("kstep"), assuranceTier: 1 });
    // The lifecycle span ends when the job's run (and its settlement) finishes.
    for (let i = 0; i < 100 && !(await flushed()).some((span) => span.name === "job.lifecycle"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    resetKernelService();

    const spans = await flushed();
    expect(spans.some((span) => span.name === "job.lifecycle"), "the kernel's lifecycle span was exported").toBe(true);
    const names = spans.map((span) => span.name);
    // Each producer's spans were exported (so an empty export cannot pass for a closed one).
    expect(spans.length, `exported: ${names.join(", ")}`).toBeGreaterThanOrEqual(8);
    const leaks = spans
      .map((span) => ({ span: exportedFields(span), found: markerIn(JSON.stringify(exportedFields(span))) }))
      .filter((entry) => entry.found.length > 0)
      .map((entry) => `${entry.span.name}: ${entry.found.join("+")} in ${JSON.stringify(entry.span).slice(0, 400)}`);
    expect(leaks, "spans that carried a marker out of the OTLP path").toEqual([]);

    // What each producer declared still leaves readable: its span names, its keys, the level and
    // Sentry's op (the declared vocabulary), with each caller value keyed.
    const { keyedHash } = await import("../../observability/closed-schema.js");
    const bridge = spans.find((span) => span.attributes["event.level"] === "err");
    expect(bridge?.name).toBe("event-bus.event");
    expect(bridge?.attributes).toMatchObject({ "event.kind": keyedHash(M("kind")), "event.text": keyedHash(M("text")) });
    expect(bridge?.status).toEqual({ code: 2 });
    expect(bridge?.events.map((event) => [event.name, event.attributes])).toEqual([
      ["exception", { "exception.type": "EventBusError", "exception.message": keyedHash(M("text")) }],
    ]);
    expect(spans.find((span) => span.name === "settlement.pipeline")?.attributes).toEqual({
      "sentry.op": "settlement",
      "job.id": keyedHash(M("job")),
      "bundle.id": keyedHash(M("bundle")),
      "bundle.assurance_tier": keyedHash(0),
    });
    expect(spans.find((span) => span.name === "job.lifecycle")?.attributes).toEqual({
      "sentry.op": "job.lifecycle",
      "job.id": keyedHash(M("kjob")),
      "job.type": keyedHash(M("kstep")),
      "job.assurance_tier": keyedHash(1),
    });
    db.closeStore();
  });

  it("a span a producer declares keeps its declared name and fields readable (positive control)", async () => {
    memory.reset();
    const closedOtel = (await import("../../observability/closed-otel.js")) as {
      startClosedSpan(tracer: Tracer, name: unknown, fields?: Record<string, unknown>): Span;
      addClosedEvent(span: Span, name: unknown, fields?: Record<string, unknown>): void;
    };
    const { declare, keyedHash, lit } = await import("../../observability/closed-schema.js");
    const span = closedOtel.startClosedSpan(trace.getTracer("n107b-otlp"), lit("n107b.otlp.control"), {
      stage: declare.code("fund", ["fund"]),
      count: declare.metric(3),
      who: declare.id("caller-id"),
      size: declare.metric(5),
    });
    closedOtel.addClosedEvent(span, lit("n107b.otlp.event"), { step: declare.code("lock", ["lock"]) });
    // A raw value set over a declared key is no longer the declared value: it leaves keyed.
    span.setAttribute("size", 6);
    span.end();
    const [exported] = await flushed();
    expect(exported!.name).toBe("n107b.otlp.control");
    expect(exported!.attributes).toEqual({ stage: "fund", count: 3, who: keyedHash("caller-id"), [keyedHash("size")]: keyedHash(6) });
    expect(exported!.events.map((event) => [event.name, event.attributes])).toEqual([["n107b.otlp.event", { step: "lock" }]]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

process.env.PCC_DB_PATH = ":memory:";
process.env.PCC_SEED_DATA = "false";
process.env.NODE_ENV = "test";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;
let app: FastifyInstance;
let key: string;
let kernelId: string;
let getApiCapabilityTypes: typeof import("../routes/capabilities.js").getApiCapabilityTypes;
let getCapabilityFacade: typeof import("../facades/index.js").getCapabilityFacade;
let recordOperatorStage: typeof import("../services/funnel-tracker.js").recordOperatorStage;
let PipelineTelemetryService: typeof import("../telemetry.js").PipelineTelemetryService;

// Synthetic inputs exercise the same credential classes as existing N71 tests.
const privateText = "password=N71-SENTINEL";

beforeAll(async () => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  const server = await import("../server.js");
  ({ getApiCapabilityTypes } = await import("../routes/capabilities.js"));
  ({ getCapabilityFacade } = await import("../facades/index.js"));
  ({ recordOperatorStage } = await import("../services/funnel-tracker.js"));
  ({ PipelineTelemetryService } = await import("../telemetry.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  const { getRepos } = await import("../db.js");
  const { generateApiKey } = await import("../auth/api-key-auth.js");
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  key = rawKey;
  getRepos().apiKeys.insert({
    id: "n71-r9-span-key",
    keyHash,
    keyPrefix,
    operatorId: "n71-r9-span-owner",
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  kernelId = "kernel-n71-r9-span";
  const created = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: { authorization: `Bearer ${key}` },
    payload: { id: kernelId, name: "N71 round 9 span capture" },
  });
  expect(created.statusCode).toBeLessThan(300);
}, 120_000);

beforeEach(() => exporter.reset());

afterAll(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  await provider?.shutdown();
  trace.disable();
  context.disable();
});

describe("N71 round 9 exported span events", () => {
  it("formats the device id when funnel-enabled registration records its active span", async () => {
    vi.stubEnv("PCC_FUNNEL_ENABLED", "true");
    const tracer = trace.getTracer("n71-r9-test");
    await tracer.startActiveSpan("registration-test", async (span) => {
      try {
        expect(trace.getActiveSpan()).toBe(span);
        const response = await app.inject({
          method: "POST",
          url: "/api/setup/register-device",
          headers: { authorization: `Bearer ${key}` },
          payload: { kernelId, deviceId: privateText, type: "sensor", adapterType: "mock" },
        });
        expect(response.statusCode).toBe(201);
      } finally {
        span.end();
      }
    });
    const event = exporter.getFinishedSpans().flatMap((span) => span.events)
      .find((event) => event.name === "pcc.operator_funnel.device_registered");
    expect(event).toBeDefined();
    expect(event?.attributes?.["pcc.device_id"]).toBe("[invalid id]");
  });

  it("formats every optional operator-funnel id at the exported event boundary", () => {
    vi.stubEnv("PCC_FUNNEL_ENABLED", "true");
    trace.getTracer("n71-r9-test").startActiveSpan("operator-metadata-test", (span) => {
      try {
        expect(recordOperatorStage(kernelId, "capability_published", {
          deviceId: privateText,
          capabilityId: privateText,
          jobId: privateText,
        })).toBe(true);
      } finally {
        span.end();
      }
    });
    const event = exporter.getFinishedSpans().flatMap((span) => span.events)
      .find((event) => event.name === "pcc.operator_funnel.capability_published");
    expect(event?.attributes).toEqual({
      "pcc.kernel_id": kernelId,
      "pcc.operator_funnel.stage": "capability_published",
      "pcc.device_id": "[invalid id]",
      "pcc.capability_id": "[invalid id]",
      "pcc.job_id": "[invalid id]",
    });
  });

  it("formats the telemetry span-event name and every exported attribute", () => {
    const telemetry = new PipelineTelemetryService();
    trace.getTracer("n71-r9-test").startActiveSpan("pipeline-event-test", (span) => {
      try {
        expect(trace.getActiveSpan()).toBe(span);
        telemetry.emit(privateText, privateText as never, privateText as never, {
          source: privateText,
          duration_ms: privateText as never,
        });
      } finally {
        span.end();
      }
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].events).toHaveLength(1);
    expect(spans[0].events[0]).toMatchObject({
      name: "pipeline.[invalid id]",
      attributes: {
        "pipeline.status": "[invalid id]",
        "pipeline.job_id": "[invalid id]",
        "pipeline.duration_ms": 0,
        "pipeline.source": "[invalid id]",
      },
    });
  });
});

describe("N71 round 9 capability-type diagnostics", () => {
  function logger() {
    return { warn: vi.fn(), error: vi.fn() };
  }

  it("contains a thrown dependency exception before the mapped logger sink", async () => {
    const log = logger();
    const spy = vi.spyOn(getCapabilityFacade(), "distinctTypes")
      .mockRejectedValue(new TypeError(privateText));
    try {
      expect((await getApiCapabilityTypes(log as unknown as FastifyBaseLogger)).length).toBeGreaterThan(0);
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        { code: "capability_type_union_failed", errorClass: "TypeError" },
        "[capabilities/types] union build failed; falling back to templates",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("contains a failed facade result before the mapped logger sink", async () => {
    const log = logger();
    const spy = vi.spyOn(getCapabilityFacade(), "distinctTypes").mockResolvedValue({
      success: false,
      error: { code: privateText, message: privateText },
    } as never);
    try {
      expect((await getApiCapabilityTypes(log as unknown as FastifyBaseLogger)).length).toBeGreaterThan(0);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        { code: "capability_distinct_types_failed", errorClass: "Error" },
        "[capabilities/types] distinct-type query failed; catalog types omitted from union",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

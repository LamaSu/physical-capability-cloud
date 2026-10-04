/**
 * N71 round 5 (astra pack 83d, HIGH #3 + #4): BaseFacade.execute()'s OTel span.
 *
 * Round 4 fixed the Result/response/pipelineTelemetry paths (instanceof over a
 * forgeable `.name`; a UNIQUE-constraint violation collapsed to a fixed CONFLICT
 * code, never the driver's message). Astra's round-5 verdict: the SPAN was never
 * touched. `span.recordException(error)` and `span.setStatus({message})` ran on
 * the RAW caught error / its raw message, BEFORE any classification — so an
 * untyped dependency's message (a DB driver string, free text with no URL in it
 * at all, `password=...`) reached OTel, and from there OTLP in production
 * (otel.ts), regardless of which typed branch (if any) matched afterward.
 *
 * The fix (base.facade.ts): classify FIRST, touch the span LAST, with the
 * classification's own CODE only — never the original error object, never its
 * message, for every branch, typed or not ("the sink is the boundary": a span is
 * an output sink exactly like a response or a log line). `recordException` is
 * gone entirely.
 *
 * This file proves it against a REAL OTel pipeline (InMemorySpanExporter +
 * SimpleSpanProcessor on a NodeTracerProvider registered as the process global)
 * rather than a mocked tracer. BaseFacade's module-level `facadeTracer` is a
 * `trace.getTracer(...)` ProxyTracer captured at import time; OTel's API package
 * is specifically designed so registering a real provider AFTER that still
 * re-points every later `startActiveSpan` call at the real tracer (see
 * @opentelemetry/api's `ProxyTracer._getTracer()` — it re-resolves its delegate
 * from the provider on first use, not at `getTracer()` time). That's also the
 * exact "import before init" ordering otel.ts documents for production
 * (NodeSDK.start() registers its provider long after every module has imported
 * `trace.getTracer(...)` at module scope).
 *
 * Isolated in its own file (not device-credentials-redaction.test.ts): this is
 * the only file in the suite that registers a real global OTel tracer provider.
 * `afterAll` tears it down (`provider.shutdown()` + `trace.disable()`) so no
 * other test file sharing this worker thread inherits it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { trace } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";

const SENTINEL = "N71-SENTINEL";

let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let getJobFacade: typeof import("../facades/index.js").getJobFacade;
let seq = 0;

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;
let kernelId: string;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `n71r5-span-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  ({ getJobFacade } = await import("../facades/index.js"));
  const app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();

  const key = seedKey("n71r5-span-owner@x.test");
  kernelId = `kernel-n71r5-span-${Date.now().toString(36)}`;
  const k = await app.inject({
    method: "POST",
    url: "/api/kernels",
    payload: { id: kernelId, name: "N71 r5 span tests" },
    headers: { authorization: `Bearer ${key}` },
  });
  expect(k.statusCode, k.body).toBeLessThan(300);

  // Register a real global tracer provider AFTER server.js (and therefore
  // base.facade.ts's module-level facadeTracer) has already been imported —
  // see the file doc comment for why this still works. Deliberately
  // `trace.setGlobalTracerProvider(provider)` directly, NOT `provider.register()`:
  // `.register()` ALSO installs a global AsyncLocalStorageContextManager +
  // W3C propagator as a side effect (NodeTracerProvider.register()), and doing
  // that mid-run, after this gateway's own app/request machinery is already
  // live, measurably breaks span export in this suite (confirmed empirically —
  // `.register()` left the exporter permanently empty; raw
  // `setGlobalTracerProvider` does not). This test only needs the tracer
  // delegate wired, never a new global context manager.
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

beforeEach(() => {
  exporter.reset();
});

function spansFor(operation: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === `job.${operation}`);
}

/** No finished span anywhere carries the sentinel — status, events, or attributes. */
function expectNoSpanLeak(spans: ReadableSpan[]): void {
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    expect(JSON.stringify(span.status), "span.status").not.toContain(SENTINEL);
    expect(JSON.stringify(span.events), "span.events").not.toContain(SENTINEL);
    expect(JSON.stringify(span.attributes), "span.attributes").not.toContain(SENTINEL);
  }
}

describe("N71 round 5 (astra pack 83d, HIGH #3): an untyped dependency error's message never reaches the exported span", () => {
  it("[neg] recordException is never called, and setStatus carries only the fixed internal_error code", async () => {
    const kernels = getRepos().kernels;
    const spy = vi.spyOn(kernels, "insertDevice").mockImplementation(() => {
      throw new Error(`password=${SENTINEL}`);
    });
    try {
      const result = await getJobFacade().registerDevice({
        kernelId,
        id: `dev-r5-h3-${++seq}`,
        type: "machine",
        model: "M",
        adapterType: "mock",
      } as never);
      expect(result.success).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const spans = spansFor("registerDevice");
    expectNoSpanLeak(spans);
    for (const span of spans) {
      expect(span.events.length).toBe(0); // no recordException at all (round 5)
      expect(span.status.message).toBe("internal_error");
    }
  });
});

describe("N71 round 5 (astra pack 83d, HIGH #4): a UNIQUE-constraint violation's driver message never reaches the exported span either", () => {
  it("[neg] a UNIQUE-prefixed message from the driver never reaches the span", async () => {
    const kernels = getRepos().kernels;
    const spy = vi.spyOn(kernels, "insertDevice").mockImplementation(() => {
      throw new Error(`UNIQUE constraint failed: devices.id value=${SENTINEL}`);
    });
    try {
      await getJobFacade().registerDevice({
        kernelId,
        id: `dev-r5-h4a-${++seq}`,
        type: "machine",
        model: "M",
        adapterType: "mock",
      } as never);
    } finally {
      spy.mockRestore();
    }
    const spans = spansFor("registerDevice");
    expectNoSpanLeak(spans);
    for (const span of spans) {
      expect(span.events.length).toBe(0);
      expect(span.status.message).toBe("CONFLICT");
    }
  });

  it("[neg] the mutable SQLITE_CONSTRAINT_UNIQUE code with an unrelated secret-bearing message never reaches the span", async () => {
    const kernels = getRepos().kernels;
    const spy = vi.spyOn(kernels, "insertDevice").mockImplementation(() => {
      throw Object.assign(new Error(`insert failed: apiKey=${SENTINEL}`), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    });
    try {
      await getJobFacade().registerDevice({
        kernelId,
        id: `dev-r5-h4b-${++seq}`,
        type: "machine",
        model: "M",
        adapterType: "mock",
      } as never);
    } finally {
      spy.mockRestore();
    }
    const spans = spansFor("registerDevice");
    expectNoSpanLeak(spans);
    for (const span of spans) {
      expect(span.events.length).toBe(0);
      expect(span.status.message).toBe("CONFLICT");
    }
  });
});

describe("control: a successful facade call still gets an OK span (round 5 doesn't break the happy path)", () => {
  it("records facade.result=success and SpanStatusCode.OK for a normal registerDevice", async () => {
    const result = await getJobFacade().registerDevice({
      kernelId,
      id: `dev-r5-ctrl-${++seq}`,
      type: "machine",
      model: "M",
      adapterType: "mock",
    } as never);
    expect(result.success).toBe(true);
    const spans = spansFor("registerDevice");
    expect(spans.length).toBeGreaterThan(0);
    const last = spans[spans.length - 1];
    expect(last.status.code).toBe(1); // SpanStatusCode.OK
    expect(last.attributes["facade.result"]).toBe("success");
  });
});

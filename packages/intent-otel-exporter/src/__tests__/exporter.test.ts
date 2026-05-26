/**
 * Tests for IntentEnvelopeSpanExporter + IntentSpanProcessor.
 *
 * We do NOT boot the OpenTelemetry SDK or run a real TracerProvider — that's
 * tested by the SDK itself. We construct fake `ReadableSpan` shapes that
 * cover the SDK contract (name, kind, attributes, resource, startTime) and
 * call the exporter / processor directly.
 */

import { describe, expect, it, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  IntentEnvelopeSpanExporter,
  IntentSpanProcessor,
  defaultMapper,
  forwardBatch,
  readableSpanToMinimal,
  spanKindToName,
  type IntentEnvelopeSpanExporterConfig,
} from "../index.js";
import type { DemandEnvelope } from "@pcc/spec";

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a fake ReadableSpan matching the fields our code actually reads. */
function fakeSpan(partial: Partial<{
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
  resourceAttrs: Record<string, unknown>;
  startTime: [number, number];
}> = {}): ReadableSpan {
  const startTime: [number, number] = partial.startTime ?? [1_716_000_000, 0];
  // Cast through unknown — the SDK type is broad, and we only set what the
  // exporter touches. Untouched fields are unused.
  return {
    name: partial.name ?? "tool.example",
    kind: partial.kind ?? 0, // INTERNAL
    attributes: partial.attributes ?? {},
    resource: {
      attributes: partial.resourceAttrs ?? {},
    },
    startTime,
    endTime: [startTime[0] + 1, 0],
    duration: [1, 0],
    status: { code: 0 },
    parentSpanId: undefined,
    spanContext: () => ({
      traceId: "00000000000000000000000000000001",
      spanId: "0000000000000001",
      traceFlags: 1,
      isRemote: false,
    }),
    events: [],
    links: [],
    instrumentationScope: { name: "test", version: "0.0.0" },
    instrumentationLibrary: { name: "test", version: "0.0.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ended: true,
  } as unknown as ReadableSpan;
}

function makeConfig(
  overrides: Partial<IntentEnvelopeSpanExporterConfig> = {},
): IntentEnvelopeSpanExporterConfig {
  return {
    ingestUrl: "https://capability.network/api/intents/ingest",
    apiKey: "pcc_live_test_xxx",
    fetchImpl: vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true, envelopeId: "x", dedupeKey: "y" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch,
    ...overrides,
  };
}

/**
 * Synchronously call exporter.export and resolve when its result callback
 * fires. We DO NOT wait for the fan-out POSTs — those run asynchronously
 * after the callback per the OTel contract.
 */
function exportSpans(
  exporter: IntentEnvelopeSpanExporter,
  spans: ReadableSpan[],
): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve) => {
    exporter.export(spans, (r) => resolve(r));
  });
}

/** Wait one microtask flush so the asynchronous POST promises resolve. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

// ── readableSpanToMinimal ──────────────────────────────────────────────────

describe("readableSpanToMinimal", () => {
  it("flattens a ReadableSpan into name + attributes + ISO startTime + resource", () => {
    const span = fakeSpan({
      name: "tool.x",
      attributes: { "gen_ai.tool.name": "browser_search" },
      resourceAttrs: { "service.name": "my-agent" },
      startTime: [1_700_000_000, 0],
    });
    const m = readableSpanToMinimal(span);
    expect(m.name).toBe("tool.x");
    expect(m.attributes["gen_ai.tool.name"]).toBe("browser_search");
    expect(m.resource?.attributes?.["service.name"]).toBe("my-agent");
    expect(m.startTimeISO).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

// ── spanKindToName ─────────────────────────────────────────────────────────

describe("spanKindToName", () => {
  it("maps numeric kinds to canonical names", () => {
    expect(spanKindToName(0)).toBe("INTERNAL");
    expect(spanKindToName(1)).toBe("SERVER");
    expect(spanKindToName(2)).toBe("CLIENT");
    expect(spanKindToName(3)).toBe("PRODUCER");
    expect(spanKindToName(4)).toBe("CONSUMER");
    expect(spanKindToName(99)).toBeUndefined();
    expect(spanKindToName(undefined)).toBeUndefined();
  });
});

// ── defaultMapper ──────────────────────────────────────────────────────────

describe("defaultMapper", () => {
  it("returns null for non-intent-shaped spans", () => {
    const m = readableSpanToMinimal(fakeSpan({ name: "db.query", attributes: {} }));
    expect(defaultMapper(m)).toBeNull();
  });

  it("returns a validated DemandEnvelope for intent-shaped spans", () => {
    const m = readableSpanToMinimal(
      fakeSpan({
        name: "tool.search",
        attributes: { "gen_ai.tool.name": "browser_search" },
      }),
    );
    const env = defaultMapper(m);
    expect(env).not.toBeNull();
    expect(env!.source).toBe("otel");
    expect(env!.capabilityTypes).toEqual(["browser_search"]);
  });
});

// ── forwardBatch ──────────────────────────────────────────────────────────

describe("forwardBatch", () => {
  const envelope: DemandEnvelope = {
    id: "test-id",
    source: "otel",
    compositionSignature:
      "0x" + "a".repeat(64) as `0x${string}`,
    capabilityTypes: ["x"],
    summary: "x",
    budgetBand: "under_100",
    urgencyBand: "standard",
    createdAt: "2026-05-23T10:00:00.000Z",
  };

  it("POSTs each envelope serially with Bearer auth", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );
    const outcome = await forwardBatch(
      [envelope, envelope, envelope],
      makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.attempted).toBe(3);
    expect(outcome.accepted).toBe(3);
    expect(outcome.rejected).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Verify auth header on the first call
    const [, init] = fetchImpl.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer pcc_live_test_xxx");
  });

  it("returns no_api_key error string when apiKey is missing", async () => {
    const fetchImpl = vi.fn();
    const outcome = await forwardBatch(
      [envelope],
      { ingestUrl: "https://example.com", fetchImpl: fetchImpl as unknown as typeof fetch },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.accepted).toBe(0);
    expect(outcome.rejected).toBe(1);
    expect(outcome.errors[0]).toBe("no_api_key");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("collects upstream_* error strings for non-2xx responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_envelope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const outcome = await forwardBatch(
      [envelope],
      makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.rejected).toBe(1);
    expect(outcome.errors[0]).toMatch(/^upstream_400/);
  });

  it("collects transport: error strings for fetch failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await forwardBatch(
      [envelope],
      makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.rejected).toBe(1);
    expect(outcome.errors[0]).toContain("ECONNREFUSED");
  });
});

// ── IntentEnvelopeSpanExporter ─────────────────────────────────────────────

describe("IntentEnvelopeSpanExporter — constructor + config", () => {
  it("throws when ingestUrl is missing", () => {
    expect(
      () =>
        new IntentEnvelopeSpanExporter({
          ingestUrl: "",
          apiKey: "x",
        }),
    ).toThrow(/ingestUrl/);
  });

  it("strips a trailing slash from ingestUrl", () => {
    const exporter = new IntentEnvelopeSpanExporter({
      ingestUrl: "https://capability.network/api/intents/ingest/",
      apiKey: "x",
    });
    // The trimmed URL is internal; verify via a fetch interaction.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    (exporter as unknown as { fetchImpl: typeof fetch }).fetchImpl =
      fetchImpl as unknown as typeof fetch;
    // The constructor stores the normalized URL on this.cfg.ingestUrl
    expect((exporter as unknown as { cfg: { ingestUrl: string } }).cfg.ingestUrl).toBe(
      "https://capability.network/api/intents/ingest",
    );
  });
});

describe("IntentEnvelopeSpanExporter — export() behavior", () => {
  it("returns SUCCESS immediately for an empty span list", async () => {
    const exporter = new IntentEnvelopeSpanExporter(makeConfig());
    const result = await exportSpans(exporter, []);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
  });

  it("returns SUCCESS when given only non-intent spans (none forwarded)", async () => {
    const fetchImpl = vi.fn();
    const exporter = new IntentEnvelopeSpanExporter(
      makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    const result = await exportSpans(exporter, [
      fakeSpan({ name: "db.query", attributes: { "db.statement": "SELECT 1" } }),
    ]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await flushAsync();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exporter.getStats().skipped).toBe(1);
  });

  it("forwards an intent-shaped span via POST with Bearer auth", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true, envelopeId: "e1" }), { status: 202 }),
    );
    const exporter = new IntentEnvelopeSpanExporter(
      makeConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    const span = fakeSpan({
      name: "tool.search",
      attributes: { "gen_ai.tool.name": "browser_search" },
    });
    const result = await exportSpans(exporter, [span]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://capability.network/api/intents/ingest");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer pcc_live_test_xxx");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.source).toBe("otel");
    expect(body.capabilityTypes).toEqual(["browser_search"]);
    expect(exporter.getStats().exported).toBe(1);
    expect(exporter.getStats().forwardedAccepted).toBe(1);
  });

  it("filters by intentSpanKindFilter when configured (CLIENT only)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    const exporter = new IntentEnvelopeSpanExporter(
      makeConfig({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        intentSpanKindFilter: new Set(["CLIENT"]),
      }),
    );
    const result = await exportSpans(exporter, [
      fakeSpan({
        name: "tool.x",
        kind: 0, // INTERNAL — filtered out
        attributes: { "gen_ai.tool.name": "a" },
      }),
      fakeSpan({
        name: "tool.y",
        kind: 2, // CLIENT — kept
        attributes: { "gen_ai.tool.name": "b" },
      }),
    ]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.capabilityTypes).toEqual(["b"]);
  });

  it("returns SUCCESS even when forwards fail (transport errors don't break the host)", async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const exporter = new IntentEnvelopeSpanExporter(
      makeConfig({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onError,
      }),
    );
    const result = await exportSpans(exporter, [
      fakeSpan({
        name: "tool.search",
        attributes: { "gen_ai.tool.name": "x" },
      }),
    ]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
    // Stats: 1 exported, 0 forwarded ok, 1 forwarded rejected
    const stats = exporter.getStats();
    expect(stats.exported).toBe(1);
    expect(stats.forwardedAccepted).toBe(0);
    expect(stats.forwardedRejected).toBe(1);
  });

  it("uses a custom attributeMapper when provided (skip everything)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    const customMapper = vi.fn(() => null);
    const exporter = new IntentEnvelopeSpanExporter(
      makeConfig({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        attributeMapper: customMapper,
      }),
    );
    const result = await exportSpans(exporter, [
      fakeSpan({ name: "tool.x", attributes: { "gen_ai.tool.name": "y" } }),
    ]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await flushAsync();
    expect(customMapper).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exporter.getStats().skipped).toBe(1);
  });

  it("respects maxBatchSize when fanning out multiple envelopes", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    const exporter = new IntentEnvelopeSpanExporter(
      makeConfig({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxBatchSize: 2,
      }),
    );
    const spans = Array.from({ length: 5 }, (_, i) =>
      fakeSpan({
        name: `tool.x${i}`,
        attributes: { "gen_ai.tool.name": `tool-${i}` },
      }),
    );
    const result = await exportSpans(exporter, spans);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await flushAsync();
    // 5 envelopes, batchSize 2 → still 5 POSTs total (serial per envelope)
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(exporter.getStats().forwardedAccepted).toBe(5);
  });

  it("returns FAILED on export after shutdown", async () => {
    const exporter = new IntentEnvelopeSpanExporter(makeConfig());
    await exporter.shutdown();
    const result = await exportSpans(exporter, [
      fakeSpan({ name: "tool.x", attributes: { "gen_ai.tool.name": "y" } }),
    ]);
    expect(result.code).toBe(ExportResultCode.FAILED);
  });
});

// ── IntentSpanProcessor ────────────────────────────────────────────────────

describe("IntentSpanProcessor", () => {
  it("constructs and exposes getStats()", () => {
    const processor = new IntentSpanProcessor(makeConfig());
    const stats = processor.getStats();
    expect(stats.exported).toBe(0);
    expect(stats.pending).toBe(0);
  });

  it("skips non-intent spans on onEnd()", () => {
    const fetchImpl = vi.fn();
    const processor = new IntentSpanProcessor({
      ...makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushIntervalMs: 0,
    });
    processor.onEnd(
      fakeSpan({ name: "db.query", attributes: { "db.statement": "SELECT 1" } }),
    );
    expect(processor.getStats().skipped).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards on every onEnd when flushIntervalMs=0", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    const processor = new IntentSpanProcessor({
      ...makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushIntervalMs: 0,
    });
    processor.onEnd(
      fakeSpan({ name: "tool.x", attributes: { "gen_ai.tool.name": "browser_search" } }),
    );
    await flushAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(processor.getStats().forwardedAccepted).toBe(1);
  });

  it("buffers envelopes until forceFlush() when flushIntervalMs > 0", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    const processor = new IntentSpanProcessor({
      ...makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushIntervalMs: 60_000,
      maxBatchSize: 100,
    });
    processor.onEnd(
      fakeSpan({ name: "tool.x", attributes: { "gen_ai.tool.name": "a" } }),
    );
    processor.onEnd(
      fakeSpan({ name: "tool.y", attributes: { "gen_ai.tool.name": "b" } }),
    );
    expect(processor.getStats().pending).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    await processor.forceFlush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(processor.getStats().pending).toBe(0);
  });

  it("drains buffer on shutdown()", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    const processor = new IntentSpanProcessor({
      ...makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushIntervalMs: 60_000,
    });
    processor.onEnd(
      fakeSpan({ name: "tool.x", attributes: { "gen_ai.tool.name": "a" } }),
    );
    expect(processor.getStats().pending).toBe(1);
    await processor.shutdown();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(processor.getStats().pending).toBe(0);
  });

  it("ignores onEnd after shutdown", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    const processor = new IntentSpanProcessor({
      ...makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushIntervalMs: 0,
    });
    await processor.shutdown();
    processor.onEnd(
      fakeSpan({ name: "tool.x", attributes: { "gen_ai.tool.name": "a" } }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

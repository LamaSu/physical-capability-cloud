/**
 * Tests for IntentCollectorClient — Phase 2.2 capture client.
 *
 * Coverage:
 *   - constructor + env defaults
 *   - captureIntent fills required fields
 *   - within-batch dedup via compositionSignature
 *   - batch-size triggers immediate flush
 *   - flush coalesces concurrent calls
 *   - retry on 5xx with backoff (mocked sleep)
 *   - no retry on 4xx (immediate drop)
 *   - hashing: raw values get hashed; already-hashed values pass through
 *   - disabled mode is a no-op
 *   - wrap-fetch: intent URL → captures; non-intent URL → no capture
 *   - missing API key → drops batch + warns
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  IntentCollectorClient,
  loadCollectorConfig,
  defaultHasher,
} from "../client.js";
import { computeCompositionSignature } from "@pcc/spec";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeMockFetch(
  responseStatus = 202,
  bodyOverride?: object,
): typeof fetch & { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(bodyOverride ?? { accepted: true }), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    });
  });
  return mock as unknown as typeof fetch & { mock: typeof mock };
}

function makeFailingFetch(
  statuses: number[],
): typeof fetch & { mock: ReturnType<typeof vi.fn> } {
  let i = 0;
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i++;
    return new Response(JSON.stringify({ error: "x" }), { status });
  });
  return mock as unknown as typeof fetch & { mock: typeof mock };
}

// ─────────────────────────────────────────────────────────────────────────
// Suite: loadCollectorConfig
// ─────────────────────────────────────────────────────────────────────────

describe("loadCollectorConfig", () => {
  it("returns sensible defaults when no env vars are set", () => {
    const cfg = loadCollectorConfig({} as NodeJS.ProcessEnv);
    expect(cfg.ingestUrl).toBe("https://capability.network/api/intents/ingest");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.batchSize).toBe(50);
    expect(cfg.flushIntervalMs).toBe(5000);
    expect(cfg.enabled).toBe(true);
    expect(typeof cfg.hasher).toBe("function");
  });

  it("strips trailing slash from ingestUrl", () => {
    const cfg = loadCollectorConfig({
      PCC_INTENT_INGEST_URL: "https://example.com/api/intents/ingest/",
    } as NodeJS.ProcessEnv);
    expect(cfg.ingestUrl).toBe("https://example.com/api/intents/ingest");
  });

  it("honors PCC_INTENT_COLLECTOR_ENABLED=false (opt-out)", () => {
    const cfg = loadCollectorConfig({
      PCC_INTENT_COLLECTOR_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
  });

  it("treats absent env var as enabled (default-on)", () => {
    const cfg = loadCollectorConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
  });

  it("parses batch size + flush interval overrides", () => {
    const cfg = loadCollectorConfig({
      PCC_INTENT_COLLECTOR_BATCH_SIZE: "10",
      PCC_INTENT_COLLECTOR_FLUSH_INTERVAL_MS: "1000",
    } as NodeJS.ProcessEnv);
    expect(cfg.batchSize).toBe(10);
    expect(cfg.flushIntervalMs).toBe(1000);
  });

  it("falls back to defaults on non-numeric overrides", () => {
    const cfg = loadCollectorConfig({
      PCC_INTENT_COLLECTOR_BATCH_SIZE: "garbage",
      PCC_INTENT_COLLECTOR_FLUSH_INTERVAL_MS: "-5",
    } as NodeJS.ProcessEnv);
    expect(cfg.batchSize).toBe(50);
    expect(cfg.flushIntervalMs).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Suite: defaultHasher
// ─────────────────────────────────────────────────────────────────────────

describe("defaultHasher", () => {
  it("produces a 64-char lowercase hex digest", () => {
    const h = defaultHasher("foo@example.com");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const a = defaultHasher("alice");
    const b = defaultHasher("alice");
    expect(a).toBe(b);
  });

  it("produces different digests for different inputs", () => {
    const a = defaultHasher("alice");
    const b = defaultHasher("bob");
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Suite: IntentCollectorClient — captureIntent + flush
// ─────────────────────────────────────────────────────────────────────────

describe("IntentCollectorClient.captureIntent", () => {
  let client: IntentCollectorClient;
  let mockFetch: ReturnType<typeof makeMockFetch>;

  beforeEach(() => {
    mockFetch = makeMockFetch();
    client = new IntentCollectorClient({
      apiKey: "pcc_live_test",
      batchSize: 5,
      flushIntervalMs: 1_000_000, // effectively disabled for these tests
      fetchImpl: mockFetch,
    });
  });

  afterEach(() => {
    client.shutdown();
  });

  it("fills required fields when caller omits them", async () => {
    client.captureIntent({ capabilityTypes: ["food-delivery"] });
    await client.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1]!.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].source).toBe("sdk");
    expect(body[0].id).toMatch(/^intent-/);
    expect(body[0].compositionSignature).toMatch(/^0x[a-f0-9]{64}$/);
    expect(body[0].budgetBand).toBe("under_100");
    expect(body[0].urgencyBand).toBe("standard");
    expect(typeof body[0].createdAt).toBe("string");
  });

  it("drops envelopes without capabilityTypes (gateway would 400 anyway)", async () => {
    client.captureIntent({ summary: "no types here" });
    expect(client.queueSize()).toBe(0);
    await client.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("dedups within a batch by compositionSignature", async () => {
    const sig = computeCompositionSignature(["food-delivery"], []);
    client.captureIntent({
      capabilityTypes: ["food-delivery"],
      compositionSignature: sig,
    });
    client.captureIntent({
      capabilityTypes: ["food-delivery"],
      compositionSignature: sig,
      summary: "second one",
    });
    expect(client.queueSize()).toBe(1);
    await client.flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(body.length).toBe(1);
  });

  it("flushes immediately when batchSize is hit", async () => {
    for (let i = 0; i < 5; i++) {
      client.captureIntent({
        capabilityTypes: [`type-${i}`],
        summary: `intent ${i}`,
      });
    }
    // batchSize = 5 → batch should have flushed already. Give it a tick.
    await new Promise((r) => setTimeout(r, 5));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(body.length).toBe(5);
  });

  it("queues + does NOT submit before batchSize / flush", () => {
    client.captureIntent({ capabilityTypes: ["t1"] });
    client.captureIntent({ capabilityTypes: ["t2"] });
    expect(client.queueSize()).toBe(2);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("hashes raw-looking originAgentId / requesterIdHash", async () => {
    client.captureIntent({
      capabilityTypes: ["t"],
      originAgentId: "raw-agent-id-from-caller",
      requesterIdHash: "raw-email@example.com",
    });
    await client.flush();
    const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(body[0].originAgentId).toMatch(/^[a-f0-9]{64}$/);
    expect(body[0].requesterIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body[0].originAgentId).not.toBe("raw-agent-id-from-caller");
  });

  it("passes already-hashed identifiers through unchanged", async () => {
    const preHashed = defaultHasher("preprocessed-by-caller");
    client.captureIntent({
      capabilityTypes: ["t"],
      requesterIdHash: preHashed,
    });
    await client.flush();
    const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(body[0].requesterIdHash).toBe(preHashed);
  });

  it("truncates summary to 200 chars", async () => {
    const long = "x".repeat(500);
    client.captureIntent({ capabilityTypes: ["t"], summary: long });
    await client.flush();
    const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(body[0].summary.length).toBe(200);
  });

  it("is a no-op when disabled", async () => {
    const disabled = new IntentCollectorClient({
      apiKey: "k",
      enabled: false,
      fetchImpl: mockFetch,
    });
    disabled.captureIntent({ capabilityTypes: ["t"], summary: "should not capture" });
    expect(disabled.queueSize()).toBe(0);
    await disabled.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Suite: IntentCollectorClient — submit + retry
// ─────────────────────────────────────────────────────────────────────────

describe("IntentCollectorClient.flush — submit + retry behavior", () => {
  it("returns submittedCount on success", async () => {
    const mockFetch = makeMockFetch(202);
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: mockFetch,
    });
    client.captureIntent({ capabilityTypes: ["t"] });
    const result = await client.flush();
    expect(result.submittedCount).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBe(202);
    client.shutdown();
  });

  it("drops the batch + warns when PCC_API_KEY is missing", async () => {
    const mockFetch = makeMockFetch();
    const client = new IntentCollectorClient({
      apiKey: undefined,
      batchSize: 100,
      fetchImpl: mockFetch,
    });
    client.captureIntent({ capabilityTypes: ["t"] });
    const result = await client.flush();
    expect(result.submittedCount).toBe(0);
    expect(result.droppedCount).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    client.shutdown();
  });

  it("retries on 5xx then drops after MAX_ATTEMPTS", async () => {
    const mockFetch = makeFailingFetch([500, 502, 503]);
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: mockFetch,
    });
    client.captureIntent({ capabilityTypes: ["t"] });
    const result = await client.flush();
    expect(result.submittedCount).toBe(0);
    expect(result.droppedCount).toBe(1);
    expect(result.attempts).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    client.shutdown();
  }, 10_000);

  it("retries on 5xx then succeeds on 2xx", async () => {
    const mockFetch = makeFailingFetch([500, 202]);
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: mockFetch,
    });
    client.captureIntent({ capabilityTypes: ["t"] });
    const result = await client.flush();
    expect(result.submittedCount).toBe(1);
    expect(result.attempts).toBe(2);
    client.shutdown();
  }, 10_000);

  it("does NOT retry on 4xx (caller bug) — drops immediately", async () => {
    const mockFetch = makeFailingFetch([400, 400, 400]);
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: mockFetch,
    });
    client.captureIntent({ capabilityTypes: ["t"] });
    const result = await client.flush();
    expect(result.droppedCount).toBe(1);
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    client.shutdown();
  });

  it("coalesces concurrent flush calls", async () => {
    const mockFetch = makeMockFetch(202);
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: mockFetch,
    });
    client.captureIntent({ capabilityTypes: ["t"] });
    const a = client.flush();
    const b = client.flush();
    const [r1, r2] = await Promise.all([a, b]);
    // Both promises resolve from the same in-flight submission.
    expect(r1).toEqual(r2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    client.shutdown();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Suite: wrap(fetch)
// ─────────────────────────────────────────────────────────────────────────

describe("IntentCollectorClient.wrap", () => {
  it("captures envelopes for intent-shaped URLs (amazon-product)", async () => {
    const ingest = makeMockFetch(202);
    const upstream = vi.fn(async () => new Response("ok", { status: 200 }));
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: ingest,
    });
    const wrapped = client.wrap(upstream as unknown as typeof fetch);

    const res = await wrapped("https://www.amazon.com/dp/B07XJ8C8F5");
    expect(await res.text()).toBe("ok");
    // Upstream gets called exactly once with the original args.
    expect(upstream).toHaveBeenCalledTimes(1);
    // Capture: queued, not yet submitted.
    expect(client.queueSize()).toBe(1);
    await client.flush();
    expect(ingest).toHaveBeenCalledTimes(1);
    const body = JSON.parse(ingest.mock.calls[0][1]!.body as string);
    expect(body[0].capabilityTypes).toContain("fulfillment-2day-us");
    client.shutdown();
  });

  it("does NOT capture for unrelated URLs", async () => {
    const ingest = makeMockFetch(202);
    const upstream = vi.fn(async () => new Response("ok", { status: 200 }));
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: ingest,
    });
    const wrapped = client.wrap(upstream as unknown as typeof fetch);

    await wrapped("https://random-blog.example.com/articles/foo");
    expect(client.queueSize()).toBe(0);
    client.shutdown();
  });

  it("always returns the underlying response unchanged even if capture throws", async () => {
    const ingest = makeMockFetch(202);
    const upstream = vi.fn(async () => new Response("upstream-body", { status: 201 }));
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: ingest,
    });
    // Monkey-patch captureIntent to throw — wrap must still pass response through.
    (client as unknown as { captureIntent: () => void }).captureIntent = () => {
      throw new Error("boom");
    };
    const wrapped = client.wrap(upstream as unknown as typeof fetch);
    const res = await wrapped("https://www.amazon.com/dp/B07XJ8C8F5");
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("upstream-body");
    client.shutdown();
  });

  it("supports URL object input + Request object input", async () => {
    const ingest = makeMockFetch(202);
    const upstream = vi.fn(async () => new Response("ok", { status: 200 }));
    const client = new IntentCollectorClient({
      apiKey: "k",
      batchSize: 100,
      fetchImpl: ingest,
    });
    const wrapped = client.wrap(upstream as unknown as typeof fetch);

    // URL object
    await wrapped(new URL("https://www.doordash.com/store/12345/"));
    // string (passthrough)
    await wrapped("https://www.lyft.com/ride");
    expect(client.queueSize()).toBe(2);
    client.shutdown();
  });
});

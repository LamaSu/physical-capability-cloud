import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockBackend, CLIPBackend, normalize } from "../embedder.js";
import type { EmbedInput } from "../types.js";

// Test fixtures previously hardcoded the Spark LAN IP; we now route through
// example.com so tests stay deterministic without leaking private network
// topology. Override with TEST_CLIP_ENDPOINT for local end-to-end runs.
const CLIP_ENDPOINT =
  process.env.TEST_CLIP_ENDPOINT ?? "http://clip.example.com:8090/v1/embeddings";

// ── MockBackend ───────────────────────────────────────────────────────

describe("MockBackend", () => {
  const backend = new MockBackend(128);

  it("has the expected name and dimensions", () => {
    expect(backend.name).toBe("mock");
    expect(backend.dimensions).toBe(128);
  });

  it("produces embeddings of the correct dimension", async () => {
    const input: EmbedInput = { type: "text", data: "hello world" };
    const embedding = await backend.embed(input);
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(128);
  });

  it("produces deterministic embeddings for the same input", async () => {
    const input: EmbedInput = { type: "text", data: "deterministic test" };
    const a = await backend.embed(input);
    const b = await backend.embed(input);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces different embeddings for different inputs", async () => {
    const a = await backend.embed({ type: "text", data: "input A" });
    const b = await backend.embed({ type: "text", data: "input B" });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("produces different embeddings for different input types", async () => {
    const a = await backend.embed({ type: "text", data: "same" });
    const b = await backend.embed({ type: "image", data: "same" });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("handles Buffer inputs", async () => {
    const input: EmbedInput = {
      type: "image",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    };
    const embedding = await backend.embed(input);
    expect(embedding.length).toBe(128);
  });

  it("produces unit-length vectors", async () => {
    const input: EmbedInput = { type: "text", data: "unit length test" };
    const embedding = await backend.embed(input);

    let normSq = 0;
    for (let i = 0; i < embedding.length; i++) {
      normSq += embedding[i] * embedding[i];
    }
    // Should be approximately 1.0 (unit vector)
    expect(Math.abs(normSq - 1.0)).toBeLessThan(1e-5);
  });

  it("supports custom dimensions", async () => {
    const small = new MockBackend(32);
    const large = new MockBackend(512);
    const input: EmbedInput = { type: "text", data: "dimension test" };

    expect((await small.embed(input)).length).toBe(32);
    expect((await large.embed(input)).length).toBe(512);
  });
});

// ── CLIPBackend ───────────────────────────────────────────────────────

describe("CLIPBackend", () => {
  const originalFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it("has expected default dimensions (512)", () => {
    const clip = new CLIPBackend({ endpoint: "http://localhost:8080/embed" });
    expect(clip.dimensions).toBe(512);
    expect(clip.name).toBe("clip");
  });

  it("supports custom dimensions", () => {
    const clip = new CLIPBackend({
      endpoint: "http://localhost:8080/embed",
      dimensions: 768,
    });
    expect(clip.dimensions).toBe(768);
  });

  it("calls the embedding endpoint with correct headers and body", async () => {
    const mockEmbedding = Array.from({ length: 512 }, (_, i) => Math.sin(i));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: mockEmbedding }] }),
    });

    const clip = new CLIPBackend({
      endpoint: CLIP_ENDPOINT,
      apiKey: "test-key",
      model: "clip-vit-large",
    });
    const result = await clip.embed({ type: "text", data: "hello world" });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe(CLIP_ENDPOINT);
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(opts.body as string);
    expect(body.input).toBe("hello world");
    expect(body.model).toBe("clip-vit-large");
    expect(body.encoding_format).toBe("float");

    // Result should be a normalized Float32Array of correct dimensions
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(512);
    // Verify normalization (unit vector)
    let normSq = 0;
    for (let i = 0; i < result.length; i++) normSq += result[i] * result[i];
    expect(Math.abs(normSq - 1.0)).toBeLessThan(1e-5);
  });

  it("sends Buffer data as base64", async () => {
    const mockEmbedding = Array.from({ length: 512 }, () => 0.1);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: mockEmbedding }] }),
    });

    const clip = new CLIPBackend({
      endpoint: "http://localhost:8090/v1/embeddings",
    });
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await clip.embed({ type: "image", data: imageData });

    const body = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.input).toBe(imageData.toString("base64"));
  });

  it("does not send Authorization header when apiKey is absent", async () => {
    const mockEmbedding = Array.from({ length: 512 }, () => 0.1);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: mockEmbedding }] }),
    });

    const clip = new CLIPBackend({
      endpoint: "http://localhost:8090/v1/embeddings",
    });
    await clip.embed({ type: "text", data: "test" });

    const headers = ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("falls back to MockBackend when endpoint returns non-OK status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    const clip = new CLIPBackend({
      endpoint: "http://unreachable:8090/v1/embeddings",
      dimensions: 256,
    });
    const result = await clip.embed({ type: "text", data: "fallback test" });

    // Should NOT throw — graceful degradation
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(256);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("falling back to mock");

    // Verify it matches what MockBackend would produce
    const mock = new MockBackend(256);
    const mockResult = await mock.embed({ type: "text", data: "fallback test" });
    expect(Array.from(result)).toEqual(Array.from(mockResult));
  });

  it("falls back to MockBackend when fetch throws (network error)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const clip = new CLIPBackend({
      endpoint: CLIP_ENDPOINT,
      dimensions: 128,
    });
    const result = await clip.embed({ type: "text", data: "network error" });

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(128);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("ECONNREFUSED");
  });

  it("falls back when response has invalid structure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: "format" }),
    });

    const clip = new CLIPBackend({
      endpoint: "http://localhost:8090/v1/embeddings",
    });
    const result = await clip.embed({ type: "text", data: "bad response" });

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(512);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("missing data[0].embedding");
  });

  it("produces deterministic fallback for same input", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    const clip = new CLIPBackend({
      endpoint: "http://offline:8090/embed",
      dimensions: 64,
    });
    const a = await clip.embed({ type: "text", data: "deterministic" });
    const b = await clip.embed({ type: "text", data: "deterministic" });
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// ── normalize ─────────────────────────────────────────────────────────

describe("normalize", () => {
  it("normalizes a vector to unit length", () => {
    const vec = new Float32Array([3, 4]);
    normalize(vec);

    let normSq = 0;
    for (let i = 0; i < vec.length; i++) {
      normSq += vec[i] * vec[i];
    }
    expect(Math.abs(normSq - 1.0)).toBeLessThan(1e-5);
    expect(Math.abs(vec[0] - 0.6)).toBeLessThan(1e-5);
    expect(Math.abs(vec[1] - 0.8)).toBeLessThan(1e-5);
  });

  it("handles zero vectors without NaN", () => {
    const vec = new Float32Array([0, 0, 0]);
    normalize(vec);
    expect(vec[0]).toBe(0);
    expect(vec[1]).toBe(0);
    expect(vec[2]).toBe(0);
  });

  it("mutates in place and returns the same array", () => {
    const vec = new Float32Array([1, 0]);
    const result = normalize(vec);
    expect(result).toBe(vec);
  });
});

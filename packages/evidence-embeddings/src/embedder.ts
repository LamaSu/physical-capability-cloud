import { createHash } from "node:crypto";
import type { EmbeddingBackend, EmbedInput } from "./types.js";

// ── Mock Backend ──────────────────────────────────────────────────────

/**
 * A deterministic mock embedding backend for testing.
 *
 * Produces embeddings derived from the SHA-256 hash of the input,
 * so the same input always yields the same embedding. The vectors
 * are normalized to unit length for valid cosine similarity.
 */
export class MockBackend implements EmbeddingBackend {
  readonly name = "mock";
  readonly dimensions: number;

  constructor(dimensions: number = 128) {
    this.dimensions = dimensions;
  }

  async embed(input: EmbedInput): Promise<Float32Array> {
    // Hash the input to get deterministic bytes
    const hash = createHash("sha256");
    hash.update(input.type);
    if (typeof input.data === "string") {
      hash.update(input.data);
    } else {
      hash.update(input.data);
    }
    const digest = hash.digest();

    // Expand the 32-byte digest to fill the embedding dimensions
    // by cycling through the hash bytes and converting to floats
    const embedding = new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      // Map each byte to [-1, 1] range
      const byteVal = digest[i % digest.length];
      // XOR with position to add variation beyond the 32-byte cycle
      const mixed = byteVal ^ (i & 0xff);
      embedding[i] = (mixed / 127.5) - 1.0;
    }

    // L2-normalize to unit vector (required for cosine similarity)
    normalize(embedding);

    return embedding;
  }
}

// ── CLIP Backend ─────────────────────────────────────────────────────

/**
 * HTTP-based embedding backend that calls a remote embedding API.
 *
 * Supports any OpenAI-compatible /v1/embeddings endpoint, or a custom
 * endpoint returning `{ data: [{ embedding: number[] }] }`.
 *
 * Gracefully degrades to MockBackend when the endpoint is unreachable,
 * so the system never hard-fails due to embedding infrastructure being down.
 */
export class CLIPBackend implements EmbeddingBackend {
  readonly name = "clip";
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: {
    endpoint: string;
    dimensions?: number;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
  }) {
    this.endpoint = config.endpoint;
    this.dimensions = config.dimensions ?? 512;
    this.apiKey = config.apiKey;
    this.model = config.model ?? "clip";
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async embed(input: EmbedInput): Promise<Float32Array> {
    try {
      const body = this.buildRequestBody(input);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(
          `Embedding API returned ${response.status}: ${await response.text().catch(() => "unknown")}`,
        );
      }

      const result = await response.json();
      const rawEmbedding: number[] | undefined = result?.data?.[0]?.embedding;

      if (!rawEmbedding || !Array.isArray(rawEmbedding)) {
        throw new Error(
          "Embedding API response missing data[0].embedding array",
        );
      }

      const embedding = new Float32Array(rawEmbedding);
      normalize(embedding);
      return embedding;
    } catch (error) {
      // Graceful degradation: fall back to deterministic mock
      const reason =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `CLIPBackend: endpoint unreachable (${this.endpoint}), falling back to mock. Reason: ${reason}`,
      );
      const mock = new MockBackend(this.dimensions);
      return mock.embed(input);
    }
  }

  /** Build the JSON request body for the embedding API. */
  private buildRequestBody(input: EmbedInput): Record<string, unknown> {
    let inputPayload: string;
    if (typeof input.data === "string") {
      inputPayload = input.data;
    } else {
      // Binary data (Buffer) -- encode as base64
      inputPayload = Buffer.from(input.data).toString("base64");
    }

    return {
      input: inputPayload,
      model: this.model,
      encoding_format: "float",
    };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────

/** L2-normalize a vector in-place. Returns the same array. */
export function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

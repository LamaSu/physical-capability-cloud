/**
 * @pcc/tool-index — embedding providers
 *
 * Two implementations:
 *   1. OpenAIEmbeddingProvider   — text-embedding-3-small via OPENAI_API_KEY,
 *                                  1536-dim. For production retrieval quality.
 *   2. HashFallbackProvider      — deterministic sha256-derived pseudo-embedding,
 *                                  256-dim, unit-normalized. Lower quality but
 *                                  zero-dependency, fully offline. Used when
 *                                  OPENAI_API_KEY is absent, or whenever the
 *                                  active env selects PCC_EMBEDDING_PROVIDER=hash.
 *
 * Provider selection:
 *   - PCC_EMBEDDING_PROVIDER=openai → OpenAI (requires OPENAI_API_KEY)
 *   - PCC_EMBEDDING_PROVIDER=hash   → HashFallback
 *   - unset / anything else         → HashFallback (safe default)
 */

import { createHash } from "node:crypto";

export interface EmbeddingProvider {
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimensionality of the returned vectors. */
  dim: number;
  /** Provider name, useful for status reporting. */
  name: string;
}

// ── Hash fallback ─────────────────────────────────────────────────────────

const HASH_DIM = 256;

/**
 * Deterministic pseudo-embedding. We expand the sha256 of the input across
 * multiple counter rounds until we have enough bytes for HASH_DIM floats,
 * map each unsigned byte to [-1, 1], then L2-normalize.
 *
 * Properties:
 *   - Same input → same vector (deterministic, test-friendly).
 *   - Similar strings → unrelated vectors (NO semantic quality — this is
 *     a placeholder that lets the indexing pipeline + cosine math work
 *     without an external API).
 *   - Unit length, so cosine ≡ dot product.
 */
function hashEmbed(text: string): number[] {
  // Need HASH_DIM bytes (one byte per dim).
  const bytes = new Uint8Array(HASH_DIM);
  let written = 0;
  let counter = 0;
  while (written < HASH_DIM) {
    const h = createHash("sha256");
    h.update(text);
    h.update(String(counter));
    const digest = h.digest();
    const take = Math.min(digest.length, HASH_DIM - written);
    bytes.set(digest.subarray(0, take), written);
    written += take;
    counter++;
  }
  // Map bytes 0..255 → [-1, 1) and normalize.
  const v = new Array<number>(HASH_DIM);
  for (let i = 0; i < HASH_DIM; i++) {
    v[i] = bytes[i]! / 127.5 - 1;
  }
  let normSq = 0;
  for (let i = 0; i < HASH_DIM; i++) normSq += v[i]! * v[i]!;
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < HASH_DIM; i++) v[i] = v[i]! / norm;
  return v;
}

export class HashFallbackProvider implements EmbeddingProvider {
  readonly dim = HASH_DIM;
  readonly name = "hash-fallback-sha256-256";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(hashEmbed);
  }
}

// ── OpenAI embeddings ─────────────────────────────────────────────────────

const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_DIM = 1536;

/**
 * `text-embedding-3-small` adapter via the OpenAI REST API. Uses global
 * `fetch` (Node 20+); a fetch impl can be injected for testing.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dim = OPENAI_DIM;
  readonly name = `openai:${OPENAI_MODEL}`;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) {
      throw new Error("OpenAIEmbeddingProvider requires an apiKey");
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.fetchImpl(OPENAI_EMBEDDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: texts,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `OpenAI embeddings failed: ${res.status} ${res.statusText} ${detail}`,
      );
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(
        `OpenAI embeddings returned ${data.length} vectors for ${texts.length} inputs`,
      );
    }
    const vectors: number[][] = data.map((d, i) => {
      const e = d.embedding;
      if (!Array.isArray(e) || e.length !== OPENAI_DIM) {
        throw new Error(
          `OpenAI embedding index ${i} malformed (len=${e?.length ?? 0}, expected ${OPENAI_DIM})`,
        );
      }
      return e;
    });
    return vectors;
  }
}

// ── Selector ──────────────────────────────────────────────────────────────

/**
 * Pick a provider based on environment. Default is `HashFallbackProvider`
 * for safety (no external API call, works in CI / offline).
 *
 * Set PCC_EMBEDDING_PROVIDER=openai + OPENAI_API_KEY to use OpenAI.
 */
export function selectEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const wanted = (env.PCC_EMBEDDING_PROVIDER ?? "").toLowerCase().trim();
  if (wanted === "openai") {
    const key = env.OPENAI_API_KEY;
    if (!key) {
      // Fail open: silently fall back to hash. This is logged at the
      // call site (gateway boot) so operators know to set a key.
      return new HashFallbackProvider();
    }
    return new OpenAIEmbeddingProvider(key);
  }
  return new HashFallbackProvider();
}

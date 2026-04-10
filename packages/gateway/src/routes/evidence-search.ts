// @ts-nocheck
import type { FastifyInstance } from "fastify";
import {
  MockBackend,
  CLIPBackend,
  InMemoryEmbeddingStore,
  buildFeatureURI,
  isValidFeatureURI,
  type EmbeddingBackend,
  type EvidenceEmbedding,
  type SearchResult,
} from "@pcc/evidence-embeddings";

// ── Backend Factory ─────────────────────────────────────────────────
// Select embedding backend based on environment variables.
// When CLIP_ENDPOINT is set, use the real HTTP-based CLIPBackend;
// otherwise fall back to MockBackend for development/testing.

function createBackend(): EmbeddingBackend {
  const endpoint = process.env.CLIP_ENDPOINT;
  if (endpoint) {
    return new CLIPBackend({
      endpoint,
      dimensions: parseInt(process.env.CLIP_DIMENSIONS ?? "512", 10),
      apiKey: process.env.CLIP_API_KEY,
      model: process.env.CLIP_MODEL ?? "clip",
      timeoutMs: parseInt(process.env.CLIP_TIMEOUT_MS ?? "10000", 10),
    });
  }
  return new MockBackend(128);
}

// ── Singleton instances ──────────────────────────────────────────────
// In-memory for now; acceptable at current scale. A production upgrade
// would swap InMemoryEmbeddingStore for a SQLite-backed vector store.

const DEFAULT_FEATURE_URI = buildFeatureURI("clip", "v1", "embedding");
const embeddingBackend = createBackend();
const embeddingStore = new InMemoryEmbeddingStore();

// ── Helpers ──────────────────────────────────────────────────────────

/** Serialize an EvidenceEmbedding for JSON responses (Float32Array -> number[]) */
function serializeEmbedding(e: EvidenceEmbedding) {
  return {
    cid: e.cid,
    jobId: e.jobId,
    featureUri: e.featureUri,
    dimensions: e.embedding.length,
    metadata: e.metadata,
    createdAt: e.createdAt.toISOString(),
  };
}

// ── Routes ───────────────────────────────────────────────────────────

export async function evidenceSearchRoutes(app: FastifyInstance) {
  // ── POST /api/evidence/embed ─────────────────────────────────────
  // Embed a piece of evidence and store it.
  app.post<{
    Body: {
      cid: string;
      jobId: string;
      type: "image" | "video" | "text";
      data?: string;
      featureUri?: string;
    };
  }>("/api/evidence/embed", async (req, reply) => {
    const { cid, jobId, type, data, featureUri } = req.body ?? {};

    if (!cid || !jobId || !type) {
      return reply.code(400).send({
        error: "validation_error",
        message: "cid, jobId, and type are required",
      });
    }

    const validTypes = ["image", "video", "text"];
    if (!validTypes.includes(type)) {
      return reply.code(400).send({
        error: "validation_error",
        message: `type must be one of: ${validTypes.join(", ")}`,
      });
    }

    const resolvedFeatureUri = featureUri ?? DEFAULT_FEATURE_URI;
    if (!isValidFeatureURI(resolvedFeatureUri)) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Invalid featureUri: "${resolvedFeatureUri}". Expected format: pcc://{extractor}@{version}/{output}`,
      });
    }

    try {
      // Generate embedding from the input data (or CID as fallback input)
      const inputData = data ?? cid;
      const embedding = await embeddingBackend.embed({
        type: type as "image" | "video" | "text",
        data: inputData,
      });

      const record: EvidenceEmbedding = {
        cid,
        jobId,
        featureUri: resolvedFeatureUri,
        embedding,
        metadata: { type, ...(data ? { hasData: true } : {}) },
        createdAt: new Date(),
      };

      await embeddingStore.store(record);

      return {
        id: `${cid}:${resolvedFeatureUri}`,
        featureUri: resolvedFeatureUri,
        dimensions: embedding.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Embedding failed";
      return reply.code(500).send({ error: "embed_failed", message });
    }
  });

  // ── POST /api/evidence/search ────────────────────────────────────
  // Semantic search across stored evidence.
  app.post<{
    Body: {
      query: {
        cid?: string;
        text?: string;
        embedding?: number[];
      };
      topK?: number;
      threshold?: number;
      jobId?: string;
      featureUri?: string;
    };
  }>("/api/evidence/search", async (req, reply) => {
    const { query, topK, threshold, jobId, featureUri } = req.body ?? {};

    if (!query) {
      return reply.code(400).send({
        error: "validation_error",
        message: "query is required",
      });
    }

    if (!query.cid && !query.text && !query.embedding) {
      return reply.code(400).send({
        error: "validation_error",
        message: "query must include at least one of: cid, text, or embedding",
      });
    }

    try {
      let queryEmbedding: Float32Array;

      if (query.embedding) {
        // Raw embedding vector provided directly
        queryEmbedding = new Float32Array(query.embedding);
      } else if (query.cid) {
        // Find the embedding for this CID and use it as the query
        const existing = await embeddingStore.getByCid(query.cid);
        if (existing.length === 0) {
          return reply.code(404).send({
            error: "not_found",
            message: `No embedding found for CID: ${query.cid}`,
          });
        }
        queryEmbedding = existing[0].embedding;
      } else {
        // Text query: embed the text first
        queryEmbedding = await embeddingBackend.embed({
          type: "text",
          data: query.text!,
        });
      }

      const results: SearchResult[] = await embeddingStore.search(queryEmbedding, {
        topK: topK ?? 10,
        threshold,
        jobId,
        featureUri,
      });

      return { results, total: results.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed";
      return reply.code(500).send({ error: "search_failed", message });
    }
  });

  // ── GET /api/evidence/job/:jobId ─────────────────────────────────
  // Get all evidence embeddings for a job.
  app.get<{ Params: { jobId: string } }>(
    "/api/evidence/job/:jobId",
    async (req) => {
      const embeddings = await embeddingStore.getByJob(req.params.jobId);
      return {
        embeddings: embeddings.map(serializeEmbedding),
        count: embeddings.length,
      };
    },
  );

  // ── GET /api/evidence/cid/:cid ──────────────────────────────────
  // Get all embeddings for a specific CID.
  app.get<{ Params: { cid: string } }>(
    "/api/evidence/cid/:cid",
    async (req) => {
      const embeddings = await embeddingStore.getByCid(req.params.cid);
      return {
        embeddings: embeddings.map(serializeEmbedding),
        count: embeddings.length,
      };
    },
  );
}

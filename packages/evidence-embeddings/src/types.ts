import { z } from "zod";

// ── Feature URI ───────────────────────────────────────────────────────

/** Parsed components of a PCC feature URI */
export interface FeatureURI {
  protocol: "pcc";
  extractor: string; // clip, phash, whisper, vlm
  version: string; // v1, v2
  output: string; // embedding, similarity, transcript, description
}

export const FeatureURISchema = z.object({
  protocol: z.literal("pcc"),
  extractor: z.string().min(1),
  version: z.string().regex(/^v\d+$/),
  output: z.string().min(1),
});

// ── Embedding Input ───────────────────────────────────────────────────

/** Input to an embedding backend */
export interface EmbedInput {
  type: "image" | "video" | "text" | "audio";
  data: Buffer | string; // Buffer for binary, string for text/URL
}

export const EmbedInputSchema = z.object({
  type: z.enum(["image", "video", "text", "audio"]),
  data: z.union([z.instanceof(Buffer), z.string()]),
});

// ── Embedding Backend ─────────────────────────────────────────────────

/** Pluggable embedding backend interface */
export interface EmbeddingBackend {
  /** Human-readable name (e.g. "clip", "mock") */
  name: string;
  /** Dimensionality of output embeddings */
  dimensions: number;
  /** Generate an embedding vector from input */
  embed(input: EmbedInput): Promise<Float32Array>;
}

// ── Stored Embedding ──────────────────────────────────────────────────

/** An embedding stored alongside its Storacha CID */
export interface EvidenceEmbedding {
  /** Storacha CID of the evidence file */
  cid: string;
  /** PCC job ID this evidence belongs to */
  jobId: string;
  /** Feature URI describing how this embedding was produced */
  featureUri: string;
  /** The embedding vector */
  embedding: Float32Array;
  /** Arbitrary metadata (e.g. original filename, mime type) */
  metadata: Record<string, unknown>;
  /** When this embedding was created */
  createdAt: Date;
}

export const EvidenceEmbeddingSchema = z.object({
  cid: z.string().min(1),
  jobId: z.string().min(1),
  featureUri: z.string().min(1),
  embedding: z.instanceof(Float32Array),
  metadata: z.record(z.unknown()),
  createdAt: z.date(),
});

// ── Search ────────────────────────────────────────────────────────────

/** Options for semantic search queries */
export interface SearchOptions {
  /** Maximum number of results to return */
  topK: number;
  /** Minimum cosine similarity threshold (0-1). Results below this are excluded. */
  threshold?: number;
  /** Filter results to a specific feature URI */
  featureUri?: string;
  /** Filter results to a specific job */
  jobId?: string;
}

export const SearchOptionsSchema = z.object({
  topK: z.number().int().positive(),
  threshold: z.number().min(-1).max(1).optional(),
  featureUri: z.string().optional(),
  jobId: z.string().optional(),
});

/** A single search result with similarity score */
export interface SearchResult {
  /** Storacha CID of the matching evidence */
  cid: string;
  /** PCC job ID */
  jobId: string;
  /** Cosine similarity score (-1 to 1, higher is more similar) */
  score: number;
  /** Feature URI of the matched embedding */
  featureUri: string;
  /** Metadata associated with the embedding */
  metadata: Record<string, unknown>;
}

// ── Embedding Store ───────────────────────────────────────────────────

/** Storage interface for evidence embeddings */
export interface EmbeddingStore {
  /** Store a new embedding */
  store(embedding: EvidenceEmbedding): Promise<void>;
  /** Semantic search: find the most similar embeddings to a query vector */
  search(query: Float32Array, options: SearchOptions): Promise<SearchResult[]>;
  /** Get all embeddings for a job */
  getByJob(jobId: string): Promise<EvidenceEmbedding[]>;
  /** Get all embeddings for a CID */
  getByCid(cid: string): Promise<EvidenceEmbedding[]>;
}

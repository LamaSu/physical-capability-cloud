/**
 * @pcc/evidence-embeddings
 *
 * Multimodal evidence embedding module for the Physical Capability Cloud.
 * Enables semantic search across job evidence (photos, videos, documents)
 * stored via Storacha (IPFS/Filecoin).
 *
 * @example
 * ```ts
 * import {
 *   MockBackend,
 *   InMemoryEmbeddingStore,
 *   buildFeatureURI,
 *   cosineSimilarity,
 * } from "@pcc/evidence-embeddings";
 *
 * const backend = new MockBackend(128);
 * const store = new InMemoryEmbeddingStore();
 *
 * const embedding = await backend.embed({ type: "image", data: imageBuffer });
 * await store.store({
 *   cid: "bafy...",
 *   jobId: "job_123",
 *   featureUri: buildFeatureURI("clip", "v1", "embedding"),
 *   embedding,
 *   metadata: { filename: "photo.jpg" },
 *   createdAt: new Date(),
 * });
 *
 * const results = await store.search(queryEmbedding, { topK: 5 });
 * ```
 */

// Types
export type {
  FeatureURI,
  EmbedInput,
  EmbeddingBackend,
  EvidenceEmbedding,
  SearchOptions,
  SearchResult,
  EmbeddingStore,
} from "./types.js";

// Zod schemas
export {
  FeatureURISchema,
  EmbedInputSchema,
  EvidenceEmbeddingSchema,
  SearchOptionsSchema,
} from "./types.js";

// Feature URI
export {
  parseFeatureURI,
  buildFeatureURI,
  isValidFeatureURI,
  KNOWN_FEATURE_URIS,
} from "./feature-uri.js";

// Embedder backends
export { MockBackend, CLIPBackend, normalize } from "./embedder.js";

// Search
export { cosineSimilarity } from "./search.js";

// Store
export { InMemoryEmbeddingStore } from "./store.js";

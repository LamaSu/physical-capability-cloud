import { cosineSimilarity } from "./search.js";
import type {
  EvidenceEmbedding,
  EmbeddingStore,
  SearchOptions,
  SearchResult,
} from "./types.js";

/**
 * In-memory embedding store with brute-force cosine similarity search.
 *
 * For PCC's scale (thousands of evidence items), this is more than adequate.
 * A production upgrade path would be to back this with SQLite + a vector
 * extension, or a purpose-built vector index, without changing the interface.
 */
export class InMemoryEmbeddingStore implements EmbeddingStore {
  private readonly embeddings: EvidenceEmbedding[] = [];

  async store(embedding: EvidenceEmbedding): Promise<void> {
    this.embeddings.push(embedding);
  }

  async search(
    query: Float32Array,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    const { topK, threshold, featureUri, jobId } = options;

    // Score all embeddings against the query
    const scored: SearchResult[] = [];

    for (const entry of this.embeddings) {
      // Apply filters
      if (featureUri && entry.featureUri !== featureUri) continue;
      if (jobId && entry.jobId !== jobId) continue;

      // Dimensionality must match
      if (entry.embedding.length !== query.length) continue;

      const score = cosineSimilarity(query, entry.embedding);

      // Apply threshold
      if (threshold !== undefined && score < threshold) continue;

      scored.push({
        cid: entry.cid,
        jobId: entry.jobId,
        score,
        featureUri: entry.featureUri,
        metadata: entry.metadata,
      });
    }

    // Sort by score descending, take topK
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async getByJob(jobId: string): Promise<EvidenceEmbedding[]> {
    return this.embeddings.filter((e) => e.jobId === jobId);
  }

  async getByCid(cid: string): Promise<EvidenceEmbedding[]> {
    return this.embeddings.filter((e) => e.cid === cid);
  }

  /** Number of embeddings stored (useful for tests) */
  get size(): number {
    return this.embeddings.length;
  }

  /** Clear all stored embeddings (useful for tests) */
  clear(): void {
    this.embeddings.length = 0;
  }
}

/**
 * @pcc/tool-index — in-memory ToolIndex
 *
 * Phase 1 storage layer: in-memory linear-scan cosine search. Fine at
 * N≤10,000 tools (the 218-tool PCC catalog is two orders of magnitude
 * below that). Phase 3+ can swap in HNSW / disk-backed storage.
 *
 * Lifecycle:
 *   const idx = new ToolIndex(selectEmbeddingProvider());
 *   idx.add(loadAgentPackage(path));
 *   const hits = await idx.search("how do I list jobs", 5);
 *
 * Embeddings are computed lazily on first search, then memoized on the
 * IndexedTool itself. Re-adding a tool with the same id replaces it
 * (and clears its embedding).
 */

import type { EmbeddingProvider } from "./embeddings.js";
import type { IndexedTool, ToolSearchHit, ToolSource } from "./types.js";

/** Default number of search hits to return. */
const DEFAULT_TOP_K = 10;

/** Cosine similarity between two equal-length numeric vectors. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch: ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Compose the document text we embed for a tool. Includes name, description,
 * tags, and capability hints — the surface most likely to match a user query.
 * Schema is omitted (JSON schema noise hurts retrieval quality more than it
 * helps).
 */
function toolText(tool: IndexedTool): string {
  const parts = [tool.name, tool.description];
  if (tool.tags && tool.tags.length > 0) {
    parts.push(`tags: ${tool.tags.join(", ")}`);
  }
  if (tool.capabilities && tool.capabilities.length > 0) {
    parts.push(`capabilities: ${tool.capabilities.join(", ")}`);
  }
  if (tool.endpoint) {
    parts.push(`endpoint: ${tool.endpoint.method} ${tool.endpoint.path}`);
  }
  return parts.join("\n");
}

export interface SearchOptions {
  topK?: number;
  /** If set, only consider tools whose `source` matches. */
  source?: ToolSource;
  /** If set, only consider tools whose `sourceId` matches. */
  sourceId?: string;
}

export class ToolIndex {
  private readonly tools = new Map<string, IndexedTool>();

  constructor(private readonly provider: EmbeddingProvider) {}

  /** Number of tools currently indexed. */
  size(): number {
    return this.tools.size;
  }

  /** Active embedding provider's dim. */
  get dim(): number {
    return this.provider.dim;
  }

  /** Active embedding provider's name. */
  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Add or replace tools. If an existing tool's embedding has the wrong
   * dimensionality (e.g. provider changed), it's dropped so it gets
   * re-embedded on next search.
   */
  add(tools: IndexedTool[]): void {
    for (const t of tools) {
      const copy: IndexedTool = { ...t };
      if (copy.embedding && copy.embedding.length !== this.provider.dim) {
        delete copy.embedding;
      }
      this.tools.set(copy.id, copy);
    }
  }

  /** Remove a tool by id. Returns true if it was present. */
  remove(id: string): boolean {
    return this.tools.delete(id);
  }

  /** Replace the entire index with a new set of tools. */
  reset(tools: IndexedTool[] = []): void {
    this.tools.clear();
    if (tools.length > 0) this.add(tools);
  }

  /** Iterate over all tools (in insertion order). */
  *all(): IterableIterator<IndexedTool> {
    yield* this.tools.values();
  }

  /** Lookup a tool by id. */
  get(id: string): IndexedTool | undefined {
    return this.tools.get(id);
  }

  /**
   * Search for tools matching a natural-language query. Returns the top-K
   * hits ranked by cosine similarity. Lazy-embeds any tool that hasn't
   * been embedded yet (batched, single fetch).
   */
  async search(
    query: string,
    topKOrOpts: number | SearchOptions = DEFAULT_TOP_K,
  ): Promise<ToolSearchHit[]> {
    const opts: SearchOptions =
      typeof topKOrOpts === "number" ? { topK: topKOrOpts } : topKOrOpts;
    const topK = Math.max(1, opts.topK ?? DEFAULT_TOP_K);

    // Filter candidates upfront.
    const candidates: IndexedTool[] = [];
    for (const t of this.tools.values()) {
      if (opts.source && t.source !== opts.source) continue;
      if (opts.sourceId && t.sourceId !== opts.sourceId) continue;
      candidates.push(t);
    }
    if (candidates.length === 0) return [];

    // Lazy-embed any candidates that don't have an embedding yet.
    const needEmbedding = candidates.filter((t) => !t.embedding);
    if (needEmbedding.length > 0) {
      const texts = needEmbedding.map(toolText);
      const vectors = await this.provider.embed(texts);
      for (let i = 0; i < needEmbedding.length; i++) {
        needEmbedding[i]!.embedding = vectors[i];
      }
    }

    // Embed the query.
    const [queryVec] = await this.provider.embed([query]);
    if (!queryVec) return [];

    // Score every candidate.
    const hits: ToolSearchHit[] = candidates.map((t) => ({
      tool: t,
      score: cosine(queryVec, t.embedding!),
    }));
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}

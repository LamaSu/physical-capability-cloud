/**
 * In-memory inverted index for BM25 candidate retrieval.
 *
 * Maps each tokenized term to the set of toolIds that contain it, plus a
 * per-doc termFreq table so BM25 scoring is O(|query terms|) per doc rather
 * than O(|doc length|).
 *
 * Memory at PCC's expected ~50K-tool ceiling: ~50MB worst case (English
 * description vocabulary ~30K terms × posting lists ~10K toolIds avg).
 * Phase 2.5 swaps to better-sqlite3 FTS5 if memory matters; the wire-format
 * here is identical (same DocStats/CorpusStats consumers).
 */

import { tokenize, type CorpusStats, type DocStats } from "./bm25.js";

/**
 * One posting-list entry: which doc + its term-frequency. We keep a small
 * Map<toolId, freq> per term (Map outperforms object for these key shapes).
 */
type PostingList = Map<string, number>;

/**
 * Searchable text composer. Concatenates description + skill labels + domain
 * labels + features + name → the BM25 document. Mirrors the `searchableText`
 * field described in the scope doc §6.1 — kept inline (rather than denormed
 * onto IndexedTool) so the inverted index stays the single source of truth.
 *
 * Exported for use by callers that want to feed the same text into other
 * retrievers (e.g. the embedding pipeline).
 */
export function searchableTextOf(input: {
  name?: string;
  description?: string;
  skills?: string[];
  domains?: string[];
  features?: string[];
  tags?: string[];
}): string {
  const parts: string[] = [];
  if (input.name) parts.push(input.name);
  if (input.description) parts.push(input.description);
  if (input.skills && input.skills.length > 0) parts.push(input.skills.join(" "));
  if (input.domains && input.domains.length > 0) parts.push(input.domains.join(" "));
  if (input.features && input.features.length > 0) parts.push(input.features.join(" "));
  if (input.tags && input.tags.length > 0) parts.push(input.tags.join(" "));
  return parts.join(" ");
}

export class InvertedIndex {
  /** Map<term, Map<toolId, termFreq>>. */
  private readonly postings = new Map<string, PostingList>();
  /** Map<toolId, DocStats> — used at scoring time. */
  private readonly docStats = new Map<string, DocStats>();
  /** Total tokens across all docs (for avg length calc). */
  private totalTokens = 0;

  /** Number of documents currently indexed. */
  size(): number {
    return this.docStats.size;
  }

  /** Add or replace a document. */
  upsert(toolId: string, text: string): void {
    // Remove old entry if present so postings stay clean.
    this.remove(toolId);
    const terms = tokenize(text);
    if (terms.length === 0) {
      // Still record an empty doc — caller may set text later.
      this.docStats.set(toolId, { length: 0, termFreq: new Map() });
      return;
    }
    const tf = new Map<string, number>();
    for (const t of terms) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    this.docStats.set(toolId, { length: terms.length, termFreq: tf });
    this.totalTokens += terms.length;
    for (const [term, count] of tf.entries()) {
      let list = this.postings.get(term);
      if (!list) {
        list = new Map();
        this.postings.set(term, list);
      }
      list.set(toolId, count);
    }
  }

  /** Remove a document. Returns true if it was present. */
  remove(toolId: string): boolean {
    const stats = this.docStats.get(toolId);
    if (!stats) return false;
    this.totalTokens -= stats.length;
    for (const term of stats.termFreq.keys()) {
      const list = this.postings.get(term);
      if (list) {
        list.delete(toolId);
        if (list.size === 0) this.postings.delete(term);
      }
    }
    this.docStats.delete(toolId);
    return true;
  }

  /** Replace the entire index. */
  reset(): void {
    this.postings.clear();
    this.docStats.clear();
    this.totalTokens = 0;
  }

  /**
   * Return the set of toolIds matching ANY of the query terms (disjunctive).
   * The phase-1 retriever scores only this subset, not the full corpus.
   */
  candidatesFor(queryTerms: string[]): Set<string> {
    const out = new Set<string>();
    for (const term of queryTerms) {
      const list = this.postings.get(term);
      if (!list) continue;
      for (const toolId of list.keys()) out.add(toolId);
    }
    return out;
  }

  /** Get DocStats for one tool (for scoring). */
  docStatsOf(toolId: string): DocStats | undefined {
    return this.docStats.get(toolId);
  }

  /** Build a CorpusStats snapshot from the current index state. */
  corpusStats(): CorpusStats {
    const docFreq = new Map<string, number>();
    for (const [term, postings] of this.postings.entries()) {
      docFreq.set(term, postings.size);
    }
    const totalDocs = this.docStats.size;
    const avgDocLength = totalDocs > 0 ? this.totalTokens / totalDocs : 0;
    return { totalDocs, avgDocLength, docFreq };
  }
}

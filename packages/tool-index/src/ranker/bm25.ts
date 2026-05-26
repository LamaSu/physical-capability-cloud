/**
 * BM25 scorer for the HybridRanker phase-1 lexical retriever.
 *
 * Implements canonical Okapi BM25 (the formula Vespa, Lucene, Elasticsearch,
 * and OpenSearch use by default). No external dep — 80 LOC, easy to test.
 *
 * Formula (per docs.vespa.ai/en/reference/bm25.html):
 *
 *   score = Σ over query-terms q_i:
 *      IDF(q_i) × tf × (k1 + 1)
 *      -------------------------------------------------
 *      tf + k1 × (1 - b + b × dl/avgdl)
 *
 * where:
 *   - IDF(q_i) = log(1 + (N - n(q_i) + 0.5) / (n(q_i) + 0.5))
 *   - tf       = term frequency of q_i in document
 *   - dl       = document length (in terms)
 *   - avgdl    = mean document length across the corpus
 *   - k1       = 1.2 (Vespa / Lucene default)
 *   - b        = 0.75 (Vespa / Lucene default)
 *
 * k1 and b are configurable via PCC_RANK_BM25_K1 / PCC_RANK_BM25_B env
 * vars but default to the canonical values.
 *
 * Tokenization is delegated to the caller — we operate on already-tokenized
 * term arrays (see tokenize() helper here for the standard tokenizer used
 * by the InvertedIndex).
 */

/** Standard BM25 k1 default (Vespa, Lucene, Elasticsearch). */
export const BM25_K1_DEFAULT = 1.2;
/** Standard BM25 b default. */
export const BM25_B_DEFAULT = 0.75;

/** Read BM25 k1 from env or fall back to canonical 1.2. */
export function bm25K1(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PCC_RANK_BM25_K1;
  if (!raw) return BM25_K1_DEFAULT;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : BM25_K1_DEFAULT;
}

/** Read BM25 b from env or fall back to canonical 0.75. */
export function bm25B(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PCC_RANK_BM25_B;
  if (!raw) return BM25_B_DEFAULT;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : BM25_B_DEFAULT;
}

/** Per-document statistics the BM25 scorer needs. */
export interface DocStats {
  /** Document length in terms (after tokenization). */
  length: number;
  /** Map of term → frequency in this document. */
  termFreq: Map<string, number>;
}

/** Corpus-wide statistics. */
export interface CorpusStats {
  /** Total number of documents in the corpus. */
  totalDocs: number;
  /** Mean document length across the corpus. */
  avgDocLength: number;
  /** Map of term → number of docs containing that term (document frequency). */
  docFreq: Map<string, number>;
}

/**
 * Compute IDF for one term per Okapi BM25.
 *
 * Uses the +1 inside the log to keep IDF strictly positive even when a term
 * appears in >half the corpus (so it doesn't go negative and flip the score).
 */
export function idf(term: string, corpus: CorpusStats): number {
  const df = corpus.docFreq.get(term) ?? 0;
  return Math.log(1 + (corpus.totalDocs - df + 0.5) / (df + 0.5));
}

/**
 * Score one document against one query, given pre-tokenized query terms.
 *
 * Returns a non-negative number. Raw BM25 scores are unbounded — RRF
 * uses RANK not raw score, so the absolute magnitude does not matter to
 * the fusion step. Useful for debugging / explain only.
 */
export function bm25Score(
  queryTerms: string[],
  doc: DocStats,
  corpus: CorpusStats,
  options: { k1?: number; b?: number } = {},
): number {
  if (queryTerms.length === 0 || doc.length === 0) return 0;
  const k1 = options.k1 ?? bm25K1();
  const b = options.b ?? bm25B();
  const lenRatio = corpus.avgDocLength > 0 ? doc.length / corpus.avgDocLength : 1;
  let total = 0;
  for (const term of queryTerms) {
    const tf = doc.termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * lenRatio);
    total += idf(term, corpus) * (numerator / denominator);
  }
  return total;
}

/**
 * Standard tokenizer used by the inverted-index — lowercase, split on
 * non-word characters, drop empties. Matches what most search libraries
 * do at ingest. Intentionally simple; PCC's tool descriptions are short
 * and don't need stemming.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length > 0);
}

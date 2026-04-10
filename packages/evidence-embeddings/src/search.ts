/**
 * Cosine similarity and search utilities for evidence embeddings.
 *
 * At PCC's scale (thousands of embeddings, not billions), a brute-force
 * flat scan with Float32Array is perfectly adequate and avoids external
 * vector DB dependencies.
 */

/**
 * Compute cosine similarity between two vectors.
 *
 * Both vectors must have the same length. Returns a value in [-1, 1].
 * Assumes vectors are already L2-normalized (returns dot product).
 * If vectors are not normalized, computes the full cosine formula.
 *
 * @throws if vectors have different lengths or are empty
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch: ${a.length} vs ${b.length}. Both must have the same dimensionality.`,
    );
  }
  if (a.length === 0) {
    throw new Error("Cannot compute cosine similarity of empty vectors.");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0; // zero vector has no direction
  }

  return dot / denom;
}

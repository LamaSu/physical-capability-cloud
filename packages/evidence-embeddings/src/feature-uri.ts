import type { FeatureURI } from "./types.js";

/**
 * Feature URI addressing system for PCC evidence features.
 *
 * Format: pcc://{extractor}@{version}/{output}
 *
 * Examples:
 *   pcc://clip@v1/embedding
 *   pcc://phash@v1/similarity
 *   pcc://whisper@v1/transcript
 *   pcc://vlm@v1/description
 */

const FEATURE_URI_REGEX = /^pcc:\/\/([a-z0-9_-]+)@(v\d+)\/([a-z0-9_-]+)$/;

/**
 * Parse a feature URI string into its components.
 * Throws if the URI is malformed.
 */
export function parseFeatureURI(uri: string): FeatureURI {
  const match = uri.match(FEATURE_URI_REGEX);
  if (!match) {
    throw new Error(
      `Invalid feature URI: "${uri}". Expected format: pcc://{extractor}@{version}/{output} (e.g. pcc://clip@v1/embedding)`,
    );
  }

  return {
    protocol: "pcc",
    extractor: match[1],
    version: match[2],
    output: match[3],
  };
}

/**
 * Build a feature URI string from components.
 * Validates inputs before constructing.
 */
export function buildFeatureURI(
  extractor: string,
  version: string,
  output: string,
): string {
  if (!extractor || !/^[a-z0-9_-]+$/.test(extractor)) {
    throw new Error(
      `Invalid extractor name: "${extractor}". Must be lowercase alphanumeric with hyphens/underscores.`,
    );
  }
  if (!version || !/^v\d+$/.test(version)) {
    throw new Error(
      `Invalid version: "${version}". Must match format vN (e.g. v1, v2).`,
    );
  }
  if (!output || !/^[a-z0-9_-]+$/.test(output)) {
    throw new Error(
      `Invalid output name: "${output}". Must be lowercase alphanumeric with hyphens/underscores.`,
    );
  }

  return `pcc://${extractor}@${version}/${output}`;
}

/**
 * Check whether a string is a valid feature URI without throwing.
 */
export function isValidFeatureURI(uri: string): boolean {
  return FEATURE_URI_REGEX.test(uri);
}

/**
 * Well-known feature URIs used across PCC.
 */
export const KNOWN_FEATURE_URIS = {
  /** CLIP image/text embedding (512d or 768d depending on model) */
  CLIP_V1_EMBEDDING: "pcc://clip@v1/embedding",
  /** Perceptual hash for photo similarity */
  PHASH_V1_SIMILARITY: "pcc://phash@v1/similarity",
  /** Whisper audio transcript */
  WHISPER_V1_TRANSCRIPT: "pcc://whisper@v1/transcript",
  /** VLM scene description */
  VLM_V1_DESCRIPTION: "pcc://vlm@v1/description",
} as const;

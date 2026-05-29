/**
 * Shared barrel — re-exports types, canonical-json, and hash primitives.
 */
export * from './types.js';
export { canonicalJSON, canonicalJSONStrict, parseCanonical } from './canonical-json.js';
export type { JsonLike } from './canonical-json.js';
export { sha256Hex, sha256OfCanonical, keccak256Hex, ZERO_HASH } from './hash.js';

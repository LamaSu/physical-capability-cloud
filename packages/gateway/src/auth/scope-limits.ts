/**
 * The ONE set of limits a stored scope column must satisfy (WP-A rounds 5 and 8).
 *
 * The parser (middleware/scope-checker.ts parseScopeColumn) refuses anything
 * outside them. Minting (auth/api-key-auth.ts assertMintableScopes) refuses to
 * create a key the parser would then read as holding nothing. Both measure the
 * serialized column in UTF-8 BYTES:
 *   - astra, failclosed r2 FC-7: the parser counted UTF-16 code units, so short
 *     Unicode scopes fit in characters but not in bytes;
 *   - astra, authz r2 new defect 2: minting checked count and entry length but
 *     not the total size, so "settlement" plus 63 distinct 64-character scopes
 *     (4,235 bytes) could be minted and then parsed as no scopes.
 */
export const MAX_SCOPE_COLUMN_BYTES = 4096;
export const MAX_SCOPES = 64;
export const MAX_SCOPE_CHARS = 64;

/** True when a serialized scope column is non-empty and at most MAX_SCOPE_COLUMN_BYTES of UTF-8. */
export function scopeColumnFits(serialized: string): boolean {
  if (serialized.length === 0) return false;
  // UTF-8 bytes >= UTF-16 code units, so this is a cheap, exact refusal of long input.
  if (serialized.length > MAX_SCOPE_COLUMN_BYTES) return false;
  return Buffer.byteLength(serialized, "utf8") <= MAX_SCOPE_COLUMN_BYTES;
}

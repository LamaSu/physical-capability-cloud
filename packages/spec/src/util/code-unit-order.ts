/**
 * The one sort order for anything a content hash commits to.
 *
 * Strings compare by UTF-16 code unit, which is the order `canonicalize` gives
 * object keys (`Object.keys(...).sort()`). `String.prototype.localeCompare`
 * must never order hashed content. It uses ICU collation, which puts `_`
 * before `-`, `:` and `.`, puts `_` before digits, and compares case-
 * insensitively first. A non-JS publisher or verifier (Python, Go, Solidity),
 * or the next ICU release, would then compute a different hash for the same
 * content (oracle #3348 / #3350).
 *
 * A mirror in another language must sort by UTF-16 code units. For ASCII
 * strings that is byte order, which is also Python's default `sorted`. Beyond
 * the BMP, Python sorts by code point, so a Python mirror sorts with
 * `key=lambda s: s.encode("utf-16-be")`.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

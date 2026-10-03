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
 * ASCII it is neither UTF-8 byte order nor code-point order: U+10000 sorts
 * before U+E000. A Python mirror sorts with
 * `key=lambda s: s.encode("utf-16-be", "surrogatepass")`; without
 * "surrogatepass" a lone surrogate (legal in a JavaScript string or a JSON
 * escape) raises UnicodeEncodeError. The codeUnitOrder vector in
 * code-unit-order.vectors.json pins this order.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

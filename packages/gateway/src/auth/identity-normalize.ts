/**
 * One identity comparison for the whole gateway (WP-A round 5; astra #2829 and
 * #2883; round 8).
 *
 * normalizeIdentity: Unicode NFKC, trimmed, then Unicode FULL case folding
 * (CaseFolding.txt statuses C + F), then NFKC again. Compatibility forms
 * ("ｖｉｃｔｉｍ＠ｘ．ｔｅｓｔ"), composed and decomposed accents, case (ß and ẞ fold
 * to "ss", final sigma to sigma) and surrounding space all name the SAME identity.
 * Identity binding (auth/reserved-identities.ts, and its pcc_norm SQL function)
 * and every owner comparison use it on BOTH sides, so the two can never fold
 * differently. It lives in its own module so stores can use it without an
 * import cycle.
 *
 * Round 8 (astra, authz r2): the fold used to be lower -> upper -> lower. That is
 * NOT case folding: it turned dotless "ı" into "i", so "alıce@…" and "alice@…"
 * were one identity, and a key holder for one could pass the other's owner checks.
 * caseFold is now the real fold. For every code point it equals Python's
 * str.casefold() (see scripts/gen-casefold-table.py and casefold.test.ts).
 */
import { CASEFOLD_BEYOND_LOWER } from "./casefold-table.js";

/**
 * Unicode full case folding: the default lowercase mapping (toLowerCase), then
 * the few folds that go beyond lowercase (auth/casefold-table.ts, generated).
 */
export function caseFold(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) out += CASEFOLD_BEYOND_LOWER.get(ch) ?? ch;
  return out;
}

export function normalizeIdentity(id: unknown): string {
  return caseFold(String(id ?? "").normalize("NFKC").trim()).normalize("NFKC");
}

/** Same identity after normalizeIdentity. Never true for an empty id, so a missing owner matches nobody. */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeIdentity(a);
  return x.length > 0 && x === normalizeIdentity(b);
}

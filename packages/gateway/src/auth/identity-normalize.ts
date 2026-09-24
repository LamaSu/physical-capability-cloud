/**
 * One identity comparison for the whole gateway (WP-A round 5; astra #2829 and
 * #2883).
 *
 * normalizeIdentity: Unicode NFKC, trimmed, then case-folded. The fold is
 * lower -> upper -> lower, so "ß" and "ẞ" become "ss" and final sigma folds like
 * sigma. So compatibility forms ("ｖｉｃｔｉｍ＠ｘ．ｔｅｓｔ"), composed and
 * decomposed accents, case and surrounding space all name the SAME identity.
 * Identity binding (auth/reserved-identities.ts, and its pcc_norm SQL function)
 * and every owner comparison use it on BOTH sides, so the two can never fold
 * differently. It lives in its own module so stores can use it without an
 * import cycle.
 */

export function normalizeIdentity(id: unknown): string {
  return String(id ?? "").normalize("NFKC").trim().toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

/** Same identity after normalizeIdentity. Never true for an empty id, so a missing owner matches nobody. */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeIdentity(a);
  return x.length > 0 && x === normalizeIdentity(b);
}

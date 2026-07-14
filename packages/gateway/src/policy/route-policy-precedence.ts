// Canonical route-policy precedence (audit P0, lane d749deff; review R2 #4/#5).
//
// THE single source of truth for "which policy wins" when several match a request.
// The runtime scope-checker (9de363c7) MUST import and use this — its previous
// star-count-only sort ties the broad jobs glob with the attestations rule and
// picks by insertion order, which would let requestor/operator reach attestation
// routes.
//
// The audit inventory (scripts/audit/route-policy-inventory.mjs) keeps a JS mirror
// of this comparator (it must stay node-runnable and cannot import .ts); a drift
// test (route-policy-precedence.test.ts) asserts the two agree so they cannot
// silently diverge.
//
// Specificity order (most specific wins): exact method, then more literal segments,
// then fewer double-stars, then fewer single-stars, then more literal characters. A
// remaining tie between rules with DIFFERENT scopes is AMBIGUOUS — the policy set
// must be rejected, not ordered.
export interface PolicyRule {
  method: string; // HTTP method or "*"
  pattern: string; // e.g. "/api/jobs/*/attestations/*" or "/api/escrow/**"
  scopes: string[];
}

export interface Specificity {
  exactMethod: number;
  literalSegs: number;
  doubleStars: number;
  singleStars: number;
  literalChars: number;
}

export function specificity(rule: PolicyRule): Specificity {
  const p = rule.pattern;
  const doubleStars = (p.match(/\*\*/g) || []).length;
  const singleStars = (p.match(/\*/g) || []).length - doubleStars * 2;
  const literalSegs = p.split("/").filter((s) => s.length > 0 && !s.includes("*")).length;
  const literalChars = p.replace(/\*/g, "").length;
  return { exactMethod: rule.method !== "*" ? 1 : 0, literalSegs, doubleStars, singleStars, literalChars };
}

/** >0 if a is more specific than b, <0 if less, 0 if an exact tie. */
export function compareSpecificity(a: PolicyRule, b: PolicyRule): number {
  const sa = specificity(a), sb = specificity(b);
  if (sa.exactMethod !== sb.exactMethod) return sa.exactMethod - sb.exactMethod;
  if (sa.literalSegs !== sb.literalSegs) return sa.literalSegs - sb.literalSegs;
  if (sa.doubleStars !== sb.doubleStars) return sb.doubleStars - sa.doubleStars; // fewer ** wins
  if (sa.singleStars !== sb.singleStars) return sb.singleStars - sa.singleStars; // fewer * wins
  if (sa.literalChars !== sb.literalChars) return sa.literalChars - sb.literalChars;
  return 0;
}

export interface PolicyResolution {
  winner: PolicyRule | null;
  scopes: string[] | null;
  matching: PolicyRule[];
  ambiguous: boolean;
}

/** Resolve the winning policy among the already-matched rules for a request. */
export function resolveWinner(matching: PolicyRule[]): PolicyResolution {
  if (matching.length === 0) return { winner: null, scopes: null, matching: [], ambiguous: false };
  const sorted = [...matching].sort((a, b) => compareSpecificity(b, a));
  const top = sorted[0];
  const ties = sorted.filter((r) => compareSpecificity(r, top) === 0);
  const distinct = new Set(ties.map((r) => [...r.scopes].sort().join(",")));
  return { winner: top, scopes: top.scopes, matching, ambiguous: ties.length > 1 && distinct.size > 1 };
}

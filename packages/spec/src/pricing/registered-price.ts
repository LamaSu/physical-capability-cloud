/**
 * Registered price: the operator's REGISTERED price for a discovery quote (N98, #498 round 2).
 *
 * Moved verbatim from packages/gateway/src/services/quote-pricing.ts (N281 PR-B). That module
 * re-exports SETTLEMENT_CURRENCY, amountCents, registeredQuotePrice and RegisteredQuotePrice
 * from here and keeps no copy, so the gateway's discovery quote runs this code. Nothing is
 * imported and no environment is read.
 */

/** The only currency this gateway settles (#498 r2 F2). A registered price in
 * any other currency — even a well-formed one, even "USD" — is refused before
 * a quote forms: there is no conversion. */
export const SETTLEMENT_CURRENCY = "USDC";

/** A registered amount: a whole number of currency units with at most two decimals, as a JSON number or string. */
const AMOUNT = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/;
const QUOTE_CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;
const USAGE_RATES = ["perMinute", "perGram", "perCm3"] as const;
/** A usage rate: non-negative, at most 6 decimals, no exponential notation. */
const USAGE_RATE_PATTERN = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/;

/** A registered amount in cents, or null when it is not a canonical amount of at most two decimals. */
export function amountCents(x: unknown): bigint | null {
  const text = typeof x === "number" ? (Number.isFinite(x) ? String(x) : "") : typeof x === "string" ? x : "";
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole!) * 100n + BigInt((frac + "00").slice(0, 2));
}

/** A usage rate's disclosed text, or null to omit it (absent, or all-zero digits). */
function usageRateText(v: unknown): { ok: true; text: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, text: null };
  const text = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v : "";
  if (!USAGE_RATE_PATTERN.test(text)) return { ok: false };
  const isZero = /^0(\.0+)?$/.test(text);
  return { ok: true, text: isZero ? null : text };
}

// ── Registered price ─────────────────────────────────────────────────────

export type RegisteredQuotePrice =
  | { ok: true; cents: bigint; currency: string; minimumCents: bigint | null; usage: Record<string, string> }
  | {
      ok: false;
      reason: "no-pricing" | "invalid-currency" | "unsupported-currency" | "invalid-price" | "zero-price" | "invalid-minimum" | "invalid-usage";
      /** Set only for "unsupported-currency": the registered (syntactically valid) currency. */
      currency?: string;
    };

/**
 * The price an operator REGISTERED on a capability (`pricing`), as a discovery quote uses it: the
 * flat `baseCost` (a positive amount of at most two decimals; adk registers numbers, the seed strings)
 * in SETTLEMENT_CURRENCY (#498 r2 F2 — no conversion, so any other currency, well-formed or not, is
 * refused), the optional `minimum`, and the usage rates, which are validated and disclosed, never
 * charged (#498 r2 F3). Anything else is not a declared price, and the route refuses it.
 */
export function registeredQuotePrice(pricing: unknown): RegisteredQuotePrice {
  if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) return { ok: false, reason: "no-pricing" };
  const p = pricing as Record<string, unknown>;
  const currency = p.currency;
  if (typeof currency !== "string" || !QUOTE_CURRENCY.test(currency)) return { ok: false, reason: "invalid-currency" };
  if (currency !== SETTLEMENT_CURRENCY) return { ok: false, reason: "unsupported-currency", currency };
  const cents = amountCents(p.baseCost);
  if (cents === null) return { ok: false, reason: "invalid-price" };
  if (cents === 0n) return { ok: false, reason: "zero-price" };
  let minimumCents: bigint | null = null;
  if (p.minimum !== undefined && p.minimum !== null) {
    minimumCents = amountCents(p.minimum);
    if (minimumCents === null) return { ok: false, reason: "invalid-minimum" };
  }
  const usage: Record<string, string> = {};
  for (const k of USAGE_RATES) {
    const r = usageRateText(p[k]);
    if (!r.ok) return { ok: false, reason: "invalid-usage" };
    if (r.text !== null) usage[k] = r.text;
  }
  return { ok: true, cents, currency, minimumCents, usage };
}

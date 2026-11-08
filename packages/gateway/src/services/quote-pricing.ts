/**
 * Quote pricing — the operator's REGISTERED price for a discovery quote, its
 * applicable rules, and exact money arithmetic (N98, #498 round 2).
 *
 * Framework-free on purpose: no route or Fastify types. N100 points negotiation
 * and A2A at this same module, so every export here takes and returns plain
 * data (bigint, string, plain objects), never a request/reply.
 *
 * Every money value is exact: amounts move as bigint cents (or, inside
 * exactQuoteTotal, bigint units of 10^-8 cent) end to end. `Number` never
 * touches a money value — that was #498 round 1's F1 (a 13-digit baseCost at
 * quantity 10 lost a cent: `Number(subtotalCents) / 100` and `toFixed(2)` on
 * a float instead of the exact decimal).
 */

// ── Constants ────────────────────────────────────────────────────────────

/** The only currency this gateway settles (#498 r2 F2). A registered price in
 * any other currency — even a well-formed one, even "USD" — is refused before
 * a quote forms: there is no conversion. */
export const SETTLEMENT_CURRENCY = "USDC";

/** The largest quantity a single discovery quote prices. */
export const MAX_QUOTE_QUANTITY = 1_000_000;

/** A registered amount: a whole number of currency units with at most two decimals, as a JSON number or string. */
const AMOUNT = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/;
const QUOTE_CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;
const USAGE_RATES = ["perMinute", "perGram", "perCm3"] as const;
/** A usage rate: non-negative, at most 6 decimals, no exponential notation. */
const USAGE_RATE_PATTERN = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/;
/** A pricing-rule impact value: an exact signed decimal, at most 6 decimals. */
const RULE_VALUE_PATTERN = /^-?(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;

// ── Plain-data helpers ───────────────────────────────────────────────────

/** HH:MM, 24h (ScheduleWindow's documented format). */
const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const isHhMm = (x: unknown): boolean => typeof x === "string" && HH_MM.test(x);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/** A registered amount in cents, or null when it is not a canonical amount of at most two decimals. */
export function amountCents(x: unknown): bigint | null {
  const text = typeof x === "number" ? (Number.isFinite(x) ? String(x) : "") : typeof x === "string" ? x : "";
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole!) * 100n + BigInt((frac + "00").slice(0, 2));
}

export function centsToDecimal(cents: bigint): string {
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

/** cents, signed, formatted with 2 decimals; zero is always "0.00", never "-0.00"
 * (BigInt has no signed zero, so this falls out of the negation naturally). */
function centsToDecimalSigned(cents: bigint): string {
  return cents < 0n ? `-${centsToDecimal(-cents)}` : centsToDecimal(cents);
}

/** Parse a pricing-rule impact value exactly: no `Number(x) * 1e6` — the decimal
 * string is split and padded so the scale-by-10^6 is always exact BigInt math. The
 * PricingRule contract types the value as a STRING (#498 r3 F6), so a JSON number is
 * not a value. */
function parseExactValue(text: unknown): { text: string; scaled: bigint } | null {
  if (typeof text !== "string" || !RULE_VALUE_PATTERN.test(text)) return null;
  const neg = text.startsWith("-");
  const unsigned = neg ? text.slice(1) : text;
  const [whole, frac = ""] = unsigned.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  const magnitude = BigInt(whole) * 1_000_000n + BigInt(fracPadded);
  return { text, scaled: neg ? -magnitude : magnitude };
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

// ── Pricing-rule validation (#498 r2 F4) ─────────────────────────────────

/** A pricing rule that passed validatePricingRules: condition is confirmed a
 * plain object (known keys type-checked, unknown keys passed through
 * untouched — they just never match on this route); impact.value is the
 * original canonical text (re-parsed by exactQuoteTotal when applied). */
export interface ValidRule {
  id: string;
  /** PricingRule.type: required by the contract (#498 r3 F6), an open string union. */
  type: string;
  label: string;
  enabled: boolean;
  condition: Record<string, unknown>;
  impact: { mode: "percent" | "flat"; value: string };
}

export type PricingRulesValidation =
  | { ok: true; rules: ValidRule[] }
  | { ok: false; ruleIndex: number; ruleId?: string; reason: string };

/**
 * Validate EVERY pricing rule — enabled or not — before any rule is applied to a quote.
 * `undefined` means no rules. Any other non-array refuses. Each element must be a
 * well-formed rule (id/label/enabled/condition/impact per #498 r2 F4) or the WHOLE
 * request is refused with the offending rule's index (and id, when it parsed as a
 * string) — a malformed policy must never reach quoting, let alone money.
 */
export function validatePricingRules(rules: unknown): PricingRulesValidation {
  if (rules === undefined) return { ok: true, rules: [] };
  if (!Array.isArray(rules)) return { ok: false, ruleIndex: -1, reason: "rules-not-an-array" };

  const validated: ValidRule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const idForError = isPlainObject(r) && typeof r.id === "string" ? r.id : undefined;
    const fail = (reason: string): { ok: false; ruleIndex: number; ruleId?: string; reason: string } => ({
      ok: false,
      ruleIndex: i,
      ...(idForError !== undefined ? { ruleId: idForError } : {}),
      reason,
    });

    if (!isPlainObject(r)) return fail("not-an-object");
    if (typeof r.id !== "string" || r.id.length === 0) return fail("invalid-id");
    // #498 r3 F6: `type` is required by the PricingRule contract. A rule without it is malformed
    // policy data, so it is refused like any other malformed rule and never applied as money.
    if (typeof r.type !== "string" || r.type.length === 0) return fail("invalid-type");
    if (typeof r.label !== "string") return fail("invalid-label");
    if (r.enabled !== true && r.enabled !== false) return fail("invalid-enabled");
    const condition = r.condition;
    if (!isPlainObject(condition)) return fail("invalid-condition");
    for (const key of Object.keys(condition)) {
      const v = condition[key];
      if (v === undefined) continue;
      if (key === "minQuantity" || key === "minCompletedJobs") {
        if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return fail(`invalid-condition-${key}`);
      } else if (key === "material") {
        if (!(typeof v === "string" && v.length > 0)) return fail("invalid-condition-material");
      } else if (key === "maxLeadTimeMs") {
        if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) return fail("invalid-condition-maxLeadTimeMs");
      } else if (key === "timeWindow") {
        // The ScheduleWindow contract: {start, end} as HH:MM 24h strings (#498 r3). Such a rule never
        // applies on this route, but a malformed one is still malformed policy data.
        if (!isPlainObject(v) || !isHhMm(v.start) || !isHhMm(v.end)) return fail("invalid-condition-timeWindow");
      }
      // Unknown keys are ALLOWED unvalidated: pricingRulesThatApply's default case
      // means such a rule never applies on this route, which keeps current semantics.
    }
    const impact = r.impact;
    if (!isPlainObject(impact)) return fail("invalid-impact");
    if (impact.mode !== "percent" && impact.mode !== "flat") return fail("invalid-impact-mode");
    const parsedValue = parseExactValue(impact.value);
    if (parsedValue === null) return fail("invalid-impact-value");

    validated.push({ id: r.id, type: r.type, label: r.label, enabled: r.enabled, condition, impact: { mode: impact.mode, value: parsedValue.text } });
  }
  return { ok: true, rules: validated };
}

/**
 * The operator pricing rules that apply to a discovery quote. A rule applies only when EVERY key of
 * its condition holds on a fact this route establishes from the order itself:
 *   - minQuantity: the order's quantity;
 *   - material: the order's selected material.
 * The route takes no start time (rush, offpeak) and no authenticated buyer history (loyalty: the
 * request's userAgentId is the caller's claim), so a rule conditioned on any of those (or any unknown
 * key) never applies. A rule with an empty condition applies. Takes VALIDATED rules only.
 */
export function pricingRulesThatApply(
  rules: readonly ValidRule[],
  order: { quantity: number; material: unknown },
): ValidRule[] {
  return rules.filter((r) => {
    if (!r.enabled) return false;
    return Object.entries(r.condition).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === "minQuantity") return typeof value === "number" && order.quantity >= value;
      if (key === "material") return typeof value === "string" && typeof order.material === "string" && order.material.trim() === value;
      return false;
    });
  });
}

// ── Exact arithmetic (#498 r2 F1) ────────────────────────────────────────

export interface ExactAdjustment {
  ruleId: string;
  label: string;
  /** This rule's own exact amount, rounded to whole cents HALF AWAY FROM ZERO and
   * formatted with 2 decimals. Display only: the total is NEVER a sum of these. */
  impact: string;
}

export interface ExactQuoteResult {
  totalCents: bigint;
  adjustments: ExactAdjustment[];
}

/** cents, rounded HALF AWAY FROM ZERO, from an amount expressed in units of 10^-8 cent. */
function roundHalfAwayFromZero(amount8: bigint): bigint {
  if (amount8 >= 0n) return (amount8 + 50_000_000n) / 100_000_000n;
  return -((-amount8 + 50_000_000n) / 100_000_000n);
}

/**
 * Evaluate the kernel's pricing formula EXACTLY (kernel/src/policy-engine.ts:441: each
 * percent rule takes `value`% of the SUBTOTAL, never compounding; a flat rule adds `value`
 * currency units; the total is floored at 0) — but in bigint units of 10^-8 cent end to
 * end, so no money value ever passes through `Number`.
 */
export function exactQuoteTotal(subtotalCents: bigint, applicable: readonly ValidRule[]): ExactQuoteResult {
  let n = subtotalCents * 100_000_000n; // S x 10^8
  const adjustments: ExactAdjustment[] = [];
  for (const rule of applicable) {
    const parsed = parseExactValue(rule.impact.value);
    // validatePricingRules guarantees this parses. A caller that skipped validation gets no quote,
    // never a quote that silently dropped the rule.
    if (parsed === null) throw new Error(`exactQuoteTotal: rule ${rule.id} has an unvalidated impact value`);
    const amount8 = rule.impact.mode === "percent" ? subtotalCents * parsed.scaled : parsed.scaled * 10_000n;
    n += amount8;
    adjustments.push({ ruleId: rule.id, label: rule.label, impact: centsToDecimalSigned(roundHalfAwayFromZero(amount8)) });
  }
  if (n < 0n) n = 0n;
  const totalCents = (n + 50_000_000n) / 100_000_000n;
  return { totalCents, adjustments };
}

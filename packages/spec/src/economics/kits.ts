/**
 * Kit royalties (R4, board item 13): contributors are paid when their code executes.
 *
 * A Kit version (a capability or terms template) carries a License whose one payment requirement is a
 * percent of the gross of every unit that runs the kit, paid to the kit's fork lineage. It is an
 * ordinary #360 License: the compiler pays it as payout legs in the unit's release, so there is no
 * second ledger and no claim step (returns/pcc-economics-work/r4-contributor-pay/DESIGN.md).
 *
 * This module is the economics side of that, and every function here is pure:
 *   - `licenseHash`: a License's content address, the `economics.economicTermsHash` that kits pin in a
 *     Kit manifest (kits #4102);
 *   - `kitLineageDistribution` and `kitRoyaltyRequirement`: the lineage split (each generation up weighs
 *     half the one below it, nothing past the grandparent) and the requirement that carries it;
 *   - `computeKitSplit`: what a buyer funds for an operator's quote with a kit royalty on top, split by
 *     lineage. It runs the compiler itself, so its numbers are exactly what settlement pays.
 *
 * Not here yet: folding a share under the smallest leg into the forker's leg, and the per-unit cap over
 * all kits. Both need a compiler rule, after the operator rules on the rates (operator item 99).
 */

import { compileEconomics, type CompileResult } from "./compile.js";
import { cmpStr, domainHash } from "./hash.js";
import { snapshotJson } from "./input.js";
import { AMOUNT_PATTERN, ID_PATTERN, LicenseSchema, MAX_FEE_BPS, MIN_UNIT_GROSS, type EconomicAgreement, type PaymentRequirement } from "./types.js";

/** The domain a License is hashed under: `H("PCC:license:v1", license)`, "0x" + 64 lowercase hex. */
export const LICENSE_DOMAIN = "PCC:license:v1";

/**
 * A License's content address. The License is read once as plain JSON and checked against the License
 * schema first, so a malformed one is refused rather than hashed, and object key order does not matter.
 * It is a content hash of the License as written, not of its meaning: reordering an array in it (its
 * fields of use, regions or payments) changes the hash, so a License is hashed as it is published.
 */
export function licenseHash(license: unknown): { ok: true; hash: `0x${string}` } | { ok: false; reason: string } {
  const copy = snapshotJson(license);
  if (!copy.ok) return { ok: false, reason: `the license is not plain JSON data: ${copy.reason}` };
  const parsed = LicenseSchema.safeParse(copy.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `the license is not valid: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, hash: domainHash(LICENSE_DOMAIN, parsed.data) };
}

/**
 * The lineage weights, nearest first: the forker, its parent, its grandparent. Nothing past the grandparent
 * is paid. Frozen: one process cannot build two different requirements for one lineage (astra EC4 M2).
 */
export const KIT_LINEAGE_WEIGHTS: readonly number[] = Object.freeze([4, 2, 1]);

/** The most lineage entries read; only the nearest three are paid. */
const MAX_LINEAGE_ENTRIES = 1_024;

/** One own data property, read once. An accessor, a missing key or a Proxy trap that throws reads as not ok. */
function ownData(from: unknown, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    if (typeof from !== "object" || from === null) return { ok: false };
    const d = Object.getOwnPropertyDescriptor(from, key);
    return d !== undefined && "value" in d ? { ok: true, value: d.value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * A lineage, read once into a frozen copy (astra EC4 M1): a real, dense array of party ids, each read as an
 * own data property, so a getter or a Proxy cannot answer twice and a hole cannot reach the arithmetic.
 * Returns the reason it is refused instead.
 */
function readLineage(lineage: unknown): readonly string[] | { refused: string } {
  try {
    if (!Array.isArray(lineage)) return { refused: "a kit lineage is an array of party ids" };
    const length = ownData(lineage, "length");
    if (!length.ok || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 1) {
      return { refused: "a kit lineage names at least its publisher" };
    }
    if (length.value > MAX_LINEAGE_ENTRIES) return { refused: `a kit lineage has at most ${MAX_LINEAGE_ENTRIES} entries` };
    const out: string[] = [];
    for (let i = 0; i < length.value; i++) {
      const entry = ownData(lineage, String(i));
      if (!entry.ok || typeof entry.value !== "string" || !ID_PATTERN.test(entry.value)) return { refused: `lineage[${i}] is not a party id` };
      out.push(entry.value);
    }
    return Object.freeze(out);
  } catch {
    return { refused: "the kit lineage could not be read" };
  }
}

/** The requirement id and role a kit's royalty carries. */
export const KIT_ROYALTY_REQUIREMENT_ID = "kit-royalty";
export const KIT_ROYALTY_ROLE = "protocol-author" as const;

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * A kit version's lineage, nearest first, as the distribution its royalty is paid to. One generation is
 * paid alone, two at 2 : 1, three or more at 4 : 2 : 1 over the nearest three. A party who appears more
 * than once (a self-fork) is one member with the summed weight. Weights are reduced to lowest terms and
 * members are sorted by party id: the order the compiler compares a requirement's distribution in.
 */
export function kitLineageDistribution(lineage: readonly string[]): Array<{ party: string; weight: number; role: null; subject: null }> {
  const read = readLineage(lineage);
  if (!Array.isArray(read)) throw new RangeError((read as { refused: string }).refused);
  return distributionOf(read as readonly string[]);
}

/** The distribution of a lineage already read once (readLineage). */
function distributionOf(lineage: readonly string[]): Array<{ party: string; weight: number; role: null; subject: null }> {
  const paid = lineage.slice(0, KIT_LINEAGE_WEIGHTS.length);
  const weights = KIT_LINEAGE_WEIGHTS.slice(KIT_LINEAGE_WEIGHTS.length - paid.length);
  const byParty = new Map<string, number>();
  paid.forEach((party, i) => byParty.set(party, (byParty.get(party) ?? 0) + weights[i]!));
  const divisor = [...byParty.values()].reduce(gcd);
  return [...byParty.entries()]
    .sort(([a], [b]) => cmpStr(a, b))
    .map(([party, weight]) => ({ party, weight: weight / divisor, role: null, subject: null }));
}

/**
 * The payment requirement of a kit version's License: `bps` of the gross of every unit that runs the
 * kit, paid to its lineage. A free kit (0 bps) asks for no payment, so this is null. Each input field is
 * read once.
 */
export function kitRoyaltyRequirement(input: { bps: number; lineage: readonly string[] }): PaymentRequirement | null {
  const bps = ownData(input, "bps");
  if (!bps.ok || typeof bps.value !== "number" || !Number.isInteger(bps.value) || bps.value < 0 || bps.value > 10_000) {
    throw new RangeError(`a royalty is 0..10000 bps, not ${bps.ok ? String(bps.value) : "unreadable"}`);
  }
  const raw = ownData(input, "lineage");
  const lineage = readLineage(raw.ok ? raw.value : undefined);
  if (!Array.isArray(lineage)) throw new RangeError((lineage as { refused: string }).refused);
  return requirementOf(bps.value, distributionOf(lineage as readonly string[]));
}

/** The requirement for a rate and a distribution already computed. */
function requirementOf(bps: number, distribution: Array<{ party: string; weight: number; role: null; subject: null }>): PaymentRequirement | null {
  if (bps === 0) return null;
  return {
    requirementId: KIT_ROYALTY_REQUIREMENT_ID,
    role: KIT_ROYALTY_ROLE,
    per: "using-unit",
    payee: { distribution },
    rule: { kind: "percent", bps, of: "gross", min: null, max: null, rateSource: null },
  };
}

/** What a buyer funds for one unit that runs one kit, and who receives it, in base units. */
export interface KitSplit {
  ok: true;
  /** What the buyer funds: the smallest gross the seam accepts for the operator's quote with the royalty on top. */
  grossMinor: string;
  /** PCC's protocol fee, on the whole gross. */
  feeMinor: string;
  /** The kit royalty: `licenseBps` of the gross. */
  royaltyMinor: string;
  /** What the operator receives: at least its quote less the fee on its quote (the seam's rule). */
  operatorMinor: string;
  /** Each paid lineage member's share of the royalty, in lineage order. */
  shares: Array<{ party: string; weight: number; amountMinor: string }>;
  /** The rounding rules, in words. */
  rounding: string;
}

export const KIT_SPLIT_ROUNDING =
  "Exact base units. PCC's fee is the gross times its rate, rounded down. The royalty is the license's rate of the " +
  "gross, rounded to the nearest base unit (a half rounds up). The royalty divides by lineage weight, by largest " +
  "remainder; a tie goes to the party whose id sorts first. The operator receives the rest.";

const MAX_KIT_SPLIT_BPS = 1_000;
const BUYER = "kit-split:buyer";
const OPERATOR = "kit-split:operator";
const KIT = "kit:kit-split";
const placeholder = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** A kit split's input, read once into plain values (astra EC4 M1, L1). */
interface KitSplitTerms {
  currency: { code: string; decimals: number };
  feeBps: number;
  licenseBps: number;
  lineage: readonly string[];
  distribution: Array<{ party: string; weight: number; role: null; subject: null }>;
}

/** Reads an integer field once; null when it is not an integer. */
function readInteger(from: unknown, key: string): number | null {
  const r = ownData(from, key);
  return r.ok && typeof r.value === "number" && Number.isSafeInteger(r.value) ? r.value : null;
}

/**
 * Reads and checks the terms a kit split shares (everything but the quote) once, as own data properties: a
 * getter or a Proxy cannot answer two different values, and nothing later reads the caller's objects again.
 */
function readTerms(input: unknown): KitSplitTerms | { refused: string } {
  const currency = ownData(input, "currency");
  const code = currency.ok ? ownData(currency.value, "code") : { ok: false as const };
  const decimals = currency.ok ? readInteger(currency.value, "decimals") : null;
  if (!code.ok || typeof code.value !== "string" || decimals === null) return { refused: "the currency is { code, decimals }" };
  const feeBps = readInteger(input, "feeBps");
  if (feeBps === null || feeBps < 0 || feeBps > MAX_FEE_BPS) return { refused: `PCC's fee is 0..${MAX_FEE_BPS} bps` };
  const licenseBps = readInteger(input, "licenseBps");
  if (licenseBps === null || licenseBps < 1 || licenseBps > MAX_KIT_SPLIT_BPS) {
    return { refused: `a paid kit's royalty is 1..${MAX_KIT_SPLIT_BPS} bps (a free kit pays nobody, so it has no split)` };
  }
  const raw = ownData(input, "lineage");
  const lineage = readLineage(raw.ok ? raw.value : undefined);
  if (!Array.isArray(lineage)) return lineage as { refused: string };
  const read = lineage as readonly string[];
  if (read.some((p) => p === BUYER || p === OPERATOR)) return { refused: `"${BUYER}" and "${OPERATOR}" are reserved here` };
  return { currency: { code: code.value, decimals }, feeBps, licenseBps, lineage: read, distribution: distributionOf(read) };
}

/** The one-unit agreement for terms already read: the distribution is the one the shares are reported from. */
function agreementFor(gross: bigint, t: KitSplitTerms): EconomicAgreement {
  const requirement = requirementOf(t.licenseBps, t.distribution)!;
  const parties = [BUYER, OPERATOR, ...t.distribution.map((d) => d.party)];
  return {
    schema: "pcc.economic-agreement.v1",
    agreementId: "kit-split",
    version: 1,
    supersedes: null,
    asOf: 1_790_000_000,
    currency: t.currency,
    payer: BUYER,
    parties: parties.map((partyId, i) => ({ partyId, label: partyId, kind: "person", payTo: placeholder(i + 1) })),
    units: [{ unitRef: "job", label: "The job", gross: gross.toString(), components: [{ ref: KIT, uses: "1" }], measures: [] }],
    splits: [{ splitId: "lineage", label: "The kit's lineage", members: t.distribution.map((d) => ({ to: { party: d.party }, weight: d.weight, role: d.role, subject: d.subject })) }],
    clauses: [
      {
        clauseId: "kit-royalty",
        label: "Kit royalty",
        role: requirement.role,
        to: { split: "lineage" },
        subject: KIT,
        appliesTo: { usingComponent: KIT },
        underLicense: { licenseId: "kit-license", version: 1 },
        rule: requirement.rule,
      },
      { clauseId: "operator", label: "The operator keeps the rest", role: "operator", to: { party: OPERATOR }, subject: null, appliesTo: { units: ["job"] }, underLicense: null, rule: { kind: "residual" } },
    ],
    licenses: [
      {
        licenseId: "kit-license",
        version: 1,
        label: "Kit license",
        licensor: t.lineage[0]!,
        subject: KIT,
        class: "permissive",
        shareAlikeTag: null,
        grants: { commercialUse: true, compose: true, resell: true, modify: true, fieldsOfUse: ["*"], regions: ["*"] },
        requires: { attribution: true, payments: [requirement] },
        validFrom: null,
        validUntil: null,
        authority: "registry-anchored",
      },
    ],
    use: { commercial: true, composite: false, resell: false, fieldOfUse: "*", region: "*", modifies: [], outbound: { class: "proprietary", shareAlikeTag: null } },
    fee: { feeBps: t.feeBps, feeRecipient: t.feeBps === 0 ? null : placeholder(0xfee) },
    terms: { acceptBy: null, changePolicy: "new-version-required" },
  } as EconomicAgreement;
}

/**
 * The one-unit agreement `computeKitSplit` prices: one unit at `gross` that runs the kit, the kit's License,
 * its lineage as a split, the royalty clause that meets the License, and the operator taking the rest.
 * Parties are named by their ids and paid at placeholder addresses; only the amounts mean anything. A free
 * kit (0 bps) has no royalty and so no split: it is refused with a RangeError, as is any other input
 * computeKitSplit would refuse (astra EC4 M3).
 */
export function kitSplitAgreement(gross: bigint, input: { currency: { code: string; decimals: number }; feeBps: number; licenseBps: number; lineage: readonly string[] }): EconomicAgreement {
  const terms = readTerms(input);
  if ("refused" in terms) throw new RangeError(terms.refused);
  return agreementFor(gross, terms);
}

/** The operator's leg in a one-unit compile, or a refusal. */
function operatorLeg(result: CompileResult): bigint | { refused: string } {
  if (!result.ok) return { refused: result.refusals.map((r) => `${r.code}: ${r.message}`).join("; ") };
  const unit = result.units[0]!;
  const leg = unit.payouts.find((p) => p.recipient === placeholder(2));
  return leg === undefined ? 0n : BigInt(leg.amount);
}

/** The quote, read once: a canonical decimal string of base units, or a bigint (astra EC4 L1). */
function readQuote(input: unknown): bigint | { refused: string } {
  const q = ownData(input, "quoteMinor");
  if (q.ok && typeof q.value === "bigint" && q.value >= 0n) return q.value;
  if (q.ok && typeof q.value === "string" && AMOUNT_PATTERN.test(q.value)) return BigInt(q.value);
  return { refused: "the quote is a canonical decimal amount of base units (digits only, no sign, no leading zeros), or a non-negative bigint" };
}

/**
 * What a buyer funds for one unit with an operator's quote and one kit royalty on top, and who receives
 * it. The gross is the smallest the accepted-plan seam accepts: the operator's legs cover its quote less
 * the fee on that quote (OPERATOR_BELOW_QUOTE), and the gross covers the quote (QUOTE_NOT_COVERED). A
 * composer may charge more, as its own margin. Every amount comes from the compiler, so this is exactly
 * what settlement pays for that gross.
 *
 * The input is read once (astra EC4 M1): each field as an own data property, the lineage as a dense array
 * of party ids. It assumes the operator is not one of the lineage's payees. When the operator is also a
 * contributor, the seam counts its share toward the operator's floor too, so a smaller gross may pass.
 */
export function computeKitSplit(input: {
  quoteMinor: string | bigint;
  currency: { code: string; decimals: number };
  feeBps: number;
  licenseBps: number;
  lineage: readonly string[];
}): KitSplit | { ok: false; reason: string } {
  const quote = readQuote(input);
  if (typeof quote !== "bigint") return { ok: false, reason: quote.refused };
  if (quote < MIN_UNIT_GROSS) return { ok: false, reason: `a quote is at least ${MIN_UNIT_GROSS} base units` };
  const t = readTerms(input);
  if ("refused" in t) return { ok: false, reason: t.refused };

  const f = BigInt(t.feeBps);
  const r = BigInt(t.licenseBps);
  const floor = quote - (quote * f) / 10_000n;
  // Every gross below `start` leaves the operator less than `floor`: its leg is at most G(10000 - f - r)/10000
  // plus 1.5 base units of rounding, and f + r <= 2000, so ten units of margin are more than enough.
  const lower = (floor * 10_000n) / (10_000n - f - r) - 10n;
  const start = lower > quote ? lower : quote;
  const paidAt = new Map(t.distribution.map((d, i) => [placeholder(i + 3), d] as const));
  const order = new Map<string, number>();
  t.lineage.forEach((party, i) => {
    if (!order.has(party)) order.set(party, i);
  });
  for (let gross = start; gross - start <= 64n; gross++) {
    const result = compileEconomics(agreementFor(gross, t));
    const leg = operatorLeg(result);
    if (typeof leg !== "bigint") return { ok: false, reason: `the compiler refused it: ${leg.refused}` };
    if (leg < floor) continue;
    const unit = (result as Extract<CompileResult, { ok: true }>).units[0]!;
    const royalty = unit.payouts.filter((p) => paidAt.has(p.recipient)).reduce((sum, p) => sum + BigInt(p.amount), 0n);
    const shares = t.distribution
      .map((d, i) => ({ party: d.party, weight: d.weight, amountMinor: unit.payouts.find((p) => p.recipient === placeholder(i + 3))?.amount ?? "0" }))
      .sort((a, b) => order.get(a.party)! - order.get(b.party)!);
    return {
      ok: true,
      grossMinor: gross.toString(),
      feeMinor: unit.fee,
      royaltyMinor: royalty.toString(),
      operatorMinor: leg.toString(),
      shares,
      rounding: KIT_SPLIT_ROUNDING,
    };
  }
  return { ok: false, reason: "no gross covers this quote" }; // unreachable: see `lower`
}

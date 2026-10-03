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
import { LicenseSchema, MAX_FEE_BPS, MIN_UNIT_GROSS, type EconomicAgreement, type License, type PaymentRequirement } from "./types.js";

/** The domain a License is hashed under: `H("PCC:license:v1", license)`, "0x" + 64 lowercase hex. */
export const LICENSE_DOMAIN = "PCC:license:v1";

/**
 * A License's content address. The License is read once as plain JSON and checked against the License
 * schema first, so two copies that mean the same License hash the same, and a malformed one is refused
 * rather than hashed.
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

/** The lineage weights, nearest first: the forker, its parent, its grandparent. Nothing past the grandparent is paid. */
export const KIT_LINEAGE_WEIGHTS: readonly number[] = [4, 2, 1];

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
  if (lineage.length === 0) throw new RangeError("a kit lineage names at least its publisher");
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
 * kit, paid to its lineage. A free kit (0 bps) asks for no payment, so this is null.
 */
export function kitRoyaltyRequirement(input: { bps: number; lineage: readonly string[] }): PaymentRequirement | null {
  if (!Number.isInteger(input.bps) || input.bps < 0 || input.bps > 10_000) throw new RangeError(`a royalty is 0..10000 bps, not ${input.bps}`);
  if (input.bps === 0) return null;
  return {
    requirementId: KIT_ROYALTY_REQUIREMENT_ID,
    role: KIT_ROYALTY_ROLE,
    per: "using-unit",
    payee: { distribution: kitLineageDistribution(input.lineage) },
    rule: { kind: "percent", bps: input.bps, of: "gross", min: null, max: null, rateSource: null },
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

/**
 * The one-unit agreement `computeKitSplit` prices: one unit at `gross` that runs the kit, the kit's License,
 * its lineage as a split, the royalty clause that meets the License, and the operator taking the rest.
 * Parties are named by their ids and paid at placeholder addresses; only the amounts mean anything.
 */
export function kitSplitAgreement(gross: bigint, input: { currency: { code: string; decimals: number }; feeBps: number; licenseBps: number; lineage: readonly string[] }): EconomicAgreement {
  const requirement = kitRoyaltyRequirement({ bps: input.licenseBps, lineage: input.lineage })!;
  const distribution = "distribution" in requirement.payee ? requirement.payee.distribution : [];
  const parties = [BUYER, OPERATOR, ...distribution.map((d) => d.party)];
  return {
    schema: "pcc.economic-agreement.v1",
    agreementId: "kit-split",
    version: 1,
    supersedes: null,
    asOf: 1_790_000_000,
    currency: input.currency,
    payer: BUYER,
    parties: parties.map((partyId, i) => ({ partyId, label: partyId, kind: "person", payTo: placeholder(i + 1) })),
    units: [{ unitRef: "job", label: "The job", gross: gross.toString(), components: [{ ref: KIT, uses: "1" }], measures: [] }],
    splits: [{ splitId: "lineage", label: "The kit's lineage", members: distribution.map((d) => ({ to: { party: d.party }, weight: d.weight, role: d.role, subject: d.subject })) }],
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
        licensor: input.lineage[0]!,
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
    fee: { feeBps: input.feeBps, feeRecipient: input.feeBps === 0 ? null : placeholder(0xfee) },
    terms: { acceptBy: null, changePolicy: "new-version-required" },
  } as EconomicAgreement;
}

/** The operator's leg in a one-unit compile, or a refusal. */
function operatorLeg(result: CompileResult): bigint | { refused: string } {
  if (!result.ok) return { refused: result.refusals.map((r) => `${r.code}: ${r.message}`).join("; ") };
  const unit = result.units[0]!;
  const leg = unit.payouts.find((p) => p.recipient === placeholder(2));
  return leg === undefined ? 0n : BigInt(leg.amount);
}

/**
 * What a buyer funds for one unit with an operator's quote and one kit royalty on top, and who receives
 * it. The gross is the smallest the accepted-plan seam accepts: the operator's legs cover its quote less
 * the fee on that quote (OPERATOR_BELOW_QUOTE), and the gross covers the quote (QUOTE_NOT_COVERED). A
 * composer may charge more, as its own margin. Every amount comes from the compiler, so this is exactly
 * what settlement pays for that gross.
 */
export function computeKitSplit(input: {
  quoteMinor: string | bigint;
  currency: { code: string; decimals: number };
  feeBps: number;
  licenseBps: number;
  lineage: readonly string[];
}): KitSplit | { ok: false; reason: string } {
  let quote: bigint;
  try {
    quote = BigInt(input.quoteMinor);
  } catch {
    return { ok: false, reason: `the quote "${String(input.quoteMinor)}" is not an integer amount of base units` };
  }
  if (quote < MIN_UNIT_GROSS) return { ok: false, reason: `a quote is at least ${MIN_UNIT_GROSS} base units` };
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > MAX_FEE_BPS) return { ok: false, reason: `PCC's fee is 0..${MAX_FEE_BPS} bps` };
  if (!Number.isInteger(input.licenseBps) || input.licenseBps < 1 || input.licenseBps > MAX_KIT_SPLIT_BPS) {
    return { ok: false, reason: `a paid kit's royalty is 1..${MAX_KIT_SPLIT_BPS} bps (a free kit pays nobody)` };
  }
  if (input.lineage.length === 0) return { ok: false, reason: "a kit lineage names at least its publisher" };
  if (input.lineage.some((p) => p === BUYER || p === OPERATOR)) return { ok: false, reason: `"${BUYER}" and "${OPERATOR}" are reserved here` };

  const f = BigInt(input.feeBps);
  const r = BigInt(input.licenseBps);
  const floor = quote - (quote * f) / 10_000n;
  // Every gross below `start` leaves the operator less than `floor`: its leg is at most G(10000 - f - r)/10000
  // plus 1.5 base units of rounding, and f + r <= 2000, so ten units of margin are more than enough.
  const start = (floor * 10_000n) / (10_000n - f - r) - 10n;
  for (let gross = start > quote ? start : quote; ; gross++) {
    if (gross - (start > quote ? start : quote) > 64n) return { ok: false, reason: "no gross covers this quote" }; // unreachable: see `start`
    const result = compileEconomics(kitSplitAgreement(gross, input));
    const leg = operatorLeg(result);
    if (typeof leg !== "bigint") return { ok: false, reason: `the compiler refused it: ${leg.refused}` };
    if (leg < floor) continue;
    const unit = (result as Extract<CompileResult, { ok: true }>).units[0]!;
    const distribution = kitLineageDistribution(input.lineage);
    const paid = new Map(distribution.map((d, i) => [placeholder(i + 3), d] as const));
    const royalty = unit.payouts.filter((p) => paid.has(p.recipient)).reduce((s, p) => s + BigInt(p.amount), 0n);
    const order = new Map<string, number>();
    input.lineage.forEach((party, i) => {
      if (!order.has(party)) order.set(party, i);
    });
    const shares = distribution
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
}

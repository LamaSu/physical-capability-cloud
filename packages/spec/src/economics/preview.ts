/**
 * buildEconomicPreview — "who gets paid what, when, and why", before anyone accepts
 * (docs/ECONOMIC_AGREEMENTS.md §11; product pack §9, PX-12).
 *
 * A plain-language view of one compile and, optionally, its scenarios. It adds no arithmetic: every
 * amount is the compiled output's, regrouped for a person (by party, by kind of payment, by step).
 * It is a Layer C prediction: it never states that a deal was accepted, funded or paid. Reserved
 * and paid money after funding come from the escrow's read model, not from here.
 */

import { cmpStr } from "./hash.js";
import { snapshotJson } from "./input.js";
import type { CompileResult, CompiledEconomics } from "./compile.js";
import type { Refusal, RefusalCode } from "./refusals.js";
import type { ScenarioResult } from "./simulate.js";
import { EconomicAgreementSchema, type Clause, type EconomicAgreement } from "./types.js";

// ── Money, exactly ───────────────────────────────────────────────────────────

export interface Money {
  /** Base units of the currency, as a decimal integer string. */
  amount: string;
  /** Exact decimal with the currency code, e.g. "25.00 USDC" or "0.5875 USDC". Never rounded. */
  display: string;
}

/**
 * Base units → exact decimal text: at least 2 fraction digits (when the currency has them), trailing
 * zeros beyond that trimmed. 25000000 at 6 decimals is "25.00"; 587500 is "0.5875".
 */
export function formatAmount(amount: bigint | string, decimals: number): string {
  const v = typeof amount === "bigint" ? amount : BigInt(amount);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  if (decimals === 0) return `${negative ? "-" : ""}${abs}`;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  let frac = (abs % unit).toString().padStart(decimals, "0");
  const keep = Math.min(2, decimals);
  while (frac.length > keep && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function money(amount: bigint | string, currency: { code: string; decimals: number }): Money {
  const a = typeof amount === "bigint" ? amount.toString() : amount;
  return { amount: a, display: `${formatAmount(a, currency.decimals)} ${currency.code}` };
}

// ── The DTO ──────────────────────────────────────────────────────────────────

/**
 * The four kinds of payment a buyer is shown (product pack §9):
 *   provider  — the operators doing the work
 *   upstream  — licensed components, modules, methods, models, datasets and other contributors
 *   fee       — verification, insurance and treasury roles (PCC's protocol fee is shown on its own)
 *   margin    — what the composer or assembler keeps
 */
export type PaymentCategory = "provider" | "upstream" | "fee" | "margin";

export const PAYMENT_CATEGORY_LABELS: Readonly<Record<PaymentCategory, string>> = {
  provider: "Doing the work",
  upstream: "Licenses and contributors",
  fee: "Verification, insurance and treasury",
  margin: "Composer's margin",
};

const UPSTREAM_ROLES = new Set(["integrator", "protocol-author", "model-author", "dataset-contributor", "backend-author", "curator"]);
const FEE_ROLES = new Set(["verifier", "insurer", "network-treasury"]);

/** A clause's kind of payment: anything owed under a license is upstream; otherwise by its role. */
export function categoryOf(clause: Pick<Clause, "role" | "underLicense">): PaymentCategory {
  if (clause.underLicense !== null) return "upstream";
  if (clause.role === "operator") return "provider";
  if (clause.role === "assembler") return "margin";
  if (FEE_ROLES.has(clause.role)) return "fee";
  if (UPSTREAM_ROLES.has(clause.role)) return "upstream";
  return "provider";
}

export interface PreviewLine {
  unitRef: string;
  stepLabel: string;
  amount: Money;
  category: PaymentCategory;
  role: string;
  subject: string | null;
  /** Why this money goes to this party, in the agreement's own words. */
  why: string;
}

export type ScenarioView =
  | {
      scenarioId: string;
      label: string;
      fundable: true;
      paid: Array<{ partyId: string; label: string; amount: Money }>;
      payer: { spent: Money; refunded: Money; reserved: Money };
      fee: Money;
    }
  | { scenarioId: string; label: string; fundable: false; reasons: string[] };

export interface EconomicPreviewDTO {
  schema: "pcc.economic-preview.v1";
  /** A prediction (Layer C). Accepting binds `agreement.agreementHash`; nothing here is a deal. */
  layer: "C";
  status: "fundable" | "refused";
  headline: string;
  agreement: {
    agreementId: string | null;
    version: number | null;
    agreementHash: string | null;
    economicTermsHash: string | null;
    rightsTermsHash: string | null;
  };
  currency: { code: string; decimals: number } | null;
  payer: { partyId: string; label: string } | null;
  totals: { maxSpend: Money; protocolFee: Money; toParties: Money } | null;
  protocolFee: { bps: number; percent: string; recipient: string | null; amount: Money; verified: boolean } | null;
  byCategory: Array<{ category: PaymentCategory; label: string; amount: Money }>;
  steps: Array<{ unitRef: string; label: string; gross: Money; fee: Money; net: Money; whenPaid: string; ifItFails: string }>;
  payees: Array<{ partyId: string; label: string; kind: string; total: Money; lines: PreviewLine[] }>;
  obligations: Array<{ license: string; licensor: string; clause: string; amount: Money }>;
  rights: Array<{ license: string; licensor: string; class: string; attributionRequired: boolean; validUntil: string | null; authority: string }>;
  rates: Array<{ clause: string; percent: string; verified: boolean; note: string }>;
  notOwed: Array<{ clause: string; why: string }>;
  terms: { asOf: string; acceptBy: string | null; changePolicy: string; supersedes: string | null } | null;
  moneyState: { reserved: Money | null; paid: Money | null; note: string };
  scenarios: ScenarioView[];
  refusals: Array<{ code: RefusalCode; path: string[]; explanation: string }>;
}

// ── Plain words ──────────────────────────────────────────────────────────────

const REFUSAL_TITLES: Readonly<Record<RefusalCode, string>> = {
  SCHEMA_INVALID: "The agreement is not well formed",
  DUPLICATE_ID: "Something is named twice",
  DUPLICATE_LICENSE_SUBJECT: "Two licenses claim the same component",
  UNKNOWN_REFERENCE: "Something refers to a party, step, split or license that is not in the agreement",
  SPLIT_CYCLE: "A split pays into itself",
  SPLIT_TOO_DEEP: "Splits are nested too deeply",
  DUPLICATE_SPLIT_MEMBER: "A split lists the same member twice",
  FEE_INVALID: "The protocol fee is not the one PCC charges",
  OFFER_EXPIRED: "The offer has expired",
  ECONOMICS_UNDECIDED_OD4: "This kind of payment is not supported yet",
  INVALID_BOUNDS: "A minimum is larger than its maximum",
  RATE_PIN_MISMATCH: "A royalty rate is not the published schedule's rate",
  TOO_MANY_ALLOCATIONS: "The splits fan out into too many payments",
  RIGHTS_UNKNOWN: "A component has no license, so its rights are unknown",
  LICENSE_NOT_IN_FORCE: "A license is not in force",
  AUTHORITY_BELOW_FLOOR: "A license's authority is not established well enough",
  RIGHTS_INCOMPATIBLE: "A license does not allow this use",
  LICENSE_PAYMENT_MISSING: "A payment a license requires is missing",
  LICENSE_PAYMENT_UNMATCHED: "A payment is attributed to a license that does not require it",
  RATE_UNVERIFIED: "A required royalty rate could not be checked",
  GROSS_OUT_OF_RANGE: "A step's price is out of range",
  UNKNOWN_MEASURE: "A per-unit price refers to something the step does not measure",
  OVER_ALLOCATED: "The payments add up to more than the price",
  MULTIPLE_RESIDUALS: "More than one party is named to keep what is left",
  UNALLOCATED_REMAINDER: "Part of the price is not assigned to anyone",
  UNRESOLVED_PARTY: "A party is owed money but has no payout address",
  FORBIDDEN_RECIPIENT: "A payment goes to an address that cannot receive it",
  TOO_MANY_LEGS: "A step pays more addresses than the escrow allows",
};

export function explainRefusal(r: Refusal): string {
  return `${REFUSAL_TITLES[r.code]}. ${r.message}`;
}

function isoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function percentText(bps: number): string {
  return `${formatAmount(BigInt(bps), 2)}%`;
}

// ── Builder ──────────────────────────────────────────────────────────────────

export interface PreviewOptions {
  /** Whether the fee in the agreement was checked against the server's own fee (compile option `fee`). */
  feeVerified: boolean;
  scenarios?: readonly ScenarioResult[];
}

/**
 * Build the preview of one compile. `input` is the agreement that was compiled; `result` is what
 * `compileEconomics` returned for it.
 */
export function buildEconomicPreview(input: unknown, result: CompileResult, options: PreviewOptions): EconomicPreviewDTO {
  const copy = snapshotJson(input);
  const parsed = copy.ok ? EconomicAgreementSchema.safeParse(copy.value) : null;
  const ag = parsed?.success ? parsed.data : null;
  const scenarios = (options.scenarios ?? []).map((s) => scenarioView(s, ag));

  if (!result.ok || ag === null) {
    const refusals = result.ok ? [] : result.refusals.map((r) => ({ code: r.code, path: r.path, explanation: explainRefusal(r) }));
    return {
      schema: "pcc.economic-preview.v1",
      layer: "C",
      status: "refused",
      headline: `This agreement cannot be funded as written. ${refusals[0]?.explanation ?? ""}`.trim(),
      agreement: { agreementId: ag?.agreementId ?? null, version: ag?.version ?? null, agreementHash: null, economicTermsHash: null, rightsTermsHash: null },
      currency: ag?.currency ?? null,
      payer: null,
      totals: null,
      protocolFee: null,
      byCategory: [],
      steps: [],
      payees: [],
      obligations: [],
      rights: [],
      rates: [],
      notOwed: [],
      terms: null,
      moneyState: { reserved: null, paid: null, note: "Nothing can be reserved or paid: the agreement is refused." },
      scenarios,
      refusals,
    };
  }
  return fundablePreview(ag, result, options, scenarios);
}

function fundablePreview(ag: EconomicAgreement, c: CompiledEconomics, options: PreviewOptions, scenarios: ScenarioView[]): EconomicPreviewDTO {
  const cur = c.currency;
  const partyById = new Map(ag.parties.map((p) => [p.partyId, p] as const));
  const unitById = new Map(ag.units.map((u) => [u.unitRef, u] as const));
  const clauseById = new Map(ag.clauses.map((x) => [x.clauseId, x] as const));
  const splitById = new Map(ag.splits.map((s) => [s.splitId, s] as const));
  const licenseByKey = new Map(ag.licenses.map((l) => [`${l.licenseId}@${l.version}`, l] as const));
  const paysNowhere = new Set(c.notEligible.map((n) => n.clauseId));
  const label = (partyId: string) => partyById.get(partyId)?.label ?? partyId;
  const payerLabel = label(c.payer);

  const why = (clause: Clause, path: readonly string[]): string => {
    const parts = [clause.label];
    const splits = path.slice(1).map((id) => splitById.get(id)?.label ?? id);
    if (splits.length > 0) parts.push(`as a share of ${splits.join(" within ")}`);
    if (clause.underLicense !== null) {
      const lic = licenseByKey.get(`${clause.underLicense.licenseId}@${clause.underLicense.version}`);
      parts.push(`required by the license "${lic?.label ?? clause.underLicense.licenseId}"`);
    }
    return parts.join(", ");
  };

  // Every attributed allocation, once: the payees' lines and the category totals come from the same list.
  const byCategory = new Map<PaymentCategory, bigint>([
    ["provider", 0n],
    ["upstream", 0n],
    ["fee", 0n],
    ["margin", 0n],
  ]);
  const linesByParty = new Map<string, PreviewLine[]>();
  const totalByParty = new Map<string, bigint>();
  for (const u of c.units) {
    const stepLabel = unitById.get(u.unitRef)?.label ?? u.unitRef;
    for (const leg of u.legs) {
      for (const a of leg.attribution) {
        const clause = clauseById.get(a.clauseId)!;
        const category = categoryOf(clause);
        const amount = BigInt(a.amount);
        byCategory.set(category, byCategory.get(category)! + amount);
        totalByParty.set(a.partyId, (totalByParty.get(a.partyId) ?? 0n) + amount);
        const lines = linesByParty.get(a.partyId) ?? [];
        lines.push({
          unitRef: u.unitRef,
          stepLabel,
          amount: money(amount, cur),
          category,
          role: leg.roles.join("+"),
          subject: leg.subjects.length > 0 ? leg.subjects.join("+") : null,
          why: why(clause, a.path),
        });
        linesByParty.set(a.partyId, lines);
      }
    }
  }

  const gross = BigInt(c.totals.gross);
  const fee = BigInt(c.totals.fee);
  const net = BigInt(c.totals.net);
  const payees = [...totalByParty.entries()]
    .sort((x, y) => cmpStr(x[0], y[0]))
    .map(([partyId, total]) => ({
      partyId,
      label: label(partyId),
      kind: partyById.get(partyId)?.kind ?? "person",
      total: money(total, cur),
      lines: (linesByParty.get(partyId) ?? []).sort((x, y) => cmpStr(x.unitRef, y.unitRef) || cmpStr(x.why, y.why)),
    }));

  const obligations: EconomicPreviewDTO["obligations"] = [];
  for (const clause of ag.clauses) {
    if (clause.underLicense === null) continue;
    const lic = licenseByKey.get(`${clause.underLicense.licenseId}@${clause.underLicense.version}`);
    let paid = 0n;
    for (const u of c.units) for (const x of u.clauses) if (x.clauseId === clause.clauseId) paid += BigInt(x.amount);
    obligations.push({ license: lic?.label ?? clause.underLicense.licenseId, licensor: label(lic?.licensor ?? ""), clause: clause.label, amount: money(paid, cur) });
  }
  obligations.sort((x, y) => cmpStr(x.license, y.license) || cmpStr(x.clause, y.clause));

  const partiesPaid = payees.length;
  const feeText = fee > 0n ? ` ${money(fee, cur).display} of that is PCC's protocol fee (${percentText(c.fee.feeBps)})${options.feeVerified ? "" : ", not yet checked against the fee PCC charges"}.` : "";
  return {
    schema: "pcc.economic-preview.v1",
    layer: "C",
    status: "fundable",
    headline: `You pay at most ${money(gross, cur).display}.${feeText} The rest, ${money(net, cur).display}, goes to ${partiesPaid} ${partiesPaid === 1 ? "party" : "parties"}, step by step, only as each step is released.`,
    agreement: {
      agreementId: c.agreementId,
      version: c.version,
      agreementHash: c.agreementHash,
      economicTermsHash: c.economicTermsHash,
      rightsTermsHash: c.rightsTermsHash,
    },
    currency: cur,
    payer: { partyId: c.payer, label: payerLabel },
    totals: { maxSpend: money(gross, cur), protocolFee: money(fee, cur), toParties: money(net, cur) },
    protocolFee: {
      bps: c.fee.feeBps,
      percent: percentText(c.fee.feeBps),
      recipient: c.fee.feeRecipient,
      amount: money(fee, cur),
      verified: options.feeVerified,
    },
    byCategory: (["provider", "upstream", "fee", "margin"] as const).map((category) => ({
      category,
      label: PAYMENT_CATEGORY_LABELS[category],
      amount: money(byCategory.get(category)!, cur),
    })),
    steps: c.units.map((u) => {
      const stepLabel = unitById.get(u.unitRef)?.label ?? u.unitRef;
      return {
        unitRef: u.unitRef,
        label: stepLabel,
        gross: money(u.gross, cur),
        fee: money(u.fee, cur),
        net: money(u.net, cur),
        whenPaid: `Paid out when "${stepLabel}" is released on its own evidence.`,
        ifItFails: `If "${stepLabel}" fails, its ${money(u.gross, cur).display} goes back to ${payerLabel} and nobody on this step is paid.`,
      };
    }),
    payees,
    obligations,
    rights: c.rights.map((r) => {
      const lic = licenseByKey.get(`${r.licenseId}@${r.version}`);
      return {
        license: lic?.label ?? r.licenseId,
        licensor: label(r.licensor),
        class: r.class,
        attributionRequired: r.attributionRequired,
        validUntil: lic?.validUntil != null ? isoTime(lic.validUntil) : null,
        authority: r.authority,
      };
    }),
    rates: c.rates.map((r) => ({
      clause: clauseById.get(r.clauseId)?.label ?? r.clauseId,
      percent: percentText(r.bps),
      verified: r.verified,
      // A compiled deal checks every rate that pays out, so an unchecked one is a clause that pays nothing here.
      note: r.verified
        ? "Checked against the published rate schedule at the time of this agreement."
        : paysNowhere.has(r.clauseId)
          ? "Not checked, because this clause pays nothing in this agreement."
          : "Not checked against the published rate schedule.",
    })),
    notOwed: c.notEligible.map((n) => {
      const clause = clauseById.get(n.clauseId)!;
      const a = clause.appliesTo;
      const component = "usingComponent" in a ? a.usingComponent : "oncePerAgreementUsing" in a ? a.oncePerAgreementUsing : null;
      return {
        clause: clause.label,
        why: component !== null ? `Owed only where ${component} runs, and it runs in no step of this agreement.` : "It applies to no step of this agreement.",
      };
    }),
    terms: {
      asOf: isoTime(c.asOf),
      acceptBy: ag.terms.acceptBy !== null ? isoTime(ag.terms.acceptBy) : null,
      changePolicy: "Any change makes a new version, which you would accept again. An accepted version never changes.",
      supersedes: ag.supersedes,
    },
    moneyState: {
      reserved: money(0n, cur),
      paid: money(0n, cur),
      note: "Nothing is reserved or paid yet. When you accept and fund, each step's price is reserved in escrow, paid out only when that step is released, and refunded if it fails.",
    },
    scenarios,
    refusals: [],
  };
}

function scenarioView(s: ScenarioResult, ag: EconomicAgreement | null): ScenarioView {
  if (!s.ok) return { scenarioId: s.scenarioId, label: s.label, fundable: false, reasons: s.refusals.map(explainRefusal) };
  const cur = ag?.currency ?? { code: "", decimals: 0 };
  const label = (partyId: string) => ag?.parties.find((p) => p.partyId === partyId)?.label ?? partyId;
  return {
    scenarioId: s.scenarioId,
    label: s.label,
    fundable: true,
    paid: s.paid.map((p) => ({ partyId: p.partyId, label: label(p.partyId), amount: money(p.amount, cur) })),
    payer: { spent: money(s.payer.spent, cur), refunded: money(s.payer.refunded, cur), reserved: money(s.payer.reserved, cur) },
    fee: money(s.fee.paid, cur),
  };
}

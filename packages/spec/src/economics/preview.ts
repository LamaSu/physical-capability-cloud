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
import { DEFAULT_MAX_AGREEMENT_AGE_SECONDS } from "./bind.js";
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
const PAYMENT_CATEGORIES: readonly PaymentCategory[] = ["provider", "upstream", "fee", "margin"];

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
  /** The step this line is paid in, or null when the line sums a payment over several steps. */
  unitRef: string | null;
  /** The step's label, or "N steps" for a line that sums several. */
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
  /**
   * fundable: it compiles, and (when the server's clock was given) it can be accepted now.
   * not-acceptable-now: it compiles, but the seam would refuse it at this moment: its offer deadline has
   * passed, or it was priced too long ago or for a moment still to come (`terms.timing` says which).
   * refused: it does not compile.
   */
  status: "fundable" | "not-acceptable-now" | "refused";
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
  terms: {
    asOf: string;
    acceptBy: string | null;
    /** The deadline in words, in the right tense for the server's clock. */
    deadline: string;
    /** Whether it can be accepted at the server's clock; null when no clock was given. */
    acceptableNow: boolean | null;
    /** Why it cannot be accepted now, or null. */
    timing: string | null;
    changePolicy: string;
    supersedes: string | null;
  } | null;
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

/**
 * The most lines one payee shows. An agreement may pay one party in 256 steps through many splits, which
 * is tens of thousands of allocations: listing each one would be megabytes that no person can read.
 */
export const MAX_LINES_PER_PAYEE = 24;

/**
 * A payee's lines, readable at any size, and always re-adding exactly to the payee's total:
 *   1. one line per step and reason, when that fits;
 *   2. else one line per reason, summed over its steps ("256 steps");
 *   3. else the largest reasons, and the rest summed per kind of payment ("40 more payments").
 */
function readableLines(lines: readonly PreviewLine[], cur: { code: string; decimals: number }): PreviewLine[] {
  const perStep = [...lines].sort((x, y) => cmpStr(x.unitRef ?? "", y.unitRef ?? "") || cmpStr(x.why, y.why));
  if (perStep.length <= MAX_LINES_PER_PAYEE) return perStep;

  const stepLabels = new Map(perStep.map((l) => [l.unitRef ?? "", l.stepLabel] as const));
  const over = (steps: ReadonlySet<string>) => (steps.size === 1 ? stepLabels.get([...steps][0]!)! : `${steps.size} steps`);
  const parts = (joined: Iterable<string>) => [...new Set([...joined].flatMap((x) => x.split("+")).filter((x) => x !== ""))].sort(cmpStr);
  interface Group {
    why: string;
    category: PaymentCategory;
    amount: bigint;
    steps: Set<string>;
    roles: Set<string>;
    subjects: Set<string>;
  }
  const merge = (into: Map<string, Group>, key: string, l: { why: string; category: PaymentCategory; amount: bigint; steps: Iterable<string>; roles: Iterable<string>; subjects: Iterable<string> }) => {
    const g = into.get(key) ?? { why: l.why, category: l.category, amount: 0n, steps: new Set<string>(), roles: new Set<string>(), subjects: new Set<string>() };
    g.amount += l.amount;
    for (const x of l.steps) g.steps.add(x);
    for (const x of l.roles) g.roles.add(x);
    for (const x of l.subjects) g.subjects.add(x);
    into.set(key, g);
  };
  const toLine = (g: Group): PreviewLine => ({
    unitRef: g.steps.size === 1 ? [...g.steps][0]! : null,
    stepLabel: over(g.steps),
    amount: money(g.amount, cur),
    category: g.category,
    role: parts(g.roles).join("+"),
    subject: g.subjects.size > 0 ? parts(g.subjects).join("+") : null,
    why: g.why,
  });
  const largestFirst = (x: Group, y: Group) => (x.amount === y.amount ? cmpStr(x.why, y.why) : x.amount > y.amount ? -1 : 1);

  const byReason = new Map<string, Group>();
  for (const l of perStep) {
    merge(byReason, `${l.category}\u0000${l.why}`, {
      why: l.why,
      category: l.category,
      amount: BigInt(l.amount.amount),
      steps: [l.unitRef ?? ""],
      roles: [l.role],
      subjects: l.subject === null ? [] : [l.subject],
    });
  }
  const reasons = [...byReason.values()].sort(largestFirst);
  if (reasons.length <= MAX_LINES_PER_PAYEE) return reasons.map(toLine);

  // Four lines are kept for the rest, one per kind of payment, so the whole never exceeds the limit.
  const kept = reasons.slice(0, MAX_LINES_PER_PAYEE - PAYMENT_CATEGORIES.length);
  const rest = new Map<string, Group>();
  const restCount = new Map<string, number>();
  for (const g of reasons.slice(kept.length)) {
    merge(rest, g.category, { ...g, why: "" });
    restCount.set(g.category, (restCount.get(g.category) ?? 0) + 1);
  }
  const tail = [...rest.values()]
    .map((g) => {
      const n = restCount.get(g.category)!;
      return { ...g, why: `${n} more ${n === 1 ? "payment" : "payments"}: ${PAYMENT_CATEGORY_LABELS[g.category]}` };
    })
    .sort(largestFirst);
  return [...kept, ...tail].map(toLine);
}

export interface PreviewOptions {
  /** Whether the fee in the agreement was checked against the server's own fee (compile option `fee`). */
  feeVerified: boolean;
  scenarios?: readonly ScenarioResult[];
  /**
   * The server's clock, in unix seconds. With it, the preview applies the seam's two timing rules
   * (`netSplitterFor`): the agreement must be priced within [now - maxAgreementAgeSeconds, now], and its
   * offer deadline must not have passed. Without it, the deadline is shown but not judged.
   */
  now?: number;
  /** The oldest pricing the seam accepts; default DEFAULT_MAX_AGREEMENT_AGE_SECONDS (one day). */
  maxAgreementAgeSeconds?: number;
}

function utc(unixSeconds: number): string {
  return `${isoTime(unixSeconds).slice(0, 16).replace("T", " ")} UTC`;
}

function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? "a day" : `${seconds / 86_400} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? "an hour" : `${seconds / 3_600} hours`;
  return `${seconds} seconds`;
}

/** The seam's timing rules at the server's clock, in its order: the pricing window, then the deadline. */
function timingAt(ag: EconomicAgreement, options: PreviewOptions): { deadline: string; acceptableNow: boolean | null; timing: string | null } {
  const acceptBy = ag.terms.acceptBy;
  const now = options.now;
  if (now === undefined) {
    return { deadline: acceptBy === null ? "The offer has no deadline." : `The offer's deadline is ${utc(acceptBy)}.`, acceptableNow: null, timing: null };
  }
  const deadline =
    acceptBy === null ? "The offer has no deadline." : now > acceptBy ? `The offer expired at ${utc(acceptBy)}.` : `The offer expires at ${utc(acceptBy)}.`;
  const maxAge = options.maxAgreementAgeSeconds ?? DEFAULT_MAX_AGREEMENT_AGE_SECONDS;
  let timing: string | null = null;
  if (ag.asOf > now) timing = `It is priced for ${utc(ag.asOf)}, which has not come yet, so it cannot be accepted before then.`;
  else if (ag.asOf < now - maxAge) timing = `It was priced at ${utc(ag.asOf)}, more than ${duration(maxAge)} ago, so it must be quoted again before it can be accepted.`;
  else if (acceptBy !== null && now > acceptBy) timing = `This offer expired at ${utc(acceptBy)}, so it can no longer be accepted.`;
  return { deadline, acceptableNow: timing === null, timing };
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
  const byCategory = new Map<PaymentCategory, bigint>(PAYMENT_CATEGORIES.map((c) => [c, 0n] as const));
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
      lines: readableLines(linesByParty.get(partyId) ?? [], cur),
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
  const deal = (you: string) =>
    `${you} pay at most ${money(gross, cur).display}.${feeText} The rest, ${money(net, cur).display}, goes to ${partiesPaid} ${partiesPaid === 1 ? "party" : "parties"}, step by step, only as each step is released.`;
  const timing = timingAt(ag, options);
  return {
    schema: "pcc.economic-preview.v1",
    layer: "C",
    status: timing.timing === null ? "fundable" : "not-acceptable-now",
    headline: timing.timing === null ? deal("You") : `${timing.timing} As written, ${deal("you")}`,
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
      ...timing,
      changePolicy: "Any change makes a new version, which you would accept again. An accepted version never changes.",
      supersedes: ag.supersedes,
    },
    moneyState: {
      reserved: money(0n, cur),
      paid: money(0n, cur),
      note:
        timing.timing === null
          ? "Nothing is reserved or paid yet. When you accept and fund, each step's price is reserved in escrow, paid out only when that step is released, and refunded if it fails."
          : "Nothing can be reserved or paid: this version cannot be accepted now. A new version would have to be offered and accepted.",
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

/**
 * compileEconomics — EconomicAgreementV1 → exact V-next per-unit payouts, or a refusal
 * (docs/ECONOMIC_AGREEMENTS.md §3-§6).
 *
 * Pure and total: no clock, no randomness, no I/O. The same input gives byte-identical output in any
 * process. There is no partial result: either every unit compiles, or the caller gets every refusal.
 *
 * This is the ONE place PCC turns economic terms into money. It emits the V-next `PayoutEntry[]`
 * of each settlement unit and nothing else that moves money. The escrow lane's V-next compiler
 * (`@pcc/contracts` vnext) turns those into `UnitConfig[]` / `prePolicyRoot`; this module never encodes
 * an escrow structure itself.
 */

import { computeScheduleHash, evaluateRateSchedule, RateScheduleSchema } from "../types/rate-schedule.js";
import type { RateSchedule } from "../types/rate-schedule.js";
import type { CaptureClass } from "../types/capture.js";
import { canonicalize } from "../util/canonical.js";
import { BPS_DENOMINATOR, floorMulDiv, largestRemainder, maxBigint, minBigint, sumBigints } from "./exact.js";
import { cmpStr, hashNormalizedAgreement, normalizeAgreement, payeeKey } from "./hash.js";
import { comparePaths, refusal, sortRefusals, type Refusal } from "./refusals.js";
import {
  AUTHORITY_LEVELS,
  EconomicAgreementSchema,
  MAX_LEGS_PER_UNIT,
  MAX_SPLIT_DEPTH,
  MAX_UNIT_GROSS,
  MIN_UNIT_GROSS,
  ZERO_ADDRESS,
  type Authority,
  type Clause,
  type EconomicAgreement,
  type License,
  type Payee,
  type PaymentRequirement,
  type RequirableRule,
  type Rule,
  type Split,
  type Unit,
} from "./types.js";

// ── Options and result shapes ────────────────────────────────────────────────

export interface CompileOptions {
  /**
   * Addresses no payout may go to, supplied by the server: the escrow clone, the settlement token and
   * the factory (the escrow's `_requireAllowedRecipient`). The zero address is always forbidden.
   */
  forbiddenRecipients?: readonly string[];
  /** The weakest license authority a used component may rest on. Default `counterparty-accepted`. */
  authorityFloor?: Authority;
  /** Rate schedule bodies, used to verify the royalty rates clauses pinned from them. */
  schedules?: readonly RateSchedule[];
}

export interface LegAttribution {
  clauseId: string;
  partyId: string;
  path: string[];
  amount: string;
}

export interface CompiledLeg {
  recipient: string;
  amount: string;
  partyIds: string[];
  roles: string[];
  subjects: string[];
  compacted: boolean;
  attribution: LegAttribution[];
}

export interface CompiledUnit {
  unitRef: string;
  gross: string;
  fee: string;
  net: string;
  /** The V-next `PayoutEntry[]` for this unit, in leg order. Σ amount == net, exactly. */
  payouts: Array<{ recipient: string; amount: string }>;
  legs: CompiledLeg[];
  zeroLegs: Array<{ partyId: string; role: string; subject: string | null; path: string[] }>;
  clauses: Array<{ clauseId: string; amount: string }>;
}

export interface RightsReportEntry {
  licenseId: string;
  version: number;
  subject: string;
  licensor: string;
  class: License["class"];
  attributionRequired: boolean;
  authority: Authority;
  compatible: true;
}

export interface CompiledEconomics {
  ok: true;
  schema: "pcc.compiled-economics.v1";
  agreementId: string;
  version: number;
  agreementHash: `0x${string}`;
  economicTermsHash: `0x${string}`;
  rightsTermsHash: `0x${string}`;
  currency: { code: string; decimals: number };
  payer: string;
  asOf: number;
  fee: { feeBps: number; feeRecipient: string | null };
  units: CompiledUnit[];
  notEligible: Array<{ clauseId: string; reason: "component-not-used" }>;
  rights: RightsReportEntry[];
  rates: Array<{ clauseId: string; scheduleHash: string; bps: number; verified: boolean }>;
  totals: { gross: string; fee: string; net: string; byParty: Array<{ partyId: string; amount: string }> };
}

export interface CompileRefused {
  ok: false;
  refusals: Refusal[];
}

export type CompileResult = CompiledEconomics | CompileRefused;

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_AUTHORITY_FLOOR: Authority = "counterparty-accepted";

function licenseKey(l: { licenseId: string; version: number }): string {
  return `${l.licenseId}@${l.version}`;
}

function authorityRank(a: Authority): number {
  return AUTHORITY_LEVELS.indexOf(a);
}

function usesOf(unit: Unit, ref: string): bigint {
  const c = unit.components.find((x) => x.ref === ref);
  return c ? BigInt(c.uses) : 0n;
}

function unitUses(unit: Unit, ref: string): boolean {
  return unit.components.some((x) => x.ref === ref);
}

/** The units a clause pays in (§2.4). `units` are canonical (sorted by unitRef). */
export function selectUnits(c: Clause, units: readonly Unit[]): Unit[] {
  const a = c.appliesTo;
  if ("units" in a) return units.filter((u) => a.units.includes(u.unitRef));
  if ("allUnits" in a) return [...units];
  if ("usingComponent" in a) return units.filter((u) => unitUses(u, a.usingComponent));
  const first = units.find((u) => unitUses(u, a.oncePerJobUsing));
  return first ? [first] : [];
}

/**
 * Does a clause's rule meet a license's required rule? Exact equality, except `percent_by_schedule`,
 * which is met by a `percent` rule pinned from that same schedule with the same base and bounds (the
 * pinned bps itself is checked against the schedule body; see RATE_UNVERIFIED).
 */
function ruleMeetsRequirement(rule: Rule, required: RequirableRule): boolean {
  if (required.kind === "percent_by_schedule") {
    return (
      rule.kind === "percent" &&
      rule.rateSource !== null &&
      rule.rateSource.scheduleHash === required.scheduleHash &&
      rule.of === required.of &&
      rule.min === required.min &&
      rule.max === required.max
    );
  }
  return canonicalize(rule) === canonicalize(required);
}

function requiredAppliesTo(req: PaymentRequirement, subject: string): Clause["appliesTo"] {
  return req.per === "using-unit" ? { usingComponent: subject } : { oncePerJobUsing: subject };
}

/**
 * A required payment is paid either to the licensor alone, or through a split whose members are
 * exactly the licensor's declared distribution (same parties, weights, roles and subjects).
 */
function payeeMeetsRequirement(
  c: Clause,
  lic: License,
  req: PaymentRequirement,
  splitById: ReadonlyMap<string, Split>,
): boolean {
  if ("licensor" in req.payee) return "party" in c.to && c.to.party === lic.licensor;
  if (!("split" in c.to)) return false;
  const s = splitById.get(c.to.split);
  if (s === undefined) return false;
  const actual: Array<{ party: string; weight: number; role: string | null; subject: string | null }> = [];
  for (const m of s.members) {
    if (!("party" in m.to)) return false;
    actual.push({ party: m.to.party, weight: m.weight, role: m.role, subject: m.subject });
  }
  actual.sort((a, b) => cmpStr(a.party, b.party));
  return canonicalize(actual) === canonicalize(req.payee.distribution);
}

function clauseMeetsRequirement(
  c: Clause,
  lic: License,
  req: PaymentRequirement,
  splitById: ReadonlyMap<string, Split>,
): boolean {
  return (
    c.underLicense !== null &&
    c.underLicense.licenseId === lic.licenseId &&
    c.underLicense.version === lic.version &&
    payeeMeetsRequirement(c, lic, req, splitById) &&
    c.role === req.role &&
    ruleMeetsRequirement(c.rule, req.rule) &&
    canonicalize(c.appliesTo) === canonicalize(requiredAppliesTo(req, lic.subject))
  );
}

/** One refusal per (code, path), canonically ordered (§3). */
function dedupeRefusals(refusals: readonly Refusal[]): Refusal[] {
  return sortRefusals(refusals);
}

// ── Phase 2: structure ───────────────────────────────────────────────────────

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup].sort(cmpStr);
}

function checkStructure(n: EconomicAgreement, options: CompileOptions): Refusal[] {
  const out: Refusal[] = [];
  const dup = (kind: string, values: readonly string[]) => {
    for (const d of duplicates(values)) out.push(refusal("DUPLICATE_ID", `duplicate ${kind} id "${d}"`, [kind, d]));
  };
  dup("party", n.parties.map((p) => p.partyId));
  dup("unit", n.units.map((u) => u.unitRef));
  dup("split", n.splits.map((s) => s.splitId));
  dup("clause", n.clauses.map((c) => c.clauseId));
  dup("license", n.licenses.map(licenseKey));
  for (const u of n.units) {
    for (const d of duplicates(u.components.map((c) => c.ref))) {
      out.push(refusal("DUPLICATE_ID", `unit "${u.unitRef}" lists component "${d}" twice`, ["unit", u.unitRef, "component", d]));
    }
    for (const d of duplicates(u.measures.map((m) => m.key))) {
      out.push(refusal("DUPLICATE_ID", `unit "${u.unitRef}" lists measure "${d}" twice`, ["unit", u.unitRef, "measure", d]));
    }
  }
  for (const d of duplicates(n.licenses.map((l) => l.subject))) {
    out.push(
      refusal("DUPLICATE_LICENSE_SUBJECT", `more than one license covers component "${d}"`, ["license-subject", d]),
    );
  }

  const partyIds = new Set(n.parties.map((p) => p.partyId));
  const splitIds = new Set(n.splits.map((s) => s.splitId));
  const unitRefs = new Set(n.units.map((u) => u.unitRef));
  const licenseKeys = new Set(n.licenses.map(licenseKey));
  const usedComponents = new Set(n.units.flatMap((u) => u.components.map((c) => c.ref)));
  const payeeExists = (to: Payee) => ("party" in to ? partyIds.has(to.party) : splitIds.has(to.split));

  if (!partyIds.has(n.payer)) out.push(refusal("UNKNOWN_REFERENCE", `payer "${n.payer}" is not a party`, ["payer", n.payer]));
  for (const c of n.clauses) {
    if (!payeeExists(c.to)) {
      out.push(refusal("UNKNOWN_REFERENCE", `clause "${c.clauseId}" pays unknown ${payeeKey(c.to)}`, ["clause", c.clauseId, "to", payeeKey(c.to)]));
    }
    if ("units" in c.appliesTo) {
      for (const r of c.appliesTo.units) {
        if (!unitRefs.has(r)) {
          out.push(refusal("UNKNOWN_REFERENCE", `clause "${c.clauseId}" applies to unknown unit "${r}"`, ["clause", c.clauseId, "appliesTo", r]));
        }
      }
    }
    if (c.underLicense !== null && !licenseKeys.has(licenseKey(c.underLicense))) {
      out.push(
        refusal("UNKNOWN_REFERENCE", `clause "${c.clauseId}" cites unknown license ${licenseKey(c.underLicense)}`, [
          "clause",
          c.clauseId,
          "underLicense",
          licenseKey(c.underLicense),
        ]),
      );
    }
    if (c.rule.kind === "metered" || c.rule.kind === "downstream") {
      out.push(
        refusal(
          "ECONOMICS_UNDECIDED_OD4",
          `clause "${c.clauseId}" is ${c.rule.kind}: contingent cross-job economics are an open operator decision (OD-4) and are refused, not approximated`,
          ["clause", c.clauseId],
        ),
      );
    }
    if (c.rule.kind === "percent" && c.rule.min !== null && c.rule.max !== null && BigInt(c.rule.min) > BigInt(c.rule.max)) {
      out.push(refusal("INVALID_BOUNDS", `clause "${c.clauseId}" has min > max`, ["clause", c.clauseId]));
    }
  }
  for (const l of n.licenses) {
    if (!partyIds.has(l.licensor)) {
      out.push(refusal("UNKNOWN_REFERENCE", `license ${licenseKey(l)} names unknown licensor "${l.licensor}"`, ["license", licenseKey(l), "licensor", l.licensor]));
    }
    for (const req of l.requires.payments) {
      const r = req.rule;
      if ((r.kind === "percent" || r.kind === "percent_by_schedule") && r.min !== null && r.max !== null && BigInt(r.min) > BigInt(r.max)) {
        out.push(refusal("INVALID_BOUNDS", `license ${licenseKey(l)} requirement "${req.requirementId}" has min > max`, ["license", licenseKey(l), "requirement", req.requirementId]));
      }
      if ("distribution" in req.payee) {
        for (const d of req.payee.distribution) {
          if (!partyIds.has(d.party)) {
            out.push(
              refusal("UNKNOWN_REFERENCE", `license ${licenseKey(l)} requirement "${req.requirementId}" distributes to unknown party "${d.party}"`, [
                "license",
                licenseKey(l),
                "requirement",
                req.requirementId,
                "party",
                d.party,
              ]),
            );
          }
        }
      }
    }
  }
  for (const m of n.use.modifies) {
    if (!usedComponents.has(m)) {
      out.push(refusal("UNKNOWN_REFERENCE", `use.modifies names "${m}", which no unit uses`, ["use", "modifies", m]));
    }
  }

  // Splits: members exist, no duplicate member, no cycle, bounded depth.
  const splitById = new Map(n.splits.map((s) => [s.splitId, s] as const));
  for (const s of n.splits) {
    for (const d of duplicates(s.members.map((m) => payeeKey(m.to)))) {
      out.push(refusal("DUPLICATE_SPLIT_MEMBER", `split "${s.splitId}" lists ${d} twice`, ["split", s.splitId, d]));
    }
    for (const m of s.members) {
      if (!payeeExists(m.to)) {
        out.push(refusal("UNKNOWN_REFERENCE", `split "${s.splitId}" has unknown member ${payeeKey(m.to)}`, ["split", s.splitId, "member", payeeKey(m.to)]));
      }
    }
  }
  const childSplits = (s: Split) =>
    s.members.flatMap((m) => ("split" in m.to && splitById.has(m.to.split) ? [m.to.split] : []));
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [...childSplits(splitById.get(from)!)];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...childSplits(splitById.get(id)!));
    }
    return false;
  };
  let cyclic = false;
  for (const s of n.splits) {
    if (reaches(s.splitId, s.splitId)) {
      cyclic = true;
      out.push(refusal("SPLIT_CYCLE", `split "${s.splitId}" pays into itself`, ["split", s.splitId]));
    }
  }
  if (!cyclic) {
    const depth = new Map<string, number>();
    const depthOf = (id: string): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      const d = 1 + Math.max(0, ...childSplits(splitById.get(id)!).map(depthOf));
      depth.set(id, d);
      return d;
    };
    for (const s of n.splits) {
      if (depthOf(s.splitId) > MAX_SPLIT_DEPTH) {
        out.push(refusal("SPLIT_TOO_DEEP", `split "${s.splitId}" nests more than ${MAX_SPLIT_DEPTH} splits`, ["split", s.splitId]));
      }
    }
  }

  // Fee (§2): recipient present exactly when the fee is nonzero, and never a forbidden address.
  const forbidden = new Set([ZERO_ADDRESS, ...(options.forbiddenRecipients ?? []).map((a) => a.toLowerCase())]);
  if (n.fee.feeBps > 0 && n.fee.feeRecipient === null) {
    out.push(refusal("FEE_INVALID", "a nonzero fee needs a fee recipient", ["fee"]));
  } else if (n.fee.feeBps === 0 && n.fee.feeRecipient !== null) {
    out.push(refusal("FEE_INVALID", "a zero fee must not name a fee recipient", ["fee"]));
  } else if (n.fee.feeRecipient !== null && forbidden.has(n.fee.feeRecipient)) {
    out.push(refusal("FEE_INVALID", "the fee recipient is a forbidden address", ["fee", "forbidden-recipient"]));
  }

  if (n.terms.acceptBy !== null && n.asOf > n.terms.acceptBy) {
    out.push(refusal("OFFER_EXPIRED", `the offer expired at ${n.terms.acceptBy}, before asOf ${n.asOf}`, ["terms", "acceptBy"]));
  }

  // Pinned royalty rates, verified against the schedule body when the caller supplied it.
  const schedules = new Map<string, RateSchedule>();
  for (const s of options.schedules ?? []) schedules.set(s.scheduleHash.toLowerCase(), s);
  for (const c of n.clauses) {
    if (c.rule.kind !== "percent" || c.rule.rateSource === null) continue;
    const src = c.rule.rateSource;
    const body = schedules.get(src.scheduleHash);
    if (body === undefined) continue;
    if (computeScheduleHash(body).toLowerCase() !== src.scheduleHash) {
      out.push(refusal("SCHEDULE_HASH_MISMATCH", `the supplied schedule body does not hash to ${src.scheduleHash}`, ["clause", c.clauseId, "rateSource"]));
      continue;
    }
    const evaluated = evaluateRateSchedule(body, {
      now: src.evaluatedAt,
      jobValueCents: src.context.jobValueCents,
      jobsPerDay: src.context.jobsPerDay,
      captureClass: (src.context.captureClass ?? undefined) as CaptureClass | undefined,
    });
    if (evaluated.bps !== c.rule.bps) {
      out.push(
        refusal("RATE_PIN_MISMATCH", `clause "${c.clauseId}" pins ${c.rule.bps} bps but the schedule gives ${evaluated.bps} bps at the recorded moment`, [
          "clause",
          c.clauseId,
          "rateSource",
        ]),
      );
    }
  }
  return out;
}

// ── Phase 3: rights ──────────────────────────────────────────────────────────

function checkRights(
  n: EconomicAgreement,
  options: CompileOptions,
): { refusals: Refusal[]; report: RightsReportEntry[] } {
  const out: Refusal[] = [];
  const report: RightsReportEntry[] = [];
  const floor = options.authorityFloor ?? DEFAULT_AUTHORITY_FLOOR;
  const used = [...new Set(n.units.flatMap((u) => u.components.map((c) => c.ref)))].sort(cmpStr);
  const bySubject = new Map(n.licenses.map((l) => [l.subject, l] as const));
  const splitById = new Map(n.splits.map((s) => [s.splitId, s] as const));
  const suppliedSchedules = new Set((options.schedules ?? []).map((s) => s.scheduleHash.toLowerCase()));
  const use = n.use;

  for (const ref of used) {
    const lic = bySubject.get(ref);
    if (lic === undefined) {
      out.push(refusal("RIGHTS_UNKNOWN", `no license covers component "${ref}"; unknown rights are refused, never assumed`, ["component", ref]));
      continue;
    }
    const key = licenseKey(lic);
    const before = out.length;
    if ((lic.validFrom !== null && n.asOf < lic.validFrom) || (lic.validUntil !== null && n.asOf >= lic.validUntil)) {
      out.push(refusal("LICENSE_NOT_IN_FORCE", `license ${key} is not in force at ${n.asOf}`, ["component", ref, key]));
    }
    if (authorityRank(lic.authority) < authorityRank(floor)) {
      out.push(
        refusal("AUTHORITY_BELOW_FLOOR", `license ${key} rests on "${lic.authority}" authority, below the floor "${floor}"`, ["component", ref, key]),
      );
    }
    const incompatible = (condition: string, message: string) =>
      out.push(refusal("RIGHTS_INCOMPATIBLE", `license ${key}: ${message}`, ["component", ref, key, condition]));
    if (use.commercial && (!lic.grants.commercialUse || lic.class === "noncommercial")) {
      incompatible("commercial-use", "commercial use is not granted");
    }
    if (use.composite && !lic.grants.compose) incompatible("compose", "composition into another capability is not granted");
    if (use.resell && !lic.grants.resell) incompatible("resell", "resale is not granted");
    if (use.modifies.includes(ref) && !lic.grants.modify) incompatible("modify", "modification is not granted");
    if (!lic.grants.fieldsOfUse.includes("*") && !lic.grants.fieldsOfUse.includes(use.fieldOfUse)) {
      incompatible("field-of-use", `field of use "${use.fieldOfUse}" is not granted`);
    }
    if (!lic.grants.regions.includes("*") && !lic.grants.regions.includes(use.region)) {
      incompatible("region", `region "${use.region}" is not granted`);
    }
    if (
      lic.class === "share-alike" &&
      (use.modifies.includes(ref) || use.resell) &&
      !(use.outbound.class === "share-alike" && use.outbound.shareAlikeTag === lic.shareAlikeTag)
    ) {
      incompatible("share-alike", `share-alike "${lic.shareAlikeTag}" requires the composite to be offered under the same share-alike terms`);
    }
    for (const req of lic.requires.payments) {
      if (!n.clauses.some((c) => clauseMeetsRequirement(c, lic, req, splitById))) {
        out.push(
          refusal("LICENSE_PAYMENT_MISSING", `license ${key} requires payment "${req.requirementId}" and no clause provides it`, [
            "license",
            key,
            req.requirementId,
          ]),
        );
      } else if (req.rule.kind === "percent_by_schedule" && !suppliedSchedules.has(req.rule.scheduleHash)) {
        // The license names a schedule, not a number: without the body nobody can confirm the pinned
        // rate is the schedule's rate, so a composer could pin a lower one. Refuse until it is checked.
        out.push(
          refusal("RATE_UNVERIFIED", `license ${key} requires the rate of schedule ${req.rule.scheduleHash}, which was not supplied to verify the pinned rate`, [
            "license",
            key,
            req.requirementId,
          ]),
        );
      }
    }
    if (out.length === before) {
      report.push({
        licenseId: lic.licenseId,
        version: lic.version,
        subject: lic.subject,
        licensor: lic.licensor,
        class: lic.class,
        attributionRequired: lic.requires.attribution,
        authority: lic.authority,
        compatible: true,
      });
    }
  }

  const byKey = new Map(n.licenses.map((l) => [licenseKey(l), l] as const));
  for (const c of n.clauses) {
    if (c.underLicense === null) continue;
    const lic = byKey.get(licenseKey(c.underLicense));
    if (lic === undefined) continue; // reported in the structure phase
    if (!lic.requires.payments.some((req) => clauseMeetsRequirement(c, lic, req, splitById))) {
      out.push(
        refusal("LICENSE_PAYMENT_UNMATCHED", `clause "${c.clauseId}" is attributed to license ${licenseKey(lic)}, which does not require it`, [
          "clause",
          c.clauseId,
          licenseKey(lic),
        ]),
      );
    }
  }
  report.sort((a, b) => cmpStr(a.licenseId, b.licenseId) || a.version - b.version);
  return { refusals: out, report };
}

// ── Phase 4: money ───────────────────────────────────────────────────────────

interface Allocation {
  clauseId: string;
  partyId: string;
  role: string;
  subject: string | null;
  path: string[];
  amount: bigint;
}

interface LegDraft {
  recipient: string;
  amount: bigint;
  roles: string[];
  subjects: string[];
  compacted: boolean;
  allocations: Allocation[];
}

function legSortKey(l: LegDraft): [string, string, string] {
  return [l.recipient, l.roles.join("+"), l.subjects.join("+")];
}

function finishLeg(l: LegDraft): CompiledLeg {
  const attribution = [...l.allocations]
    .sort((a, b) => cmpStr(a.clauseId, b.clauseId) || comparePaths(a.path, b.path) || cmpStr(a.partyId, b.partyId))
    .map((a) => ({ clauseId: a.clauseId, partyId: a.partyId, path: a.path, amount: a.amount.toString() }));
  return {
    recipient: l.recipient,
    amount: l.amount.toString(),
    partyIds: [...new Set(l.allocations.map((a) => a.partyId))].sort(cmpStr),
    roles: l.roles,
    subjects: l.subjects,
    compacted: l.compacted,
    attribution,
  };
}

function compileUnit(
  n: EconomicAgreement,
  unit: Unit,
  applicable: readonly Clause[],
  forbidden: ReadonlySet<string>,
  out: Refusal[],
): { unit: CompiledUnit; allocations: Allocation[] } | null {
  const at = (...rest: string[]) => ["unit", unit.unitRef, ...rest];
  const G = BigInt(unit.gross);
  if (G < MIN_UNIT_GROSS || G > MAX_UNIT_GROSS) {
    out.push(refusal("GROSS_OUT_OF_RANGE", `unit "${unit.unitRef}" gross ${G} is outside [${MIN_UNIT_GROSS}, 2^128-1]`, at()));
    return null;
  }
  const F = floorMulDiv(G, BigInt(n.fee.feeBps), BPS_DENOMINATOR);
  const N = G - F; // > 0: G >= 5 and feeBps <= 1000 leave at least 90% of G.

  const amounts = new Map<string, bigint>();
  const before = out.length;

  for (const c of applicable) {
    const r = c.rule;
    if (r.kind === "fixed") {
      amounts.set(c.clauseId, BigInt(r.amount));
    } else if (r.kind === "per_use") {
      let q: bigint;
      if ("component" in r.per) {
        q = usesOf(unit, r.per.component);
      } else {
        const key = r.per.measure;
        const m = unit.measures.find((x) => x.key === key);
        if (m === undefined) {
          out.push(refusal("UNKNOWN_MEASURE", `clause "${c.clauseId}" prices per "${key}", which unit "${unit.unitRef}" does not measure`, at("clause", c.clauseId, key)));
          continue;
        }
        q = BigInt(m.value);
      }
      let a = BigInt(r.rate) * q;
      if (r.cap !== null) a = minBigint(a, BigInt(r.cap));
      amounts.set(c.clauseId, a);
    } else if (r.kind === "pass_through") {
      const cost = BigInt(r.cost);
      amounts.set(c.clauseId, cost + floorMulDiv(cost, BigInt(r.markupBps), BPS_DENOMINATOR));
    }
  }

  for (const base of ["gross", "net"] as const) {
    const group = applicable.filter((c) => c.rule.kind === "percent" && c.rule.of === base);
    if (group.length === 0) continue;
    const bps = group.map((c) => BigInt((c.rule as Extract<Rule, { kind: "percent" }>).bps));
    const sumBps = sumBigints(bps);
    if (sumBps > BPS_DENOMINATOR) {
      out.push(refusal("OVER_ALLOCATED", `percentages of ${base} in unit "${unit.unitRef}" add up to ${sumBps} bps, over 10000`, at(`percent-${base}`)));
      continue;
    }
    const baseAmount = base === "gross" ? G : N;
    // The rest claimant (never paid) takes the unclaimed share and loses every tie (§4.3).
    const shares = largestRemainder(
      baseAmount,
      [...bps, BPS_DENOMINATOR - sumBps],
      [...group.map((_, i) => i), group.length],
    );
    group.forEach((c, i) => {
      const r = c.rule as Extract<Rule, { kind: "percent" }>;
      let a = shares[i]!;
      if (r.min !== null) a = maxBigint(a, BigInt(r.min));
      if (r.max !== null) a = minBigint(a, BigInt(r.max));
      amounts.set(c.clauseId, a);
    });
  }
  if (out.length > before) return null;

  const residuals = applicable.filter((c) => c.rule.kind === "residual");
  const spent = sumBigints(applicable.filter((c) => c.rule.kind !== "residual").map((c) => amounts.get(c.clauseId)!));
  const rest = N - spent;
  if (rest < 0n) {
    out.push(refusal("OVER_ALLOCATED", `unit "${unit.unitRef}" owes ${spent} but its net after the fee is ${N}`, at()));
    return null;
  }
  if (residuals.length > 1) {
    out.push(refusal("MULTIPLE_RESIDUALS", `unit "${unit.unitRef}" has ${residuals.length} residual clauses; at most one may take what is left`, at()));
    return null;
  }
  if (rest > 0n && residuals.length === 0) {
    out.push(
      refusal("UNALLOCATED_REMAINDER", `unit "${unit.unitRef}" leaves ${rest} unallocated and names no residual recipient; nobody is paid by default`, at()),
    );
    return null;
  }
  if (residuals.length === 1) amounts.set(residuals[0]!.clauseId, rest);

  // Pay each clause amount to its party, or down through its splits (§4.5).
  const splitById = new Map(n.splits.map((s) => [s.splitId, s] as const));
  const allocations: Allocation[] = [];
  const expand = (to: Payee, amount: bigint, path: string[], role: string, subject: string | null, clauseId: string) => {
    if ("party" in to) {
      allocations.push({ clauseId, partyId: to.party, role, subject, path, amount });
      return;
    }
    const s = splitById.get(to.split)!;
    const shares = largestRemainder(
      amount,
      s.members.map((m) => BigInt(m.weight)),
      s.members.map((_, i) => i), // members are sorted by target key, so the index is the tie rank
    );
    s.members.forEach((m, i) => {
      expand(m.to, shares[i]!, [...path, s.splitId], m.role ?? role, m.subject ?? subject, clauseId);
    });
  };
  for (const c of applicable) expand(c.to, amounts.get(c.clauseId)!, [c.clauseId], c.role, c.subject, c.clauseId);

  // Resolve addresses (§4.6 step 1). Only positive allocations are payments.
  const partyById = new Map(n.parties.map((p) => [p.partyId, p] as const));
  const payTo = new Map<string, string>();
  for (const a of allocations) {
    if (a.amount === 0n) continue;
    const p = partyById.get(a.partyId)!;
    if (p.payTo === null) {
      out.push(refusal("UNRESOLVED_PARTY", `party "${p.partyId}" is owed ${a.amount} in unit "${unit.unitRef}" but has no payout address`, at("party", p.partyId)));
    } else if (forbidden.has(p.payTo)) {
      out.push(refusal("FORBIDDEN_RECIPIENT", `party "${p.partyId}" pays to a forbidden address`, at("party", p.partyId)));
    } else {
      payTo.set(a.partyId, p.payTo);
    }
  }
  if (out.length > before) return null;

  // Legs: one per (payTo, role, subject) (§4.6 step 2).
  const byIdentity = new Map<string, LegDraft>();
  const zeroLegs: CompiledUnit["zeroLegs"] = [];
  for (const a of allocations) {
    if (a.amount === 0n) {
      zeroLegs.push({ partyId: a.partyId, role: a.role, subject: a.subject, path: a.path });
      continue;
    }
    const recipient = payTo.get(a.partyId)!;
    const key = `${recipient}|${a.role}|${a.subject ?? ""}`;
    const leg = byIdentity.get(key);
    if (leg === undefined) {
      byIdentity.set(key, {
        recipient,
        amount: a.amount,
        roles: [a.role],
        subjects: a.subject === null ? [] : [a.subject],
        compacted: false,
        allocations: [a],
      });
    } else {
      leg.amount += a.amount;
      leg.allocations.push(a);
    }
  }
  let legs = [...byIdentity.values()];

  // Compaction (§4.6 step 4): only when the escrow's 16-leg limit would otherwise be exceeded.
  if (legs.length > MAX_LEGS_PER_UNIT) {
    const byRecipient = new Map<string, LegDraft[]>();
    for (const l of legs) byRecipient.set(l.recipient, [...(byRecipient.get(l.recipient) ?? []), l]);
    legs = [...byRecipient.entries()].map(([recipient, group]) =>
      group.length === 1
        ? group[0]!
        : {
            recipient,
            amount: sumBigints(group.map((g) => g.amount)),
            roles: [...new Set(group.flatMap((g) => g.roles))].sort(cmpStr),
            subjects: [...new Set(group.flatMap((g) => g.subjects))].sort(cmpStr),
            compacted: true,
            allocations: group.flatMap((g) => g.allocations),
          },
    );
    if (legs.length > MAX_LEGS_PER_UNIT) {
      out.push(
        refusal("TOO_MANY_LEGS", `unit "${unit.unitRef}" pays ${legs.length} distinct addresses; the escrow allows ${MAX_LEGS_PER_UNIT}`, at()),
      );
      return null;
    }
  }

  legs.sort((a, b) => {
    const ka = legSortKey(a);
    const kb = legSortKey(b);
    return cmpStr(ka[0], kb[0]) || cmpStr(ka[1], kb[1]) || cmpStr(ka[2], kb[2]);
  });

  const paid = sumBigints(legs.map((l) => l.amount));
  if (paid !== N || legs.length === 0 || legs.some((l) => l.amount <= 0n)) {
    // Unreachable by construction (every clause amount is fully apportioned and rest goes to the
    // residual); asserted so a future edit that breaks conservation cannot emit a payout.
    throw new Error(`compileEconomics: conservation violated in unit "${unit.unitRef}" (${paid} != ${N})`);
  }

  zeroLegs.sort(
    (a, b) =>
      cmpStr(a.partyId, b.partyId) ||
      cmpStr(a.role, b.role) ||
      cmpStr(a.subject ?? "", b.subject ?? "") ||
      comparePaths(a.path, b.path),
  );

  const compiledLegs = legs.map(finishLeg);
  return {
    unit: {
      unitRef: unit.unitRef,
      gross: G.toString(),
      fee: F.toString(),
      net: N.toString(),
      payouts: compiledLegs.map((l) => ({ recipient: l.recipient, amount: l.amount })),
      legs: compiledLegs,
      zeroLegs,
      clauses: applicable.map((c) => ({ clauseId: c.clauseId, amount: amounts.get(c.clauseId)!.toString() })),
    },
    allocations,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Compile an agreement. `input` is untrusted: it is schema-checked first, and nothing is assumed
 * from it that the schema did not establish.
 */
export function compileEconomics(input: unknown, options: CompileOptions = {}): CompileResult {
  const parsed = EconomicAgreementSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      refusals: dedupeRefusals(
        parsed.error.issues.map((i) => refusal("SCHEMA_INVALID", i.message, i.path.map((p) => String(p)))),
      ),
    };
  }
  for (const s of options.schedules ?? []) {
    const ok = RateScheduleSchema.safeParse(s);
    if (!ok.success) {
      return { ok: false, refusals: [refusal("SCHEMA_INVALID", "a supplied rate schedule is malformed", ["options", "schedules"])] };
    }
  }
  const n = normalizeAgreement(parsed.data);

  const structural = checkStructure(n, options);
  if (structural.length > 0) return { ok: false, refusals: dedupeRefusals(structural) };

  const rights = checkRights(n, options);
  if (rights.refusals.length > 0) return { ok: false, refusals: dedupeRefusals(rights.refusals) };

  const forbidden = new Set([ZERO_ADDRESS, ...(options.forbiddenRecipients ?? []).map((a) => a.toLowerCase())]);
  const selected = new Map(n.clauses.map((c) => [c.clauseId, selectUnits(c, n.units)] as const));
  const money: Refusal[] = [];
  const units: CompiledUnit[] = [];
  const allAllocations: Allocation[] = [];
  for (const unit of n.units) {
    const applicable = n.clauses.filter((c) => selected.get(c.clauseId)!.some((u) => u.unitRef === unit.unitRef));
    const compiled = compileUnit(n, unit, applicable, forbidden, money);
    if (compiled !== null) {
      units.push(compiled.unit);
      allAllocations.push(...compiled.allocations);
    }
  }
  if (money.length > 0) return { ok: false, refusals: dedupeRefusals(money) };

  const byParty = new Map<string, bigint>();
  for (const a of allAllocations) {
    if (a.amount > 0n) byParty.set(a.partyId, (byParty.get(a.partyId) ?? 0n) + a.amount);
  }
  // A supplied body for a pinned rate was verified in the structure phase (a mismatch refuses there).
  const suppliedSchedules = new Set((options.schedules ?? []).map((s) => s.scheduleHash.toLowerCase()));
  const hashes = hashNormalizedAgreement(n);
  return {
    ok: true,
    schema: "pcc.compiled-economics.v1",
    agreementId: n.agreementId,
    version: n.version,
    ...hashes,
    currency: n.currency,
    payer: n.payer,
    asOf: n.asOf,
    fee: n.fee,
    units,
    notEligible: n.clauses
      .filter((c) => selected.get(c.clauseId)!.length === 0)
      .map((c) => ({ clauseId: c.clauseId, reason: "component-not-used" as const })),
    rights: rights.report,
    rates: n.clauses.flatMap((c) =>
      c.rule.kind === "percent" && c.rule.rateSource !== null
        ? [
            {
              clauseId: c.clauseId,
              scheduleHash: c.rule.rateSource.scheduleHash,
              bps: c.rule.bps,
              verified: suppliedSchedules.has(c.rule.rateSource.scheduleHash),
            },
          ]
        : [],
    ),
    totals: {
      gross: sumBigints(units.map((u) => BigInt(u.gross))).toString(),
      fee: sumBigints(units.map((u) => BigInt(u.fee))).toString(),
      net: sumBigints(units.map((u) => BigInt(u.net))).toString(),
      byParty: [...byParty.entries()]
        .sort((a, b) => cmpStr(a[0], b[0]))
        .map(([partyId, amount]) => ({ partyId, amount: amount.toString() })),
    },
  };
}

/**
 * compileEconomics — EconomicAgreementV1 → exact V-next per-unit payouts, or a refusal
 * (docs/ECONOMIC_AGREEMENTS.md §3-§6).
 *
 * Pure and total: no clock, no randomness, no I/O, and it never throws on any input or options. The same
 * input gives byte-identical output in any process. There is no partial result: either every unit
 * compiles, or the caller gets every refusal.
 *
 * This is the ONE place PCC turns economic terms into money. It emits the V-next `PayoutEntry[]`
 * of each settlement unit and nothing else that moves money. The escrow lane's V-next compiler
 * (`@pcc/contracts` vnext) turns those into `UnitConfig[]` / `prePolicyRoot`; this module never encodes
 * an escrow structure itself.
 */

import { z } from "zod";
import { assertScheduleIsWellFormed, computeScheduleHash, RateScheduleSchema } from "../types/rate-schedule.js";
import type { RateSchedule } from "../types/rate-schedule.js";
import { canonicalize } from "../util/canonical.js";
import { BPS_DENOMINATOR, floorMulDiv, largestRemainder, maxBigint, minBigint, sumBigints } from "./exact.js";
import { cmpStr, hashNormalizedAgreement, normalizeAgreement, payeeKey } from "./hash.js";
import { snapshotJson } from "./input.js";
import { CAPTURE_CLASS_IDS, evaluateScheduleExact, valueInCents, type CaptureClassId } from "./rates.js";
import { comparePaths, refusal, sortRefusals, type Refusal } from "./refusals.js";
import {
  AddressSchema,
  AUTHORITY_LEVELS,
  AuthoritySchema,
  EconomicAgreementSchema,
  MAX_AGREEMENT_ALLOCATIONS,
  MAX_FEE_BPS,
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
  type Rule,
  type Split,
  type Unit,
} from "./types.js";

// ── Options and result shapes ────────────────────────────────────────────────

/** Everything here comes from the server, never from the agreement's author (§3, "Options"). */
export interface CompileOptions {
  /**
   * Addresses no payout may go to: the escrow clone, the settlement token and the factory (the escrow's
   * `_requireAllowedRecipient`). The zero address is always forbidden.
   */
  forbiddenRecipients?: readonly string[];
  /** The weakest license authority a used component may rest on. Default `counterparty-accepted`. */
  authorityFloor?: Authority;
  /** Sealed rate schedule bodies, used to verify the royalty rates clauses pinned from them. */
  schedules?: readonly RateSchedule[];
  /** The protocol fee the server charges. When given, the agreement's fee must be exactly this. */
  fee?: { feeBps: number; feeRecipient: string | null };
  /** Facts some rate schedules depend on, which only the server knows (§2.4, "Pinned rates"). */
  rateFacts?: { jobsPerDay?: number | null; captureClass?: CaptureClassId | null };
}

export const CompileOptionsSchema = z
  .object({
    forbiddenRecipients: z.array(AddressSchema).max(64).optional(),
    authorityFloor: AuthoritySchema.optional(),
    schedules: z.array(RateScheduleSchema).max(64).optional(),
    fee: z
      .object({ feeBps: z.number().int().min(0).max(MAX_FEE_BPS), feeRecipient: AddressSchema.nullable() })
      .strict()
      .refine((f) => (f.feeBps > 0) === (f.feeRecipient !== null), "a nonzero fee has a recipient, and a zero fee has none")
      .optional(),
    rateFacts: z
      .object({
        jobsPerDay: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
        captureClass: z.enum(CAPTURE_CLASS_IDS).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    // A body is trusted only for the hash it actually has, so a repeated or mislabeled body can never
    // make the result depend on the order the server listed them in.
    (o.schedules ?? []).forEach((s, i) => {
      if (computeScheduleHash(s).toLowerCase() !== s.scheduleHash.toLowerCase()) {
        ctx.addIssue({ code: "custom", message: `schedule ${s.scheduleHash} does not hash to its scheduleHash`, path: ["schedules", i] });
      }
      try {
        assertScheduleIsWellFormed(s);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: `schedule ${s.scheduleHash} is malformed: ${(e as Error).message}`, path: ["schedules", i] });
      }
    });
  });
type ParsedOptions = z.infer<typeof CompileOptionsSchema>;

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
  return units.filter((u) => unitUses(u, a.oncePerAgreementUsing));
}

/** A zod error as one informative line (messages never carry a refusal's identity, §3). */
function describeIssues(error: z.ZodError, limit = 20): string {
  const parts = error.issues
    .slice(0, limit)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`);
  if (error.issues.length > limit) parts.push(`and ${error.issues.length - limit} more`);
  return parts.join("; ");
}

// ── License requirements, matched one to one (§4.1 step 5) ──────────────────

/** What a requirement asks for, as a comparable key. */
function requirementKey(lic: License, q: PaymentRequirement): string {
  return canonicalize({
    payee: "licensor" in q.payee ? { party: lic.licensor } : { distribution: q.payee.distribution },
    role: q.role,
    per: q.per,
    rule:
      q.rule.kind === "percent_by_schedule"
        ? { bySchedule: { scheduleHash: q.rule.scheduleHash, of: q.rule.of, min: q.rule.min, max: q.rule.max } }
        : { exact: q.rule },
  });
}

/**
 * The same key for a clause attributed to `lic`, or null when the clause cannot meet any requirement of
 * it: it must be about the license's subject, apply exactly where the requirement applies, and pay the
 * licensor directly or through a split of parties that is exactly the declared distribution.
 */
function clauseKey(c: Clause, lic: License, splitById: ReadonlyMap<string, Split>): string | null {
  if (c.subject !== lic.subject) return null;
  const a = c.appliesTo;
  const per =
    "usingComponent" in a && a.usingComponent === lic.subject
      ? "using-unit"
      : "oncePerAgreementUsing" in a && a.oncePerAgreementUsing === lic.subject
        ? "agreement"
        : null;
  if (per === null) return null;
  let payee: { party: string } | { distribution: Array<{ party: string; weight: number; role: string | null; subject: string | null }> };
  if ("party" in c.to) {
    payee = { party: c.to.party };
  } else {
    const s = splitById.get(c.to.split);
    if (s === undefined) return null;
    const distribution: Array<{ party: string; weight: number; role: string | null; subject: string | null }> = [];
    for (const m of s.members) {
      if (!("party" in m.to)) return null;
      distribution.push({ party: m.to.party, weight: m.weight, role: m.role, subject: m.subject });
    }
    distribution.sort((x, y) => cmpStr(x.party, y.party));
    payee = { distribution };
  }
  const r = c.rule;
  const rule =
    r.kind === "percent" && r.rateSource !== null
      ? { bySchedule: { scheduleHash: r.rateSource.scheduleHash, of: r.of, min: r.min, max: r.max } }
      : { exact: r };
  return canonicalize({ payee, role: c.role, per, rule });
}

interface LicenseMatch {
  /** Requirement ↔ clause pairs. */
  pairs: Array<{ requirementId: string; clauseId: string }>;
  /** Requirements no clause is left to meet. */
  missing: string[];
  /** Clauses attributed to the license that meet none of its requirements, or one already met. */
  unmatched: string[];
}

/**
 * Requirements and the clauses attributed to a license are paired one to one. Within one key, the i-th
 * requirement (by requirementId) pairs with the i-th clause (by clauseId). Two identical requirements
 * therefore need two clauses, and a second clause for one requirement is not a payment the license asked
 * for.
 */
function matchLicense(n: EconomicAgreement, lic: License, splitById: ReadonlyMap<string, Split>): LicenseMatch {
  const key = licenseKey(lic);
  const requirements = new Map<string, string[]>();
  for (const q of lic.requires.payments) {
    const k = requirementKey(lic, q);
    requirements.set(k, [...(requirements.get(k) ?? []), q.requirementId]);
  }
  const candidates = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const c of n.clauses) {
    if (c.underLicense === null || licenseKey(c.underLicense) !== key) continue;
    const k = clauseKey(c, lic, splitById);
    if (k === null || !requirements.has(k)) unmatched.push(c.clauseId);
    else candidates.set(k, [...(candidates.get(k) ?? []), c.clauseId]);
  }
  const pairs: LicenseMatch["pairs"] = [];
  const missing: string[] = [];
  for (const [k, requirementIds] of requirements) {
    const clauseIds = candidates.get(k) ?? [];
    requirementIds.forEach((requirementId, i) => {
      if (i < clauseIds.length) pairs.push({ requirementId, clauseId: clauseIds[i]! });
      else missing.push(requirementId);
    });
    unmatched.push(...clauseIds.slice(requirementIds.length));
  }
  return { pairs, missing, unmatched };
}

// ── Phase 2: structure ───────────────────────────────────────────────────────

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup].sort(cmpStr);
}

type PinStatus = "verified" | "unverifiable" | "no-body" | "not-evaluated";

/**
 * Pinned royalty rates (§2.4). A clause's bps must equal the schedule's rate at the agreement's `asOf`,
 * for the value of every unit the clause pays in, with the server's rate facts. The clause's own
 * `evaluatedAt` and `context` are the quoting side's record and are not trusted. A clause that names a
 * rate source and pays in some unit must be verified: without the schedule body, or on a segment that
 * cannot be evaluated exactly, it is refused (RATE_UNVERIFIED), whether or not a license requires it.
 * A clause that pays in no unit is never evaluated, so its pin is not verified: nothing was compared.
 */
function checkPins(
  n: EconomicAgreement,
  o: ParsedOptions,
  selected: ReadonlyMap<string, Unit[]>,
): { refusals: Refusal[]; status: Map<string, PinStatus> } {
  const out: Refusal[] = [];
  const status = new Map<string, PinStatus>();
  const bodies = new Map<string, RateSchedule>();
  for (const s of o.schedules ?? []) bodies.set(s.scheduleHash.toLowerCase(), s);
  for (const c of n.clauses) {
    if (c.rule.kind !== "percent" || c.rule.rateSource === null) continue;
    const units = selected.get(c.clauseId) ?? [];
    if (units.length === 0) {
      status.set(c.clauseId, "not-evaluated");
      continue;
    }
    const body = bodies.get(c.rule.rateSource.scheduleHash);
    if (body === undefined) {
      status.set(c.clauseId, "no-body");
      out.push(
        refusal("RATE_UNVERIFIED", `clause "${c.clauseId}" pins a rate from schedule ${c.rule.rateSource.scheduleHash}, which was not supplied to check it`, [
          "clause",
          c.clauseId,
          "rateSource",
        ]),
      );
      continue;
    }
    let unverifiable = false;
    const mismatches: string[] = [];
    for (const u of units) {
      const r = evaluateScheduleExact(body, {
        now: n.asOf,
        valueCents: valueInCents(BigInt(u.gross), n.currency.decimals),
        jobsPerDay: o.rateFacts?.jobsPerDay ?? null,
        captureClass: o.rateFacts?.captureClass ?? null,
      });
      if (!r.ok) unverifiable = true;
      else if (r.bps !== c.rule.bps) mismatches.push(`${r.bps} bps in unit "${u.unitRef}"`);
    }
    if (mismatches.length > 0) {
      out.push(
        refusal("RATE_PIN_MISMATCH", `clause "${c.clauseId}" pins ${c.rule.bps} bps but the schedule gives ${mismatches.join(", ")} at asOf ${n.asOf}`, [
          "clause",
          c.clauseId,
          "rateSource",
        ]),
      );
    } else if (unverifiable) {
      out.push(
        refusal("RATE_UNVERIFIED", `clause "${c.clauseId}" pins a rate whose schedule segment at asOf cannot be evaluated exactly with the facts supplied`, [
          "clause",
          c.clauseId,
          "rateSource",
        ]),
      );
    }
    status.set(c.clauseId, unverifiable ? "unverifiable" : "verified");
  }
  return { refusals: out, status };
}

/**
 * The number of allocations the money phase would make: over every unit, over every clause applicable
 * there, the number of paths from the clause's payee down to a party. Counted with saturation, so the
 * count itself is cheap however large the true number is. Only called on an acyclic split graph.
 */
function countAllocations(n: EconomicAgreement, selected: ReadonlyMap<string, Unit[]>, splitById: ReadonlyMap<string, Split>): number {
  const cap = MAX_AGREEMENT_ALLOCATIONS + 1;
  const memo = new Map<string, number>();
  const paths = (to: Payee): number => {
    if ("party" in to) return 1;
    const s = splitById.get(to.split);
    if (s === undefined) return 1; // an unknown split is refused as UNKNOWN_REFERENCE
    const known = memo.get(s.splitId);
    if (known !== undefined) return known;
    let total = 0;
    for (const m of s.members) total = Math.min(cap, total + paths(m.to));
    memo.set(s.splitId, total);
    return total;
  };
  let total = 0;
  for (const c of n.clauses) {
    const k = selected.get(c.clauseId)?.length ?? 0;
    if (k > 0) total = Math.min(cap, total + Math.min(cap, k * paths(c.to)));
  }
  return total;
}

function checkStructure(
  n: EconomicAgreement,
  o: ParsedOptions,
  selected: ReadonlyMap<string, Unit[]>,
): { refusals: Refusal[]; pins: Map<string, PinStatus> } {
  const out: Refusal[] = [];
  let anyDuplicate = false;
  const dup = (kind: string, values: readonly string[]) => {
    for (const d of duplicates(values)) {
      anyDuplicate = true;
      out.push(refusal("DUPLICATE_ID", `duplicate ${kind} id "${d}"`, [kind, d]));
    }
  };
  dup("party", n.parties.map((p) => p.partyId));
  dup("unit", n.units.map((u) => u.unitRef));
  dup("split", n.splits.map((s) => s.splitId));
  dup("clause", n.clauses.map((c) => c.clauseId));
  dup("license", n.licenses.map(licenseKey));
  for (const u of n.units) {
    for (const d of duplicates(u.components.map((c) => c.ref))) {
      anyDuplicate = true;
      out.push(refusal("DUPLICATE_ID", `unit "${u.unitRef}" lists component "${d}" twice`, ["unit", u.unitRef, "component", d]));
    }
    for (const d of duplicates(u.measures.map((m) => m.key))) {
      anyDuplicate = true;
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

  // Splits: members exist, no duplicate member, no cycle, bounded depth, bounded fan-out.
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
  // Which object a duplicated id means is undefined, so the checks that resolve ids through the split
  // graph or the clause selection (cycles, depth, allocation count, pinned rates) run only when every
  // id is unique. Otherwise their result would depend on the order of the input (§3).
  let cyclic = false;
  if (!anyDuplicate) {
    for (const s of n.splits) {
      if (reaches(s.splitId, s.splitId)) {
        cyclic = true;
        out.push(refusal("SPLIT_CYCLE", `split "${s.splitId}" pays into itself`, ["split", s.splitId]));
      }
    }
  }
  if (!anyDuplicate && !cyclic) {
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
    const allocations = countAllocations(n, selected, splitById);
    if (allocations > MAX_AGREEMENT_ALLOCATIONS) {
      out.push(
        refusal(
          "TOO_MANY_ALLOCATIONS",
          `paying every clause through its splits takes more than ${MAX_AGREEMENT_ALLOCATIONS} allocations; shared splits multiply per level`,
          [],
        ),
      );
    }
  }

  // Fee (§2): recipient present exactly when the fee is nonzero, never a forbidden address, and, when
  // the server states its fee, exactly that fee. At most one refusal, the first that applies.
  const forbidden = new Set([ZERO_ADDRESS, ...(o.forbiddenRecipients ?? []).map((a) => a.toLowerCase())]);
  if (n.fee.feeBps > 0 && n.fee.feeRecipient === null) {
    out.push(refusal("FEE_INVALID", "a nonzero fee needs a fee recipient", ["fee"]));
  } else if (n.fee.feeBps === 0 && n.fee.feeRecipient !== null) {
    out.push(refusal("FEE_INVALID", "a zero fee must not name a fee recipient", ["fee"]));
  } else if (n.fee.feeRecipient !== null && forbidden.has(n.fee.feeRecipient)) {
    out.push(refusal("FEE_INVALID", "the fee recipient is a forbidden address", ["fee", "forbidden-recipient"]));
  } else if (
    o.fee !== undefined &&
    (n.fee.feeBps !== o.fee.feeBps || n.fee.feeRecipient !== (o.fee.feeRecipient === null ? null : o.fee.feeRecipient.toLowerCase()))
  ) {
    out.push(refusal("FEE_INVALID", "the agreement's fee is not the fee the server charges", ["fee", "server-fee"]));
  }

  if (n.terms.acceptBy !== null && n.asOf > n.terms.acceptBy) {
    out.push(refusal("OFFER_EXPIRED", `the offer expired at ${n.terms.acceptBy}, before asOf ${n.asOf}`, ["terms", "acceptBy"]));
  }

  if (anyDuplicate) return { refusals: out, pins: new Map() };
  const pins = checkPins(n, o, selected);
  out.push(...pins.refusals);
  return { refusals: out, pins: pins.status };
}

// ── Phase 3: rights ──────────────────────────────────────────────────────────

function checkRights(n: EconomicAgreement, o: ParsedOptions): { refusals: Refusal[]; report: RightsReportEntry[] } {
  const out: Refusal[] = [];
  const report: RightsReportEntry[] = [];
  const floor = o.authorityFloor ?? DEFAULT_AUTHORITY_FLOOR;
  const used = [...new Set(n.units.flatMap((u) => u.components.map((c) => c.ref)))].sort(cmpStr);
  const bySubject = new Map(n.licenses.map((l) => [l.subject, l] as const));
  const splitById = new Map(n.splits.map((s) => [s.splitId, s] as const));
  const matches = new Map(n.licenses.map((l) => [licenseKey(l), matchLicense(n, l, splitById)] as const));
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
    // use.commercial is always true (schema): every compiled deal is paid work.
    if (!lic.grants.commercialUse || lic.class === "noncommercial") {
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
    const m = matches.get(key)!;
    for (const requirementId of m.missing) {
      out.push(
        refusal("LICENSE_PAYMENT_MISSING", `license ${key} requires payment "${requirementId}" and no clause is left to provide it`, [
          "license",
          key,
          requirementId,
        ]),
      );
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

  // A payment is never attributed to a license that did not ask for it (used component or not).
  for (const [key, m] of matches) {
    for (const clauseId of m.unmatched) {
      out.push(
        refusal("LICENSE_PAYMENT_UNMATCHED", `clause "${clauseId}" is attributed to license ${key}, which does not require it (or requires it once, already met)`, [
          "clause",
          clauseId,
          key,
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

/** A fixed or pass-through amount, which is the same in every unit (§2.4). */
function flatAmount(r: Extract<Rule, { kind: "fixed" | "pass_through" }>): bigint {
  if (r.kind === "fixed") return BigInt(r.amount);
  const cost = BigInt(r.cost);
  return cost + floorMulDiv(cost, BigInt(r.markupBps), BPS_DENOMINATOR);
}

/**
 * A once-per-agreement amount, spread over the units that use the component in proportion to their
 * gross (largest remainder, ties to the lower unitRef). Each unit pays its share only if it is released,
 * so the licensor is paid for exactly the part of the deal that ran (§2.4).
 */
function spreadOncePerAgreement(n: EconomicAgreement, selected: ReadonlyMap<string, Unit[]>): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  for (const c of n.clauses) {
    if (!("oncePerAgreementUsing" in c.appliesTo)) continue;
    if (c.rule.kind !== "fixed" && c.rule.kind !== "pass_through") continue; // schema-enforced
    const units = selected.get(c.clauseId) ?? [];
    if (units.length === 0) continue;
    const weights = units.map((u) => BigInt(u.gross));
    const total = flatAmount(c.rule);
    const shares =
      sumBigints(weights) > 0n ? largestRemainder(total, weights, units.map((_, i) => i)) : units.map(() => 0n);
    out.set(c.clauseId, new Map(units.map((u, i) => [u.unitRef, shares[i]!] as const)));
  }
  return out;
}

function compileUnit(
  n: EconomicAgreement,
  unit: Unit,
  applicable: readonly Clause[],
  forbidden: ReadonlySet<string>,
  onceShares: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
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
    const share = onceShares.get(c.clauseId)?.get(unit.unitRef);
    if (share !== undefined) {
      amounts.set(c.clauseId, share);
    } else if (r.kind === "fixed" || r.kind === "pass_through") {
      amounts.set(c.clauseId, flatAmount(r));
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

  // Pay each clause amount to its party, or down through its splits (§4.5). The structure phase bounded
  // the number of allocations (TOO_MANY_ALLOCATIONS), so this expansion is bounded too.
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
 * Compile an agreement. `input` and `options` are both untrusted: each is read once into plain data
 * (./input.ts) and schema-checked, and nothing is assumed that the schema did not establish.
 */
export function compileEconomics(input: unknown, options: CompileOptions = {}): CompileResult {
  const schema: Refusal[] = [];
  let parsedAgreement: EconomicAgreement | null = null;
  const inputCopy = snapshotJson(input);
  if (!inputCopy.ok) {
    schema.push(refusal("SCHEMA_INVALID", inputCopy.reason, []));
  } else {
    const parsed = EconomicAgreementSchema.safeParse(inputCopy.value);
    if (parsed.success) parsedAgreement = parsed.data;
    else schema.push(refusal("SCHEMA_INVALID", describeIssues(parsed.error), []));
  }
  let o: ParsedOptions | null = null;
  const optionsCopy = snapshotJson(options);
  if (!optionsCopy.ok) {
    schema.push(refusal("SCHEMA_INVALID", `options: ${optionsCopy.reason}`, ["options"]));
  } else {
    const parsed = CompileOptionsSchema.safeParse(optionsCopy.value);
    if (parsed.success) o = parsed.data;
    else schema.push(refusal("SCHEMA_INVALID", `options: ${describeIssues(parsed.error)}`, ["options"]));
  }
  if (parsedAgreement === null || o === null) return { ok: false, refusals: sortRefusals(schema) };
  const n = normalizeAgreement(parsedAgreement);
  const selected = new Map(n.clauses.map((c) => [c.clauseId, selectUnits(c, n.units)] as const));

  const structural = checkStructure(n, o, selected);
  if (structural.refusals.length > 0) return { ok: false, refusals: sortRefusals(structural.refusals) };

  const rights = checkRights(n, o);
  if (rights.refusals.length > 0) return { ok: false, refusals: sortRefusals(rights.refusals) };

  const forbidden = new Set([ZERO_ADDRESS, ...(o.forbiddenRecipients ?? []).map((a) => a.toLowerCase())]);
  const onceShares = spreadOncePerAgreement(n, selected);
  const money: Refusal[] = [];
  const units: CompiledUnit[] = [];
  const byParty = new Map<string, bigint>();
  for (const unit of n.units) {
    const applicable = n.clauses.filter((c) => selected.get(c.clauseId)!.some((u) => u.unitRef === unit.unitRef));
    const compiled = compileUnit(n, unit, applicable, forbidden, onceShares, money);
    if (compiled === null) continue;
    units.push(compiled.unit);
    for (const a of compiled.allocations) {
      if (a.amount > 0n) byParty.set(a.partyId, (byParty.get(a.partyId) ?? 0n) + a.amount);
    }
  }
  if (money.length > 0) return { ok: false, refusals: sortRefusals(money) };

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
              verified: structural.pins.get(c.clauseId) === "verified",
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

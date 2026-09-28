/**
 * The sealed deal, read back (R13 amendment #3231; ChatGPT review of #402/#410/#415, findings H1 and M6).
 *
 * The R13 store keeps the accepted deal's canonical PREIMAGE: the bytes `acceptedDealPreimage`
 * produced, whose sha256 is the sealed `acceptedDealDigest`. Bytes that merely hash right prove nothing
 * about their shape, so the store never trusts them. It parses them here, strictly, both when it seals
 * them (consume) and when it derives a parent unit's terms from them (MC 9 child issue).
 *
 * `parseSealedDeal` is total and bounded: it never throws. It accepts only what `acceptedDealPreimage`
 * can emit for a deal the accept route can seal:
 *   - canonical bytes: at most MAX_SEALED_DEAL_BYTES, and re-canonicalizing the parse reproduces them
 *     exactly (no whitespace, no unsorted or duplicate keys, no alternative spellings);
 *   - the domain PCC:accepted-deal:v2, and EXACTLY the preimage's key set at every level;
 *   - lowercase addresses and hashes, canonical base-unit strings, integer tiers 0..3;
 *   - at most 64 units in the deal (VCR's deal binding, #391) and 16 per job, at most 16 payout legs
 *     per unit, and at most 16 KiB of canonical JSON per unit;
 *   - the money: 5 <= g <= 2^128 - 1, f = floor(g * feeBps / 10000), n = g - f > 0, the legs sum to n
 *     exactly, and the total obligation is the sum of g;
 *   - identity: one job per operator, jobId = `${planId}:${operator}`, operator != payer, milestones
 *     0..k-1 in order, each unit's stepId = keccak256(its node id), and exactly one nodeToUnit entry per
 *     unit, naming that unit's node, job, operator and tier, with planHash = canonicalPlanHash.
 * The result is owned, frozen data.
 */
import { canonicalize } from "../util/canonical.js";
import {
  ACCEPTED_DEAL_DOMAIN,
  BPS_DENOMINATOR,
  COMPOSITION_SCHEMA_VERSION,
  MAX_FEE_BPS,
  MAX_GROSS_BASE_UNITS,
  MAX_PAYOUT_LEGS_PER_UNIT,
  MAX_UNITS_PER_JOB,
  MIN_GROSS_BASE_UNITS,
  SETTLEMENT_TOKEN_DECIMALS,
  stepIdBytes32,
} from "./accepted-plan-compiler.js";
import { ID_PATTERN } from "./composition-commitment.js";

/** The largest sealed deal stored or parsed (steward condition #3235 c). */
export const MAX_SEALED_DEAL_BYTES = 1 << 20;
/** Units per deal: VCR's deal-binding limit, which the accept route (#391) enforces first. */
export const MAX_SEALED_DEAL_UNITS = 64;
/** Canonical JSON per unit entry: 16 payout legs and every field at its bound fit well inside it. */
export const MAX_SEALED_UNIT_BYTES = 16 * 1024;

/** One unit of a sealed deal, as the reservation store needs it. */
export interface SealedDealUnit {
  /** `${jobId}#${milestoneIndex}`: how an MC 9 child reservation names it. */
  readonly unitRef: string;
  readonly jobId: string;
  readonly milestoneIndex: number;
  readonly nodeId: string;
  /** The job's signing operator (lowercase): the only principal a child of this unit may be issued to. */
  readonly operator: string;
  /** The job's payer (lowercase). */
  readonly payer: string;
  readonly tier: number;
  readonly g: bigint;
  readonly f: bigint;
  /** The unit's net: the most all its children may reserve together. */
  readonly n: bigint;
  /** Unix seconds after which the payer may reclaim the unit: no child may outlive it. */
  readonly reclaimAt: bigint;
}

export interface SealedDeal {
  readonly planId: string;
  readonly requestId: string;
  readonly reservationId: string;
  readonly currency: string;
  /** The sum of g over every unit. */
  readonly totalObligationBaseUnits: bigint;
  /** Every job's payer (lowercase), in job order. */
  readonly payers: readonly string[];
  /** Every unit, in job order then milestone order. */
  readonly units: readonly SealedDealUnit[];
  /** The lowest tier of any unit: what a reservation's assurance floor is checked against. */
  readonly minTier: number;
}

export type SealedDealRefusal =
  | "too-large"
  | "not-json"
  | "not-canonical"
  | "bad-domain"
  | "bad-shape"
  | "bad-money"
  | "bad-identity"
  | "too-many-units"
  | "unit-too-large";

export type SealedDealParse = { ok: true; deal: SealedDeal } | { ok: false; reason: SealedDealRefusal };

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const PLAN_HASH = /^sha256:[0-9a-f]{64}$/;
const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT64 = (1n << 64n) - 1n;

const DEAL_KEYS = [
  "domain", "planId", "requestId", "reservationId", "currency", "currencyDecimals", "totalObligationBaseUnits",
  "compositionRoot", "capabilityContractRoot", "agreementHash", "economicTermsHash", "rightsTermsHash", "jobs", "nodeToUnit",
] as const;
const JOB_KEYS = ["jobId", "operator", "payer", "nodeIds", "units"] as const;
const UNIT_KEYS = [
  "milestoneIndex", "stepId", "requiredTier", "requestedTier", "g", "f", "n", "feeBps", "feeRecipient", "reclaimAt",
  "compositionSchemaVersion", "compositionRoot", "payouts",
] as const;
const LEG_KEYS = ["recipient", "amount"] as const;
const BINDING_KEYS = [
  "nodeId", "jobIndex", "jobId", "operator", "milestoneIndex", "stepId", "stepIdBytes32", "tier", "committedProgramHash",
  "planHash", "canonicalPlanHash",
] as const;

type Obj = Record<string, unknown>;

/** A refusal raised while parsing; thrown only as this module's own token, never a caller's value. */
class Refused {
  constructor(readonly reason: SealedDealRefusal) {}
}
function refuse(reason: SealedDealRefusal): never {
  throw new Refused(reason);
}

function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isId(x: unknown): x is string {
  return typeof x === "string" && ID_PATTERN.test(x);
}
function isInt(x: unknown, lo: number, hi: number): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
}
function isAddress(x: unknown): x is string {
  return typeof x === "string" && ADDRESS.test(x) && x !== ZERO_ADDRESS;
}
/** Exactly these own keys: no more, no fewer. */
function exact(o: unknown, keys: readonly string[]): Obj {
  if (!isObj(o)) refuse("bad-shape");
  const own = Object.keys(o);
  if (own.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))) refuse("bad-shape");
  return o;
}
function list(x: unknown, min: number, max: number, over: SealedDealRefusal = "bad-shape"): unknown[] {
  if (!Array.isArray(x) || x.length < min) refuse("bad-shape");
  if (x.length > max) refuse(over);
  return x;
}
function amount(x: unknown): bigint {
  if (typeof x !== "string" || !BASE_UNITS.test(x)) refuse("bad-money");
  return BigInt(x);
}

/** Parse the bytes a consume sealed. Never throws. */
export function parseSealedDeal(bytes: unknown): SealedDealParse {
  if (typeof bytes !== "string") return { ok: false, reason: "not-json" };
  if (bytes.length > MAX_SEALED_DEAL_BYTES || new TextEncoder().encode(bytes).length > MAX_SEALED_DEAL_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  try {
    if (canonicalize(raw) !== bytes) return { ok: false, reason: "not-canonical" };
  } catch {
    return { ok: false, reason: "not-canonical" };
  }
  try {
    return { ok: true, deal: read(raw) };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    return { ok: false, reason: "bad-shape" };
  }
}

function read(raw: unknown): SealedDeal {
  const d = exact(raw, DEAL_KEYS);
  if (d.domain !== ACCEPTED_DEAL_DOMAIN) refuse("bad-domain");
  const planId = d.planId;
  const requestId = d.requestId;
  const reservationId = d.reservationId;
  if (!isId(planId) || !isId(requestId) || !isId(reservationId)) refuse("bad-identity");
  const currency = d.currency;
  if (typeof currency !== "string" || !Object.prototype.hasOwnProperty.call(SETTLEMENT_TOKEN_DECIMALS, currency)) refuse("bad-money");
  if (d.currencyDecimals !== SETTLEMENT_TOKEN_DECIMALS[currency]) refuse("bad-money");
  const root = d.compositionRoot;
  if (typeof root !== "string" || !BYTES32.test(root)) refuse("bad-shape");
  if (typeof d.capabilityContractRoot !== "string" || !BYTES32.test(d.capabilityContractRoot)) refuse("bad-shape");
  const hashes = [d.agreementHash, d.economicTermsHash, d.rightsTermsHash];
  const allNull = hashes.every((h) => h === null);
  const allSet = hashes.every((h) => typeof h === "string" && BYTES32.test(h));
  if (!allNull && !allSet) refuse("bad-shape");

  const jobs = list(d.jobs, 1, MAX_SEALED_DEAL_UNITS, "too-many-units");
  const units: SealedDealUnit[] = [];
  const payers: string[] = [];
  const operators = new Set<string>();
  const nodeIds = new Set<string>();
  /** byJob[jobIndex][milestoneIndex]: the unit, for the binding check. */
  const byJob: SealedDealUnit[][] = [];
  let total = 0n;
  let unitCount = 0;
  for (const rawJob of jobs) {
    const job = exact(rawJob, JOB_KEYS);
    const operator = job.operator;
    const payer = job.payer;
    if (!isAddress(operator) || !isAddress(payer) || operator === payer || operators.has(operator)) refuse("bad-identity");
    const jobId = `${planId}:${operator}`;
    if (job.jobId !== jobId) refuse("bad-identity");
    operators.add(operator);
    const jobUnits = list(job.units, 1, MAX_UNITS_PER_JOB, "too-many-units");
    unitCount += jobUnits.length;
    if (unitCount > MAX_SEALED_DEAL_UNITS) refuse("too-many-units");
    const ids = list(job.nodeIds, jobUnits.length, jobUnits.length);
    const names: string[] = [];
    for (const id of ids) {
      if (!isId(id) || nodeIds.has(id)) refuse("bad-identity");
      nodeIds.add(id);
      names.push(id);
    }
    for (const [i, rawUnit] of jobUnits.entries()) {
      const u = exact(rawUnit, UNIT_KEYS);
      if (u.milestoneIndex !== String(i) || u.stepId !== stepIdBytes32(names[i]!)) refuse("bad-identity");
      const tier = u.requiredTier;
      if (!isInt(tier, 0, 3) || u.requestedTier !== tier) refuse("bad-shape");
      if (u.compositionSchemaVersion !== COMPOSITION_SCHEMA_VERSION || u.compositionRoot !== root) refuse("bad-shape");
      const g = amount(u.g);
      const f = amount(u.f);
      const n = amount(u.n);
      const feeBps = u.feeBps;
      if (!isInt(feeBps, 0, MAX_FEE_BPS)) refuse("bad-money");
      if (g < MIN_GROSS_BASE_UNITS || g > MAX_GROSS_BASE_UNITS) refuse("bad-money");
      if (f !== (g * BigInt(feeBps)) / BPS_DENOMINATOR || n !== g - f || n <= 0n) refuse("bad-money");
      const feeRecipient = u.feeRecipient;
      if (typeof feeRecipient !== "string" || !ADDRESS.test(feeRecipient)) refuse("bad-money");
      if ((feeBps === 0) !== (feeRecipient === ZERO_ADDRESS)) refuse("bad-money");
      const reclaimAt = amount(u.reclaimAt);
      if (reclaimAt <= 0n || reclaimAt > MAX_UINT64) refuse("bad-money");
      let legs = 0n;
      for (const rawLeg of list(u.payouts, 1, MAX_PAYOUT_LEGS_PER_UNIT, "bad-money")) {
        const leg = exact(rawLeg, LEG_KEYS);
        if (!isAddress(leg.recipient)) refuse("bad-money");
        const a = amount(leg.amount);
        if (a <= 0n) refuse("bad-money");
        legs += a;
      }
      if (legs !== n) refuse("bad-money");
      if (canonicalize(u).length > MAX_SEALED_UNIT_BYTES) refuse("unit-too-large");
      total += g;
      units.push(Object.freeze({ unitRef: `${jobId}#${i}`, jobId, milestoneIndex: i, nodeId: names[i]!, operator, payer, tier, g, f, n, reclaimAt }));
    }
    payers.push(payer);
    byJob.push(units.slice(units.length - jobUnits.length));
  }
  if (d.totalObligationBaseUnits !== total.toString()) refuse("bad-money");

  // Exactly one binding per unit, each naming that unit's node, job, operator and tier.
  const bindings = list(d.nodeToUnit, units.length, units.length);
  const bound = new Set<string>();
  for (const rawBinding of bindings) {
    const b = exact(rawBinding, BINDING_KEYS);
    const jobIndex = b.jobIndex;
    if (!isInt(jobIndex, 0, byJob.length - 1)) refuse("bad-identity");
    const m = b.milestoneIndex;
    if (!isInt(m, 0, byJob[jobIndex]!.length - 1)) refuse("bad-identity");
    const unit = byJob[jobIndex]![m]!;
    if (b.nodeId !== unit.nodeId || bound.has(unit.unitRef)) refuse("bad-identity");
    bound.add(unit.unitRef);
    if (b.jobId !== unit.jobId || b.operator !== unit.operator || b.stepId !== unit.nodeId || b.stepIdBytes32 !== stepIdBytes32(unit.nodeId)) {
      refuse("bad-identity");
    }
    if (b.tier !== unit.tier) refuse("bad-identity");
    const program = b.committedProgramHash;
    if (!(program === null || (typeof program === "string" && BYTES32.test(program)))) refuse("bad-shape");
    if (typeof b.planHash !== "string" || !PLAN_HASH.test(b.planHash) || b.canonicalPlanHash !== b.planHash) refuse("bad-identity");
  }

  return Object.freeze({
    planId,
    requestId,
    reservationId,
    currency,
    totalObligationBaseUnits: total,
    payers: Object.freeze(payers),
    units: Object.freeze(units),
    minTier: Math.min(...units.map((u) => u.tier)),
  });
}

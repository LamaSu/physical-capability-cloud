/**
 * Live provider re-read for an externally authored plan (reconciliation row R10; MUST-CLOSE 3 and 4).
 *
 * An external agent's plan names, for each node, the capability it wants and the deal it believes
 * it is getting: a price, a currency, a tier, the kernel that performs it and the operator it pays,
 * and optionally the deal-snapshot digest it was quoted against. NONE of that is authoritative — a
 * snapshot the caller signed is still the caller's claim. This service re-reads every capability and
 * its kernel LIVE, recomputes the deal-snapshot digest from the live row with the decomposer's own
 * function, and returns one typed verdict per node. The kernel and operator are REQUIRED in the
 * claim: the digest does not cover the operator, so an operator rotation since the quote is only
 * detectable if the caller states whom it expects to pay (cross-family review, #355).
 *
 *  - current       the claim matches the live row; `resolved` carries the SERVER's terms (operator,
 *                  gross in base units, digest, CSD). These are the only values the accepted-plan
 *                  compiler may be fed.
 *  - stale         the live row differs from the claim — a forged cheaper price, a price or tier
 *                  change since the quote, a different kernel. `diffs` names each field and `live`
 *                  is the re-quote. Never silently accepted: the caller re-submits against `live`.
 *  - missing       no such capability (or not visible to this tenant), or its kernel is gone.
 *  - unavailable   the operator is suspended or has no valid settlement address, or the live row is
 *                  malformed — including missing, empty or out-of-range tiers, which are NEVER
 *                  defaulted (a default would sell a tier the row does not offer).
 *  - unpriceable   the live row has no exact flat price in a settleable currency.
 *  - incompatible  the capability's type maps to no CSD, so there is no evidence contract to settle
 *                  against.
 *  - invalid-claim the claim itself is malformed.
 *
 * Price is compared EXACTLY, as canonical decimal strings, and the gross comes from the live decimal
 * STRING in base units. It never goes through the digest's `toFixed(2)` (blind to 6.504 vs 6.50)
 * and never through `capPrice`'s fallback to 0 for an unpriced row.
 *
 * Deliberately NOT done here: the HTTP route (R9), program resolution (R11, evidence's #349 gate),
 * or evidence requirements (read from the resolved CSD tier by the caller). A payout wallet distinct
 * from the operator address (#1690) has no server-side store today, so `payoutAddress` is the
 * kernel's `operatorAddress`; a caller-supplied payout address is never used.
 */

import {
  ADDRESS_PATTERN,
  CURRENCY_PATTERN,
  DIGEST_PATTERN,
  ID_PATTERN,
  MAX_GROSS_BASE_UNITS,
  SETTLEMENT_TOKEN_DECIMALS,
  tierFromKey,
} from "@pcc/spec";
import { capPrice } from "./agentic-decomposer.js";
import { matchedCapabilityDigest } from "./matched-capability-digest.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** What an external plan claims about one node. Every field is checked against the live row. */
export interface SnapshotClaim {
  nodeId: string;
  capabilityId: string;
  /** The quoted price as an exact decimal string, e.g. "6.50". */
  price: string;
  currency: string;
  /** The tier the node is bought at, e.g. "tier2". */
  tierKey: string;
  /** The kernel the caller was quoted — who performs the work. Must equal the live row's. */
  kernelId: string;
  /** The operator address the caller expects to pay. Must equal the live kernel's. */
  operator: string;
  /** Optional cross-checks: each one, if present, must equal the live value. */
  capabilityType?: string;
  csd?: string;
  matchedCapabilityDigest?: string;
}

/** The live capability fields this service reads (structurally a subset of the db `CapabilityRow`). */
export interface LiveCapability {
  id: string;
  type: string;
  kernelId: string;
  pricing?: {
    currency?: string;
    baseCost?: string;
    minimum?: string;
    perMinute?: string;
    perGram?: string;
    perCm3?: string;
  } | null;
  assuranceTiers?: number[] | null;
  tenantId?: string | null;
}

/** The live kernel fields this service reads (structurally a subset of the db `KernelRow`). */
export interface LiveKernel {
  id: string;
  operatorAddress: string;
  status: string;
}

export interface RevalidationDeps {
  /** Live capability rows by id (e.g. `repos.capabilities.findByIds`). Unknown ids are absent. */
  loadCapabilities(ids: string[]): LiveCapability[];
  /** Live kernel rows by id (e.g. `repos.kernels.findByIds`). Unknown ids are absent. */
  loadKernels(ids: string[]): LiveKernel[];
  /** The CSD slug for a capability type (see `csdSlugFromUrl`), or null when there is none. */
  csdForType(type: string): string | null;
}

export interface RevalidationOpts {
  /** The claimant's tenant. A tenant-scoped capability is visible only to its own tenant. */
  tenantId?: string | null;
}

/** The server's view of one capability, re-read live. */
export interface LiveTerms {
  capabilityId: string;
  capabilityType: string;
  kernelId: string;
  kernelStatus: string;
  csd: string;
  operator: `0x${string}`;
  /** The operator address until a payout-wallet store exists (#1690). Never the caller's. */
  payoutAddress: `0x${string}`;
  /** The live flat price as a canonical decimal ("6.5", never "6.50"). */
  priceDecimal: string;
  grossBaseUnits: bigint;
  currency: string;
  currencyDecimals: number;
  /** The tiers the capability offers, ascending. */
  assuranceTiers: number[];
  /** Recomputed from the live row with the decomposer's own inputs. */
  matchedCapabilityDigest: `0x${string}`;
}

export interface ResolvedNodeTerms extends LiveTerms {
  nodeId: string;
  tierKey: string;
  tier: number;
}

export type SnapshotField =
  | "capabilityType"
  | "csd"
  | "currency"
  | "kernelId"
  | "matchedCapabilityDigest"
  | "operator"
  | "price"
  | "tier";

export interface FieldDiff {
  field: SnapshotField;
  claimed: string;
  live: string;
}

export type NodeVerdict =
  | { nodeId: string; status: "current"; resolved: ResolvedNodeTerms }
  | { nodeId: string; status: "stale"; diffs: FieldDiff[]; live: LiveTerms }
  | { nodeId: string; status: "missing"; reason: "capability-not-found" | "kernel-not-found" }
  | {
      nodeId: string;
      status: "unavailable";
      reason: "operator-suspended" | "operator-address-invalid" | "malformed-tiers" | "malformed-live-row";
    }
  | {
      nodeId: string;
      status: "unpriceable";
      reason:
        | "no-pricing"
        | "currency-not-settleable"
        | "variable-pricing"
        | "malformed-price"
        | "sub-base-unit-price"
        | "non-positive-price"
        | "price-out-of-range"
        | "below-minimum-charge";
    }
  | { nodeId: string; status: "incompatible"; reason: "no-csd-for-type" }
  | {
      nodeId: string;
      status: "invalid-claim";
      reason:
        | "malformed-node-id"
        | "duplicate-node-id"
        | "malformed-capability-id"
        | "malformed-price"
        | "malformed-currency"
        | "malformed-tier"
        | "malformed-kernel-id"
        | "malformed-operator"
        | "malformed-cross-check"
        | "unreadable-claim";
    };

export interface RevalidationResult {
  /** True only when there is at least one node and EVERY node is `current`. */
  ok: boolean;
  /** One verdict per node id, sorted by node id. */
  verdicts: NodeVerdict[];
}

// ── Exact decimals ───────────────────────────────────────────────────────────────────────────────

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * The canonical form of an exact non-negative decimal string, or null. "6.50" -> "6.5", "7.0" -> "7".
 * No sign, exponent, whitespace or leading zeros are accepted, so equal strings mean equal amounts.
 */
export function canonicalDecimal(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = DECIMAL.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return frac.length > 0 ? `${m[1]}.${frac}` : m[1]!;
}

/** Exact base units of a canonical decimal at `decimals`; null when it is finer than one base unit. */
export function decimalToBaseUnits(canonical: string, decimals: number): bigint | null {
  const [whole, frac = ""] = canonical.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** The CSD slug in a registry URL: "pcc://capabilities/document-print-and-mail/v1" -> "document-print-and-mail". */
export function csdSlugFromUrl(url: string | undefined | null): string | null {
  const m = /^pcc:\/\/capabilities\/([^/]+)\//i.exec(url ?? "");
  return m ? m[1]! : null;
}

// ── The re-read ──────────────────────────────────────────────────────────────────────────────────

function isId(x: unknown): x is string {
  return typeof x === "string" && ID_PATTERN.test(x);
}

// ── Read-once snapshots (cross-family review of 27a23c6e) ────────────────────────────────────────
// Claims are caller data and live rows arrive as JS objects: either can carry getters, proxies or
// be mutated by a callback between two reads. Every claim, row, nested pricing object and tier list
// is therefore read EXACTLY ONCE into owned plain data, and validation, comparison, the digest and
// the output use only that copy. A failure while READING data is a typed verdict; a loader or
// csdForType call that THROWS is a server fault and propagates.

/** An owned stand-in for a non-primitive where a primitive belongs: fails every check, holds no caller reference. */
const NOT_DATA: object = Object.freeze(Object.create(null));

/** Primitives are kept; objects and functions become NOT_DATA. */
function leaf(v: unknown): unknown {
  return (typeof v === "object" && v !== null) || typeof v === "function" ? NOT_DATA : v;
}

/** A list's elements, its length read once and capped; null for a non-array or a lying or over-cap length. */
function listOnce(x: unknown, max: number): unknown[] | null {
  if (!Array.isArray(x)) return null;
  const n: unknown = x.length;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) return null;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(x[i]);
  return out;
}

const MAX_CLAIMS = 1024;
const MAX_ROWS = 4096;

type InvalidClaimReason = Extract<NodeVerdict, { status: "invalid-claim" }>["reason"];

/** A claim as owned, validated plain data. */
interface Claim {
  nodeId: string;
  capabilityId: string;
  /** Canonical decimal. */
  price: string;
  currency: string;
  tierKey: string;
  tier: number;
  kernelId: string;
  operator: string;
  capabilityType?: string;
  csd?: string;
  matchedCapabilityDigest?: string;
}

function claimError(f: Record<string, unknown>): InvalidClaimReason | null {
  if (!isId(f.capabilityId)) return "malformed-capability-id";
  if (canonicalDecimal(f.price) === null) return "malformed-price";
  if (typeof f.currency !== "string" || !CURRENCY_PATTERN.test(f.currency)) return "malformed-currency";
  if (tierFromKey(f.tierKey) === null) return "malformed-tier";
  if (!isId(f.kernelId)) return "malformed-kernel-id";
  if (!(typeof f.operator === "string" && ADDRESS_PATTERN.test(f.operator))) return "malformed-operator";
  for (const x of [f.capabilityType, f.csd]) if (x !== undefined && !isId(x)) return "malformed-cross-check";
  if (f.matchedCapabilityDigest !== undefined && !(typeof f.matchedCapabilityDigest === "string" && DIGEST_PATTERN.test(f.matchedCapabilityDigest))) {
    return "malformed-cross-check";
  }
  return null;
}

/** Read one claim once. Never throws: a getter that throws makes the claim unreadable. */
function readClaim(raw: unknown): { ok: true; claim: Claim } | { ok: false; nodeId: string; reason: InvalidClaimReason } {
  let nodeId: unknown;
  try {
    if (typeof raw !== "object" || raw === null) return { ok: false, nodeId: "<undefined>", reason: "malformed-node-id" };
    const c = raw as Record<string, unknown>;
    nodeId = leaf(c.nodeId);
    if (!isId(nodeId)) return { ok: false, nodeId: typeof nodeId === "string" ? nodeId : `<${typeof nodeId}>`, reason: "malformed-node-id" };
    const f: Record<string, unknown> = {
      capabilityId: leaf(c.capabilityId),
      price: leaf(c.price),
      currency: leaf(c.currency),
      tierKey: leaf(c.tierKey),
      kernelId: leaf(c.kernelId),
      operator: leaf(c.operator),
      capabilityType: leaf(c.capabilityType),
      csd: leaf(c.csd),
      matchedCapabilityDigest: leaf(c.matchedCapabilityDigest),
    };
    const bad = claimError(f);
    if (bad) return { ok: false, nodeId, reason: bad };
    const claim: Claim = {
      nodeId,
      capabilityId: f.capabilityId as string,
      price: canonicalDecimal(f.price)!,
      currency: f.currency as string,
      tierKey: f.tierKey as string,
      tier: tierFromKey(f.tierKey)!,
      kernelId: f.kernelId as string,
      operator: f.operator as string,
    };
    if (f.capabilityType !== undefined) claim.capabilityType = f.capabilityType as string;
    if (f.csd !== undefined) claim.csd = f.csd as string;
    if (f.matchedCapabilityDigest !== undefined) claim.matchedCapabilityDigest = f.matchedCapabilityDigest as string;
    return { ok: true, claim };
  } catch {
    return { ok: false, nodeId: isId(nodeId) ? nodeId : "<unreadable>", reason: "unreadable-claim" };
  }
}

/** A live capability row as owned plain data. Pricing and tiers are copied, never re-read. */
interface CapRow {
  id: string;
  type: unknown;
  kernelId: unknown;
  tenantId: unknown;
  /** The validated tier list, or null when malformed. Never defaulted. */
  tiers: number[] | null;
  pricing: Readonly<Record<"currency" | "baseCost" | "minimum" | "perMinute" | "perGram" | "perCm3", unknown>> | null;
}

interface KernelRow {
  id: string;
  operatorAddress: unknown;
  status: unknown;
}

/**
 * A tier list copied once, or null when it is malformed: not an array, empty, over 16 long, holed
 * (a hole reads as undefined), or holding anything but integers 0..3. Read by index, never through
 * the row's own methods, length read once.
 */
function readTiers(x: unknown): number[] | null {
  const items = listOnce(x, 16);
  if (!items || items.length === 0) return null;
  const out: number[] = [];
  for (const t of items) {
    if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t > 3) return null;
    out.push(t);
  }
  return out;
}

/** Read one capability row once. An unattributable or unreadable row is null: it cannot be matched to a claim. */
function readCapRow(raw: unknown): CapRow | null {
  try {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = leaf(r.id);
    if (!isId(id)) return null;
    const row: CapRow = { id, type: leaf(r.type), kernelId: leaf(r.kernelId), tenantId: leaf(r.tenantId), tiers: readTiers(r.assuranceTiers), pricing: null };
    const p = r.pricing;
    if (typeof p === "object" && p !== null) {
      const q = p as Record<string, unknown>;
      row.pricing = Object.freeze({
        currency: leaf(q.currency),
        baseCost: leaf(q.baseCost),
        minimum: leaf(q.minimum),
        perMinute: leaf(q.perMinute),
        perGram: leaf(q.perGram),
        perCm3: leaf(q.perCm3),
      });
    }
    return row;
  } catch {
    return null; // tenant visibility is unknown, so it is reported exactly like a missing row
  }
}

/** Read one kernel row once. */
function readKernelRow(raw: unknown): KernelRow | null {
  try {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const id = leaf(r.id);
    if (!isId(id)) return null;
    return { id, operatorAddress: leaf(r.operatorAddress), status: leaf(r.status) };
  } catch {
    return null;
  }
}

/** Read a loader's answer once. Null when it is not a readable list: the caller reports it as a malformed live answer. */
function readRows<T>(answer: unknown, read: (raw: unknown) => T | null): T[] | null {
  try {
    const items = listOnce(answer, MAX_ROWS);
    if (!items) return null;
    const out: T[] = [];
    for (const raw of items) {
      const row = read(raw);
      if (row) out.push(row);
    }
    return out;
  } catch {
    return null;
  }
}

type Priced =
  | { ok: true; priceDecimal: string; grossBaseUnits: bigint; currency: string; currencyDecimals: number }
  | { ok: false; reason: Extract<NodeVerdict, { status: "unpriceable" }>["reason"] };

/** The live row's exact flat price from its pricing SNAPSHOT, or why it has none. Never defaults. */
function livePrice(p: CapRow["pricing"]): Priced {
  if (!p) return { ok: false, reason: "no-pricing" };
  const currency = p.currency;
  if (typeof currency !== "string" || !Object.prototype.hasOwnProperty.call(SETTLEMENT_TOKEN_DECIMALS, currency)) {
    return { ok: false, reason: "currency-not-settleable" };
  }
  const decimals = SETTLEMENT_TOKEN_DECIMALS[currency]!;
  for (const variable of [p.perMinute, p.perGram, p.perCm3]) {
    if (variable === undefined || variable === null) continue;
    const c = canonicalDecimal(variable);
    if (c === null) return { ok: false, reason: "malformed-price" };
    if (c !== "0") return { ok: false, reason: "variable-pricing" }; // needs a parameterized quote
  }
  const flat = p.baseCost ?? p.minimum; // the same headline the decomposer's capPrice reads
  if (flat === undefined || flat === null) return { ok: false, reason: "no-pricing" };
  const priceDecimal = canonicalDecimal(flat);
  if (priceDecimal === null) return { ok: false, reason: "malformed-price" };
  const gross = decimalToBaseUnits(priceDecimal, decimals);
  if (gross === null) return { ok: false, reason: "sub-base-unit-price" };
  if (gross === 0n) return { ok: false, reason: "non-positive-price" };
  if (gross > MAX_GROSS_BASE_UNITS) return { ok: false, reason: "price-out-of-range" };
  if (p.baseCost !== undefined && p.baseCost !== null && p.minimum !== undefined && p.minimum !== null) {
    // The real charge would be the minimum while the digest commits baseCost: refuse, don't pick.
    const min = canonicalDecimal(p.minimum);
    if (min === null) return { ok: false, reason: "malformed-price" };
    const minUnits = decimalToBaseUnits(min, decimals);
    if (minUnits === null) return { ok: false, reason: "sub-base-unit-price" };
    if (gross < minUnits) return { ok: false, reason: "below-minimum-charge" };
  }
  return { ok: true, priceDecimal, grossBaseUnits: gross, currency, currencyDecimals: decimals };
}

/**
 * Re-read every claimed capability and its kernel live and compare. One batched load per table.
 * A loader or csdForType call that THROWS propagates: an outage must not read as "capability not
 * found". Everything else — claims, rows, their fields — is read once, and a failure to read it is
 * a typed verdict.
 */
export function revalidatePlanSnapshots(
  claims: readonly SnapshotClaim[],
  deps: RevalidationDeps,
  opts: RevalidationOpts = {},
): RevalidationResult {
  // Dependencies and options, read once, before any claim (a callback cannot swap them later).
  const loadCapabilities = deps.loadCapabilities;
  const loadKernels = deps.loadKernels;
  const csdForType = deps.csdForType;
  if (typeof loadCapabilities !== "function" || typeof loadKernels !== "function" || typeof csdForType !== "function") {
    throw new TypeError("revalidatePlanSnapshots: loadCapabilities, loadKernels and csdForType must be functions");
  }
  const tenantId = leaf(opts?.tenantId ?? null);

  const verdicts: NodeVerdict[] = [];
  const read = (() => {
    try {
      return listOnce(claims, MAX_CLAIMS);
    } catch {
      return null;
    }
  })();
  if (!read) return { ok: false, verdicts: [{ nodeId: "<claims>", status: "invalid-claim", reason: "unreadable-claim" }] };

  // Node identity first, on the COPIES: a malformed or duplicated node id gets one verdict and nothing else.
  const parsed = read.map(readClaim);
  const counts = new Map<string, number>();
  for (const r of parsed) if (r.ok) counts.set(r.claim.nodeId, (counts.get(r.claim.nodeId) ?? 0) + 1);
  const valid: Claim[] = [];
  for (const r of parsed) {
    if (!r.ok) verdicts.push({ nodeId: r.nodeId, status: "invalid-claim", reason: r.reason });
    else if (counts.get(r.claim.nodeId)! > 1) continue;
    else valid.push(r.claim);
  }
  for (const [id, n] of counts) if (n > 1) verdicts.push({ nodeId: id, status: "invalid-claim", reason: "duplicate-node-id" });

  // Capabilities, then visibility, THEN kernels. A capability scoped to another tenant is dropped
  // before any kernel lookup, so it is indistinguishable from one that does not exist: in the
  // verdict, in the kernel loader's calls, and in timing. An unattributable row is ignored.
  const caps = new Map<string, CapRow>();
  const capIds = [...new Set(valid.map((c) => c.capabilityId))].sort();
  const requested = new Set(capIds);
  const capRows = capIds.length > 0 ? readRows(loadCapabilities(capIds), readCapRow) : [];
  for (const row of capRows ?? []) {
    if (requested.has(row.id) && !caps.has(row.id) && visibleTo(row, tenantId)) caps.set(row.id, row);
  }
  const kernels = new Map<string, KernelRow>();
  const kernelIds = [...new Set([...caps.values()].map((r) => r.kernelId).filter(isId))].sort();
  const kernelRows = kernelIds.length > 0 ? readRows(loadKernels(kernelIds), readKernelRow) : [];
  for (const row of kernelRows ?? []) if (!kernels.has(row.id)) kernels.set(row.id, row);

  for (const c of valid) {
    if (capRows === null || (caps.has(c.capabilityId) && kernelRows === null)) {
      verdicts.push({ nodeId: c.nodeId, status: "unavailable", reason: "malformed-live-row" });
    } else {
      verdicts.push(judge(c, caps.get(c.capabilityId), csdForType, kernels));
    }
  }

  verdicts.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return { ok: verdicts.length > 0 && verdicts.every((v) => v.status === "current"), verdicts };
}

function visibleTo(row: CapRow, tenantId: unknown): boolean {
  return row.tenantId === undefined || row.tenantId === null || row.tenantId === tenantId;
}

function judge(
  c: Claim,
  cap: CapRow | undefined,
  csdForType: (type: string) => string | null,
  kernels: Map<string, KernelRow>,
): NodeVerdict {
  const nodeId = c.nodeId;
  if (!cap) return { nodeId, status: "missing", reason: "capability-not-found" };
  const type = cap.type;
  const kernelId = cap.kernelId;
  if (!isId(type) || !isId(kernelId)) return { nodeId, status: "unavailable", reason: "malformed-live-row" };
  const kernel = kernels.get(kernelId);
  if (!kernel) return { nodeId, status: "missing", reason: "kernel-not-found" };
  const kernelStatus = kernel.status;
  if (typeof kernelStatus !== "string") return { nodeId, status: "unavailable", reason: "malformed-live-row" };
  const csd = leaf(csdForType(type));
  if (!isId(csd)) return { nodeId, status: "incompatible", reason: "no-csd-for-type" };
  if (kernelStatus === "suspended") return { nodeId, status: "unavailable", reason: "operator-suspended" };
  const operator = kernel.operatorAddress;
  if (typeof operator !== "string" || !ADDRESS_PATTERN.test(operator) || operator.toLowerCase() === ZERO_ADDRESS) {
    return { nodeId, status: "unavailable", reason: "operator-address-invalid" };
  }
  // Tiers are NEVER defaulted. The decomposer's `?? [0, 1]` would sell tier 1 on a row that offers
  // nothing; SQL NOT NULL does not validate the JSON inside the column (cross-family review, #355).
  const tiers = cap.tiers;
  if (!tiers) return { nodeId, status: "unavailable", reason: "malformed-tiers" };
  const priced = livePrice(cap.pricing);
  if (!priced.ok) return { nodeId, status: "unpriceable", reason: priced.reason };

  const assuranceTiers = [...new Set(tiers)].sort((a, b) => a - b);
  const pricing = cap.pricing!;
  const live: LiveTerms = {
    capabilityId: cap.id,
    capabilityType: type,
    kernelId,
    kernelStatus,
    csd,
    operator: operator as `0x${string}`,
    payoutAddress: operator as `0x${string}`,
    priceDecimal: priced.priceDecimal,
    grossBaseUnits: priced.grossBaseUnits,
    currency: priced.currency,
    currencyDecimals: priced.currencyDecimals,
    assuranceTiers,
    // Exactly the decomposer's inputs (toMatched), from the SAME pricing snapshot livePrice read:
    // capPrice, the row's currency, the tier list.
    matchedCapabilityDigest: matchedCapabilityDigest({
      capabilityId: cap.id,
      capabilityType: type,
      kernelId,
      price: capPrice({
        id: cap.id,
        type,
        name: "",
        kernelId,
        pricing: { currency: pricing.currency as string, baseCost: pricing.baseCost as string | undefined, minimum: pricing.minimum as string | undefined },
      }),
      currency: priced.currency,
      assuranceTiers: tiers,
    }),
  };

  const diffs: FieldDiff[] = [];
  if (c.price !== live.priceDecimal) diffs.push({ field: "price", claimed: c.price, live: live.priceDecimal });
  if (c.currency !== live.currency) diffs.push({ field: "currency", claimed: c.currency, live: live.currency });
  if (!assuranceTiers.includes(c.tier)) {
    diffs.push({ field: "tier", claimed: c.tierKey, live: assuranceTiers.map((t) => `tier${t}`).join(",") });
  }
  if (c.capabilityType !== undefined && c.capabilityType !== live.capabilityType) {
    diffs.push({ field: "capabilityType", claimed: c.capabilityType, live: live.capabilityType });
  }
  if (c.kernelId !== live.kernelId) diffs.push({ field: "kernelId", claimed: c.kernelId, live: live.kernelId });
  if (c.csd !== undefined && c.csd !== live.csd) diffs.push({ field: "csd", claimed: c.csd, live: live.csd });
  if (c.operator.toLowerCase() !== live.operator.toLowerCase()) {
    diffs.push({ field: "operator", claimed: c.operator, live: live.operator });
  }
  if (c.matchedCapabilityDigest !== undefined && c.matchedCapabilityDigest.toLowerCase() !== live.matchedCapabilityDigest.toLowerCase()) {
    diffs.push({ field: "matchedCapabilityDigest", claimed: c.matchedCapabilityDigest, live: live.matchedCapabilityDigest });
  }
  if (diffs.length > 0) {
    diffs.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
    return { nodeId, status: "stale", diffs, live };
  }
  return { nodeId, status: "current", resolved: { ...live, nodeId, tierKey: c.tierKey, tier: c.tier } };
}

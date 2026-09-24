/**
 * Live provider re-read for an externally authored plan (reconciliation row R10; MUST-CLOSE 3 and 4).
 *
 * An external agent's plan names, for each node, the capability it wants and the deal it believes
 * it is getting: a price, a currency, a tier, and optionally the deal-snapshot digest it was quoted
 * against. NONE of that is authoritative — a snapshot the caller signed is still the caller's
 * claim. This service re-reads every capability and its kernel LIVE, recomputes the deal-snapshot
 * digest from the live row with the decomposer's own function, and returns one typed verdict per
 * node:
 *
 *  - current       the claim matches the live row; `resolved` carries the SERVER's terms (operator,
 *                  gross in base units, digest, CSD). These are the only values the accepted-plan
 *                  compiler may be fed.
 *  - stale         the live row differs from the claim — a forged cheaper price, a price or tier
 *                  change since the quote, a different kernel. `diffs` names each field and `live`
 *                  is the re-quote. Never silently accepted: the caller re-submits against `live`.
 *  - missing       no such capability (or not visible to this tenant), or its kernel is gone.
 *  - unavailable   the operator is suspended, has no valid settlement address, or the row's tiers
 *                  are malformed.
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
  /** Optional cross-checks: each one, if present, must equal the live value. */
  capabilityType?: string;
  kernelId?: string;
  csd?: string;
  operator?: string;
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
  | { nodeId: string; status: "unavailable"; reason: "operator-suspended" | "operator-address-invalid" | "malformed-tiers" }
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
        | "malformed-cross-check";
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

type Priced =
  | { ok: true; priceDecimal: string; grossBaseUnits: bigint; currency: string; currencyDecimals: number }
  | { ok: false; reason: Extract<NodeVerdict, { status: "unpriceable" }>["reason"] };

/** The live row's exact flat price, or why it has none. Never defaults a currency or a price. */
function livePrice(cap: LiveCapability): Priced {
  const p = cap.pricing;
  if (!p || typeof p !== "object") return { ok: false, reason: "no-pricing" };
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

function claimError(c: SnapshotClaim): Extract<NodeVerdict, { status: "invalid-claim" }>["reason"] | null {
  if (!isId(c.capabilityId)) return "malformed-capability-id";
  if (canonicalDecimal(c.price) === null) return "malformed-price";
  if (typeof c.currency !== "string" || !CURRENCY_PATTERN.test(c.currency)) return "malformed-currency";
  if (tierFromKey(c.tierKey) === null) return "malformed-tier";
  for (const x of [c.capabilityType, c.kernelId, c.csd]) if (x !== undefined && !isId(x)) return "malformed-cross-check";
  if (c.operator !== undefined && !(typeof c.operator === "string" && ADDRESS_PATTERN.test(c.operator))) {
    return "malformed-cross-check";
  }
  if (c.matchedCapabilityDigest !== undefined && !(typeof c.matchedCapabilityDigest === "string" && DIGEST_PATTERN.test(c.matchedCapabilityDigest))) {
    return "malformed-cross-check";
  }
  return null;
}

/**
 * Re-read every claimed capability and its kernel live and compare. One batched load per table.
 * A loader error propagates: an outage must not read as "capability not found".
 */
export function revalidatePlanSnapshots(
  claims: readonly SnapshotClaim[],
  deps: RevalidationDeps,
  opts: RevalidationOpts = {},
): RevalidationResult {
  const list = Array.isArray(claims) ? claims : [];
  const verdicts: NodeVerdict[] = [];

  // Node identity first: a malformed or duplicated node id gets one verdict and nothing else.
  const counts = new Map<string, number>();
  for (const c of list) if (isId(c?.nodeId)) counts.set(c.nodeId, (counts.get(c.nodeId) ?? 0) + 1);
  const valid: SnapshotClaim[] = [];
  for (const c of list) {
    const id = c?.nodeId;
    if (!isId(id)) verdicts.push({ nodeId: typeof id === "string" ? id : `<${typeof id}>`, status: "invalid-claim", reason: "malformed-node-id" });
    else if (counts.get(id)! > 1) continue;
    else {
      const bad = claimError(c);
      if (bad) verdicts.push({ nodeId: id, status: "invalid-claim", reason: bad });
      else valid.push(c);
    }
  }
  for (const [id, n] of counts) if (n > 1) verdicts.push({ nodeId: id, status: "invalid-claim", reason: "duplicate-node-id" });

  const caps = new Map<string, LiveCapability>();
  const capIds = [...new Set(valid.map((c) => c.capabilityId))].sort();
  for (const row of capIds.length > 0 ? deps.loadCapabilities(capIds) : []) caps.set(row.id, row);
  const kernels = new Map<string, LiveKernel>();
  const kernelIds = [...new Set([...caps.values()].map((r) => r.kernelId))].sort();
  for (const row of kernelIds.length > 0 ? deps.loadKernels(kernelIds) : []) kernels.set(row.id, row);

  for (const c of valid) verdicts.push(judge(c, caps.get(c.capabilityId), deps, opts, kernels));

  verdicts.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return { ok: verdicts.length > 0 && verdicts.every((v) => v.status === "current"), verdicts };
}

function judge(
  c: SnapshotClaim,
  cap: LiveCapability | undefined,
  deps: RevalidationDeps,
  opts: RevalidationOpts,
  kernels: Map<string, LiveKernel>,
): NodeVerdict {
  const nodeId = c.nodeId;
  // A capability scoped to another tenant is reported exactly like one that does not exist.
  if (!cap || (cap.tenantId !== undefined && cap.tenantId !== null && cap.tenantId !== (opts.tenantId ?? null))) {
    return { nodeId, status: "missing", reason: "capability-not-found" };
  }
  const kernel = kernels.get(cap.kernelId);
  if (!kernel) return { nodeId, status: "missing", reason: "kernel-not-found" };
  const csd = deps.csdForType(cap.type);
  if (!isId(csd)) return { nodeId, status: "incompatible", reason: "no-csd-for-type" };
  if (kernel.status === "suspended") return { nodeId, status: "unavailable", reason: "operator-suspended" };
  const operator = kernel.operatorAddress;
  if (typeof operator !== "string" || !ADDRESS_PATTERN.test(operator) || operator.toLowerCase() === ZERO_ADDRESS) {
    return { nodeId, status: "unavailable", reason: "operator-address-invalid" };
  }
  // The decomposer's default, mirrored so both digests agree (the column is NOT NULL in the schema).
  const tiers = cap.assuranceTiers ?? [0, 1];
  if (!Array.isArray(tiers) || !tiers.every((t) => Number.isInteger(t) && t >= 0 && t <= 3)) {
    return { nodeId, status: "unavailable", reason: "malformed-tiers" };
  }
  const priced = livePrice(cap);
  if (!priced.ok) return { nodeId, status: "unpriceable", reason: priced.reason };

  const assuranceTiers = [...new Set(tiers)].sort((a, b) => a - b);
  const live: LiveTerms = {
    capabilityId: cap.id,
    capabilityType: cap.type,
    kernelId: cap.kernelId,
    kernelStatus: kernel.status,
    csd,
    operator: operator as `0x${string}`,
    payoutAddress: operator as `0x${string}`,
    priceDecimal: priced.priceDecimal,
    grossBaseUnits: priced.grossBaseUnits,
    currency: priced.currency,
    currencyDecimals: priced.currencyDecimals,
    assuranceTiers,
    // Exactly the decomposer's inputs (toMatched): capPrice, the row's currency, the tier list.
    matchedCapabilityDigest: matchedCapabilityDigest({
      capabilityId: cap.id,
      capabilityType: cap.type,
      kernelId: cap.kernelId,
      price: capPrice({ id: cap.id, type: cap.type, name: "", kernelId: cap.kernelId, pricing: cap.pricing ?? undefined }),
      currency: priced.currency,
      assuranceTiers: tiers,
    }),
  };

  const tier = tierFromKey(c.tierKey)!;
  const diffs: FieldDiff[] = [];
  const claimedPrice = canonicalDecimal(c.price)!;
  if (claimedPrice !== live.priceDecimal) diffs.push({ field: "price", claimed: claimedPrice, live: live.priceDecimal });
  if (c.currency !== live.currency) diffs.push({ field: "currency", claimed: c.currency, live: live.currency });
  if (!assuranceTiers.includes(tier)) {
    diffs.push({ field: "tier", claimed: c.tierKey, live: assuranceTiers.map((t) => `tier${t}`).join(",") });
  }
  if (c.capabilityType !== undefined && c.capabilityType !== live.capabilityType) {
    diffs.push({ field: "capabilityType", claimed: c.capabilityType, live: live.capabilityType });
  }
  if (c.kernelId !== undefined && c.kernelId !== live.kernelId) {
    diffs.push({ field: "kernelId", claimed: c.kernelId, live: live.kernelId });
  }
  if (c.csd !== undefined && c.csd !== live.csd) diffs.push({ field: "csd", claimed: c.csd, live: live.csd });
  if (c.operator !== undefined && c.operator.toLowerCase() !== live.operator.toLowerCase()) {
    diffs.push({ field: "operator", claimed: c.operator, live: live.operator });
  }
  if (
    c.matchedCapabilityDigest !== undefined &&
    c.matchedCapabilityDigest.toLowerCase() !== live.matchedCapabilityDigest.toLowerCase()
  ) {
    diffs.push({ field: "matchedCapabilityDigest", claimed: c.matchedCapabilityDigest, live: live.matchedCapabilityDigest });
  }
  if (diffs.length > 0) {
    diffs.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
    return { nodeId, status: "stale", diffs, live };
  }
  return { nodeId, status: "current", resolved: { ...live, nodeId, tierKey: c.tierKey, tier } };
}

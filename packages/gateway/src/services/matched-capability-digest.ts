/**
 * A stable binding digest for a capability AS MATCHED, for composition's
 * compositionRoot commitment (coord #1439).
 *
 * ── READ THIS BEFORE USING IT ──────────────────────────────────────────────
 * THIS IS NOT `capabilityContractDigest`. Composition asked for that field, and
 * it is genuinely the right one — but it CANNOT BE COMPUTED HERE TODAY, and
 * quietly shipping something else under that name would be worse than shipping
 * nothing.
 *
 * `capabilityContractDigest` (packages/spec/src/csd/capability-contract-identity.ts)
 * is SHA-256 over the canonicalized RESOLVED CSD, which requires a CSD and a
 * `CsdRegistry` to resolve `baseDefinition` inheritance. The decomposer has
 * neither: it matches against `CapabilityLite` (id / type / name / kernelId /
 * pricing / tiers / tags / materials), and — verified 2026-08-26 — capability
 * rows carry NO csdUri, csdRef, or contractRef field of any kind. There is no
 * join from a matched capability to its CSD. That join is the real prerequisite
 * for `capabilityContractDigest`, and it does not exist yet.
 *
 * So this digest binds THE SNAPSHOT THE MATCH WAS MADE AGAINST. It answers
 * "did the thing I matched change underneath me?" — which is what makes a
 * commitment meaningful — but it does NOT carry CSD-resolution semantics, and
 * a consumer must not assume it does.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import { ADDRESS_PATTERN, canonicalize, ID_PATTERN } from "@pcc/spec";

/** The subset of a matched capability this digest commits to. */
export interface MatchedCapabilitySnapshot {
  capabilityId: string;
  capabilityType: string;
  kernelId: string;
  price: number;
  currency: string;
  assuranceTiers: number[];
}

/**
 * Fields deliberately EXCLUDED, and why — this list is the contract:
 *
 *  - `score`      the matcher's confidence, not a property of the capability.
 *                 Two runs may score differently for identical capabilities;
 *                 including it would make the digest unstable for no gain.
 *  - `name`       human-facing and freely editable. A rename is not a change
 *                 in what was bought.
 *  - `tags`,
 *    `materials`  descriptive. They influence WHETHER something matched, not
 *                 WHAT the operator is committing to deliver or be paid.
 *
 * Included, and why: id and type identify it; kernelId says WHO performs it
 * (the same capability type on a different kernel is a different commitment);
 * price and currency are the money; assuranceTiers are the evidence obligation.
 * If any of those six move, the commitment should not silently still verify.
 */
export function matchedCapabilityDigest(
  snap: MatchedCapabilitySnapshot,
): `0x${string}` {
  if (!Number.isFinite(snap.price)) {
    throw new TypeError(
      `matchedCapabilityDigest: price must be finite, got ${snap.price}. ` +
        `An unpriced match must not produce a digest that looks valid.`,
    );
  }
  const canonical = canonicalize({
    capabilityId: snap.capabilityId,
    capabilityType: snap.capabilityType,
    kernelId: snap.kernelId,
    // Price as a fixed-precision STRING, never a float. 0.1 + 0.2 style drift
    // in a JS number would move this digest for two runs that agree on the
    // money, and the shared canonicalizer's number serialization is not
    // RFC 8785 either.
    price: snap.price.toFixed(2),
    currency: snap.currency,
    // Sorted so the digest cannot depend on registry iteration order.
    assuranceTiers: [...snap.assuranceTiers].sort((a, b) => a - b),
  });
  return `0x${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** The canonical pre-image, exposed so a cross-lane mismatch is diffable. */
export function matchedCapabilityDigestPreImage(
  snap: MatchedCapabilitySnapshot,
): string {
  return canonicalize({
    capabilityId: snap.capabilityId,
    capabilityType: snap.capabilityType,
    kernelId: snap.kernelId,
    price: snap.price.toFixed(2),
    currency: snap.currency,
    assuranceTiers: [...snap.assuranceTiers].sort((a, b) => a - b),
  });
}

// ── v2 (board N20) ───────────────────────────────────────────────────────────
// The CONTENT is gateway's decision (#2354). The byte layout is composition's draft, which gateway
// acked (#3547). The full spec and the golden vector are in the reconciliation plan
// plan-accepted-deal-v3.md, section "N20". v1 above is unchanged. It stays what the legacy decomposer
// and today's claims carry, and accepted-deal v3's per-node `matchedCapabilityDigestVersion` says
// which pre-image a sealed digest was made from.
//
// v2 commits to what v1 leaves out: WHO is paid, the CSD's exact version AND content, the measurement
// profile, and where the kernel is. The price is an exact integer of minor units, never a float. Every
// value is checked and normalized before hashing. A value that breaks its rule means NO digest: the
// function throws, and nothing is coerced.

export const MATCHED_CAPABILITY_DIGEST_V2_DOMAIN = "PCC:matched-capability:v2";

/** The inputs of a v2 digest: each one is the SERVER's resolved value, never a caller's claim. */
export interface MatchedCapabilitySnapshotV2 {
  capabilityId: string;
  capabilityType: string;
  kernelId: string;
  /** The address R10 pays, from the same resolver, so the commitment and the payment can never diverge. */
  operatorSettlementAddress: string;
  /** A settlement token symbol. The caller has already checked that it is settleable. */
  currency: string;
  /** That token's decimals. */
  currencyDecimals: number;
  /** The flat price in minor units. Variable pricing has no v2 digest. */
  priceMinorUnits: bigint;
  /** The SERVED tiers: the declared tiers, clamped to the kernel's authorized ceiling by the one resolver R10 admits a tier with. */
  assuranceTiers: readonly number[];
  /** The resolved CSD identity (`resolveCapabilityContractIdentity`): its versioned url and its content digest. */
  csd: { url: string; contractDigest: string };
  /** R21's measurement profile, or null until R21 exists. */
  measurementProfile: { id: string; version: string } | null;
  /**
   * The KERNEL's registered location, never the capability row's. `null`,
   * absent, or the exact {lat:0,lng:0} origin all mean "no location" (board
   * N20 round 2, agreed with gateway #3603) and encode identically as
   * `kernelLocationGeohash6: null` — never a geohash, never omitted.
   */
  kernelLocation?: { lat: number; lng: number } | null;
}

// ── Acceptance limits NOT stated in the quoted N20 spec text (board N20
// follow-up #440-C) ──────────────────────────────────────────────────────
// MAX_TIER_ENTRIES and the per-component length caps inside CSD_URL_PATTERN
// (64 for <class>, 32 for <version>) are DELIBERATE restrictions this
// implementation adds on top of N20's text, to bound the cost of
// validating/sorting/hashing a hostile input. They are kept, not removed —
// a conforming re-implementation in another language should adopt them
// explicitly as part of THIS module's contract, rather than infer them.
// Flagged here for the spec owner to fold into N20's text.
const MAX_PRICE_MINOR_UNITS = (1n << 128n) - 1n;
const MAX_TIER_ENTRIES = 16;
const CURRENCY_PATTERN = /^[A-Za-z0-9]{1,16}$/;
/** `pcc://capabilities/<class>/<version>`: printable ASCII, and no "/" inside either part. */
const CSD_URL_PATTERN = /^pcc:\/\/capabilities\/[\x21-\x2E\x30-\x7E]{1,64}\/[\x21-\x2E\x30-\x7E]{1,32}$/;
const CONTRACT_DIGEST_PATTERN = /^sha256:[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ASSURANCE_TIERS: ReadonlySet<number> = new Set([0, 1, 2, 3]);
const GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * The standard base32 geohash. The bits alternate, longitude first. Each bit compares the value with
 * the midpoint of its current interval: `>=` the midpoint is 1 and keeps the upper half. Only
 * comparisons and halving of IEEE doubles are used, and both are exact, so any language computes the
 * same string from the same doubles. Throws on a value that is not a location.
 */
export function geohash(lat: number, lng: number, precision: number): string {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new TypeError(`geohash: latitude ${String(lat)} is not in [-90, 90]`);
  }
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new TypeError(`geohash: longitude ${String(lng)} is not in [-180, 180]`);
  }
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new TypeError(`geohash: precision ${String(precision)} is not an integer from 1 to 12`);
  }
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let out = "", bits = 0, count = 0, longitudeBit = true;
  while (out.length < precision) {
    if (longitudeBit) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { bits = bits * 2 + 1; lngLo = mid; } else { bits = bits * 2; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { bits = bits * 2 + 1; latLo = mid; } else { bits = bits * 2; latHi = mid; }
    }
    longitudeBit = !longitudeBit;
    if (++count === 5) {
      out += GEOHASH_ALPHABET[bits];
      bits = 0;
      count = 0;
    }
  }
  return out;
}

function refuse(field: string, rule: string): never {
  throw new TypeError(`matchedCapabilityDigestV2: ${field} ${rule}. A value that breaks its rule gets no digest.`);
}

function idOf(field: string, v: unknown): string {
  if (typeof v !== "string" || !ID_PATTERN.test(v)) refuse(field, "must be 1-128 printable ASCII characters");
  return v;
}

/**
 * The canonical v2 pre-image, exposed so a cross-lane mismatch can be diffed. It has exactly the 12
 * keys of the spec: nothing from the input is spread in, so no other field can leak into the
 * commitment. Every field is read once. Throws on any value that breaks its rule.
 */
export function matchedCapabilityDigestV2PreImage(snap: MatchedCapabilitySnapshotV2): string {
  const {
    capabilityId, capabilityType, kernelId, operatorSettlementAddress, currency, currencyDecimals,
    priceMinorUnits, assuranceTiers, csd, measurementProfile, kernelLocation,
  } = snap;

  const id = idOf("capabilityId", capabilityId);
  const type = idOf("capabilityType", capabilityType);
  const kernel = idOf("kernelId", kernelId);

  if (typeof operatorSettlementAddress !== "string" || !ADDRESS_PATTERN.test(operatorSettlementAddress)) {
    refuse("operatorSettlementAddress", "must be 0x and 40 hex digits (no fallback for any other form)");
  }
  const address = operatorSettlementAddress.toLowerCase();
  if (address === ZERO_ADDRESS) refuse("operatorSettlementAddress", "must not be the zero address");

  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) refuse("currency", "must be a token symbol");
  if (typeof currencyDecimals !== "number" || !Number.isInteger(currencyDecimals) || currencyDecimals < 0 || currencyDecimals > 36) {
    refuse("currencyDecimals", "must be an integer from 0 to 36");
  }
  if (typeof priceMinorUnits !== "bigint" || priceMinorUnits < 1n || priceMinorUnits > MAX_PRICE_MINOR_UNITS) {
    refuse("priceMinorUnits", "must be a bigint from 1 to 2^128 - 1");
  }

  if (!Array.isArray(assuranceTiers)) {
    refuse("assuranceTiers", "must be a non-empty list of at most 16 entries");
  }
  // Reject a substituted iterator outright instead of trusting it: a
  // caller-defined Symbol.iterator can serve fewer, different, or zero
  // entries than bounded index access sees on the SAME object (board N20
  // follow-up #440-A) — its mere presence makes the array's real content
  // unknowable, so this refuses rather than tries to "see through" it.
  if ((assuranceTiers as unknown as Record<symbol, unknown>)[Symbol.iterator] !== Array.prototype[Symbol.iterator]) {
    refuse("assuranceTiers", "must be a plain array with the built-in iterator");
  }
  // `.length` is read exactly ONCE, right here, and never again — a Proxy
  // that answers differently across repeated reads (e.g. one value during
  // this check, another during iteration) cannot smuggle a different
  // element count past this check, because there is no separate iteration
  // step left for it to diverge on.
  const tierCount = assuranceTiers.length;
  if (!Number.isInteger(tierCount) || tierCount === 0 || tierCount > MAX_TIER_ENTRIES) {
    refuse("assuranceTiers", "must be a non-empty list of at most 16 entries");
  }
  const tiers: number[] = [];
  for (let i = 0; i < tierCount; i++) {
    // Bounded index scan via hasOwnProperty, never the iterable protocol: a
    // sparse hole must throw here (Array#every silently skips holes instead).
    if (!Object.prototype.hasOwnProperty.call(assuranceTiers, i)) {
      refuse("assuranceTiers", "may only hold the tiers 0 to 3");
    }
    const t = (assuranceTiers as readonly unknown[])[i];
    if (typeof t !== "number" || !ASSURANCE_TIERS.has(t)) refuse("assuranceTiers", "may only hold the tiers 0 to 3");
    tiers.push(t);
  }

  if (typeof csd !== "object" || csd === null) refuse("csd", "is required (no contract, no digest)");
  const { url, contractDigest } = csd;
  if (typeof url !== "string" || !CSD_URL_PATTERN.test(url)) refuse("csd.url", "must be a versioned pcc://capabilities/<class>/<version> url");
  if (typeof contractDigest !== "string" || !CONTRACT_DIGEST_PATTERN.test(contractDigest)) {
    refuse("csd.contractDigest", "must be sha256: and 64 hex digits");
  }

  let profile: { id: string; version: string } | null = null;
  if (measurementProfile !== null) {
    if (typeof measurementProfile !== "object" || measurementProfile === undefined) {
      refuse("measurementProfile", "must be null or {id, version}");
    }
    const { id: profileId, version } = measurementProfile;
    profile = { id: idOf("measurementProfile.id", profileId), version: idOf("measurementProfile.version", version) };
  }

  // `null`/absent, or the exact {lat:0,lng:0} origin, both mean "no
  // location" (board N20 round 2, agreed with gateway #3603): {0,0} is not
  // a real place any kernel is actually registered at, so it is treated
  // the same as "we don't know" — and BOTH encode as an explicit `null`,
  // never a geohash string and never an omitted key, so "no location" can
  // never be misread as a real cell.
  const isOrigin =
    typeof kernelLocation === "object" &&
    kernelLocation !== null &&
    (kernelLocation as { lat?: unknown }).lat === 0 &&
    (kernelLocation as { lng?: unknown }).lng === 0;
  let kernelLocationGeohash6: string | null;
  if (kernelLocation === null || kernelLocation === undefined || isOrigin) {
    kernelLocationGeohash6 = null;
  } else {
    if (typeof kernelLocation !== "object") refuse("kernelLocation", "is required");
    const { lat, lng } = kernelLocation;
    try {
      kernelLocationGeohash6 = geohash(lat, lng, 6);
    } catch {
      refuse(
        "kernelLocation",
        "must be null/absent, exactly {lat:0,lng:0}, or a finite latitude in [-90, 90] and longitude in [-180, 180]",
      );
    }
  }

  return canonicalize({
    domain: MATCHED_CAPABILITY_DIGEST_V2_DOMAIN,
    capabilityId: id,
    capabilityType: type,
    kernelId: kernel,
    operatorSettlementAddress: address,
    currency,
    currencyDecimals: String(currencyDecimals),
    priceMinorUnits: priceMinorUnits.toString(),
    assuranceTiers: [...new Set(tiers)].sort((a, b) => a - b),
    csd: { url, contractDigest: contractDigest.toLowerCase() },
    measurementProfile: profile,
    kernelLocationGeohash6,
  });
}

/** v2: `0x` and the lowercase hex of SHA-256 over the UTF-8 bytes of the canonical pre-image. Throws like the pre-image. */
export function matchedCapabilityDigestV2(snap: MatchedCapabilitySnapshotV2): `0x${string}` {
  return `0x${createHash("sha256").update(matchedCapabilityDigestV2PreImage(snap), "utf8").digest("hex")}`;
}

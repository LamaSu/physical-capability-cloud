/**
 * Per-(CSD, tier) evidence requirement ladders (board N19; the public data the
 * oracle's /settle tier recompute consumes, N33).
 *
 * The oracle recomputes the achieved tier from a kernel-signed bundle's
 * AUTHENTICATED event types, under the ladder of the capability that was
 * funded: tier T counts only if every tier 0..T is met (monotone closure over
 * tiers contiguous from 0). Until now the only public ladder was
 * DEFAULT_TIER_REQUIREMENTS, which is FDM-shaped and ignores the CSD, so a
 * print-and-mail bundle (no gcode_hash_verified) failed even tier 0. This
 * module compiles a CSD's OWN ladder from its evidence tiers, deterministically,
 * so the oracle and every public consumer read the same sets by value:
 *
 *   - requiredEventTypes: AND of OR-groups, the DEFAULT_TIER_REQUIREMENTS shape
 *     (a tier drops into any consumer of TierEvidenceRequirements). Every
 *     `required[]` entry that is a vocabulary event type is one group.
 *   - nonEventRequirements: the `required[]` entries that are not event types
 *     (payload or bundle fields such as trackingCode). Presence of an event
 *     type cannot prove them; the primitive that binds them must.
 *   - primitives: the tier's structured primitive references, the list the
 *     oracle runs a registered verifier over at /settle. Every listed
 *     primitive is verified, supporting ones included: `supporting` says only
 *     that a committed program may not release on it (committed-program.ts).
 *
 * Compilation fails closed with a TierLadderError when the tiers are not
 * contiguous from tier0, a tier binds a primitive to something it does not
 * require or to an event its verifier cannot read, a tier supplies params to
 * a primitive whose paramsSchema is closed-empty, a tier drops a requirement
 * of the tier below it, or a tier above 0
 * adds no event type over the tier below. The last matters because the
 * recompute reads event types only: such a tier would be granted on the lower
 * tier's evidence. Legacy CSDs whose required[] lists field names rather than
 * event types (fdm, sla, and the other built-ins today) are refused entirely
 * with tier-adds-no-event-type; compilation returns no tier-0-only ladder. A `role:
 * "supporting"` flag never removes a bind from the ladder, so a tier's promise
 * cannot be weakened by relabelling its evidence (N19).
 *
 * The ladder is committed like a program hash (`computeTierLadderDigest`):
 * 0x + SHA-256 of the canonical ladder, domain-separated by its `schemaHash`.
 * It carries the CSD's `capabilityContractDigest`, so a ladder names the exact
 * contract revision it was compiled from. Verifier implementation status is
 * deliberately NOT in the ladder: a verifier going live must not change what
 * a funded agreement committed to (see `computeCsdEligibility` for that axis).
 */

import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { CSD } from "../csd/schema.js";
import { computeContractDigest } from "../csd/capability-contract-identity.js";
import type { AssuranceTier } from "../types/common.js";
import { DEFAULT_TIER_REQUIREMENTS, EVIDENCE_EVENT_TYPES, type EvidenceEventType } from "../types/evidence.js";
import { canonicalize, canonicalSnapshot } from "../util/canonical.js";
import { getPrimitive } from "./primitives.js";

export const TIER_LADDER_SCHEMA = "tier-ladder/v1" as const;

export interface TierLadderPrimitive {
  id: string;
  /** The event type or field the primitive binds; null when it binds none (a declaration). */
  bind: string | null;
  /** `params.role === "supporting"`: supports the outcome, never proves it. */
  supporting: boolean;
  params: Record<string, unknown> | null;
}

export interface TierLadderTier {
  tier: AssuranceTier;
  description: string;
  /** AND of OR-groups over vocabulary event types, sorted. */
  requiredEventTypes: EvidenceEventType[][];
  /** Always requiredEventTypes.length: one present event per group. */
  minimumEvents: number;
  /** Required entries that are not event types, sorted. */
  nonEventRequirements: string[];
  /** The tier's primitive references, in CSD order. */
  primitives: TierLadderPrimitive[];
}

export interface TierLadderV1 {
  version: 1;
  schemaHash: typeof TIER_LADDER_SCHEMA;
  /** The versioned CSD url. */
  capabilityContractId: string;
  /** computeContractDigest of the CSD the ladder was compiled from. */
  capabilityContractDigest: string;
  tiers: TierLadderTier[];
}

export type TierLadderErrorCode =
  | "non-canonical-input"
  | "malformed-ladder"
  | "no-evidence-tiers"
  | "unknown-tier-key"
  | "tiers-not-contiguous"
  | "malformed-tier"
  | "bind-not-required"
  | "primitive-bind-not-allowed"
  | "primitive-params-not-allowed"
  | "tier-drops-requirement"
  | "tier-adds-no-event-type";

export class TierLadderError extends Error {
  constructor(
    readonly code: TierLadderErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TierLadderError";
  }
}

const EVENT_TYPES = new Set<string>(EVIDENCE_EVENT_TYPES);
const TIER_KEY = /^tier([0-3])$/;

/**
 * Fixed verifier event sources (#8812/#8815). Keep compile admission separate
 * from EvidencePrimitiveDef: it adds no vocabulary-manifest contract field.
 */
export const PRIMITIVE_ALLOWED_BIND_TYPES: Readonly<Record<string, readonly EvidenceEventType[]>> = Object.freeze({
  "input.hash_bound": Object.freeze(["method_loaded"] as const),
});

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/**
 * Read caller data once, by own descriptors, before interpreting any fields.
 * Node can detect Proxies; refuse them before reflection can run a trap. The
 * shared canonicalizer then validates the owned tree's JSON values and makes
 * the canonical snapshot. No caller iterator, getter or toJSON is invoked.
 */
function ownedSnapshot<T>(input: unknown): T {
  const copies = new WeakMap<object, object>();
  function copy(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (nodeTypes.isProxy(value)) throw new Error("Proxy input");
    const previous = copies.get(value);
    if (previous) return previous;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("non-plain input");
    }
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    copies.set(value, result);
    let length = 0;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
        throw new Error("invalid array length");
      }
      length = descriptor.value;
    }
    const keys = Reflect.ownKeys(value);
    // An array must own every index and nothing else besides length.
    if (array && keys.length !== length + 1) throw new Error("sparse or extended array");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw new Error("symbol property");
      if (array && !(Number.isInteger(Number(key)) && Number(key) >= 0 && Number(key) < length && String(Number(key)) === key)) {
        throw new Error("non-index array property");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        throw new Error("accessor or non-enumerable property");
      }
      Object.defineProperty(result, key, {
        value: copy(descriptor.value), enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  }
  try {
    return canonicalSnapshot<T>(copy(input)).value;
  } catch {
    // Never inspect a thrown caller value (it could itself be a hostile Proxy).
    throw new TierLadderError("non-canonical-input", "expected plain JSON data with dense arrays and no accessors or Proxies");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// The public spec barrel loads this module. Keep initialization here because
// types/evidence.ts also serves as the wire-type source of truth.
deepFreeze(DEFAULT_TIER_REQUIREMENTS);

function compileTier(k: number, raw: unknown): { tier: TierLadderTier; required: Set<string> } {
  if (!isPlainObject(raw) || typeof raw.description !== "string" || !Array.isArray(raw.required)) {
    throw new TierLadderError("malformed-tier", `tier${k}: needs description and a required[] array`);
  }
  if (!raw.required.every(isNonEmptyString)) {
    throw new TierLadderError("malformed-tier", `tier${k}: every required[] entry must be a non-empty string`);
  }
  const primitivesRaw = raw.primitives ?? [];
  if (!Array.isArray(primitivesRaw)) {
    throw new TierLadderError("malformed-tier", `tier${k}: primitives must be an array`);
  }

  const required = new Set<string>(raw.required as string[]);
  const primitives: TierLadderPrimitive[] = primitivesRaw.map((p, i) => {
    if (
      !isPlainObject(p) ||
      !isNonEmptyString(p.id) ||
      (p.bind !== undefined && !isNonEmptyString(p.bind)) ||
      (p.params !== undefined && !isPlainObject(p.params))
    ) {
      throw new TierLadderError("malformed-tier", `tier${k}: primitives[${i}] needs an id, and bind/params of the right type`);
    }
    const bind = (p.bind as string | undefined) ?? null;
    if (bind !== null && !required.has(bind)) {
      throw new TierLadderError(
        "bind-not-required",
        `tier${k}: primitive "${p.id}" binds "${bind}", which tier${k} does not require`,
      );
    }
    const allowedBindTypes = Object.hasOwn(PRIMITIVE_ALLOWED_BIND_TYPES, p.id)
      ? PRIMITIVE_ALLOWED_BIND_TYPES[p.id]
      : undefined;
    if (allowedBindTypes !== undefined && !allowedBindTypes.some((eventType) => eventType === bind)) {
      throw new TierLadderError(
        "primitive-bind-not-allowed",
        `tier${k}: primitive "${p.id}" must bind ${allowedBindTypes.map((eventType) => `"${eventType}"`).join(" or ")}, got ${bind === null ? "no bind" : `"${bind}"`}`,
      );
    }
    const params = (p.params as Record<string, unknown> | undefined) ?? null;
    // A closed-empty schema promises no configurable fields. Do not silently
    // preserve params that a verifier cannot read; other schemas are unchanged.
    const paramsSchema = getPrimitive(p.id)?.paramsSchema;
    if (
      paramsSchema?.additionalProperties === false &&
      (paramsSchema.properties === undefined ||
        (isPlainObject(paramsSchema.properties) && Object.keys(paramsSchema.properties).length === 0)) &&
      params !== null && Object.keys(params).length !== 0
    ) {
      throw new TierLadderError(
        "primitive-params-not-allowed",
        `tier${k}: primitive "${p.id}" has a closed-empty paramsSchema and refuses non-empty params`,
      );
    }
    return { id: p.id, bind, supporting: params?.role === "supporting", params };
  });

  const events = [...required].filter((r) => EVENT_TYPES.has(r)).sort() as EvidenceEventType[];
  const tier: TierLadderTier = {
    tier: k as AssuranceTier,
    description: raw.description,
    requiredEventTypes: events.map((e) => [e]),
    minimumEvents: events.length,
    nonEventRequirements: [...required].filter((r) => !EVENT_TYPES.has(r)).sort(),
    primitives,
  };
  return { tier, required };
}

/**
 * Compile a CSD's evidence tiers into its ladder. Pass the resolved CSD (as
 * CsdRegistry.resolve returns it) so `capabilityContractDigest` equals the one
 * `resolveCapabilityContractIdentity` reports. Throws TierLadderError.
 */
export async function compileTierLadder(csd: CSD): Promise<TierLadderV1> {
  const snapshot = ownedSnapshot<CSD>(csd);
  if (!isPlainObject(snapshot) || !isNonEmptyString(snapshot.url)) {
    throw new TierLadderError("non-canonical-input", "the CSD must be an object with a non-empty url");
  }
  const evidence: unknown = snapshot.evidence;
  if (!isPlainObject(evidence) || Object.keys(evidence).length === 0) {
    throw new TierLadderError("no-evidence-tiers", `${snapshot.url}: the CSD declares no evidence tiers`);
  }
  const present: number[] = [];
  for (const key of Object.keys(evidence)) {
    const m = TIER_KEY.exec(key);
    if (!m) throw new TierLadderError("unknown-tier-key", `${snapshot.url}: evidence key "${key}" is not tier0..tier3`);
    present.push(Number(m[1]));
  }
  present.sort((a, b) => a - b);
  if (present.some((t, i) => t !== i)) {
    throw new TierLadderError(
      "tiers-not-contiguous",
      `${snapshot.url}: tiers [${present.join(", ")}] must run from tier0 without gaps`,
    );
  }

  const tiers: TierLadderTier[] = [];
  let below: Set<string> | null = null;
  for (const k of present) {
    const { tier, required } = compileTier(k, evidence[`tier${k}`]);
    if (below !== null) {
      const dropped = [...below].filter((r) => !required.has(r)).sort();
      if (dropped.length > 0) {
        throw new TierLadderError(
          "tier-drops-requirement",
          `tier${k} drops what tier${k - 1} requires: ${dropped.join(", ")}`,
        );
      }
      // The recompute reads event types only, so a tier that adds none over the
      // tier below would be granted on the lower tier's evidence. Refuse the
      // entire compilation, including legacy/FDM CSDs; return no partial ladder.
      const added = tier.requiredEventTypes.filter(([e]) => !below!.has(e!));
      if (added.length === 0) {
        throw new TierLadderError(
          "tier-adds-no-event-type",
          `tier${k} requires no event type beyond tier${k - 1}, so events cannot tell the two apart`,
        );
      }
    }
    tiers.push(tier);
    below = required;
  }

  return deepFreeze({
    version: 1,
    schemaHash: TIER_LADDER_SCHEMA,
    capabilityContractId: snapshot.url,
    capabilityContractDigest: await computeContractDigest(snapshot),
    tiers,
  });
}

/**
 * Ladder commitments pinned by capability contract id, so a funded policy and
 * the oracle's service-pinned ladder can be checked against one public value.
 * The DPM and Thursday PRINT unit's print-leg ladders are reproduced from the
 * bundled CSDs by tier-ladder.test.ts and mvp-print-leg.test.ts. Their full
 * ladders are in tier-ladder.vectors.json; the print-leg pin serves the oracle
 * and the host.
 */
export const PINNED_TIER_LADDER_DIGESTS: Readonly<Record<string, `0x${string}`>> = deepFreeze({
  "pcc://capabilities/document-print-and-mail/v1":
    "0xe9cf2a2f9f6dcc355a5c71cd503b7598c0cbf1b58429e452adfafe6cf0fe0560",
  "pcc://capabilities/document-print-leg/v1":
    "0x8d353c7ce7a41e60c1e6167ccd7a7fe0f66d7d031c3c8db45127b2c53b0cf14b",
});

function hasFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

/** Validate all V1 fields on the owned snapshot, before hashing any bytes. */
function assertLadderShape(value: unknown): asserts value is TierLadderV1 {
  const fail: () => never = () => { throw new TierLadderError("malformed-ladder", "expected a complete tier-ladder/v1 ladder"); };
  if (!hasFields(value, ["version", "schemaHash", "capabilityContractId", "capabilityContractDigest", "tiers"]) ||
    value.version !== 1 || value.schemaHash !== TIER_LADDER_SCHEMA ||
    !isNonEmptyString(value.capabilityContractId) ||
    typeof value.capabilityContractDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.capabilityContractDigest) ||
    !Array.isArray(value.tiers) || value.tiers.length === 0 || value.tiers.length > 4) fail();
  for (const [i, tier] of value.tiers.entries()) {
    if (!hasFields(tier, ["tier", "description", "requiredEventTypes", "minimumEvents", "nonEventRequirements", "primitives"]) ||
      tier.tier !== i || typeof tier.description !== "string" ||
      !Array.isArray(tier.requiredEventTypes) || tier.minimumEvents !== tier.requiredEventTypes.length ||
      !tier.requiredEventTypes.every((group: unknown) => Array.isArray(group) && group.length > 0 &&
        group.every((event: unknown) => typeof event === "string" && EVENT_TYPES.has(event))) ||
      !Array.isArray(tier.nonEventRequirements) || !tier.nonEventRequirements.every(isNonEmptyString) ||
      !Array.isArray(tier.primitives)) fail();
    for (const primitive of tier.primitives) {
      if (!hasFields(primitive, ["id", "bind", "supporting", "params"]) ||
        !isNonEmptyString(primitive.id) || (primitive.bind !== null && !isNonEmptyString(primitive.bind)) ||
        typeof primitive.supporting !== "boolean" || (primitive.params !== null && !isPlainObject(primitive.params))) fail();
    }
  }
}

/**
 * The ladder commitment: 0x + SHA-256 of the canonical V1 ladder. Refuses other
 * runtime shapes with TierLadderError; the fixed schema tag separates this
 * domain without changing the pinned canonical bytes.
 */
export function computeTierLadderDigest(ladder: TierLadderV1): `0x${string}` {
  const snapshot = ownedSnapshot<unknown>(ladder);
  assertLadderShape(snapshot);
  return `0x${createHash("sha256").update(canonicalize(snapshot), "utf8").digest("hex")}`;
}

/**
 * The tier a set of AUTHENTICATED, non-fabricated event types reaches under a
 * ladder: the highest T such that tiers 0..T are all met, a tier being met
 * when every AND-group has a present type. Null when tier0 is not met. The
 * caller authenticates the events; this reads types only.
 */
export function achievedTierFromEventTypes(
  ladder: Pick<TierLadderV1, "tiers">,
  eventTypes: Iterable<string>,
): AssuranceTier | null {
  const types = new Set(eventTypes);
  let achieved: AssuranceTier | null = null;
  const tiers = [...ladder.tiers].sort((a, b) => a.tier - b.tier);
  for (const [i, t] of tiers.entries()) {
    if (t.tier !== i) break;
    if (!t.requiredEventTypes.every((group) => group.some((e) => types.has(e)))) break;
    achieved = t.tier;
  }
  return achieved;
}

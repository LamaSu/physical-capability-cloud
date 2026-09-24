/**
 * Provenance planner (ADK D2): for one capability contract (CSD) and one
 * operator setup, which assurance tier the setup can reach, why it stops
 * there, and what would unlock the next tier.
 *
 * It composes the evidence engine that already exists and is otherwise
 * unwired: the contract side is `computeCsdEligibility` (unchanged rule, same
 * options), and the supply side is the default emitter manifests per adapter
 * type and device role (`adapter-manifests.ts`), plus explicit operator
 * adjustments. Nothing here is new evidence logic, and nothing here mints
 * assurance. Emitter manifests are CLAIMS used for matching (emitter-manifest.ts
 * trust model): the oracle verifies real primitive instances at settlement.
 *
 * Rules the planner keeps:
 *   - It never reads a self-declared tier. Only the CSD's `url` and `evidence`
 *     are read; `maxAssuranceTier`, capability `assuranceTiers` and similar
 *     fields cannot change the plan.
 *   - A `mock` adapter caps the plan at tier 0, whatever else is declared: a
 *     mock cannot prove a real execution.
 *   - A tier is achievable only if the contract makes it eligible AND every
 *     primitive it requires is supplied. Tiers are cumulative: tier N needs
 *     tiers 0..N achievable. Tier 0 is the always-listable floor.
 *   - Human-attestation (Family "attest") and payment ("pay") primitives are
 *     settlement steps, not hardware: they are listed, never counted as gaps.
 *     The contract's tier>=2 human floor still applies through the lint.
 *   - Deterministic: inputs are de-duplicated and sorted before use, and every
 *     output list is sorted, so any permutation of the inputs yields the same
 *     plan and the same `provenancePlanDigest`.
 *
 * Whether a tier is FUNDABLE is decided by the pre-funding gate, not by this
 * plan: #349's assertAcceptedProgramForTier, which also requires tiers 0..T
 * eligible with implemented verifiers (this plan's requireImplementedVerifier
 * mode shows that side) and the committed program hash.
 */

import type { SHA256 } from "../types/common.js";
import type { CSD, CsdEvidenceTier } from "../csd/schema.js";
import { canonicalize, sha256 } from "../util/canonical.js";
import { computeCsdEligibility, type EligibilityOptions } from "./eligibility.js";
import {
  ADAPTER_DEFAULT_MANIFESTS,
  DEVICE_ROLE_DEFAULT_MANIFESTS,
} from "./adapter-manifests.js";
import {
  EVIDENCE_PRIMITIVES,
  HUMAN_ATTESTATION_FAMILY,
  type EvidencePrimitiveDef,
} from "./primitives.js";
import type { EvidenceEmitterManifest } from "./emitter-manifest.js";

export const PROVENANCE_PLAN_SCHEMA = "pcc.provenance-plan.v0" as const;

/** The self-attested floor: any operator can always declare it. */
const DECLARATION_PRIMITIVE = "decl.self_attested";
const PAYMENT_FAMILY = "pay";

export interface ProvenancePlanInput {
  /** Only `url` and `evidence` are read. */
  csd: Pick<CSD, "url" | "evidence">;
  /** Kernel adapter types of the executing machines, e.g. "ipp", "opentrons". */
  adapterTypes: readonly string[];
  /** Evidence-only peripherals, e.g. "camera", "sensor". */
  deviceRoles?: readonly string[];
  /**
   * Operator adjustments to the default manifests. `add` names primitives the
   * operator says the setup can emit (a claim, flagged in the advisories);
   * `remove` names primitives it cannot emit, whatever the defaults say.
   */
  adjustments?: { add?: readonly string[]; remove?: readonly string[] };
  /** Passed to computeCsdEligibility: stub verifiers cap (the oracle-enforcing mode). */
  requireImplementedVerifier?: boolean;
  /** Primitive index; defaults to the live vocabulary. */
  index?: ReadonlyMap<string, EvidencePrimitiveDef>;
}

export interface TierPlan {
  tier: number;
  /** The contract side: computeCsdEligibility's verdict for this tier. */
  contractEligible: boolean;
  contractReasons: string[];
  /** Primitive ids this tier requires (structured primitives[] only). */
  required: string[];
  /** Required ids the setup supplies, with every source that supplies each. */
  supplied: Array<{ id: string; sources: string[] }>;
  /** Required ids met at settlement (human approval, payment), not by hardware. */
  settlementSteps: string[];
  /** Required ids nothing in the setup supplies. */
  missing: string[];
  /** Required ids whose verifier is not live yet (advisory in report-only mode). */
  stubVerifiers: string[];
  achievable: boolean;
}

export interface MissingPrimitiveHint {
  id: string;
  /** Known default emitters, e.g. "device-role:camera". Empty when none exists. */
  candidates: string[];
}

export interface ProvenancePlan {
  schema: typeof PROVENANCE_PLAN_SCHEMA;
  csdUrl: string;
  /** The normalized inputs the plan was computed from. */
  inputs: {
    adapterTypes: string[];
    deviceRoles: string[];
    added: string[];
    removed: string[];
    requireImplementedVerifier: boolean;
  };
  contract: {
    verdict: "ELIGIBLE" | "CAPPED";
    eligibleTier: number;
    declaredTier: number;
    cappedReason: string | null;
  };
  /** Highest tier N with tiers 0..N achievable by this setup. Never below 0. */
  achievableTier: number;
  /** Why tier achievableTier+1 is not reached; empty when nothing higher is declared. */
  cappedBy: string[];
  /** What the next declared tier needs, or null when nothing higher is declared. */
  nextTier: {
    tier: number;
    missing: MissingPrimitiveHint[];
    contractReasons: string[];
    settlementSteps: string[];
  } | null;
  perTier: TierPlan[];
  advisories: string[];
}

const TIER_KEY = /^tier([0-3])$/;

function sortedUnique(values: Iterable<string>): string[] {
  const out = [...new Set([...values].map((v) => v.trim()).filter((v) => v !== ""))];
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** First occurrence wins; order is otherwise kept. */
function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function defaultIndex(): ReadonlyMap<string, EvidencePrimitiveDef> {
  return new Map(EVIDENCE_PRIMITIVES.map((d) => [d.id, d]));
}

function addSource(map: Map<string, Set<string>>, id: string, source: string): void {
  const set = map.get(id) ?? new Set<string>();
  set.add(source);
  map.set(id, set);
}

function manifestSources(
  manifests: Readonly<Record<string, EvidenceEmitterManifest>>,
  prefix: string,
): Map<string, Set<string>> {
  const byPrimitive = new Map<string, Set<string>>();
  for (const [name, manifest] of Object.entries(manifests)) {
    for (const emit of manifest.emits) addSource(byPrimitive, emit.id, `${prefix}:${name}`);
  }
  return byPrimitive;
}

/** Which default emitters can supply each primitive (the reverse index). */
export function defaultEmitterIndex(): Map<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const src of [
    manifestSources(ADAPTER_DEFAULT_MANIFESTS, "adapter"),
    manifestSources(DEVICE_ROLE_DEFAULT_MANIFESTS, "device-role"),
  ]) {
    for (const [id, sources] of src) for (const s of sources) addSource(merged, id, s);
  }
  // mock can supply nothing above the floor, so it is never suggested.
  const out = new Map<string, string[]>();
  for (const [id, sources] of merged) {
    out.set(id, sortedUnique([...sources].filter((s) => s !== "adapter:mock")));
  }
  return out;
}

/**
 * The CSD evidence map with each tier's primitives in a canonical order, so the
 * lint's reasons (which follow ref order) do not depend on how the CSD lists
 * them. Only order changes; no ref is added, dropped or merged.
 */
function canonicalEvidenceOrder(
  evidence: CSD["evidence"] | undefined,
): Record<string, CsdEvidenceTier> {
  const out: Record<string, CsdEvidenceTier> = {};
  for (const [key, tier] of Object.entries(evidence ?? {})) {
    const t = tier as CsdEvidenceTier;
    if (!t.primitives) {
      out[key] = t;
      continue;
    }
    const keyed = t.primitives.map((ref) => ({ ref, sortKey: canonicalize(ref) }));
    keyed.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    out[key] = { ...t, primitives: keyed.map((k) => k.ref) };
  }
  return out;
}

function tierRequired(tier: CsdEvidenceTier | undefined): string[] {
  return sortedUnique((tier?.primitives ?? []).map((p) => p.id));
}

/**
 * Plan the provenance a setup can produce for a capability contract.
 * Pure and synchronous; see `provenancePlanDigest` for the plan's identity.
 */
export function planProvenance(input: ProvenancePlanInput): ProvenancePlan {
  const index = input.index ?? defaultIndex();
  const requireImplementedVerifier = input.requireImplementedVerifier ?? false;
  const adapterTypes = sortedUnique(input.adapterTypes);
  const deviceRoles = sortedUnique(input.deviceRoles ?? []);
  const added = sortedUnique(input.adjustments?.add ?? []);
  const removed = sortedUnique(input.adjustments?.remove ?? []);
  const removedSet = new Set(removed);
  const advisories: string[] = [];

  // ── Supply: which primitives this setup can emit, and from where ──────────
  const supply = new Map<string, Set<string>>();
  for (const type of adapterTypes) {
    const manifest = ADAPTER_DEFAULT_MANIFESTS[type];
    if (!manifest) {
      advisories.push(`adapter "${type}" has no default emitter manifest; it supplies nothing`);
      continue;
    }
    for (const emit of manifest.emits) addSource(supply, emit.id, `adapter:${type}`);
  }
  for (const role of deviceRoles) {
    const manifest = DEVICE_ROLE_DEFAULT_MANIFESTS[role];
    if (!manifest) {
      advisories.push(`device role "${role}" has no default emitter manifest; it supplies nothing`);
      continue;
    }
    for (const emit of manifest.emits) addSource(supply, emit.id, `device-role:${role}`);
  }
  for (const id of added) {
    if (!index.has(id)) {
      advisories.push(`operator-added primitive "${id}" is not in the vocabulary; ignored`);
      continue;
    }
    addSource(supply, id, "operator");
  }
  if (added.length > 0) {
    advisories.push(
      "operator-added primitives are claims: none is demonstrated until a real test job produces it",
    );
  }
  for (const id of removedSet) supply.delete(id);
  // The declaration floor is always available unless the operator removed it.
  if (!removedSet.has(DECLARATION_PRIMITIVE)) addSource(supply, DECLARATION_PRIMITIVE, "declaration");

  const mockPresent = adapterTypes.includes("mock");
  if (mockPresent) {
    advisories.push("a mock adapter cannot prove a real execution: the plan is capped at tier 0");
  }

  // ── Contract: the unchanged eligibility rule ──────────────────────────────
  const eligibilityOptions: EligibilityOptions = { index, requireImplementedVerifier };
  const evidence = canonicalEvidenceOrder(input.csd.evidence);
  const contract = computeCsdEligibility({ url: input.csd.url, evidence }, eligibilityOptions);

  const declaredTiers = Object.keys(evidence)
    .map((k) => TIER_KEY.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  // ── Per tier: contract verdict × supply coverage ──────────────────────────
  const perTier: TierPlan[] = [];
  for (const k of declaredTiers) {
    const lint = contract.perTier.find((p) => p.tier === k);
    const required = tierRequired(evidence[`tier${k}`] as CsdEvidenceTier | undefined);
    const supplied: Array<{ id: string; sources: string[] }> = [];
    const settlementSteps: string[] = [];
    const missing: string[] = [];
    for (const id of required) {
      const def = index.get(id);
      const family = def?.family;
      if (family === HUMAN_ATTESTATION_FAMILY || family === PAYMENT_FAMILY) {
        settlementSteps.push(id);
        continue;
      }
      const sources = supply.get(id);
      if (sources && sources.size > 0) supplied.push({ id, sources: sortedUnique(sources) });
      else missing.push(id);
    }
    const contractEligible = lint?.eligible ?? false;
    const achievable =
      contractEligible && missing.length === 0 && !(mockPresent && k >= 1);
    perTier.push({
      tier: k,
      contractEligible,
      contractReasons: uniqueInOrder(lint?.reasons ?? []),
      required,
      supplied,
      settlementSteps,
      missing,
      stubVerifiers: sortedUnique(lint?.stubVerifierPrimitives ?? []),
      achievable,
    });
  }

  // Tiers are cumulative; an unachievable declared tier 0 blocks any ascent.
  const tier0 = perTier.find((t) => t.tier === 0);
  let achievableTier = 0;
  if (!tier0 || tier0.achievable) {
    for (let k = 1; k <= 3; k++) {
      const t = perTier.find((p) => p.tier === k);
      if (t && t.achievable && achievableTier === k - 1) achievableTier = k;
      else break;
    }
  }

  // ── What stops the next tier, and what would unlock it ────────────────────
  const reverse = defaultEmitterIndex();
  const blockedAt =
    tier0 && !tier0.achievable ? tier0 : perTier.find((p) => p.tier === achievableTier + 1);
  const cappedBy: string[] = [];
  let nextTier: ProvenancePlan["nextTier"] = null;
  if (blockedAt) {
    cappedBy.push(...blockedAt.contractReasons);
    for (const id of blockedAt.missing) cappedBy.push(`tier${blockedAt.tier}: nothing in this setup supplies "${id}"`);
    if (mockPresent && blockedAt.tier >= 1) cappedBy.push("a mock adapter caps the plan at tier 0");
    nextTier = {
      tier: blockedAt.tier,
      missing: blockedAt.missing.map((id) => ({ id, candidates: reverse.get(id) ?? [] })),
      contractReasons: [...blockedAt.contractReasons],
      settlementSteps: [...blockedAt.settlementSteps],
    };
  }

  const stubs = sortedUnique(perTier.filter((t) => t.tier <= achievableTier).flatMap((t) => t.stubVerifiers));
  if (!requireImplementedVerifier && stubs.length > 0) {
    advisories.push(
      `verifiers not live yet for: ${stubs.join(", ")}; the oracle-enforcing mode caps on these`,
    );
  }

  return {
    schema: PROVENANCE_PLAN_SCHEMA,
    csdUrl: input.csd.url,
    inputs: { adapterTypes, deviceRoles, added, removed, requireImplementedVerifier },
    contract: {
      verdict: contract.verdict,
      eligibleTier: contract.eligibleTier,
      declaredTier: contract.declaredTier,
      cappedReason: contract.cappedReason ?? null,
    },
    achievableTier,
    cappedBy,
    nextTier,
    perTier,
    advisories: sortedUnique(advisories),
  };
}

/** The plan's identity: sha256 over its canonical JSON, as `sha256:<hex>`. */
export async function provenancePlanDigest(plan: ProvenancePlan): Promise<SHA256> {
  return sha256(canonicalize(plan));
}

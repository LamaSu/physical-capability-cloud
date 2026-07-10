/**
 * Evidence Emitter Manifest — the SUPPLY side of the evidence vocabulary.
 *
 * Two legs of the onboarding pattern already shipped: (leg 1) the bounded
 * primitive vocabulary + eligibility lint (`primitives.ts` + `eligibility.ts`),
 * and (leg 2) the open declaration document (CSD `evidence.tierN.primitives[]`,
 * `csd/schema.ts`). What nothing declared was the SUPPLY side: which primitives
 * a given adapter / device / process instance can actually EMIT. That mapping
 * lived only in adapter code. This file is that missing declaration.
 *
 * An `EvidenceEmitterManifest` is a subject-flexible list of primitive claims in
 * the SAME grammar as the CSD refs (`CsdEvidencePrimitiveRefSchema`) — it reuses
 * that schema and adds two fields: `via` (provenance) and `demonstrated` (set
 * only by test-job/prove, never the author). It attaches to an adapter TYPE
 * (default manifest), a DEVICE instance, or a PROCESS/workflow CSD. It must be
 * able to attach to the DEVICE, because evidence-only peripherals (a camera, a
 * power monitor) have no billable CSD of their own to host it, yet are exactly
 * what upgrade OTHER capabilities' tiers.
 *
 * TRUST MODEL (durable constraint D1 — everything settles through the oracle):
 * `emits[]` is a CLAIM used for MATCHING, eligibility, and lint. It NEVER mints
 * assurance. At job time the oracle verifies actual primitive instances per its
 * fail-closed verifier registry; a false manifest yields failed verification and
 * reputation damage, not stolen funds. The manifest is a matching artifact, not
 * a security boundary.
 *
 * See ai/research/pcc-evidence-onboarding-pattern.md §2 for the full design.
 */

import { z } from "zod";
import {
  CsdEvidencePrimitiveRefSchema,
  type CsdEvidencePrimitiveRef,
  type CsdEvidenceTier,
} from "../csd/schema.js";
import { computeCsdEligibility } from "./eligibility.js";
import { EVIDENCE_PRIMITIVES, type EvidencePrimitiveDef } from "./primitives.js";

// ── The manifest shape ──────────────────────────────────────────────

/**
 * One emitter declaration — the SAME grammar as a CSD primitive ref
 * (`{ id, params?, bind? }`) plus supply-side provenance/demonstration.
 */
export const EmitterDeclSchema = CsdEvidencePrimitiveRefSchema.extend({
  /** Provenance: adapter command / EvidenceEventType / peripheral deviceId. */
  via: z.string().optional(),
  /**
   * Demonstration flag — set ONLY by test-job / prove after a real run produced
   * this primitive, NEVER by the author. Declaration ≠ demonstration ≠
   * settlement; this is the middle checkpoint. (Consumers land in a follow-up.)
   */
  demonstrated: z.boolean().optional(),
});
export type EmitterDecl = z.infer<typeof EmitterDeclSchema>;

/** What a manifest attaches to. Subject-flexible: adapter | device | process. */
export const EmitterSubjectKindSchema = z.enum(["adapter", "device", "process"]);
export type EmitterSubjectKind = z.infer<typeof EmitterSubjectKindSchema>;

export const EmitterSubjectSchema = z.object({
  kind: EmitterSubjectKindSchema,
  /** adapterType | deviceId | CSD url — identifies the subject instance. */
  ref: z.string().min(1),
});
export type EmitterSubject = z.infer<typeof EmitterSubjectSchema>;

export const EvidenceEmitterManifestSchema = z.object({
  subject: EmitterSubjectSchema,
  /** Which vocabulary version the claims were authored against. */
  vocabVersion: z.number().int().nonnegative(),
  emits: z.array(EmitterDeclSchema),
  /** Optional draft primitive proposals → the growth loop (consumer deferred). */
  proposals: z.array(z.unknown()).optional(),
});
export type EvidenceEmitterManifest = z.infer<typeof EvidenceEmitterManifestSchema>;

// ── Bridge: emitter manifest → CSD evidence tier map ────────────────

export interface BuildEvidenceOptions {
  /** Primitive index to resolve ids against. Defaults to the v1 vocabulary. */
  index?: ReadonlyMap<string, EvidencePrimitiveDef>;
  /** Highest tier the derived ladder may reach. Default 3. */
  maxTier?: 0 | 1 | 2 | 3;
}

function defaultIndex(): ReadonlyMap<string, EvidencePrimitiveDef> {
  return new Map(EVIDENCE_PRIMITIVES.map((d) => [d.id, d]));
}

function minSupportedTier(def: EvidencePrimitiveDef): number {
  return Math.min(...def.tierSupport.map((t) => t.tier));
}

/**
 * The lowest tier a primitive can VALIDLY appear at: its own minimum supported
 * tier, raised by any transitive dependency's effective-min (a primitive cannot
 * sit below its dependencies). The vocabulary graph is acyclic (asserted by the
 * primitives test); the stack guard is defensive only.
 */
function effectiveMinTier(
  id: string,
  index: ReadonlyMap<string, EvidencePrimitiveDef>,
  memo: Map<string, number>,
  stack: Set<string>,
): number {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  const def = index.get(id);
  if (!def) return 0;
  if (stack.has(id)) return minSupportedTier(def);
  stack.add(id);
  let m = minSupportedTier(def);
  for (const dep of def.dependsOn ?? []) {
    if (index.has(dep)) m = Math.max(m, effectiveMinTier(dep, index, memo, stack));
  }
  stack.delete(id);
  memo.set(id, m);
  return m;
}

/** Keep only the CSD-ref fields; drop the manifest-only via/demonstrated. */
function toCsdRef(e: EmitterDecl): CsdEvidencePrimitiveRef {
  const ref: CsdEvidencePrimitiveRef = { id: e.id };
  if (e.params !== undefined) ref.params = e.params;
  if (e.bind !== undefined) ref.bind = e.bind;
  return ref;
}

/** Strip an emit list down to plain CSD primitive refs. */
export function emitsToPrimitiveRefs(
  emits: readonly EmitterDecl[],
): CsdEvidencePrimitiveRef[] {
  return emits.map(toCsdRef);
}

function deriveRequired(refs: readonly CsdEvidencePrimitiveRef[]): string[] {
  const binds = refs
    .map((r) => r.bind)
    .filter((b): b is string => typeof b === "string" && b.length > 0);
  return Array.from(new Set(["jobId", "timestamp", ...binds]));
}

/**
 * Derive a CSD `evidence` tier map from a flat emit list — the artifact that
 * makes an onboarded device eligible-by-default instead of tier-0-capped.
 *
 * The derivation is VOCABULARY-DRIVEN (tiers flow from each primitive's
 * `tierSupport`, not from hand-authored tier numbers):
 *   1. Resolve known emits; DROP ids absent from the live vocabulary — a
 *      not-yet-shipped primitive contributes nothing until its entry lands, at
 *      which point the tier rises with zero re-onboarding (the "rising tide").
 *   2. Expand transitive vocabulary dependencies, so the map is dependency-
 *      closed regardless of whether the manifest author listed the deps.
 *   3. Place each ref at every supported tier ≥ its effective-min tier.
 *   4. Truncate to the highest REPORT-ONLY-eligible tier, so the result is
 *      ELIGIBLE (never CAPPED) at whatever tier the emit set can support. A set
 *      that cannot reach the human-attestation floor stops below tier 2 — the
 *      honest matching signal, not a claim of assurance.
 * Tier 0 is always present (self-attested floor) so the CSD stays listable.
 */
export function buildEvidenceTiersFromEmits(
  emits: readonly EmitterDecl[],
  options: BuildEvidenceOptions = {},
): Record<string, CsdEvidenceTier> {
  const index = options.index ?? defaultIndex();
  const maxTier = options.maxTier ?? 3;

  // 1 + 2 — resolve known emits, expand transitive vocab dependencies.
  const refById = new Map<string, CsdEvidencePrimitiveRef>();
  const queue: EmitterDecl[] = emits.filter((e) => index.has(e.id));
  while (queue.length > 0) {
    const e = queue.shift() as EmitterDecl;
    const existing = refById.get(e.id);
    if (existing) {
      // Merge duplicate declarations of one primitive: keep the first, but adopt
      // a bind/params the first lacked (preserves authoring intent across a
      // shared core + a per-adapter refinement of the same id).
      if (existing.bind === undefined && e.bind !== undefined) existing.bind = e.bind;
      if (existing.params === undefined && e.params !== undefined) existing.params = e.params;
      continue;
    }
    refById.set(e.id, toCsdRef(e));
    for (const dep of index.get(e.id)?.dependsOn ?? []) {
      if (index.has(dep) && !refById.has(dep)) queue.push({ id: dep });
    }
  }

  const memo = new Map<string, number>();
  const effMin = (id: string) => effectiveMinTier(id, index, memo, new Set());

  // 3 — candidate ladder: each ref at every supported tier ≥ its effective-min.
  const candidate: Record<string, CsdEvidenceTier> = {};
  for (let k = 0; k <= maxTier; k++) {
    const inTier: CsdEvidencePrimitiveRef[] = [];
    for (const [id, ref] of refById) {
      const def = index.get(id);
      if (!def) continue;
      if (def.tierSupport.some((t) => t.tier === k) && k >= effMin(id)) inTier.push(ref);
    }
    if (inTier.length === 0) continue;
    candidate[`tier${k}`] = {
      description: `Derived tier ${k} evidence (emitter manifest → vocabulary).`,
      required: deriveRequired(inTier),
      primitives: inTier,
    };
  }

  // Guarantee a listable tier-0 floor even for an empty/degenerate emit set.
  if (!candidate.tier0) {
    candidate.tier0 = {
      description: "Self-attested tier-0 floor (permissionless on-ramp).",
      required: ["jobId", "timestamp"],
      primitives: [{ id: "decl.self_attested" }],
    };
  }

  // 4 — truncate to the highest report-only-eligible tier.
  const report = computeCsdEligibility({ url: "pcc://emitter-derived", evidence: candidate });
  const out: Record<string, CsdEvidenceTier> = {};
  for (let k = 0; k <= report.eligibleTier; k++) {
    const key = `tier${k}`;
    if (candidate[key]) out[key] = candidate[key];
  }
  if (!out.tier0 && candidate.tier0) out.tier0 = candidate.tier0;
  return out;
}

/** Convenience: derive a CSD evidence map straight from a manifest. */
export function manifestToCsdEvidence(
  manifest: EvidenceEmitterManifest,
  options: BuildEvidenceOptions = {},
): Record<string, CsdEvidenceTier> {
  return buildEvidenceTiersFromEmits(manifest.emits, options);
}

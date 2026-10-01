/**
 * Committed verification programs and the tier-assurance check (technical pack
 * §3, must-close 6; the resolver half of composition's LO-CO-3).
 *
 * Non-zero assurance must bind the exact committed program for its CSD tier
 * before funding, and that program must actually release on what the tier
 * promises. Before this, the composition commitment (v3, #327) pinned a
 * `verificationProgramHash` that the plan's author supplied, and nothing
 * checked the program against the tier.
 *
 * A COMMITTED program is the evidence-owned stage shape the oracle hashes and
 * runs: string predicates over raw event types (`event-present`,
 * `event-absent`, `event-present-independent`, `not-simulated`), hashed with
 * the same preimage as `computeVerificationProgramHash`
 * ({version, schemaHash, stages}). It is distinct from the object-predicate
 * `VerificationProgram` authoring shape.
 *
 * `checkCommittedProgramForTier` enforces, for a non-zero tier:
 *   - every stage uses a known predicate and names a vocabulary event type;
 *   - every positive stage (event-present / event-present-independent) names an
 *     event type the tier binds through a primitive that is not marked
 *     `role: "supporting"`, and that proves an outcome level (`evidenceLevelOf`
 *     rulings: `printer_job_verified` proves none);
 *   - some positive stage proves device_reported or stronger;
 *   - a `not-simulated` stage is present;
 *   - an event-present `execution_completed` is paired with event-absent
 *     `execution_failed` (the v4 print-leg rule).
 * Tier evidence that no stage requires is returned as `unenforcedTierEvidence`:
 * it is only enforced if the oracle verifies those primitives itself, which is
 * not visible from public PCC and must be confirmed with the oracle.
 *
 * `resolveAcceptedProgram` maps (CSD, tier) to its one committed program, or
 * fails closed for a non-zero tier with none. `assertAcceptedProgramForTier` is
 * the pre-funding gate: the committed hash must equal the resolved program's
 * hash exactly, so a tier upgrade or downgrade without its own program is
 * refused, and the resolved program must pass the tier check.
 *
 * The gate also refuses a tier that cannot be verified end to end (N19). The
 * oracle reads the tier's evidence two ways: event presence under the CSD's
 * ladder (tier-ladder.ts) and a registered verifier per listed primitive, which
 * fails closed while it is a stub (verifier-interface.ts). So the funded CSD's
 * tiers 0..T must be eligible under `computeCsdEligibility` in its
 * oracle-enforcing mode (`requireImplementedVerifier`). Otherwise the program
 * would be sold for evidence nobody can check, and the unenforced tier
 * evidence above would silently weaken the promise. As authored,
 * document-print-and-mail is eligible only at tier 0, so its tier2 program
 * stays pinned but cannot be funded until the CSD and its verifiers are fixed.
 *
 * The production gate takes no overrides. `assertAcceptedProgramForTier(input)`
 * always resolves against `COMMITTED_PROGRAM_REGISTRY` and the built-in
 * primitive vocabulary, so a caller cannot hand it a registry, or a primitive
 * index that marks every verifier "live", to fund a tier (E8 F4). The
 * registry- and index-injecting form, `assertAcceptedProgramForTierWith`, is for
 * tests only and is deliberately absent from `evidence/index.ts`.
 */

import type { CsdEvidenceTier } from "../csd/schema.js";
import { EVIDENCE_EVENT_TYPES } from "../types/evidence.js";
import {
  computeVerificationProgramHash,
  type VerificationProgram,
} from "../types/verification-program.js";
import { computeCsdEligibility, type EligibilityOptions } from "./eligibility.js";
import {
  DEVICE_REPORTED_EVENT_TYPES,
  INSPECTION_EVENT_TYPES,
  NO_OUTCOME_LEVEL_EVENT_TYPES,
} from "./evidence-level.js";

export const COMMITTED_STAGE_PREDICATES = [
  "event-present",
  "event-absent",
  "event-present-independent",
  "not-simulated",
] as const;

export type CommittedStagePredicate = (typeof COMMITTED_STAGE_PREDICATES)[number];

export interface CommittedStage {
  id: string;
  predicate: CommittedStagePredicate;
  eventType?: string;
  allowedProvenance?: string[];
}

export interface CommittedProgram {
  version: number;
  schemaHash: string;
  stages: CommittedStage[];
}

/** The committed program hash: the preimage of `computeVerificationProgramHash`. */
export function computeCommittedProgramHash(program: CommittedProgram): `0x${string}` {
  return computeVerificationProgramHash(
    program as unknown as Omit<VerificationProgram, "programHash">,
  );
}

// ── document.print-and-mail, v4 (ported from the evidence golden on #270) ────

const PRINT_LEG: CommittedStage[] = [
  { id: "print-ok", predicate: "event-present", eventType: "execution_completed" },
  { id: "print-not-failed", predicate: "event-absent", eventType: "execution_failed" },
];

/** Print succeeded and did not fail, and an INDEPENDENT carrier scan closed the mail leg. */
export const PRINT_AND_MAIL_INDEPENDENCE_PROGRAM: CommittedProgram = {
  version: 1,
  schemaHash: "verification-program/v1",
  stages: [
    ...PRINT_LEG,
    {
      id: "mail",
      predicate: "event-present-independent",
      eventType: "courier_pickup_confirmed",
      allowedProvenance: ["independent_carrier_scan"],
    },
    { id: "auth", predicate: "not-simulated" },
  ],
};

/** As above, but an operator self-reported carrier event may close the mail leg. */
export const PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM: CommittedProgram = {
  version: 1,
  schemaHash: "verification-program/v1",
  stages: [
    ...PRINT_LEG,
    { id: "mail", predicate: "event-present", eventType: "courier_pickup_confirmed" },
    { id: "auth", predicate: "not-simulated" },
  ],
};

export const PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH =
  "0xd229c8daa76cb3022041b6ff076d30a5ecb614d71f50a07f80f680629dcc2b86" as const;
export const PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH =
  "0x6e00cad1095c6a2913671e30969436897bd12ce60b3957f7b259f56875c863e0" as const;

export interface CommittedProgramEntry {
  /** CSD name, e.g. "document-print-and-mail". */
  csd: string;
  /** Evidence tier key in the CSD, e.g. "tier2". */
  tier: string;
  program: CommittedProgram;
  programHash: `0x${string}`;
}

/**
 * The one committed program per (CSD, non-zero tier). A tier with no entry has
 * no committed program and cannot be funded above tier 0. Only
 * document-print-and-mail tier2 (independent carrier acceptance scan) has one
 * today; tier1 (print only) and tier3 (close on delivery) have none. An entry
 * is necessary, not sufficient: the gate also requires the tier to be
 * eligible, which print-and-mail tier2 is not yet (see the module header).
 */
export const COMMITTED_PROGRAM_REGISTRY: readonly CommittedProgramEntry[] = [
  {
    csd: "document-print-and-mail",
    tier: "tier2",
    program: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM,
    programHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
  },
];

// ── The tier check ──────────────────────────────────────────────────────────

export type TierAssuranceViolation =
  | { code: "unknown-predicate"; stageId: string }
  | { code: "stage-missing-event-type"; stageId: string }
  | { code: "stage-event-not-in-vocabulary"; stageId: string; eventType: string }
  | { code: "positive-stage-not-bound-by-tier"; stageId: string; eventType: string }
  | { code: "positive-stage-on-supporting-evidence"; stageId: string; eventType: string }
  | { code: "positive-stage-proves-no-level"; stageId: string; eventType: string }
  | { code: "no-device-reported-stage" }
  | { code: "missing-not-simulated" }
  | { code: "completion-without-failure-absence" };

export interface TierAssuranceCheck {
  violations: TierAssuranceViolation[];
  /** Event types the tier binds (not as supporting evidence) that no stage requires. */
  unenforcedTierEvidence: string[];
}

const VOCABULARY = new Set<string>(EVIDENCE_EVENT_TYPES);
const PREDICATES = new Set<string>(COMMITTED_STAGE_PREDICATES);
const NO_LEVEL = new Set<string>(NO_OUTCOME_LEVEL_EVENT_TYPES);
const COMPLETION_OR_STRONGER = new Set<string>([
  ...DEVICE_REPORTED_EVENT_TYPES,
  ...INSPECTION_EVENT_TYPES,
]);

function isSupporting(params: Record<string, unknown> | undefined): boolean {
  return params?.role === "supporting";
}

/** Check a committed program against the CSD tier it is meant to back. */
export function checkCommittedProgramForTier(
  program: CommittedProgram,
  tier: CsdEvidenceTier,
): TierAssuranceCheck {
  const violations: TierAssuranceViolation[] = [];
  const primitives = tier.primitives ?? [];
  const bound = new Set<string>();
  const boundSupportingOnly = new Set<string>();
  for (const p of primitives) {
    if (p.bind === undefined) continue;
    if (isSupporting(p.params)) boundSupportingOnly.add(p.bind);
    else bound.add(p.bind);
  }
  for (const t of bound) boundSupportingOnly.delete(t);

  const required = new Set<string>();
  let sawNotSimulated = false;
  let sawDeviceReported = false;
  let completionPresent = false;
  let failureAbsent = false;

  for (const stage of program.stages) {
    if (!PREDICATES.has(stage.predicate)) {
      violations.push({ code: "unknown-predicate", stageId: stage.id });
      continue;
    }
    if (stage.predicate === "not-simulated") {
      sawNotSimulated = true;
      continue;
    }
    const eventType = stage.eventType;
    if (eventType === undefined || eventType === "") {
      violations.push({ code: "stage-missing-event-type", stageId: stage.id });
      continue;
    }
    if (!VOCABULARY.has(eventType)) {
      violations.push({ code: "stage-event-not-in-vocabulary", stageId: stage.id, eventType });
      continue;
    }
    if (stage.predicate === "event-absent") {
      if (eventType === "execution_failed") failureAbsent = true;
      continue;
    }
    // A positive stage: the program releases on this event being present.
    required.add(eventType);
    if (eventType === "execution_completed") completionPresent = true;
    if (!bound.has(eventType)) {
      violations.push(
        boundSupportingOnly.has(eventType)
          ? { code: "positive-stage-on-supporting-evidence", stageId: stage.id, eventType }
          : { code: "positive-stage-not-bound-by-tier", stageId: stage.id, eventType },
      );
    }
    if (NO_LEVEL.has(eventType)) {
      violations.push({ code: "positive-stage-proves-no-level", stageId: stage.id, eventType });
    }
    if (COMPLETION_OR_STRONGER.has(eventType)) sawDeviceReported = true;
  }

  if (!sawDeviceReported) violations.push({ code: "no-device-reported-stage" });
  if (!sawNotSimulated) violations.push({ code: "missing-not-simulated" });
  if (completionPresent && !failureAbsent) {
    violations.push({ code: "completion-without-failure-absence" });
  }

  const unenforcedTierEvidence = [...bound].filter((t) => VOCABULARY.has(t) && !required.has(t)).sort();
  return { violations, unenforcedTierEvidence };
}

// ── Resolution and the pre-funding gate ─────────────────────────────────────

/** Tier number from a CSD tier key ("tier2" -> 2); null for any other key. */
export function tierNumber(tierKey: string): number | null {
  const m = /^tier(\d+)$/.exec(tierKey);
  return m ? Number(m[1]) : null;
}

export type ResolvedProgram =
  | { ok: true; program: null; programHash: null }
  | { ok: true; program: CommittedProgram; programHash: `0x${string}` }
  | { ok: false; code: "no-committed-program" };

/**
 * The committed program for (CSD, tier). Tier 0 needs none. Any other tier,
 * including a key that is not `tierN`, resolves only to its registry entry.
 */
export function resolveAcceptedProgram(
  csd: string,
  tierKey: string,
  registry: readonly CommittedProgramEntry[] = COMMITTED_PROGRAM_REGISTRY,
): ResolvedProgram {
  if (tierNumber(tierKey) === 0) return { ok: true, program: null, programHash: null };
  const entries = registry.filter((e) => e.csd === csd && e.tier === tierKey);
  if (entries.length !== 1) return { ok: false, code: "no-committed-program" };
  const entry = entries[0]!;
  return { ok: true, program: entry.program, programHash: entry.programHash };
}

/** Primitives whose verifier checks a signer against a pinned registry snapshot. */
export const REGISTRY_BACKED_PRIMITIVES: readonly string[] = ["ident.registered_key"];

/**
 * A registry the accepted deal must pin. The committed CSD tier names the
 * registry (`params.registryId`), and the deal seals the snapshotHash it read
 * before compile (bus #3391, registry-pins-note.md).
 */
export interface RequiredRegistryPin {
  primitiveId: string;
  registryId: string;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A registry id the deal can seal: printable ASCII, 1 to 128 characters. It is the
 * same id rule the accepted deal's parser applies (`ID_PATTERN`), so a bad id is
 * refused here, before funding, instead of at compile.
 */
const REGISTRY_ID = /^[\x21-\x7E]{1,128}$/;

/**
 * The registry pins a funded (CSD, tier k) needs sealed in the accepted deal:
 * every registry-backed primitive in tiers 0..k, with the registry its params
 * name. Deduped on (primitiveId, registryId), and sorted by primitiveId then
 * registryId, in code-unit order. A registry-backed primitive that names no
 * registry cannot be pinned, so it is refused.
 */
export function requiredRegistryPins(
  evidence: Readonly<Record<string, CsdEvidenceTier>>,
  k: number,
): { ok: true; pins: RequiredRegistryPin[] } | { ok: false; reasons: string[] } {
  const pins = new Map<string, RequiredRegistryPin>();
  const reasons: string[] = [];
  for (let t = 0; t <= k; t++) {
    for (const p of evidence[`tier${t}`]?.primitives ?? []) {
      if (!REGISTRY_BACKED_PRIMITIVES.includes(p.id)) continue;
      const registryId = (p.params as { registryId?: unknown } | undefined)?.registryId;
      if (typeof registryId !== "string" || registryId.length === 0) {
        reasons.push(`tier${t}: "${p.id}" names no registryId, so the deal cannot pin its registry`);
        continue;
      }
      if (!REGISTRY_ID.test(registryId)) {
        reasons.push(`tier${t}: "${p.id}" names a registryId that is not 1-128 printable ASCII characters, so the deal cannot pin it`);
        continue;
      }
      pins.set(JSON.stringify([p.id, registryId]), { primitiveId: p.id, registryId });
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    pins: [...pins.values()].sort((a, b) => byCodeUnit(a.primitiveId, b.primitiveId) || byCodeUnit(a.registryId, b.registryId)),
  };
}

export type AcceptedProgramGateResult =
  /** `registryPins`: what the accepted deal must pin (`requiredRegistryPins`). */
  | { ok: true; registryPins: RequiredRegistryPin[] }
  | {
      ok: false;
      code:
        | "no-committed-program"
        | "program-hash-mismatch"
        | "registry-hash-mismatch"
        | "program-on-tier-zero"
        | "tier-not-in-csd"
        | "tier-not-eligible"
        | "program-fails-tier-check"
        | "registry-not-named";
      violations?: TierAssuranceViolation[];
      /** tier-not-eligible: why tiers 0..T cannot be verified end to end. */
      reasons?: string[];
    };

/** What the test-only form of the gate can override. The production gate takes none of it. */
export interface AcceptedProgramGateOptions {
  /** Primitive index eligibility resolves against. Defaults to the v1 vocabulary. */
  primitiveIndex?: EligibilityOptions["index"];
}

export interface AcceptedProgramGateInput {
  csd: string;
  tierKey: string;
  evidence: Readonly<Record<string, CsdEvidenceTier>>;
  committedProgramHash: string | null;
}

/**
 * Pre-funding gate for one (CSD, tier) selection. `evidence` is the funded
 * CSD's whole evidence map (tiers 0..3), and `committedProgramHash` is what the
 * plan or composition commitment carries (null when none). A non-zero tier
 * passes only when that hash equals the resolved program's hash exactly, the
 * CSD's tiers 0..T are eligible with implemented verifiers, and the program
 * passes `checkCommittedProgramForTier` for the CSD's own tier. On success it
 * returns the registry pins the accepted deal must seal (`requiredRegistryPins`),
 * taken from the same server-resolved CSD tiers the gate just checked.
 *
 * It takes NO overrides: the registry is `COMMITTED_PROGRAM_REGISTRY` and the
 * primitive index is the built-in vocabulary, so what counts as a live verifier
 * is the evidence lane's data, never the caller's (E8 F4). A second or third
 * argument is a type error, and is ignored at runtime.
 */
export function assertAcceptedProgramForTier(input: AcceptedProgramGateInput): AcceptedProgramGateResult {
  return assertAcceptedProgramForTierWith(input, COMMITTED_PROGRAM_REGISTRY);
}

/**
 * TEST-ONLY. `assertAcceptedProgramForTier` with an injectable registry and
 * primitive index, so tests can drive the program, tier and eligibility legs
 * with fixtures. It is exported from this module and deliberately NOT from
 * `evidence/index.ts`, so it is not on the package's public surface. spec's
 * package.json `exports` map exposes only ".", "./schemas", "./identity" and
 * "./tool-manifests", so a package consumer cannot deep-import this module
 * either. Production code must call `assertAcceptedProgramForTier`: a caller
 * that could inject the index could mark every verifier live and fund a tier
 * whose evidence nobody can check.
 */
export function assertAcceptedProgramForTierWith(
  input: AcceptedProgramGateInput,
  registry: readonly CommittedProgramEntry[],
  options: AcceptedProgramGateOptions = {},
): AcceptedProgramGateResult {
  const resolved = resolveAcceptedProgram(input.csd, input.tierKey, registry);
  if (!resolved.ok) return { ok: false, code: "no-committed-program" };
  if (resolved.program === null) {
    if (input.committedProgramHash !== null) return { ok: false, code: "program-on-tier-zero" };
    return pinsResult(input.evidence ?? {}, 0);
  }
  if (computeCommittedProgramHash(resolved.program) !== resolved.programHash) {
    return { ok: false, code: "registry-hash-mismatch" };
  }
  // Hex case carries no meaning in a 0x digest; any other difference does.
  if (
    typeof input.committedProgramHash !== "string" ||
    input.committedProgramHash.toLowerCase() !== resolved.programHash
  ) {
    return { ok: false, code: "program-hash-mismatch" };
  }
  const tier = input.evidence?.[input.tierKey];
  const k = tierNumber(input.tierKey);
  if (tier === undefined || k === null) return { ok: false, code: "tier-not-in-csd" };
  const eligibility = computeCsdEligibility(
    { url: input.csd, evidence: { ...input.evidence } },
    { requireImplementedVerifier: true, index: options.primitiveIndex },
  );
  if (eligibility.eligibleTier < k) {
    const reasons = eligibility.perTier.filter((t) => t.tier <= k).flatMap((t) => t.reasons);
    if (reasons.length === 0) reasons.push(`tiers 0..${k} are not all declared`);
    return { ok: false, code: "tier-not-eligible", reasons };
  }
  const check = checkCommittedProgramForTier(resolved.program, tier);
  if (check.violations.length > 0) {
    return { ok: false, code: "program-fails-tier-check", violations: check.violations };
  }
  return pinsResult(input.evidence, k);
}

function pinsResult(evidence: Readonly<Record<string, CsdEvidenceTier>>, k: number): AcceptedProgramGateResult {
  const pins = requiredRegistryPins(evidence, k);
  return pins.ok ? { ok: true, registryPins: pins.pins } : { ok: false, code: "registry-not-named", reasons: pins.reasons };
}

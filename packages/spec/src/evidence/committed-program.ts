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
 */

import type { CsdEvidenceTier } from "../csd/schema.js";
import { EVIDENCE_EVENT_TYPES } from "../types/evidence.js";
import {
  computeVerificationProgramHash,
  type VerificationProgram,
} from "../types/verification-program.js";
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
 * today; tier1 (print only) and tier3 (close on delivery) have none.
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

export type AcceptedProgramGateResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "no-committed-program"
        | "program-hash-mismatch"
        | "registry-hash-mismatch"
        | "program-on-tier-zero"
        | "program-fails-tier-check";
      violations?: TierAssuranceViolation[];
    };

/**
 * Pre-funding gate for one (CSD, tier) selection. `committedProgramHash` is
 * what the plan or composition commitment carries (null when none). A non-zero
 * tier passes only when that hash equals the resolved program's hash exactly
 * and the program passes `checkCommittedProgramForTier` for this tier.
 */
export function assertAcceptedProgramForTier(
  input: {
    csd: string;
    tierKey: string;
    tier: CsdEvidenceTier;
    committedProgramHash: string | null;
  },
  registry: readonly CommittedProgramEntry[] = COMMITTED_PROGRAM_REGISTRY,
): AcceptedProgramGateResult {
  const resolved = resolveAcceptedProgram(input.csd, input.tierKey, registry);
  if (!resolved.ok) return { ok: false, code: "no-committed-program" };
  if (resolved.program === null) {
    return input.committedProgramHash === null ? { ok: true } : { ok: false, code: "program-on-tier-zero" };
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
  const check = checkCommittedProgramForTier(resolved.program, input.tier);
  if (check.violations.length > 0) {
    return { ok: false, code: "program-fails-tier-check", violations: check.violations };
  }
  return { ok: true };
}

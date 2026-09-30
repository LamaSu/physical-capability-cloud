/**
 * Safety envelope (ADK R8): the onboarding agent DRAFTS a device's safety
 * envelope and typed I/O from the operator's intake answers and cited
 * references, the operator CONFIRMS it once (yes or edit), and only a confirmed
 * envelope COMPILES into the CSD's typed I/O and its evidence tier.
 *
 * The operator's ruling (OPERATOR-QUEUE item 100.4): "the agent drafts the
 * safety envelope from manuals and literature, and the human confirms it once
 * (yes or edit). Price, payout wallet and safety limits are NEVER
 * agent-defaulted." So nothing here fills a limit on its own:
 *   - an operator's answer is a limit; a cited reference only PROPOSES one,
 *     and the operator confirms it;
 *   - a reference without a citation, or in another unit, is dropped;
 *   - a required quantity nobody gave, a conflict, or a reference that is
 *     tighter than the operator's answer becomes a QUESTION, never a default;
 *   - a draft with open questions cannot be confirmed, and an unconfirmed
 *     envelope cannot be compiled.
 *
 * "Safety envelope" is this term exactly. It is not `evidence-envelope` (a
 * data-integrity wrapper) or onboard-kit's `workEnvelope` (part dimensions).
 * The kernel's `OperationalEnvelope` (safety/governor.ts) is the runtime
 * check; compiling into it waits for the governor's owner, because an
 * undeclared field there falls back to built-in defaults and a limit of 0
 * disables its check (bus #4074). Until then a confirmed envelope is enforced
 * at admission (the CSD's typed parameter ranges) and after execution (the
 * #53 `telemetry.envelope_conformance` evidence tier).
 *
 * Every function is pure and deterministic: no I/O, no clock, no randomness.
 * Units come only from the composition unit table (`KNOWN_UNITS`), the one
 * the prism compiler parses.
 *
 * Inputs, by kits' permanent intake field ids (item 6, bus #4140):
 *   - `safety.limits` gives the operator's answers, one per template quantity (`intake.limits`);
 *   - `safety.estop` gives `intake.eStop`, `safety.supervision` gives
 *     `intake.supervision`, and `safety.hazards` gives `intake.hazards`;
 *   - R5 research findings give `references`, in R5's `{claim, value, unit,
 *     citation, retrievedAt}` shape, each for the template quantity it was
 *     asked about.
 * All of these are never defaulted.
 */

import { createHash } from "node:crypto";

import { KNOWN_UNITS, type ParameterDefinition, type PortType, type Unit } from "../csd/composition.js";
import type { CsdEvidenceTier, CsdParameter } from "../csd/schema.js";
import { canonicalize } from "../util/canonical.js";

/** Domain separator: an envelope digest can never collide with another digest. */
export const SAFETY_ENVELOPE_DOMAIN = "PCC:safety-envelope:v1";

/** A confirmed envelope's digest: `0x` + 64 lowercase hex (SHA-256), the commitment family. */
export type SafetyEnvelopeDigest = `0x${string}`;

const UNITS = new Set<string>(KNOWN_UNITS);

// ── Inputs ──────────────────────────────────────────────────────────

/** A limit the operator stated during intake (kits' item 6). */
export interface IntakeLimit {
  /** The intake field it answers, for provenance. */
  field: string;
  quantity: string;
  unit: string;
  min?: number;
  max?: number;
}

export interface Citation {
  doc: string;
  section: string;
  url?: string;
}

/**
 * A value found in a manual, datasheet or paper: an R5 research finding
 * (`{claim, value, unit, citation, retrievedAt}`) for one template quantity.
 * For a limit, `value` is a range, and either side may be absent: "at most
 * 95 degC" is `{max: 95}`, and it bounds only that side.
 */
export interface ReferenceFinding {
  /** The template quantity R5 was asked about. */
  quantity: string;
  claim: string;
  value: { min?: number; max?: number };
  unit: string;
  citation: Citation;
  /** ISO-8601 date the reference was read. */
  retrievedAt: string;
}

/** Who watches the device while it runs (`safety.supervision`). */
export const SUPERVISION_MODES = ["attended", "unattended", "remote-supervised"] as const;
export type Supervision = (typeof SUPERVISION_MODES)[number];

/** Hazard classes (`safety.hazards`). An empty list is the operator's explicit "none". */
export const HAZARDS = ["biological", "chemical", "heat", "laser", "mechanical"] as const;
export type Hazard = (typeof HAZARDS)[number];

export interface EStopDeclaration {
  /** How the device is stopped: a hardware button or relay, the adapter's stop command, or nothing. */
  mechanism: "hardware" | "adapter-stop" | "none";
  /** The adapter command that stops it, when `adapter-stop`. */
  stopCommand?: string;
}

export interface DeviceIdentity {
  deviceId: string;
  adapterType: string;
  vendor?: string;
  model?: string;
}

export interface SafetyEnvelopeInput {
  /** A key of DEVICE_CLASS_TEMPLATES. */
  deviceClass: string;
  device: DeviceIdentity;
  intake: {
    limits: IntakeLimit[];
    eStop?: EStopDeclaration;
    supervision?: Supervision;
    /** An empty list means the operator said "none"; a missing list is a question. */
    hazards?: Hazard[];
    /** The most commands per minute the operator allows; operator-only, never from a reference. */
    maxCommandsPerMinute?: number;
  };
  references: ReferenceFinding[];
}

// ── Templates (the "templates plus rules") ──────────────────────────

/** A quantity a device class must bound, and the typed job input it becomes. */
export interface QuantityRequirement {
  quantity: string;
  unit: Unit;
  /** The CSD / composition input parameter this limit bounds. */
  param: string;
  label: string;
  /** UI granularity of the input; not a safety limit. */
  step: number;
  semanticType: string;
  /** Why the limit matters, shown to the operator with the question. */
  why: string;
}

export interface DeviceClassTemplate {
  id: string;
  label: string;
  /** A device that moves or heats cannot be confirmed without an e-stop mechanism. */
  movesOrHeats: boolean;
  /** Every one needs a confirmed [min, max]; typed job inputs are ranges. */
  requires: QuantityRequirement[];
  outputPorts: Record<string, PortType>;
}

/**
 * The first cut: the two devices of the ADK dress rehearsal (item 100.2), a
 * generic-HTTP plate reader and an Opentrons OT-2. A template names what must
 * be bounded and how it is typed; it never supplies a value.
 */
export const DEVICE_CLASS_TEMPLATES: Readonly<Record<string, DeviceClassTemplate>> = {
  "lab-plate-reader": {
    id: "lab-plate-reader",
    label: "Microplate reader (absorbance), generic HTTP",
    movesOrHeats: true,
    requires: [
      {
        quantity: "incubation_temperature",
        unit: "degC",
        param: "incubationTemperature",
        label: "Incubation temperature",
        step: 0.1,
        semanticType: "temperature",
        why: "the incubator heats the plate; outside the instrument's rated range it damages samples or the heater",
      },
      {
        quantity: "read_duration",
        unit: "s",
        param: "readDuration",
        label: "Read duration",
        step: 1,
        semanticType: "duration",
        why: "the longest single read the instrument is rated for",
      },
    ],
    outputPorts: {
      absorbance: { semanticType: "absorbance-optical-density", required: true },
    },
  },
  "liquid-handler-ot2": {
    id: "liquid-handler-ot2",
    label: "Liquid handler, Opentrons OT-2",
    movesOrHeats: true,
    requires: [
      {
        quantity: "aspirate_volume",
        unit: "uL",
        param: "aspirateVolume",
        label: "Aspirate volume per transfer",
        step: 1,
        semanticType: "volume",
        why: "the mounted pipette's volume range; outside it the pipette over-aspirates or moves nothing",
      },
      {
        quantity: "module_temperature",
        unit: "degC",
        param: "moduleTemperature",
        label: "Temperature module setpoint",
        step: 0.5,
        semanticType: "temperature",
        why: "the temperature module's rated range",
      },
      {
        quantity: "run_duration",
        unit: "min",
        param: "runDuration",
        label: "Run duration",
        step: 1,
        semanticType: "duration",
        why: "the longest run the operator allows unattended",
      },
    ],
    outputPorts: {
      plate: { semanticType: "processed-plate", required: true },
    },
  },
};

// ── The draft ───────────────────────────────────────────────────────

export type LimitSource =
  | { kind: "operator"; field: string }
  | { kind: "reference"; citation: Citation; retrievedAt: string; claim: string };

export interface EnvelopeLimit {
  quantity: string;
  unit: Unit;
  param: string;
  min: number;
  max: number;
  proposedBy: "operator" | "reference";
  sources: LimitSource[];
}

export interface EnvelopeQuestion {
  /** The quantity it is about, or "e-stop", "command-rate", "supervision" or "hazards". */
  about: string;
  ask: string;
  why: string;
}

/** An input the draft did not use, and why. Shown to the operator, never silently lost. */
export interface DroppedInput {
  quantity: string;
  reason: string;
}

export interface SafetyEnvelopeDraft {
  envelopeVersion: 1;
  deviceClass: string;
  device: DeviceIdentity;
  limits: EnvelopeLimit[];
  eStop: EStopDeclaration | null;
  maxCommandsPerMinute: number | null;
  supervision: Supervision | null;
  hazards: Hazard[] | null;
  /** Empty exactly when the draft is ready to confirm. */
  questions: EnvelopeQuestion[];
  dropped: DroppedInput[];
}

/** Input the generator refuses outright (malformed, not merely incomplete). */
export class EnvelopeRefused extends Error {
  constructor(public readonly reasons: string[]) {
    super(`safety envelope refused (${reasons.length}): ${reasons.join("; ")}`);
    this.name = "EnvelopeRefused";
  }
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Why a bound pair is unusable as a range, or null. */
function rangeProblem(min: unknown, max: unknown): string | null {
  if (!finite(min) || !finite(max)) return "needs both a finite min and a finite max";
  if (min > max) return `min ${min} is above max ${max}`;
  return null;
}

const ESTOP_MECHANISMS: readonly string[] = ["hardware", "adapter-stop", "none"];

/** Why an e-stop cannot stand in a confirmed envelope for this class, or null. */
function eStopProblem(eStop: EStopDeclaration | null | undefined, template: DeviceClassTemplate): string | null {
  if (!eStop) return "no e-stop declared";
  if (!ESTOP_MECHANISMS.includes(eStop.mechanism)) {
    return `e-stop mechanism ${JSON.stringify(String(eStop.mechanism))} is not hardware, adapter-stop or none`;
  }
  if (eStop.mechanism === "none" && template.movesOrHeats) return "a device that moves or heats needs an e-stop";
  if (eStop.mechanism === "adapter-stop" && !nonEmpty(eStop.stopCommand)) return "an adapter stop needs its command";
  return null;
}

function rateProblem(rate: unknown): string | null {
  return Number.isInteger(rate) && (rate as number) >= 1 ? null : "maxCommandsPerMinute must be an integer >= 1";
}

/** Why a finding's value cannot bound a quantity, or null. Either side may be absent, but not both. */
function boundProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "has no {min, max} value";
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (min === undefined && max === undefined) return "bounds neither side";
  if (min !== undefined && !finite(min)) return "has a min that is not a finite number";
  if (max !== undefined && !finite(max)) return "has a max that is not a finite number";
  if (finite(min) && finite(max) && min > max) return `gives min ${min} above max ${max}`;
  return null;
}

function describeBound(bound: { min?: number; max?: number }, unit: string): string {
  if (bound.min !== undefined && bound.max !== undefined) return `${bound.min}..${bound.max} ${unit}`;
  return bound.min !== undefined ? `at least ${bound.min} ${unit}` : `at most ${bound.max} ${unit}`;
}

function supervisionProblem(supervision: unknown): string | null {
  return (SUPERVISION_MODES as readonly unknown[]).includes(supervision)
    ? null
    : `supervision ${JSON.stringify(String(supervision))} is not attended, unattended or remote-supervised`;
}

function hazardsProblem(hazards: unknown): string | null {
  if (!Array.isArray(hazards)) return "hazards must be a list (an empty list means none)";
  const unknown = hazards.filter((h) => !(HAZARDS as readonly unknown[]).includes(h));
  return unknown.length > 0 ? `unknown hazard ${unknown.map((h) => JSON.stringify(String(h))).join(", ")}` : null;
}

/** Hazards in one canonical order, each once, so the same answer always digests the same. */
function canonicalHazards(hazards: readonly Hazard[]): Hazard[] {
  return HAZARDS.filter((h) => hazards.includes(h));
}

/** Why a committed hazards list is not one confirm produces (each once, in canonical order), or null. */
function hazardsCanonicalProblem(hazards: unknown): string | null {
  if (hazardsProblem(hazards)) return null; // hazardsProblem reports it
  const list = hazards as Hazard[];
  const canonical = canonicalHazards(list);
  return canonical.length === list.length && canonical.every((h, i) => h === list[i])
    ? null
    : "hazards must each appear once, in canonical order";
}

function checkInput(input: SafetyEnvelopeInput): { template: DeviceClassTemplate } {
  const reasons: string[] = [];
  const template = Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, input?.deviceClass)
    ? DEVICE_CLASS_TEMPLATES[input.deviceClass]
    : undefined;
  if (!template) reasons.push(`unknown deviceClass ${JSON.stringify(String(input?.deviceClass))}`);
  if (!nonEmpty(input?.device?.deviceId)) reasons.push("device.deviceId is required");
  if (!nonEmpty(input?.device?.adapterType)) reasons.push("device.adapterType is required");
  if (!Array.isArray(input?.intake?.limits)) reasons.push("intake.limits must be an array");
  if (!Array.isArray(input?.references)) reasons.push("references must be an array");
  if (reasons.length > 0 || !template) throw new EnvelopeRefused(reasons);
  return { template };
}

/**
 * Draft the envelope for one device. Throws `EnvelopeRefused` only for
 * malformed input; missing or conflicting information becomes `questions`.
 */
export function draftSafetyEnvelope(input: SafetyEnvelopeInput): SafetyEnvelopeDraft {
  const { template } = checkInput(input);
  const limits: EnvelopeLimit[] = [];
  const questions: EnvelopeQuestion[] = [];
  const dropped: DroppedInput[] = [];

  for (const req of template.requires) {
    const ask = (why: string, text: string) => questions.push({ about: req.quantity, ask: text, why });
    const range = `the range of ${req.label.toLowerCase()} in ${req.unit}`;

    const answers = input.intake.limits.filter((l) => l?.quantity === req.quantity);
    const usableAnswers: IntakeLimit[] = [];
    for (const a of answers) {
      if (a.unit !== req.unit) {
        dropped.push({ quantity: req.quantity, reason: `operator answer in ${JSON.stringify(a.unit)}, not ${req.unit}` });
        continue;
      }
      const problem = rangeProblem(a.min, a.max);
      if (problem) {
        dropped.push({ quantity: req.quantity, reason: `operator answer ${problem}` });
        continue;
      }
      usableAnswers.push(a);
    }

    const references: ReferenceFinding[] = [];
    for (const r of input.references.filter((x) => x?.quantity === req.quantity)) {
      if (!nonEmpty(r.citation?.doc) || !nonEmpty(r.citation?.section)) {
        dropped.push({ quantity: req.quantity, reason: "a reference without a citation (doc and section) cannot propose a limit" });
      } else if (!nonEmpty(r.retrievedAt) || !Number.isFinite(Date.parse(r.retrievedAt))) {
        dropped.push({ quantity: req.quantity, reason: `a reference from ${r.citation.doc} has no valid retrievedAt` });
      } else if (r.unit !== req.unit) {
        dropped.push({ quantity: req.quantity, reason: `a reference from ${r.citation.doc} is in ${JSON.stringify(r.unit)}, not ${req.unit}` });
      } else if (boundProblem(r.value)) {
        dropped.push({ quantity: req.quantity, reason: `a reference from ${r.citation.doc} ${boundProblem(r.value)}` });
      } else {
        references.push(r);
      }
    }
    const referenceSources: LimitSource[] = references.map((r) => ({
      kind: "reference",
      citation: r.citation,
      retrievedAt: r.retrievedAt,
      claim: r.claim,
    }));

    const distinct = new Set(usableAnswers.map((a) => `${a.min}..${a.max}`));
    if (distinct.size > 1) {
      ask(req.why, `You gave ${[...distinct].join(" and ")} ${req.unit} for ${req.label.toLowerCase()}. Which is it?`);
      continue;
    }
    if (usableAnswers.length > 0) {
      const a = usableAnswers[0]!;
      // A reference tighter than the operator's answer, on either side, is asked about, never silently loosened past.
      const tighter = references.filter(
        (r) => (r.value.min !== undefined && r.value.min > (a.min as number)) || (r.value.max !== undefined && r.value.max < (a.max as number)),
      );
      for (const r of tighter) {
        ask(
          req.why,
          `${r.citation.doc} (${r.citation.section}) gives ${describeBound(r.value, req.unit)}; you gave ${a.min}..${a.max}. Confirm your range or tighten it.`,
        );
      }
      if (tighter.length > 0) continue;
      limits.push({
        quantity: req.quantity,
        unit: req.unit,
        param: req.param,
        min: a.min as number,
        max: a.max as number,
        proposedBy: "operator",
        sources: [{ kind: "operator", field: a.field }, ...referenceSources],
      });
      continue;
    }
    if (references.length > 0) {
      // Propose the tightest range the references allow together; the operator confirms it.
      // A one-sided bound constrains only its side, and a side nobody bounded is a question.
      const mins = references.flatMap((r) => (r.value.min === undefined ? [] : [r.value.min]));
      const maxes = references.flatMap((r) => (r.value.max === undefined ? [] : [r.value.max]));
      const min = mins.length > 0 ? Math.max(...mins) : undefined;
      const max = maxes.length > 0 ? Math.min(...maxes) : undefined;
      if (min !== undefined && max !== undefined && min > max) {
        ask(req.why, `The references disagree on ${range}: they do not overlap. What range should apply?`);
        continue;
      }
      if (min === undefined || max === undefined) {
        const missing = min === undefined ? "lowest" : "highest";
        ask(req.why, `The references give ${describeBound({ min, max }, req.unit)} for ${req.label.toLowerCase()}. What is the ${missing} it may be?`);
        continue;
      }
      limits.push({ quantity: req.quantity, unit: req.unit, param: req.param, min, max, proposedBy: "reference", sources: referenceSources });
      continue;
    }
    ask(req.why, `What is ${range}?`);
  }

  const eStop = input.intake.eStop ?? null;
  if (eStop === null) {
    questions.push({ about: "e-stop", ask: "How is this device stopped in an emergency?", why: "every device needs a declared stop" });
  } else if (!ESTOP_MECHANISMS.includes(eStop.mechanism)) {
    throw new EnvelopeRefused([`intake.eStop.mechanism ${JSON.stringify(String(eStop.mechanism))} is not hardware, adapter-stop or none`]);
  } else if (eStop.mechanism === "none" && template.movesOrHeats) {
    questions.push({
      about: "e-stop",
      ask: "This device moves or heats, and no emergency stop was declared. How is it stopped?",
      why: "a device that moves or heats cannot be confirmed without an e-stop",
    });
  } else if (eStop.mechanism === "adapter-stop" && !nonEmpty(eStop.stopCommand)) {
    questions.push({ about: "e-stop", ask: "Which adapter command stops the device?", why: "an adapter stop needs its command" });
  }

  const rate = input.intake.maxCommandsPerMinute;
  if (rate === undefined) {
    questions.push({
      about: "command-rate",
      ask: "How many commands per minute may be sent to this device at most?",
      why: "the runtime check rate-limits commands; the operator sets the limit",
    });
  } else if (!Number.isInteger(rate) || rate < 1) {
    throw new EnvelopeRefused([`intake.maxCommandsPerMinute must be an integer >= 1 (got ${String(rate)})`]);
  }

  const supervision = input.intake.supervision ?? null;
  if (supervision === null) {
    questions.push({
      about: "supervision",
      ask: "Who watches this device while it runs: attended, unattended, or remote-supervised?",
      why: "how the device is supervised is the operator's to state",
    });
  } else if (supervisionProblem(supervision)) {
    throw new EnvelopeRefused([`intake.${supervisionProblem(supervision)}`]);
  }

  const givenHazards = input.intake.hazards;
  if (givenHazards === undefined) {
    questions.push({
      about: "hazards",
      ask: "Which hazards does this device present: biological, chemical, heat, laser, mechanical, or none?",
      why: "none is an answer; silence is not",
    });
  } else if (hazardsProblem(givenHazards)) {
    throw new EnvelopeRefused([`intake.${hazardsProblem(givenHazards)}`]);
  }

  return {
    envelopeVersion: 1,
    deviceClass: template.id,
    device: { ...input.device },
    limits,
    eStop,
    maxCommandsPerMinute: rate ?? null,
    supervision,
    hazards: givenHazards === undefined ? null : canonicalHazards(givenHazards),
    questions,
    dropped,
  };
}

// ── Confirm once ────────────────────────────────────────────────────

export interface EnvelopeEdit {
  quantity: string;
  min: number;
  max: number;
}

export interface EnvelopeDecision {
  /** Who confirmed: the operator's identity as the registration records it. */
  confirmedBy: string;
  /** ISO-8601 time of the confirmation, supplied by the caller (this module reads no clock). */
  confirmedAt: string;
  /** Values the operator set or changed; each is operator-sourced. */
  edits?: EnvelopeEdit[];
  eStop?: EStopDeclaration;
  maxCommandsPerMinute?: number;
  supervision?: Supervision;
  hazards?: Hazard[];
}

/** The part of a confirmed envelope the digest commits. */
export interface SafetyEnvelopeBody {
  envelopeVersion: 1;
  deviceClass: string;
  device: DeviceIdentity;
  limits: EnvelopeLimit[];
  eStop: EStopDeclaration;
  maxCommandsPerMinute: number;
  supervision: Supervision;
  /** In canonical order; empty means the operator said none. */
  hazards: Hazard[];
}

export interface ConfirmedSafetyEnvelope {
  envelope: SafetyEnvelopeBody;
  confirmedBy: string;
  confirmedAt: string;
  envelopeDigest: SafetyEnvelopeDigest;
}

/** `"0x" + hex(sha256(canonicalize({ domain, envelope })))`. */
export function computeSafetyEnvelopeDigest(envelope: SafetyEnvelopeBody): SafetyEnvelopeDigest {
  return `0x${createHash("sha256").update(canonicalize({ domain: SAFETY_ENVELOPE_DOMAIN, envelope })).digest("hex")}`;
}

/**
 * The operator's one confirmation. Edits answer questions or change proposed
 * values. Afterwards:
 *   - every required quantity must have a limit;
 *   - the e-stop, command rate, supervision and hazards must be settled;
 *   - no question may remain.
 * Throws `EnvelopeRefused` otherwise.
 */
export function confirmSafetyEnvelope(draft: SafetyEnvelopeDraft, decision: EnvelopeDecision): ConfirmedSafetyEnvelope {
  const reasons: string[] = [];
  const template = DEVICE_CLASS_TEMPLATES[draft.deviceClass];
  if (!template) throw new EnvelopeRefused([`unknown deviceClass ${JSON.stringify(draft.deviceClass)}`]);
  if (!nonEmpty(decision.confirmedBy)) reasons.push("confirmedBy is required");
  if (!nonEmpty(decision.confirmedAt) || !Number.isFinite(Date.parse(decision.confirmedAt))) {
    reasons.push("confirmedAt must be an ISO-8601 time");
  }

  const limits = new Map(draft.limits.map((l) => [l.quantity, l]));
  const answered = new Set<string>();
  for (const edit of decision.edits ?? []) {
    const req = template.requires.find((r) => r.quantity === edit.quantity);
    if (!req) {
      reasons.push(`edit for ${JSON.stringify(edit.quantity)}: not a quantity this device class bounds`);
      continue;
    }
    const problem = rangeProblem(edit.min, edit.max);
    if (problem) {
      reasons.push(`edit for ${edit.quantity}: ${problem}`);
      continue;
    }
    const previous = limits.get(edit.quantity);
    limits.set(edit.quantity, {
      quantity: req.quantity,
      unit: req.unit,
      param: req.param,
      min: edit.min,
      max: edit.max,
      proposedBy: "operator",
      sources: [{ kind: "operator", field: "confirmation" }, ...(previous?.sources.filter((s) => s.kind === "reference") ?? [])],
    });
    answered.add(edit.quantity);
  }

  const eStop = decision.eStop ?? draft.eStop;
  if (decision.eStop) answered.add("e-stop");
  const rate = decision.maxCommandsPerMinute ?? draft.maxCommandsPerMinute;
  if (decision.maxCommandsPerMinute !== undefined) answered.add("command-rate");
  const supervision = decision.supervision ?? draft.supervision;
  if (decision.supervision !== undefined) answered.add("supervision");
  const hazards = decision.hazards ?? draft.hazards;
  if (decision.hazards !== undefined) answered.add("hazards");

  for (const q of draft.questions) {
    if (!answered.has(q.about)) reasons.push(`unanswered: ${q.ask}`);
  }
  for (const req of template.requires) {
    if (!limits.has(req.quantity)) reasons.push(`no confirmed limit for ${req.quantity}`);
  }
  const stopProblem = eStopProblem(eStop, template);
  if (stopProblem) reasons.push(stopProblem);
  const rateIssue = rateProblem(rate);
  if (rateIssue) reasons.push(rateIssue);
  const supervisionIssue = supervisionProblem(supervision);
  if (supervisionIssue) reasons.push(supervisionIssue);
  const hazardsIssue = hazardsProblem(hazards);
  if (hazardsIssue) reasons.push(hazardsIssue);
  if (reasons.length > 0 || !eStop || !hazards) throw new EnvelopeRefused(reasons);

  const envelope: SafetyEnvelopeBody = {
    envelopeVersion: 1,
    deviceClass: draft.deviceClass,
    device: { ...draft.device },
    limits: template.requires.map((r) => limits.get(r.quantity)!),
    // Only the declaration's own fields are committed.
    eStop: {
      mechanism: eStop.mechanism,
      ...(eStop.mechanism === "adapter-stop" ? { stopCommand: eStop.stopCommand } : {}),
    },
    maxCommandsPerMinute: rate as number,
    supervision: supervision as Supervision,
    hazards: canonicalHazards(hazards),
  };
  return {
    envelope,
    confirmedBy: decision.confirmedBy,
    confirmedAt: decision.confirmedAt,
    envelopeDigest: computeSafetyEnvelopeDigest(envelope),
  };
}

// ── Compile ─────────────────────────────────────────────────────────

export interface CompiledSafetyEnvelope {
  /** Typed job inputs, each bounded by its confirmed range (CSD `parameters`). */
  parameters: CsdParameter[];
  /** The #53 evidence tier: the job's signals stayed inside the confirmed limits. */
  evidence: Record<string, CsdEvidenceTier>;
  /** Composable typed I/O (CSD `composition`): bounded parameters and the device's output ports. */
  composition: { parameters: ParameterDefinition[]; outputPorts: Record<string, PortType> };
  /** The confirmed envelope this was compiled from. */
  envelopeDigest: SafetyEnvelopeDigest;
}

/**
 * Compile a CONFIRMED envelope. Refuses one whose digest no longer matches its
 * content (edited after confirmation) or whose units left the unit table.
 */
export function compileSafetyEnvelope(confirmed: ConfirmedSafetyEnvelope): CompiledSafetyEnvelope {
  const { envelope } = confirmed;
  if (computeSafetyEnvelopeDigest(envelope) !== confirmed.envelopeDigest) {
    throw new EnvelopeRefused(["the envelope changed after it was confirmed; it must be confirmed again"]);
  }
  const template = DEVICE_CLASS_TEMPLATES[envelope.deviceClass];
  if (!template) throw new EnvelopeRefused([`unknown deviceClass ${JSON.stringify(envelope.deviceClass)}`]);
  // A digest anyone can recompute, so the committed rules are checked again here.
  const bodyProblems = [
    eStopProblem(envelope.eStop, template),
    rateProblem(envelope.maxCommandsPerMinute),
    supervisionProblem(envelope.supervision),
    hazardsProblem(envelope.hazards),
    hazardsCanonicalProblem(envelope.hazards),
  ].filter((p): p is string => p !== null);
  if (bodyProblems.length > 0) throw new EnvelopeRefused(bodyProblems);

  const parameters: CsdParameter[] = [];
  const definitions: ParameterDefinition[] = [];
  for (const req of template.requires) {
    const limit = envelope.limits.find((l) => l.quantity === req.quantity);
    if (!limit || !UNITS.has(limit.unit) || rangeProblem(limit.min, limit.max)) {
      throw new EnvelopeRefused([`no valid confirmed limit for ${req.quantity}`]);
    }
    parameters.push({
      key: req.param,
      label: req.label,
      description: `${req.why}. Confirmed range ${limit.min}..${limit.max} ${limit.unit}.`,
      required: true,
      type: "number",
      min: limit.min,
      max: limit.max,
      step: req.step,
      unit: limit.unit,
    });
    definitions.push({
      name: req.param,
      semanticType: req.semanticType,
      required: true,
      unit: limit.unit,
      minimum: { value: limit.min, unit: limit.unit },
      maximum: { value: limit.max, unit: limit.unit },
    });
  }

  return {
    parameters,
    evidence: {
      "envelope-conformance": {
        description: `The job's signals stayed inside the operator-confirmed safety envelope ${confirmed.envelopeDigest}.`,
        required: ["telemetry within the confirmed limits"],
        primitives: [
          {
            id: "telemetry.envelope_conformance",
            params: { envelope: envelope.limits.map((l) => ({ metric: l.quantity, min: l.min, max: l.max })) },
          },
        ],
      },
    },
    composition: { parameters: definitions, outputPorts: { ...template.outputPorts } },
    envelopeDigest: confirmed.envelopeDigest,
  };
}

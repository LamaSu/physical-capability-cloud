/**
 * Safety envelope (ADK R8): the onboarding agent DRAFTS a device's safety
 * envelope and typed I/O from the operator's intake answers, cited
 * references and the adapter's declared commands. The operator CONFIRMS it
 * once (yes or edit), and only a confirmed envelope, matched against the
 * digest its registration record committed, COMPILES into the CSD's typed
 * I/O, its evidence tier and the runtime envelope.
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
 *   - a cited reference bound stays attached to its quantity: a confirmation
 *     edit that loosens it needs an explicit override with a reason;
 *   - a draft with open questions cannot be confirmed, and an unconfirmed
 *     envelope cannot be compiled.
 *
 * Authority. A digest anyone can recompute proves nothing by itself, so
 * compiling takes the digest the device's registration record committed when
 * the operator confirmed through an authenticated session, never the digest
 * carried by the object being compiled. The confirmation (who, when) is inside
 * the digested body, and confirm and both compilers run one shared set of
 * rules (`confirmedBodyProblems`), so a hand-built body can pass nothing that
 * confirm would refuse.
 *
 * Safety policy in v1 (fail closed until safeguards are modeled):
 *   - a device that moves or heats cannot run unattended;
 *   - remote supervision needs a stop the supervisor can trigger remotely, an
 *     adapter stop;
 *   - every template names a deadline quantity (a whole job's duration); the
 *     runtime stops a job that runs past its confirmed maximum.
 *
 * The command surface. The adapter declares every command it can send and,
 * for each parameter, the template quantity it sets (checked against that
 * limit at runtime) or why it sets none. The map is committed in the digest,
 * and every bounded quantity must be set by some declared parameter, so a
 * strict runtime can refuse any command or parameter outside it.
 *
 * "Safety envelope" is this term exactly. It is not `evidence-envelope` (a
 * data-integrity wrapper) or onboard-kit's `workEnvelope` (part dimensions).
 *
 * Every function is pure and deterministic: no I/O, no clock, no randomness.
 * Units come only from the composition unit table (`KNOWN_UNITS`), the one
 * the prism compiler parses.
 *
 * Inputs, by kits' permanent intake field ids (item 6, bus #4140):
 *   - `safety.limits` gives the operator's answers, one per template quantity (`intake.limits`);
 *   - `safety.estop` gives `intake.eStop`, `safety.supervision` gives
 *     `intake.supervision`, `safety.hazards` gives `intake.hazards`, and
 *     `safety.commandRate` gives `intake.maxCommandsPerMinute` (kits #474; a
 *     researched value reaches it only after the operator confirms it);
 *   - R5 research findings give `references`, in R5's `{claim, value, unit,
 *     citation, retrievedAt}` shape, each for the template quantity it was
 *     asked about;
 *   - the adapter gives `commandMap` and `device.adapterVersion` (class A).
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
const DIGEST_PATTERN = /^0x[0-9a-f]{64}$/;

const UNITS = new Set<string>(KNOWN_UNITS);
/** Units a job deadline can be stated in. */
const TIME_UNITS = new Set<string>(["s", "min", "h"]);

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
  /** For `adapter-stop`: the name of one of the adapter's declared commands. */
  stopCommand?: string;
}

export interface DeviceIdentity {
  deviceId: string;
  adapterType: string;
  /** The adapter version whose command map this envelope commits. */
  adapterVersion: string;
  vendor?: string;
  model?: string;
}

/** One parameter of an adapter command: the quantity it sets, or why it sets none. */
export interface CommandParamSpec {
  name: string;
  /** The template quantity this parameter sets, in `unit`; the runtime checks it against that limit. */
  quantity?: string;
  unit?: Unit;
  /** Why this parameter sets no physical quantity (a well name, a labware id); the runtime passes it unchecked. */
  unbounded?: string;
}

export interface CommandSpec {
  name: string;
  params: CommandParamSpec[];
}

/** Every command the adapter can send (class A: the adapter declares it). */
export interface CommandMapV1 {
  commands: CommandSpec[];
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
  /** The adapter's declared command surface; missing is a question, never a default. */
  commandMap?: CommandMapV1;
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
  /** A device that moves or heats cannot be confirmed without an e-stop, and cannot run unattended in v1. */
  movesOrHeats: boolean;
  /** Every one needs a confirmed [min, max]; typed job inputs are ranges. */
  requires: QuantityRequirement[];
  /** The quantity whose confirmed maximum is a whole job's deadline; its unit is a time unit. */
  deadline: string;
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
      {
        quantity: "job_duration",
        unit: "min",
        param: "jobDuration",
        label: "Job duration",
        step: 1,
        semanticType: "duration",
        why: "the longest job the operator allows; the runtime stops the device past it",
      },
    ],
    deadline: "job_duration",
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
        quantity: "dispense_volume",
        unit: "uL",
        param: "dispenseVolume",
        label: "Dispense volume per transfer",
        step: 1,
        semanticType: "volume",
        why: "the mounted pipette's volume range, on the way out",
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
        why: "the longest run the operator allows; the runtime stops the robot past it",
      },
    ],
    deadline: "run_duration",
    outputPorts: {
      plate: { semanticType: "processed-plate", required: true },
    },
  },
};

// ── The draft ───────────────────────────────────────────────────────

export type LimitSource =
  | { kind: "operator"; field: string }
  | { kind: "reference"; citation: Citation; retrievedAt: string; claim: string }
  | { kind: "override"; reason: string; overrides: Citation[] };

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
  /** The quantity it is about, or "e-stop", "command-rate", "supervision", "hazards" or "command-map". */
  about: string;
  ask: string;
  why: string;
}

/** An input the draft did not use, and why. Shown to the operator, never silently lost. */
export interface DroppedInput {
  quantity: string;
  reason: string;
}

/** What the usable cited references say about one quantity; either side may be open. */
export interface ReferenceBound {
  quantity: string;
  unit: Unit;
  min?: number;
  max?: number;
  sources: LimitSource[];
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
  commandMap: CommandMapV1 | null;
  /** Kept for confirmation: an edit may not loosen a cited bound without an explicit override. */
  referenceBounds: ReferenceBound[];
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why a bound pair is unusable as a range, or null. */
function rangeProblem(min: unknown, max: unknown): string | null {
  if (!finite(min) || !finite(max)) return "needs both a finite min and a finite max";
  if (min > max) return `min ${min} is above max ${max}`;
  return null;
}

const ESTOP_MECHANISMS: readonly string[] = ["hardware", "adapter-stop", "none"];

function declaredCommands(commandMap: unknown): Set<string> {
  if (!isRecord(commandMap) || !Array.isArray(commandMap.commands)) return new Set();
  return new Set(commandMap.commands.filter(isRecord).map((c) => c.name).filter(nonEmpty));
}

/** Why an e-stop cannot stand in a confirmed envelope for this class, or null. */
function eStopProblem(
  eStop: EStopDeclaration | null | undefined,
  template: DeviceClassTemplate,
  commandMap: unknown,
): string | null {
  if (!eStop) return "no e-stop declared";
  if (!ESTOP_MECHANISMS.includes(eStop.mechanism)) {
    return `e-stop mechanism ${JSON.stringify(String(eStop.mechanism))} is not hardware, adapter-stop or none`;
  }
  if (eStop.mechanism === "none" && template.movesOrHeats) return "a device that moves or heats needs an e-stop";
  if (eStop.mechanism === "adapter-stop") {
    if (!nonEmpty(eStop.stopCommand)) return "an adapter stop needs its command";
    if (!declaredCommands(commandMap).has(eStop.stopCommand)) {
      return `the stop command ${JSON.stringify(eStop.stopCommand)} is not one of the adapter's declared commands`;
    }
  }
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

/** v1's supervision policy (fail closed until safeguards are modeled), or null. */
function supervisionPolicyProblem(
  supervision: unknown,
  eStop: EStopDeclaration | null | undefined,
  template: DeviceClassTemplate,
): string | null {
  if (supervision === "unattended" && template.movesOrHeats) {
    return "v1 does not allow unattended operation of a device that moves or heats: that needs independent safeguards (an over-temperature cutoff, a watchdog that stops it) v1 does not model yet";
  }
  if (supervision === "remote-supervised" && eStop?.mechanism !== "adapter-stop") {
    return "remote supervision needs a stop the supervisor can trigger remotely: an adapter stop";
  }
  return null;
}

/** Why a command map is malformed for this class, or null. Coverage gaps are `commandMapGaps`. */
function commandMapProblem(commandMap: unknown, template: DeviceClassTemplate): string | null {
  if (!isRecord(commandMap) || !Array.isArray(commandMap.commands) || commandMap.commands.length === 0) {
    return "the command map must list at least one command";
  }
  const units = new Map(template.requires.map((r) => [r.quantity, r.unit]));
  const commandNames = new Set<string>();
  for (const [i, command] of commandMap.commands.entries()) {
    if (!isRecord(command) || !nonEmpty(command.name)) return `command ${i} needs a name`;
    if (commandNames.has(command.name)) return `command ${JSON.stringify(command.name)} is declared twice`;
    commandNames.add(command.name);
    if (!Array.isArray(command.params)) return `command ${JSON.stringify(command.name)} needs a params list`;
    const paramNames = new Set<string>();
    for (const param of command.params) {
      if (!isRecord(param) || !nonEmpty(param.name)) return `command ${JSON.stringify(command.name)} has a parameter without a name`;
      const at = `${command.name}.${param.name}`;
      if (paramNames.has(param.name)) return `parameter ${at} is declared twice`;
      paramNames.add(param.name);
      const mapped = param.quantity !== undefined || param.unit !== undefined;
      if (mapped === (param.unbounded !== undefined)) {
        return `parameter ${at} must either set a quantity (quantity and unit) or say why it sets none (unbounded)`;
      }
      if (mapped) {
        if (!units.has(param.quantity as string)) return `parameter ${at} sets ${JSON.stringify(param.quantity)}, which this class does not bound`;
        if (param.unit !== units.get(param.quantity as string)) {
          return `parameter ${at} sets ${String(param.quantity)} in ${JSON.stringify(param.unit)}, not ${units.get(param.quantity as string)}`;
        }
      } else if (!nonEmpty(param.unbounded)) {
        return `parameter ${at} is unbounded without a reason`;
      }
    }
  }
  return null;
}

/** Bounded quantities no declared parameter sets: their limits could not be enforced. */
function commandMapGaps(commandMap: CommandMapV1, template: DeviceClassTemplate): string[] {
  const set = new Set(commandMap.commands.flatMap((c) => c.params.map((p) => p.quantity).filter(nonEmpty)));
  return template.requires.map((r) => r.quantity).filter((q) => !set.has(q));
}

function checkInput(input: SafetyEnvelopeInput): { template: DeviceClassTemplate } {
  const reasons: string[] = [];
  const template = Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, input?.deviceClass)
    ? DEVICE_CLASS_TEMPLATES[input.deviceClass]
    : undefined;
  if (!template) reasons.push(`unknown deviceClass ${JSON.stringify(String(input?.deviceClass))}`);
  if (!nonEmpty(input?.device?.deviceId)) reasons.push("device.deviceId is required");
  if (!nonEmpty(input?.device?.adapterType)) reasons.push("device.adapterType is required");
  if (!nonEmpty(input?.device?.adapterVersion)) reasons.push("device.adapterVersion is required");
  if (!Array.isArray(input?.intake?.limits)) reasons.push("intake.limits must be an array");
  if (!Array.isArray(input?.references)) reasons.push("references must be an array");
  if (template && input?.commandMap !== undefined) {
    const problem = commandMapProblem(input.commandMap, template);
    if (problem) reasons.push(`commandMap: ${problem}`);
  }
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
  const referenceBounds: ReferenceBound[] = [];

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
    // The tightest bound the references allow together: the max of the given mins, the min of the given maxes.
    const mins = references.flatMap((r) => (r.value.min === undefined ? [] : [r.value.min]));
    const maxes = references.flatMap((r) => (r.value.max === undefined ? [] : [r.value.max]));
    const min = mins.length > 0 ? Math.max(...mins) : undefined;
    const max = maxes.length > 0 ? Math.min(...maxes) : undefined;
    if (references.length > 0) {
      referenceBounds.push({
        quantity: req.quantity,
        unit: req.unit,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        sources: referenceSources,
      });
    }

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
      // A one-sided bound constrains only its side, and a side nobody bounded is a question.
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

  const commandMap = input.commandMap ?? null;
  if (commandMap === null) {
    questions.push({
      about: "command-map",
      ask: "The adapter must declare its commands, and which parameters set which quantities.",
      why: "the runtime refuses anything outside the declared command surface; it cannot be guessed",
    });
  } else {
    const gaps = commandMapGaps(commandMap, template);
    if (gaps.length > 0) {
      questions.push({
        about: "command-map",
        ask: `No declared command parameter sets ${gaps.join(", ")}. Which parameters do?`,
        why: "a limit no parameter maps to is never enforced",
      });
    }
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
  } else if (eStop.mechanism === "adapter-stop" && commandMap !== null && !declaredCommands(commandMap).has(eStop.stopCommand as string)) {
    questions.push({
      about: "e-stop",
      ask: `The stop command ${JSON.stringify(eStop.stopCommand)} is not one of the adapter's declared commands. Which declared command stops the device?`,
      why: "a stop the runtime cannot send is no stop",
    });
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
  } else if (supervision === "unattended" && template.movesOrHeats) {
    questions.push({
      about: "supervision",
      ask: "This device moves or heats, and v1 does not allow it to run unattended. Attended, or remote-supervised?",
      why: supervisionPolicyProblem(supervision, eStop, template) as string,
    });
  } else if (supervision === "remote-supervised" && eStop !== null && eStop.mechanism !== "adapter-stop") {
    questions.push({
      about: "e-stop",
      ask: "Remote supervision needs a stop the supervisor can trigger remotely. Which adapter command stops the device?",
      why: supervisionPolicyProblem(supervision, eStop, template) as string,
    });
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
    commandMap,
    referenceBounds,
    questions,
    dropped,
  };
}

// ── Confirm once ────────────────────────────────────────────────────

export interface EnvelopeEdit {
  quantity: string;
  min: number;
  max: number;
  /** Required when the edit loosens a cited reference bound: the operator's explicit reason. */
  override?: { reason: string };
}

export interface EnvelopeDecision {
  /** Who confirmed: the operator's identity as the registration records it. */
  confirmedBy: string;
  /** ISO-8601 time of the confirmation, supplied by the caller (this module reads no clock). */
  confirmedAt: string;
  /** Values the operator set or changed; each is operator-sourced. One per quantity. */
  edits?: EnvelopeEdit[];
  eStop?: EStopDeclaration;
  maxCommandsPerMinute?: number;
  supervision?: Supervision;
  hazards?: Hazard[];
}

/** The part of a confirmed envelope the digest commits, including who confirmed it and when. */
export interface SafetyEnvelopeBody {
  envelopeVersion: 1;
  deviceClass: string;
  device: DeviceIdentity;
  /** In template order, one per required quantity. */
  limits: EnvelopeLimit[];
  eStop: EStopDeclaration;
  maxCommandsPerMinute: number;
  supervision: Supervision;
  /** In canonical order; empty means the operator said none. */
  hazards: Hazard[];
  commandMap: CommandMapV1;
  confirmation: { confirmedBy: string; confirmedAt: string };
}

export interface ConfirmedSafetyEnvelope {
  envelope: SafetyEnvelopeBody;
  envelopeDigest: SafetyEnvelopeDigest;
}

/** `"0x" + hex(sha256(canonicalize({ domain, envelope })))`. */
export function computeSafetyEnvelopeDigest(envelope: SafetyEnvelopeBody): SafetyEnvelopeDigest {
  return `0x${createHash("sha256").update(canonicalize({ domain: SAFETY_ENVELOPE_DOMAIN, envelope })).digest("hex")}`;
}

/**
 * Every rule a confirmed body must meet, whoever built it. Confirm runs it on
 * the body it produces, and both compilers run it on the body they are given,
 * so a hand-built body that matches its registered digest still passes only
 * what confirm would.
 */
export function confirmedBodyProblems(envelope: SafetyEnvelopeBody): string[] {
  const problems: string[] = [];
  if (!isRecord(envelope)) return ["the envelope is not an object"];
  const template = Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, envelope.deviceClass)
    ? DEVICE_CLASS_TEMPLATES[envelope.deviceClass]
    : undefined;
  if (!template) return [`unknown deviceClass ${JSON.stringify(String(envelope.deviceClass))}`];
  if (envelope.envelopeVersion !== 1) problems.push("envelopeVersion must be 1");
  const device = (isRecord(envelope.device) ? envelope.device : {}) as Record<string, unknown>;
  for (const key of ["deviceId", "adapterType", "adapterVersion"] as const) {
    if (!nonEmpty(device[key])) problems.push(`device.${key} is required`);
  }
  const confirmation = (isRecord(envelope.confirmation) ? envelope.confirmation : {}) as Record<string, unknown>;
  if (!nonEmpty(confirmation.confirmedBy)) problems.push("confirmedBy is required");
  if (!nonEmpty(confirmation.confirmedAt) || !Number.isFinite(Date.parse(confirmation.confirmedAt as string))) {
    problems.push("confirmedAt must be an ISO-8601 time");
  }
  if (!Array.isArray(envelope.limits) || envelope.limits.length !== template.requires.length) {
    problems.push(`limits must hold exactly one limit per required quantity, in template order (${template.requires.map((r) => r.quantity).join(", ")})`);
  } else {
    template.requires.forEach((req, i) => {
      const limit: unknown = envelope.limits[i];
      if (!isRecord(limit) || limit.quantity !== req.quantity) {
        problems.push(`limit ${i} must be ${req.quantity}`);
        return;
      }
      if (limit.unit !== req.unit || !UNITS.has(limit.unit as string)) problems.push(`${req.quantity} must be in ${req.unit} (got ${JSON.stringify(limit.unit)})`);
      if (limit.param !== req.param) problems.push(`${req.quantity} must bound the parameter ${req.param}`);
      const range = rangeProblem(limit.min, limit.max);
      if (range) problems.push(`${req.quantity}: ${range}`);
      if (limit.proposedBy !== "operator" && limit.proposedBy !== "reference") problems.push(`${req.quantity}: proposedBy must be operator or reference`);
    });
  }
  const stop = eStopProblem(envelope.eStop, template, envelope.commandMap);
  if (stop) problems.push(stop);
  const rate = rateProblem(envelope.maxCommandsPerMinute);
  if (rate) problems.push(rate);
  for (const p of [supervisionProblem(envelope.supervision), hazardsProblem(envelope.hazards), hazardsCanonicalProblem(envelope.hazards)]) {
    if (p) problems.push(p);
  }
  const policy = supervisionPolicyProblem(envelope.supervision, envelope.eStop, template);
  if (policy) problems.push(policy);
  const map = commandMapProblem(envelope.commandMap, template);
  if (map) problems.push(`commandMap: ${map}`);
  else {
    const gaps = commandMapGaps(envelope.commandMap, template);
    if (gaps.length > 0) problems.push(`commandMap: no declared parameter sets ${gaps.join(", ")}`);
  }
  return problems;
}

/**
 * The operator's one confirmation. Edits answer questions or change proposed
 * values. Afterwards:
 *   - every required quantity must have a limit;
 *   - the e-stop, command rate, supervision and hazards must be settled;
 *   - the adapter's command map must cover every bounded quantity;
 *   - no question may remain.
 * An edit that loosens a cited reference bound needs `override.reason`.
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

  const bounds = new Map((draft.referenceBounds ?? []).map((b) => [b.quantity, b]));
  const limits = new Map(draft.limits.map((l) => [l.quantity, l]));
  const answered = new Set<string>();
  const edited = new Set<string>();
  for (const edit of decision.edits ?? []) {
    const req = template.requires.find((r) => r.quantity === edit.quantity);
    if (!req) {
      reasons.push(`edit for ${JSON.stringify(edit.quantity)}: not a quantity this device class bounds`);
      continue;
    }
    if (edited.has(edit.quantity)) {
      reasons.push(`edit for ${edit.quantity}: given twice; one confirmation states one range`);
      continue;
    }
    edited.add(edit.quantity);
    const problem = rangeProblem(edit.min, edit.max);
    if (problem) {
      reasons.push(`edit for ${edit.quantity}: ${problem}`);
      continue;
    }
    const bound = bounds.get(edit.quantity);
    const loosens =
      bound !== undefined &&
      ((bound.min !== undefined && edit.min < bound.min) || (bound.max !== undefined && edit.max > bound.max));
    if (loosens && !nonEmpty(edit.override?.reason)) {
      reasons.push(
        `edit for ${edit.quantity}: ${edit.min}..${edit.max} ${req.unit} loosens the cited bound ${describeBound(bound, req.unit)}; an override needs a reason`,
      );
      continue;
    }
    const citations = (bound?.sources ?? []).flatMap((s) => (s.kind === "reference" ? [s.citation] : []));
    limits.set(edit.quantity, {
      quantity: req.quantity,
      unit: req.unit,
      param: req.param,
      min: edit.min,
      max: edit.max,
      proposedBy: "operator",
      sources: [
        { kind: "operator", field: "confirmation" },
        ...(bound?.sources ?? []),
        ...(loosens ? [{ kind: "override" as const, reason: (edit.override as { reason: string }).reason, overrides: citations }] : []),
      ],
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
  if (draft.commandMap === null) reasons.push("the adapter has not declared its commands; draft again with its command map");
  for (const p of [eStopProblem(eStop, template, draft.commandMap), rateProblem(rate), supervisionProblem(supervision), hazardsProblem(hazards)]) {
    if (p) reasons.push(p);
  }
  if (reasons.length > 0 || !eStop || !hazards || !draft.commandMap) throw new EnvelopeRefused(reasons);

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
    commandMap: draft.commandMap,
    confirmation: { confirmedBy: decision.confirmedBy, confirmedAt: decision.confirmedAt },
  };
  const problems = confirmedBodyProblems(envelope);
  if (problems.length > 0) throw new EnvelopeRefused(problems);
  return { envelope, envelopeDigest: computeSafetyEnvelopeDigest(envelope) };
}

/**
 * The shared gate of both compilers: the body is the one the registration
 * record committed, and it meets every rule confirm enforces. `committedDigest`
 * must come from the device's registration record, never from the object being
 * compiled: a digest anyone can recompute is not a confirmation.
 */
export function checkCommittedEnvelope(confirmed: ConfirmedSafetyEnvelope, committedDigest: string): SafetyEnvelopeBody {
  if (typeof committedDigest !== "string" || !DIGEST_PATTERN.test(committedDigest)) {
    throw new EnvelopeRefused(["the committed digest must be 0x + 64 lowercase hex, read from the registration record"]);
  }
  const envelope = confirmed?.envelope;
  if (computeSafetyEnvelopeDigest(envelope) !== confirmed.envelopeDigest) {
    throw new EnvelopeRefused(["the envelope changed after it was confirmed; it must be confirmed again"]);
  }
  if (confirmed.envelopeDigest !== committedDigest) {
    throw new EnvelopeRefused(["this is not the envelope the registration record committed"]);
  }
  const problems = confirmedBodyProblems(envelope);
  if (problems.length > 0) throw new EnvelopeRefused(problems);
  return envelope;
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
 * Compile the envelope the registration record committed (see
 * `checkCommittedEnvelope`) into the CSD's typed I/O and its evidence tier.
 */
export function compileSafetyEnvelope(confirmed: ConfirmedSafetyEnvelope, committedDigest: string): CompiledSafetyEnvelope {
  const envelope = checkCommittedEnvelope(confirmed, committedDigest);
  const template = DEVICE_CLASS_TEMPLATES[envelope.deviceClass]!;

  const parameters: CsdParameter[] = [];
  const definitions: ParameterDefinition[] = [];
  template.requires.forEach((req, i) => {
    const limit = envelope.limits[i]!;
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
  });

  return {
    parameters,
    evidence: {
      "envelope-conformance": {
        description: `The job's signals stayed inside the operator-confirmed safety envelope ${committedDigest}.`,
        required: ["telemetry within the confirmed limits"],
        primitives: [
          {
            id: "telemetry.envelope_conformance",
            params: { envelope: envelope.limits.map((l) => ({ metric: l.quantity, unit: l.unit, min: l.min, max: l.max })) },
          },
        ],
      },
    },
    composition: { parameters: definitions, outputPorts: { ...template.outputPorts } },
    envelopeDigest: committedDigest as SafetyEnvelopeDigest,
  };
}

/** The time units a deadline quantity may use (for the runtime schema). */
export function isTimeUnit(unit: unknown): boolean {
  return typeof unit === "string" && TIME_UNITS.has(unit);
}

/** The v1 supervision policy, exported for the runtime schema. */
export function supervisionPolicy(
  supervision: unknown,
  eStop: EStopDeclaration | null | undefined,
  deviceClass: string,
): string | null {
  const template = Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, deviceClass) ? DEVICE_CLASS_TEMPLATES[deviceClass] : undefined;
  return template ? supervisionPolicyProblem(supervision, eStop, template) : null;
}

/** Why a command map is malformed or leaves a bounded quantity unset, for a known class; null when it is complete. */
export function commandMapIssue(commandMap: unknown, deviceClass: string): string | null {
  const template = Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, deviceClass) ? DEVICE_CLASS_TEMPLATES[deviceClass] : undefined;
  if (!template) return `unknown deviceClass ${JSON.stringify(String(deviceClass))}`;
  const problem = commandMapProblem(commandMap, template);
  if (problem) return problem;
  const gaps = commandMapGaps(commandMap as CommandMapV1, template);
  return gaps.length > 0 ? `no declared parameter sets ${gaps.join(", ")}` : null;
}

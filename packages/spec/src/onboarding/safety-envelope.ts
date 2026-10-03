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
 * compiling takes the device's REGISTRATION: the registry's signed statement
 * that this device's confirmed envelope has this digest, made after the
 * operator confirmed through an authenticated session. Its signature is
 * checked by the integration's verifier, wired to the registry's pinned key
 * (trusted code, like every verification callback). A body built and digested
 * by the caller has no registry signature, so it compiles nothing. The
 * confirmation (who, when) is inside the digested body, and confirm and both
 * compilers run one shared set of rules (`confirmedBodyProblems`), so even a
 * registered body passes nothing that confirm would refuse.
 *
 * One observation. Compiling never re-reads the object it was given. The
 * envelope is copied once as plain JSON data, through property descriptors
 * (no getter, proxy trap or other code supplied with it runs), serialized
 * once, and hashed. Checks and compilation run on the copy parsed back from
 * those same bytes, so what is compiled is exactly what the digest covers
 * (astra pack 153).
 *
 * Provenance. Confirm re-drafts from the input; it never trusts a draft
 * object. Each limit carries its sources, and a cited reference source carries
 * the bound it cites. A limit looser than its cited bound must carry an
 * override with the operator's reason, and a limit a reference proposed must
 * be exactly that bound. Both compilers check this, so it holds for every
 * body, however it was built.
 *
 * Safety policy in v1 (fail closed until safeguards are modeled):
 *   - a device that moves or heats cannot run unattended;
 *   - remote supervision needs a stop the supervisor can trigger remotely, an
 *     adapter stop;
 *   - every template names a deadline quantity (a whole job's duration); the
 *     runtime stops a job that runs past its confirmed maximum.
 *
 * The command surface. The adapter declares every command it can send and,
 * for each parameter, either the template quantity it sets (checked against
 * that limit at runtime) or why it sets none, together with the finite set of
 * values it may carry. There is no free-form parameter, so no opaque payload
 * can carry a physical control. The map and the adapter's manifest digest
 * (`device.adapterVersion`, `sha256:` of the reviewed adapter release) are
 * committed in the digest. Every bounded quantity must be set by some declared
 * parameter, so a strict runtime can refuse any command, parameter or value
 * outside the map, and any adapter whose manifest digest differs.
 *
 * "Safety envelope" is this term exactly. It is not `evidence-envelope` (a
 * data-integrity wrapper) or onboard-kit's `workEnvelope` (part dimensions).
 *
 * Every function is pure and deterministic: no I/O, no clock, no randomness.
 * The only code it calls that the caller supplies is the registration
 * verifier. Units come only from the composition unit table (`KNOWN_UNITS`),
 * the one the prism compiler parses.
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
import { parseEd25519SignatureHex, signingPreimage } from "../evidence/signing-preimage.js";
import type { SHA256 } from "../types/common.js";
import { canonicalize } from "../util/canonical.js";

/** Domain separator: an envelope digest can never collide with another digest. */
export const SAFETY_ENVELOPE_DOMAIN = "PCC:safety-envelope:v1";

/** Domain separator of the registry's signed registration statement. */
export const SAFETY_ENVELOPE_REGISTRATION_DOMAIN = "PCC:safety-envelope-registration:v1";

/** A confirmed envelope's digest: `0x` + 64 lowercase hex (SHA-256), the commitment family. */
export type SafetyEnvelopeDigest = `0x${string}`;
const DIGEST_PATTERN = /^0x[0-9a-f]{64}$/;

/** An adapter's manifest digest: `sha256:` + 64 lowercase hex of its reviewed release manifest. */
export const ADAPTER_MANIFEST_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

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
  /**
   * The adapter release this envelope commits: `sha256:` + 64 lowercase hex
   * of its reviewed release manifest (its code and this command map). The
   * runtime refuses an adapter whose manifest digest differs.
   */
  adapterVersion: string;
  vendor?: string;
  model?: string;
}

/** Why a parameter sets no physical quantity, and the only values it may carry. */
export interface UnboundedParam {
  /** Why it sets no physical quantity (a well name, a labware id). */
  reason: string;
  /** The single values the runtime lets through, each a non-blank string or a finite number. */
  allowed?: (string | number)[];
  /**
   * For a list-valued parameter (a plate's wells): the items a list may hold.
   * The runtime lets through a non-empty list of distinct items, each in
   * `allowedItems`. At least one of `allowed` and `allowedItems` is given.
   */
  allowedItems?: (string | number)[];
}

/** One parameter of an adapter command: the quantity it sets, or why it sets none and what it may carry. */
export interface CommandParamSpec {
  name: string;
  /** The template quantity this parameter sets, in `unit`; the runtime checks it against that limit. */
  quantity?: string;
  unit?: Unit;
  /** A parameter that sets no physical quantity; the runtime passes only the values in `allowed`. */
  unbounded?: UnboundedParam;
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

/**
 * Where a limit came from. A reference source carries the bound it cites, in
 * the limit's unit, so the limit can be checked against it wherever the body
 * is compiled; an override names the citations it overrides.
 */
export type LimitSource =
  | { kind: "operator"; field: string }
  | { kind: "reference"; citation: Citation; retrievedAt: string; claim: string; value: { min?: number; max?: number }; unit: Unit }
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

/** The keys of `v` that are not in `allowed`, for closed shapes. */
function extraKeys(v: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(v).filter((k) => !allowed.includes(k));
}

// ── One observation: plain data, read once ──────────────────────────

class NotPlainData extends Error {}

const MAX_DEPTH = 64;

/**
 * A proxy check that runs no trap: Node's `util.types.isProxy`, loaded at
 * module load without a static `node:util` import, so browser bundles of
 * @pcc/spec still build (the dashboard has no `node:util`). Where there is
 * none (a browser, or Node before 20.16) it is null, and every object is
 * refused: a proxy cannot be told apart from plain data there without
 * running its traps.
 */
const isProxy: ((value: object) => boolean) | null = (() => {
  const runtime = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const util = runtime?.getBuiltinModule?.("node:util") as { types?: { isProxy?: (value: unknown) => boolean } } | undefined;
  const check = util?.types?.isProxy;
  return typeof check === "function" ? (value: object) => check(value) : null;
})();

/**
 * A one-pass copy of JSON data that runs no code supplied with it. Everything
 * is read through property descriptors, so a getter is found and refused
 * without being called. Refused: a proxy; an accessor; an array whose
 * prototype is not Array.prototype, or with a hole; an object whose prototype
 * is not Object.prototype or null; a function, symbol, bigint or non-finite
 * number; undefined inside an array; a cycle; a key named `__proto__`; and
 * nesting deeper than 64. An undefined member is dropped, and -0 becomes 0,
 * both as `canonicalize` writes them. Copied objects have a null prototype,
 * and copied array elements are installed with `Object.defineProperty`, so
 * building the copy runs no inherited setter either.
 */
function plainCopy(value: unknown, path: string, ancestors: Set<object>, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NotPlainData(`${path}: ${String(value)} is not a finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new NotPlainData(`${path}: a ${typeof value} is not JSON data`);
  if (isProxy === null) throw new NotPlainData(`${path}: this runtime has no trap-free proxy check, so no object is copied as plain data`);
  if (isProxy(value)) throw new NotPlainData(`${path}: a proxy`);
  if (depth > MAX_DEPTH) throw new NotPlainData(`${path}: nested deeper than ${MAX_DEPTH}`);
  if (ancestors.has(value)) throw new NotPlainData(`${path}: a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new NotPlainData(`${path}: an array with a nonstandard prototype`);
      const out: unknown[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const element = Object.getOwnPropertyDescriptor(value, i);
        if (element === undefined) throw new NotPlainData(`${path}[${i}]: a hole in an array`);
        if (!("value" in element)) throw new NotPlainData(`${path}[${i}]: an accessor (a getter or setter)`);
        if (element.value === undefined) throw new NotPlainData(`${path}[${i}]: undefined in an array`);
        // Installed as the copy's own data property: an assignment or push would run a setter
        // Array.prototype serves for this index (astra pack 158).
        Object.defineProperty(out, i, { value: plainCopy(element.value, `${path}[${i}]`, ancestors, depth + 1), writable: true, enumerable: true, configurable: true });
      }
      return out;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new NotPlainData(`${path}: not a plain object`);
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (key === "__proto__") throw new NotPlainData(`${path}: a key named __proto__`);
      const member = Object.getOwnPropertyDescriptor(value, key);
      if (member === undefined) continue;
      if (!("value" in member)) throw new NotPlainData(`${path}.${key}: an accessor (a getter or setter)`);
      if (member.value === undefined) continue;
      out[key] = plainCopy(member.value, `${path}.${key}`, ancestors, depth + 1);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** `value` as plain JSON data, copied once; `EnvelopeRefused` when it is anything else. */
function plainSnapshot<T>(value: unknown, what: string): T {
  try {
    return plainCopy(value, what, new Set(), 0) as T;
  } catch (err) {
    if (err instanceof NotPlainData) {
      throw new EnvelopeRefused([`${err.message}: ${what} must be plain JSON data, and no code supplied with it may run`]);
    }
    throw err;
  }
}

function nullPrototype(_key: string, value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.assign(Object.create(null) as Record<string, unknown>, value)
    : value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** An envelope as it was hashed: the one copy that is checked and compiled, and its digest. */
interface EnvelopeSnapshot {
  body: SafetyEnvelopeBody;
  digest: SafetyEnvelopeDigest;
}

/**
 * Copy the envelope once as plain data, serialize the copy once, hash those
 * bytes, and parse the same bytes back into the frozen body that is checked
 * and compiled. Nothing afterwards reads the caller's object, so a value
 * cannot change between hashing, checking and use (astra pack 153).
 */
function snapshotEnvelope(envelope: unknown): EnvelopeSnapshot {
  const bytes = canonicalize(plainSnapshot(envelope, "envelope"));
  // Exactly canonicalize({ domain, envelope }): "domain" sorts before "envelope".
  const preimage = `{"domain":${JSON.stringify(SAFETY_ENVELOPE_DOMAIN)},"envelope":${bytes}}`;
  const digest = `0x${createHash("sha256").update(preimage).digest("hex")}` as SafetyEnvelopeDigest;
  const body = deepFreeze(JSON.parse(bytes, nullPrototype)) as SafetyEnvelopeBody;
  return { body, digest };
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

/** A citation with exactly its own fields. */
function citationOf(c: Citation): Citation {
  return { doc: c.doc, section: c.section, ...(c.url !== undefined ? { url: c.url } : {}) };
}

/** A cited range with exactly the sides it gives. */
function sidesOf(v: { min?: number; max?: number }): { min?: number; max?: number } {
  return { ...(v.min !== undefined ? { min: v.min } : {}), ...(v.max !== undefined ? { max: v.max } : {}) };
}

/** The tightest bound cited references allow together: the largest given min and the smallest given max. */
function tightestBound(values: readonly { min?: number; max?: number }[]): { min?: number; max?: number } {
  const mins = values.flatMap((v) => (v.min === undefined ? [] : [v.min]));
  const maxes = values.flatMap((v) => (v.max === undefined ? [] : [v.max]));
  return {
    ...(mins.length > 0 ? { min: Math.max(...mins) } : {}),
    ...(maxes.length > 0 ? { max: Math.min(...maxes) } : {}),
  };
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

/** Why `values` is not a non-empty list of distinct non-blank strings or finite numbers, or null. */
function finiteSetProblem(values: unknown, at: string, name: string): string | null {
  if (!Array.isArray(values) || values.length === 0) {
    return `parameter ${at}: ${name} must list the values it may carry; a free-form parameter could carry anything`;
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!nonEmpty(value) && !finite(value)) return `parameter ${at}: every ${name} value must be a non-blank string or a finite number`;
    const key = JSON.stringify(value);
    if (seen.has(key)) return `parameter ${at}: the ${name} value ${key} is listed twice`;
    seen.add(key);
  }
  return null;
}

/**
 * Why an unbounded parameter's declaration is not a reason plus finite sets
 * of what it may carry, or null: single values (`allowed`), list items
 * (`allowedItems`), or both. A free-form parameter could carry anything (an
 * opaque payload hiding a physical control), so v1 has none (astra pack 153).
 */
function unboundedProblem(unbounded: unknown, at: string): string | null {
  if (!isRecord(unbounded) || extraKeys(unbounded, ["reason", "allowed", "allowedItems"]).length > 0) {
    return `parameter ${at} is unbounded, so it must be exactly {reason, allowed?, allowedItems?}`;
  }
  if (!nonEmpty(unbounded.reason)) return `parameter ${at} is unbounded without a reason`;
  if (unbounded.allowed === undefined && unbounded.allowedItems === undefined) {
    return `parameter ${at} is unbounded, so it must list the values it may carry (allowed, or allowedItems for a list); a free-form parameter could carry anything`;
  }
  for (const name of ["allowed", "allowedItems"] as const) {
    if (unbounded[name] === undefined) continue;
    const problem = finiteSetProblem(unbounded[name], at, name);
    if (problem) return problem;
  }
  return null;
}

/** Why a command map is malformed for this class, or null. Coverage gaps are `commandMapGaps`. */
function commandMapProblem(commandMap: unknown, template: DeviceClassTemplate): string | null {
  if (!isRecord(commandMap) || !Array.isArray(commandMap.commands) || commandMap.commands.length === 0) {
    return "the command map must list at least one command";
  }
  if (extraKeys(commandMap, ["commands"]).length > 0) return "the command map holds only commands";
  const units = new Map(template.requires.map((r) => [r.quantity, r.unit]));
  const commandNames = new Set<string>();
  for (const [i, command] of commandMap.commands.entries()) {
    if (!isRecord(command) || !nonEmpty(command.name)) return `command ${i} needs a name`;
    if (extraKeys(command, ["name", "params"]).length > 0) return `command ${JSON.stringify(command.name)} has keys other than name and params`;
    if (commandNames.has(command.name)) return `command ${JSON.stringify(command.name)} is declared twice`;
    commandNames.add(command.name);
    if (!Array.isArray(command.params)) return `command ${JSON.stringify(command.name)} needs a params list`;
    const paramNames = new Set<string>();
    for (const param of command.params) {
      if (!isRecord(param) || !nonEmpty(param.name)) return `command ${JSON.stringify(command.name)} has a parameter without a name`;
      const at = `${command.name}.${param.name}`;
      if (extraKeys(param, ["name", "quantity", "unit", "unbounded"]).length > 0) return `parameter ${at} has keys other than name, quantity, unit and unbounded`;
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
      } else {
        const problem = unboundedProblem(param.unbounded, at);
        if (problem) return problem;
      }
    }
  }
  return null;
}

/**
 * Bounded quantities no declared parameter sets: their limits could not be
 * enforced. The template's deadline is exempt. The runtime enforces it as the
 * job's elapsed time whether or not a parameter also sets it, so requiring a
 * parameter for it would only invite a dummy one (astra pack 153, HIGH 8).
 */
function commandMapGaps(commandMap: CommandMapV1, template: DeviceClassTemplate): string[] {
  const set = new Set(commandMap.commands.flatMap((c) => c.params.map((p) => p.quantity).filter(nonEmpty)));
  return template.requires.map((r) => r.quantity).filter((q) => q !== template.deadline && !set.has(q));
}

function checkInput(input: SafetyEnvelopeInput): { template: DeviceClassTemplate } {
  const reasons: string[] = [];
  const template = Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, input?.deviceClass)
    ? DEVICE_CLASS_TEMPLATES[input.deviceClass]
    : undefined;
  if (!template) reasons.push(`unknown deviceClass ${JSON.stringify(String(input?.deviceClass))}`);
  if (!nonEmpty(input?.device?.deviceId)) reasons.push("device.deviceId is required");
  if (!nonEmpty(input?.device?.adapterType)) reasons.push("device.adapterType is required");
  if (typeof input?.device?.adapterVersion !== "string" || !ADAPTER_MANIFEST_DIGEST_PATTERN.test(input.device.adapterVersion)) {
    reasons.push("device.adapterVersion must be the adapter's manifest digest, sha256: + 64 lowercase hex");
  }
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
export function draftSafetyEnvelope(given: SafetyEnvelopeInput): SafetyEnvelopeDraft {
  // Every later read is of this one plain copy, so the draft is one observation of the input.
  const input = plainSnapshot<SafetyEnvelopeInput>(given, "input");
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
      } else if (r.citation.url !== undefined && !nonEmpty(r.citation.url)) {
        dropped.push({ quantity: req.quantity, reason: `a reference from ${r.citation.doc} has a blank url` });
      } else if (!nonEmpty(r.claim)) {
        dropped.push({ quantity: req.quantity, reason: `a reference from ${r.citation.doc} states no claim` });
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
    // Each source keeps exactly what it cites, so the bound can be checked wherever the body is compiled.
    const referenceSources: LimitSource[] = references.map((r) => ({
      kind: "reference",
      citation: citationOf(r.citation),
      retrievedAt: r.retrievedAt,
      claim: r.claim,
      value: sidesOf(r.value),
      unit: req.unit,
    }));
    const { min, max } = tightestBound(references.map((r) => r.value));
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

/**
 * `"0x" + hex(sha256(canonicalize({ domain, envelope })))`, over one plain
 * copy of the envelope (anything that is not plain JSON data is refused).
 */
export function computeSafetyEnvelopeDigest(envelope: SafetyEnvelopeBody): SafetyEnvelopeDigest {
  return snapshotEnvelope(envelope).digest;
}

/** Why a citation is not exactly `{doc, section, url?}` with non-blank fields, or null. */
function citationProblem(c: unknown): string | null {
  if (!isRecord(c) || extraKeys(c, ["doc", "section", "url"]).length > 0) return "has a citation that is not exactly {doc, section, url?}";
  if (!nonEmpty(c.doc) || !nonEmpty(c.section)) return "has a citation without a doc and a section";
  if (c.url !== undefined && !nonEmpty(c.url)) return "has a citation with a blank url";
  return null;
}

/** Why a limit source is malformed, for a limit in `unit`, or null. */
function sourceProblem(source: unknown, unit: string): string | null {
  if (!isRecord(source)) return "a source is not an object";
  switch (source.kind) {
    case "operator":
      if (extraKeys(source, ["kind", "field"]).length > 0) return "an operator source holds only kind and field";
      return nonEmpty(source.field) ? null : "an operator source needs the field it answered";
    case "reference": {
      if (extraKeys(source, ["kind", "citation", "retrievedAt", "claim", "value", "unit"]).length > 0) {
        return "a reference source holds only kind, citation, retrievedAt, claim, value and unit";
      }
      const citation = citationProblem(source.citation);
      if (citation) return `a reference source ${citation}`;
      if (!nonEmpty(source.claim)) return "a reference source needs its claim";
      if (!nonEmpty(source.retrievedAt) || !Number.isFinite(Date.parse(source.retrievedAt))) return "a reference source needs a valid retrievedAt";
      if (source.unit !== unit) return `a reference source must cite the limit's unit ${unit} (got ${JSON.stringify(source.unit)})`;
      const bound = boundProblem(source.value);
      if (bound) return `a reference source ${bound}`;
      if (extraKeys(source.value as Record<string, unknown>, ["min", "max"]).length > 0) return "a reference source's value holds only min and max";
      return null;
    }
    case "override":
      if (extraKeys(source, ["kind", "reason", "overrides"]).length > 0) return "an override source holds only kind, reason and overrides";
      if (!nonEmpty(source.reason)) return "an override needs the operator's reason";
      if (!Array.isArray(source.overrides) || source.overrides.length === 0) return "an override must name the citations it overrides";
      for (const c of source.overrides) {
        const problem = citationProblem(c);
        if (problem) return `an override ${problem}`;
      }
      return null;
    default:
      return `a source of kind ${JSON.stringify(String(source.kind))} is not operator, reference or override`;
  }
}

/**
 * Why a limit's sources do not account for its range, or an empty list
 * (astra pack 153: provenance is a rule of every confirmed body, not only of
 * confirm):
 *   - a limit a reference proposed comes from references alone, and is exactly
 *     the tightest bound they cite;
 *   - an operator's limit names exactly one operator source;
 *   - a limit looser than the tightest cited bound, on either side, carries
 *     exactly one override, with the operator's reason, naming exactly the
 *     cited references in order; a limit within that bound carries none.
 */
function provenanceProblems(limit: Record<string, unknown>, quantity: string, unit: string): string[] {
  const sources = limit.sources;
  if (!Array.isArray(sources) || sources.length === 0) return [`${quantity}: a limit must name its sources`];
  for (const source of sources) {
    const problem = sourceProblem(source, unit);
    if (problem) return [`${quantity}: ${problem}`];
  }
  const typed = sources as LimitSource[];
  const operators = typed.filter((s) => s.kind === "operator");
  const references = typed.flatMap((s) => (s.kind === "reference" ? [s] : []));
  const overrides = typed.flatMap((s) => (s.kind === "override" ? [s] : []));
  const bound = tightestBound(references.map((r) => r.value));
  const min = limit.min as number;
  const max = limit.max as number;
  if (limit.proposedBy === "reference") {
    if (operators.length > 0 || overrides.length > 0 || references.length === 0) {
      return [`${quantity}: a limit a reference proposed must come from references alone`];
    }
    if (bound.min !== min || bound.max !== max) {
      return [`${quantity}: a limit a reference proposed must be exactly the bound its references cite (${bound.min === undefined && bound.max === undefined ? "none" : describeBound(bound, unit)}), not ${min}..${max} ${unit}`];
    }
    return [];
  }
  const problems: string[] = [];
  if (operators.length !== 1) problems.push(`${quantity}: an operator's limit names exactly one operator source`);
  const loosens = (bound.min !== undefined && min < bound.min) || (bound.max !== undefined && max > bound.max);
  if (loosens && overrides.length !== 1) {
    problems.push(`${quantity}: ${min}..${max} ${unit} loosens the cited bound ${describeBound(bound, unit)}, so it must carry exactly one override with the operator's reason`);
  } else if (loosens && canonicalize(overrides[0]!.overrides) !== canonicalize(references.map((r) => r.citation))) {
    problems.push(`${quantity}: the override must name exactly the cited references, in order`);
  } else if (!loosens && overrides.length > 0) {
    problems.push(`${quantity}: an override is recorded, but ${min}..${max} ${unit} loosens no cited bound`);
  }
  return problems;
}

const BODY_KEYS = ["envelopeVersion", "deviceClass", "device", "limits", "eStop", "maxCommandsPerMinute", "supervision", "hazards", "commandMap", "confirmation"];
const LIMIT_KEYS = ["quantity", "unit", "param", "min", "max", "proposedBy", "sources"];

/**
 * Every rule a confirmed body must meet, whoever built it. Confirm runs it on
 * the body it produces, and both compilers run it on the body they are given,
 * so a hand-built body that matches its registered digest still passes only
 * what confirm would. Every shape is closed: a key the body does not define
 * is refused, never committed and ignored.
 */
export function confirmedBodyProblems(envelope: SafetyEnvelopeBody): string[] {
  const problems: string[] = [];
  if (!isRecord(envelope)) return ["the envelope is not an object"];
  const template = Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, envelope.deviceClass)
    ? DEVICE_CLASS_TEMPLATES[envelope.deviceClass]
    : undefined;
  if (!template) return [`unknown deviceClass ${JSON.stringify(String(envelope.deviceClass))}`];
  const extra = extraKeys(envelope, BODY_KEYS);
  if (extra.length > 0) problems.push(`the envelope holds keys it does not define: ${extra.join(", ")}`);
  if (envelope.envelopeVersion !== 1) problems.push("envelopeVersion must be 1");
  const device = (isRecord(envelope.device) ? envelope.device : {}) as Record<string, unknown>;
  for (const key of ["deviceId", "adapterType"] as const) {
    if (!nonEmpty(device[key])) problems.push(`device.${key} is required`);
  }
  if (typeof device.adapterVersion !== "string" || !ADAPTER_MANIFEST_DIGEST_PATTERN.test(device.adapterVersion)) {
    problems.push("device.adapterVersion must be the adapter's manifest digest, sha256: + 64 lowercase hex");
  }
  for (const key of ["vendor", "model"] as const) {
    if (device[key] !== undefined && !nonEmpty(device[key])) problems.push(`device.${key}, when given, must not be blank`);
  }
  if (extraKeys(device, ["deviceId", "adapterType", "adapterVersion", "vendor", "model"]).length > 0) {
    problems.push("device holds only deviceId, adapterType, adapterVersion, vendor and model");
  }
  const confirmation = (isRecord(envelope.confirmation) ? envelope.confirmation : {}) as Record<string, unknown>;
  if (!nonEmpty(confirmation.confirmedBy)) problems.push("confirmedBy is required");
  if (!nonEmpty(confirmation.confirmedAt) || !Number.isFinite(Date.parse(confirmation.confirmedAt as string))) {
    problems.push("confirmedAt must be an ISO-8601 time");
  }
  if (extraKeys(confirmation, ["confirmedBy", "confirmedAt"]).length > 0) problems.push("confirmation holds only confirmedBy and confirmedAt");
  if (!Array.isArray(envelope.limits) || envelope.limits.length !== template.requires.length) {
    problems.push(`limits must hold exactly one limit per required quantity, in template order (${template.requires.map((r) => r.quantity).join(", ")})`);
  } else {
    template.requires.forEach((req, i) => {
      const limit: unknown = envelope.limits[i];
      if (!isRecord(limit) || limit.quantity !== req.quantity) {
        problems.push(`limit ${i} must be ${req.quantity}`);
        return;
      }
      if (extraKeys(limit, LIMIT_KEYS).length > 0) problems.push(`${req.quantity}: a limit holds only ${LIMIT_KEYS.join(", ")}`);
      if (limit.unit !== req.unit || !UNITS.has(limit.unit as string)) problems.push(`${req.quantity} must be in ${req.unit} (got ${JSON.stringify(limit.unit)})`);
      if (limit.param !== req.param) problems.push(`${req.quantity} must bound the parameter ${req.param}`);
      const range = rangeProblem(limit.min, limit.max);
      if (range) problems.push(`${req.quantity}: ${range}`);
      if (limit.proposedBy !== "operator" && limit.proposedBy !== "reference") problems.push(`${req.quantity}: proposedBy must be operator or reference`);
      else if (!range) problems.push(...provenanceProblems(limit, req.quantity, req.unit));
    });
  }
  if (isRecord(envelope.eStop) && extraKeys(envelope.eStop, envelope.eStop.mechanism === "adapter-stop" ? ["mechanism", "stopCommand"] : ["mechanism"]).length > 0) {
    problems.push("eStop holds only its mechanism, and an adapter stop's command");
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
 * The operator's one confirmation, of the draft `input` produces. Confirm
 * drafts again from the input itself: it never trusts a draft object, whose
 * cited bounds or questions a caller could have changed (astra pack 153).
 * Edits answer questions or change proposed values. Afterwards:
 *   - every required quantity must have a limit;
 *   - the e-stop, command rate, supervision and hazards must be settled;
 *   - the adapter's command map must cover every bounded quantity;
 *   - no question may remain.
 * An edit that loosens a cited reference bound needs `override.reason`.
 * Throws `EnvelopeRefused` otherwise.
 */
export function confirmSafetyEnvelope(input: SafetyEnvelopeInput, given: EnvelopeDecision): ConfirmedSafetyEnvelope {
  const draft = draftSafetyEnvelope(input);
  const decision = plainSnapshot<EnvelopeDecision>(given, "decision");
  const reasons: string[] = [];
  const template = DEVICE_CLASS_TEMPLATES[draft.deviceClass];
  if (!template) throw new EnvelopeRefused([`unknown deviceClass ${JSON.stringify(draft.deviceClass)}`]);
  if (!nonEmpty(decision.confirmedBy)) reasons.push("confirmedBy is required");
  if (!nonEmpty(decision.confirmedAt) || !Number.isFinite(Date.parse(decision.confirmedAt))) {
    reasons.push("confirmedAt must be an ISO-8601 time");
  }

  const bounds = new Map(draft.referenceBounds.map((b) => [b.quantity, b]));
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
  // What confirm returns is the snapshot it hashed: frozen, and exactly what the digest covers.
  const { body, digest } = snapshotEnvelope(envelope);
  const problems = confirmedBodyProblems(body);
  if (problems.length > 0) throw new EnvelopeRefused(problems);
  return { envelope: body, envelopeDigest: digest };
}

// ── Registration: the authority to compile ──────────────────────────

/**
 * What the registry signs once the operator has confirmed through an
 * authenticated session: this device's confirmed envelope has this digest.
 */
export interface SafetyEnvelopeRegistrationStatement {
  deviceId: string;
  envelopeDigest: SafetyEnvelopeDigest;
  /** ISO-8601 time the registry recorded it. */
  registeredAt: string;
}

export interface SafetyEnvelopeRegistration extends SafetyEnvelopeRegistrationStatement {
  /** Ed25519 signature, 128 hex characters, over `registrationSigningPreimage(statement)`. */
  signature: string;
}

/**
 * The registry's signature check, wired by the integration to the registry's
 * pinned public key. It is trusted code, like every verification callback:
 * only `true` counts, and a throw counts as false.
 */
export type RegistrationVerifier = (preimage: Uint8Array, signature: Uint8Array) => boolean;

function registrationStatementProblems(statement: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!nonEmpty(statement.deviceId)) problems.push("the registration needs the deviceId");
  if (typeof statement.envelopeDigest !== "string" || !DIGEST_PATTERN.test(statement.envelopeDigest)) {
    problems.push("the registration's envelopeDigest must be 0x + 64 lowercase hex");
  }
  if (!nonEmpty(statement.registeredAt) || !Number.isFinite(Date.parse(statement.registeredAt))) {
    problems.push("the registration's registeredAt must be an ISO-8601 time");
  }
  return problems;
}

function statementDigestOf(statement: Record<string, unknown>): SHA256 {
  const canonical = canonicalize({
    domain: SAFETY_ENVELOPE_REGISTRATION_DOMAIN,
    deviceId: statement.deviceId,
    envelopeDigest: statement.envelopeDigest,
    registeredAt: statement.registeredAt,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}` as SHA256;
}

/**
 * `"sha256:" + hex(sha256(canonicalize({ domain, deviceId, envelopeDigest,
 * registeredAt })))`, with the registration domain. Its signing preimage is
 * LO-EV-1's: the UTF-8 of this tagged digest (`signingPreimage`).
 */
export function registrationStatementDigest(statement: SafetyEnvelopeRegistrationStatement): SHA256 {
  const plain = plainSnapshot<Record<string, unknown>>(statement, "registration");
  const problems = registrationStatementProblems(plain);
  if (problems.length > 0) throw new EnvelopeRefused(problems);
  return statementDigestOf(plain);
}

/** The bytes the registry signs: LO-EV-1's preimage of `registrationStatementDigest(statement)`. */
export function registrationSigningPreimage(statement: SafetyEnvelopeRegistrationStatement): Uint8Array {
  return signingPreimage(registrationStatementDigest(statement));
}

/**
 * The shared gate of both compilers. It returns the one snapshot that is
 * checked and compiled, after establishing that:
 *   - the envelope is plain data, copied once, and its digest is the one it
 *     was confirmed with;
 *   - the registration is for this device and this digest, and the registry's
 *     signature over it verifies. A digest the caller computed is not a
 *     confirmation (astra pack 153);
 *   - the body meets every rule confirm enforces.
 */
function committedSnapshot(
  confirmed: ConfirmedSafetyEnvelope,
  registration: SafetyEnvelopeRegistration,
  verifyRegistration: RegistrationVerifier,
): EnvelopeSnapshot {
  if (typeof verifyRegistration !== "function") {
    throw new EnvelopeRefused(["a registration verifier (the registry's signature check) is required"]);
  }
  const given = plainSnapshot<Record<string, unknown>>(confirmed, "confirmed");
  const record = plainSnapshot<Record<string, unknown>>(registration, "registration");
  const snapshot = snapshotEnvelope(given.envelope);
  if (snapshot.digest !== given.envelopeDigest) {
    throw new EnvelopeRefused(["the envelope changed after it was confirmed; it must be confirmed again"]);
  }
  const statement = registrationStatementProblems(record);
  if (statement.length > 0) throw new EnvelopeRefused(statement);
  if (record.envelopeDigest !== snapshot.digest) {
    throw new EnvelopeRefused(["this is not the envelope the registration record committed"]);
  }
  if (record.deviceId !== snapshot.body.device?.deviceId) {
    throw new EnvelopeRefused(["the registration is for another device"]);
  }
  let signature: Uint8Array;
  try {
    signature = parseEd25519SignatureHex(record.signature);
  } catch {
    throw new EnvelopeRefused(["the registration's signature is not an Ed25519 signature (128 hex characters)"]);
  }
  let verified = false;
  try {
    verified = verifyRegistration(signingPreimage(statementDigestOf(record)), signature) === true;
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new EnvelopeRefused(["the registration's signature does not verify against the registry's key"]);
  }
  const problems = confirmedBodyProblems(snapshot.body);
  if (problems.length > 0) throw new EnvelopeRefused(problems);
  return snapshot;
}

/**
 * The envelope the registry's signed registration commits, as one frozen
 * snapshot that meets every rule confirm enforces, with its digest (see
 * `committedSnapshot`). Compile from what this returns, never from the input.
 */
export function checkCommittedEnvelope(
  confirmed: ConfirmedSafetyEnvelope,
  registration: SafetyEnvelopeRegistration,
  verifyRegistration: RegistrationVerifier,
): ConfirmedSafetyEnvelope {
  const { body, digest } = committedSnapshot(confirmed, registration, verifyRegistration);
  return { envelope: body, envelopeDigest: digest };
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
 * Compile the envelope the registry's signed registration commits (see
 * `checkCommittedEnvelope`) into the CSD's typed I/O and its evidence tier.
 * It reads only the snapshot it checked, never `confirmed` again.
 */
export function compileSafetyEnvelope(
  confirmed: ConfirmedSafetyEnvelope,
  registration: SafetyEnvelopeRegistration,
  verifyRegistration: RegistrationVerifier,
): CompiledSafetyEnvelope {
  const { body: envelope, digest: committedDigest } = committedSnapshot(confirmed, registration, verifyRegistration);
  const template = DEVICE_CLASS_TEMPLATES[envelope.deviceClass]!;

  // Built with map, which installs each element directly: a push or an
  // assignment would run a setter Array.prototype serves for that index, and
  // could substitute a compiled bound.
  const parameters: CsdParameter[] = template.requires.map((req, i) => {
    const limit = envelope.limits[i]!;
    return {
      key: req.param,
      label: req.label,
      description: `${req.why}. Confirmed range ${limit.min}..${limit.max} ${limit.unit}.`,
      required: true,
      type: "number",
      min: limit.min,
      max: limit.max,
      step: req.step,
      unit: limit.unit,
    };
  });
  const definitions: ParameterDefinition[] = template.requires.map((req, i) => {
    const limit = envelope.limits[i]!;
    return {
      name: req.param,
      semanticType: req.semanticType,
      required: true,
      unit: limit.unit,
      minimum: { value: limit.min, unit: limit.unit },
      maximum: { value: limit.max, unit: limit.unit },
    };
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

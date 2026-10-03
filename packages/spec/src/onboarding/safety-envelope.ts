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
 * committed in the digest. Every template quantity keeps a limit. One that no
 * declared parameter sets is device-controlled: the operator states how its
 * limit is enforced (telemetry or an independent cutoff), because "no command
 * sets it" is not "the device cannot cause it". Only a template that does not
 * list a quantity makes it absent (astra pack 173). So a strict runtime can
 * refuse any command, parameter or value outside the map, and any adapter
 * whose manifest digest differs.
 *
 * "Safety envelope" is this term exactly. It is not `evidence-envelope` (a
 * data-integrity wrapper) or onboard-kit's `workEnvelope` (part dimensions).
 *
 * Every function is pure and deterministic: no I/O, no clock, no randomness.
 * The only code it calls that the caller supplies is the registration
 * verifier. Units come only from the composition unit table (`KNOWN_UNITS`),
 * the one the prism compiler parses.
 *
 * Intrinsics. Every check, hash and projection calls only the intrinsics
 * `primordials.ts` captured when it loaded, plain loops and operators, never a
 * method looked up on a mutable prototype or global at call time. So a
 * prototype method or global replaced after load cannot change what is
 * checked or emitted (astra pack 164: a replaced `Array.prototype.map` raised
 * an emitted limit from the signed 40 to 400). The templates and the other
 * module constants are frozen when this module loads. A realm whose
 * intrinsics were replaced BEFORE this module loaded is beyond any in-process
 * check: load @pcc/spec before any untrusted code, or run under a frozen
 * realm.
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

import { KNOWN_UNITS, type ParameterDefinition, type PortType, type Unit } from "../csd/composition.js";
import type { CsdEvidenceTier, CsdParameter } from "../csd/schema.js";
import type { SHA256 } from "../types/common.js";
import {
  append,
  ArrayIsArray,
  ArrayPrototype,
  asciiBytes,
  canonicalJson,
  deepFreeze,
  defineIndex,
  DateParse,
  filterList,
  fixedHexBytes,
  hasOwn,
  includesValue,
  inSet,
  isHex256Digest,
  isProxy,
  isTaggedSha256,
  joinStrings,
  JSONParse,
  JSONStringify,
  mapList,
  newList,
  NumberIsFinite,
  NumberIsInteger,
  ObjectAssign,
  ObjectCreate,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototype,
  quoted,
  sha256Hex,
  stringSet,
  text,
  toLowerCase,
  trim,
} from "./primordials.js";

/** Domain separator: an envelope digest can never collide with another digest. */
export const SAFETY_ENVELOPE_DOMAIN = "PCC:safety-envelope:v1";

/** Domain separator of the registry's signed registration statement. */
export const SAFETY_ENVELOPE_REGISTRATION_DOMAIN = "PCC:safety-envelope-registration:v1";

/** A confirmed envelope's digest: `0x` + 64 lowercase hex (SHA-256), the commitment family. */
export type SafetyEnvelopeDigest = `0x${string}`;

/** Whether `value` is a confirmed envelope's digest: `0x` + 64 lowercase hex. */
export function isSafetyEnvelopeDigest(value: unknown): value is SafetyEnvelopeDigest {
  return isHex256Digest(value);
}

/**
 * Whether `value` is an adapter's manifest digest: `sha256:` + 64 lowercase hex
 * of its reviewed release manifest. This is a function, not an exported RegExp:
 * RegExp.prototype.compile rewrites a RegExp's matcher in place after load,
 * frozen or not, and draft, confirm and compile then accepted any adapter
 * version (astra pack 167).
 */
export function isAdapterManifestDigest(value: unknown): value is string {
  return isTaggedSha256(value);
}

const UNITS = stringSet(KNOWN_UNITS);
/** Units a job deadline can be stated in. */
const TIME_UNITS = stringSet(["s", "min", "h"]);

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
export const SUPERVISION_MODES = deepFreeze(["attended", "unattended", "remote-supervised"] as const);
export type Supervision = (typeof SUPERVISION_MODES)[number];

/** Hazard classes (`safety.hazards`). An empty list is the operator's explicit "none". */
export const HAZARDS = deepFreeze(["biological", "chemical", "heat", "laser", "mechanical"] as const);
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
  /**
   * An enumerated PHYSICAL parameter, such as a temperature preset: the only
   * values it may carry, each inside the confirmed limit of `quantity`. It is
   * distinct from `unbounded`, which claims the parameter sets no physical
   * quantity at all (astra pack 173).
   */
  allowed?: number[];
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
export const DEVICE_CLASS_TEMPLATES: Readonly<Record<string, DeviceClassTemplate>> = deepFreeze({
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
  // Physical absence is a property of a reviewed template, never an operator's word at confirm
  // (astra pack 173): this class has no incubator, so it does not list incubation_temperature.
  "lab-plate-reader-absorbance": {
    id: "lab-plate-reader-absorbance",
    label: "Microplate reader (absorbance only, no incubator), generic HTTP",
    movesOrHeats: true,
    requires: [
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
});

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
    super(`safety envelope refused (${reasons.length}): ${joinStrings(reasons, "; ")}`);
    this.name = "EnvelopeRefused";
  }
}

function finite(v: unknown): v is number {
  return typeof v === "number" && NumberIsFinite(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && trim(v).length > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !ArrayIsArray(v);
}

/** The keys of `v` that are not in `allowed`, for closed shapes. */
function extraKeys(v: object, allowed: readonly string[]): string[] {
  return filterList(ObjectKeys(v), (k) => !includesValue(allowed, k));
}

/** The template for `deviceClass`, read as an own property only. */
function templateOf(deviceClass: unknown): DeviceClassTemplate | undefined {
  return typeof deviceClass === "string" && hasOwn(DEVICE_CLASS_TEMPLATES, deviceClass) ? DEVICE_CLASS_TEMPLATES[deviceClass] : undefined;
}

// ── One observation: plain data, read once ──────────────────────────

class NotPlainData extends Error {}
const NOT_PLAIN_DATA = NotPlainData.prototype;

const MAX_DEPTH = 64;

/**
 * A one-pass copy of JSON data that runs no code supplied with it. Everything
 * is read through property descriptors, so a getter is found and refused
 * without being called. Refused: a proxy; an accessor; an array whose
 * prototype is not Array.prototype, or with a hole; an object whose prototype
 * is not Object.prototype or null; a function, symbol, bigint or non-finite
 * number; undefined inside an array; a cycle; a key named `__proto__`; and
 * nesting deeper than 64. An undefined member is dropped, and -0 becomes 0,
 * both as `canonicalize` writes them. Copied objects have a null prototype,
 * and copied array elements are installed as own data properties, so
 * building the copy runs no inherited setter either.
 */
function plainCopy(value: unknown, path: string, ancestors: object[], depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!NumberIsFinite(value)) throw new NotPlainData(`${path}: ${text(value)} is not a finite number`);
    return ObjectIs(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new NotPlainData(`${path}: a ${typeof value} is not JSON data`);
  if (isProxy === null) throw new NotPlainData(`${path}: this runtime has no trap-free proxy check, so no object is copied as plain data`);
  if (isProxy(value)) throw new NotPlainData(`${path}: a proxy`);
  if (depth > MAX_DEPTH) throw new NotPlainData(`${path}: nested deeper than ${MAX_DEPTH}`);
  if (includesValue(ancestors, value)) throw new NotPlainData(`${path}: a cycle`);
  append(ancestors, value);
  try {
    if (ArrayIsArray(value)) {
      if (ObjectGetPrototypeOf(value) !== ArrayPrototype) throw new NotPlainData(`${path}: an array with a nonstandard prototype`);
      const out = newList<unknown>(value.length);
      for (let i = 0; i < value.length; i++) {
        const element = ObjectGetOwnPropertyDescriptor(value, i);
        if (element === undefined) throw new NotPlainData(`${path}[${i}]: a hole in an array`);
        if (!hasOwn(element, "value")) throw new NotPlainData(`${path}[${i}]: an accessor (a getter or setter)`);
        if (element.value === undefined) throw new NotPlainData(`${path}[${i}]: undefined in an array`);
        // Installed as the copy's own data property: an assignment or push would run a setter
        // Array.prototype serves for this index (astra pack 158).
        defineIndex(out, i, plainCopy(element.value, `${path}[${i}]`, ancestors, depth + 1));
      }
      return out;
    }
    const prototype = ObjectGetPrototypeOf(value);
    if (prototype !== ObjectPrototype && prototype !== null) throw new NotPlainData(`${path}: not a plain object`);
    const out = ObjectCreate(null) as Record<string, unknown>;
    const keys = ObjectKeys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (key === "__proto__") throw new NotPlainData(`${path}: a key named __proto__`);
      const member = ObjectGetOwnPropertyDescriptor(value, key);
      if (member === undefined) continue;
      if (!hasOwn(member, "value")) throw new NotPlainData(`${path}.${key}: an accessor (a getter or setter)`);
      if (member.value === undefined) continue;
      out[key] = plainCopy(member.value, `${path}.${key}`, ancestors, depth + 1);
    }
    return out;
  } finally {
    ancestors.length = ancestors.length - 1;
  }
}

/** `value` as plain JSON data, copied once; `EnvelopeRefused` when it is anything else. */
function plainSnapshot<T>(value: unknown, what: string): T {
  try {
    return plainCopy(value, what, newList<object>(0), 0) as T;
  } catch (err) {
    if (typeof err === "object" && err !== null && ObjectGetPrototypeOf(err) === NOT_PLAIN_DATA) {
      throw new EnvelopeRefused([`${(err as NotPlainData).message}: ${what} must be plain JSON data, and no code supplied with it may run`]);
    }
    throw err;
  }
}

function nullPrototype(_key: string, value: unknown): unknown {
  return value !== null && typeof value === "object" && !ArrayIsArray(value)
    ? ObjectAssign(ObjectCreate(null) as Record<string, unknown>, value)
    : value;
}

/** An envelope as it was hashed: the one copy that is checked and compiled, and its digest. */
interface EnvelopeSnapshot {
  body: SafetyEnvelopeBody;
  digest: SafetyEnvelopeDigest;
}

/** `{"domain":<SAFETY_ENVELOPE_DOMAIN>,"envelope":`, the start of the digest preimage, fixed at load. */
const ENVELOPE_PREIMAGE_HEAD = `{"domain":${JSONStringify(SAFETY_ENVELOPE_DOMAIN)},"envelope":`;

/**
 * Copy the envelope once as plain data, serialize the copy once, hash those
 * bytes, and parse the same bytes back into the frozen body that is checked
 * and compiled. Nothing afterwards reads the caller's object, so a value
 * cannot change between hashing, checking and use (astra pack 153). Every
 * step uses intrinsics captured at load (astra pack 164).
 */
function snapshotEnvelope(envelope: unknown): EnvelopeSnapshot {
  const bytes = canonicalJson(plainSnapshot(envelope, "envelope"));
  // Exactly canonicalize({ domain, envelope }): "domain" sorts before "envelope".
  const digest = `0x${sha256Hex(`${ENVELOPE_PREIMAGE_HEAD}${bytes}}`)}` as SafetyEnvelopeDigest;
  const body = deepFreeze(JSONParse(bytes, nullPrototype)) as SafetyEnvelopeBody;
  return { body, digest };
}

/** Why a bound pair is unusable as a range, or null. */
function rangeProblem(min: unknown, max: unknown): string | null {
  if (!finite(min) || !finite(max)) return "needs both a finite min and a finite max";
  if (min > max) return `min ${min} is above max ${max}`;
  return null;
}

const ESTOP_MECHANISMS: readonly string[] = deepFreeze(["hardware", "adapter-stop", "none"]);

/** The names of the map's declared commands. */
function declaredCommands(commandMap: unknown): string[] {
  const names = newList<string>(0);
  if (!isRecord(commandMap) || !ArrayIsArray(commandMap.commands)) return names;
  const commands = commandMap.commands as unknown[];
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (isRecord(command) && nonEmpty(command.name)) append(names, command.name);
  }
  return names;
}

/** Why an e-stop cannot stand in a confirmed envelope for this class, or null. */
function eStopProblem(
  eStop: EStopDeclaration | null | undefined,
  template: DeviceClassTemplate,
  commandMap: unknown,
): string | null {
  if (!eStop) return "no e-stop declared";
  if (!includesValue(ESTOP_MECHANISMS, eStop.mechanism)) {
    return `e-stop mechanism ${quoted(eStop.mechanism)} is not hardware, adapter-stop or none`;
  }
  if (eStop.mechanism === "none" && template.movesOrHeats) return "a device that moves or heats needs an e-stop";
  if (eStop.mechanism === "adapter-stop") {
    if (!nonEmpty(eStop.stopCommand)) return "an adapter stop needs its command";
    if (!includesValue(declaredCommands(commandMap), eStop.stopCommand)) {
      return `the stop command ${JSONStringify(eStop.stopCommand)} is not one of the adapter's declared commands`;
    }
  }
  return null;
}

function rateProblem(rate: unknown): string | null {
  return NumberIsInteger(rate) && (rate as number) >= 1 ? null : "maxCommandsPerMinute must be an integer >= 1";
}

/** Why a finding's value cannot bound a quantity, or null. Either side may be absent, but not both. */
function boundProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || ArrayIsArray(value)) return "has no {min, max} value";
  const min = hasOwn(value, "min") ? (value as { min?: unknown }).min : undefined;
  const max = hasOwn(value, "max") ? (value as { max?: unknown }).max : undefined;
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

/**
 * The tightest bound cited references allow together: the largest given min
 * and the smallest given max. It has a null prototype, so a side no
 * reference gives reads as undefined, never as an inherited value.
 */
function tightestBound(values: readonly { min?: number; max?: number }[]): { min?: number; max?: number } {
  let min: number | undefined;
  let max: number | undefined;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const vMin = hasOwn(v, "min") ? v.min : undefined;
    const vMax = hasOwn(v, "max") ? v.max : undefined;
    if (vMin !== undefined && (min === undefined || vMin > min)) min = vMin;
    if (vMax !== undefined && (max === undefined || vMax < max)) max = vMax;
  }
  const bound = ObjectCreate(null) as { min?: number; max?: number };
  if (min !== undefined) bound.min = min;
  if (max !== undefined) bound.max = max;
  return bound;
}

function describeBound(bound: { min?: number; max?: number }, unit: string): string {
  if (bound.min !== undefined && bound.max !== undefined) return `${bound.min}..${bound.max} ${unit}`;
  return bound.min !== undefined ? `at least ${bound.min} ${unit}` : `at most ${bound.max} ${unit}`;
}

function supervisionProblem(supervision: unknown): string | null {
  return includesValue(SUPERVISION_MODES, supervision)
    ? null
    : `supervision ${quoted(supervision)} is not attended, unattended or remote-supervised`;
}

function hazardsProblem(hazards: unknown): string | null {
  if (!ArrayIsArray(hazards)) return "hazards must be a list (an empty list means none)";
  const unknown = filterList(hazards as unknown[], (h) => !includesValue(HAZARDS, h));
  return unknown.length > 0 ? `unknown hazard ${joinStrings(mapList(unknown, (h) => quoted(h)), ", ")}` : null;
}

/** Hazards in one canonical order, each once, so the same answer always digests the same. */
function canonicalHazards(hazards: readonly Hazard[]): Hazard[] {
  return filterList(HAZARDS as readonly Hazard[], (h) => includesValue(hazards, h));
}

/** Why a committed hazards list is not one confirm produces (each once, in canonical order), or null. */
function hazardsCanonicalProblem(hazards: unknown): string | null {
  if (hazardsProblem(hazards)) return null; // hazardsProblem reports it
  const list = hazards as Hazard[];
  const canonical = canonicalHazards(list);
  if (canonical.length !== list.length) return "hazards must each appear once, in canonical order";
  for (let i = 0; i < list.length; i++) if (canonical[i] !== list[i]) return "hazards must each appear once, in canonical order";
  return null;
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
  if (!ArrayIsArray(values) || values.length === 0) {
    return `parameter ${at}: ${name} must list the values it may carry; a free-form parameter could carry anything`;
  }
  const seen = newList<string>(0);
  for (let i = 0; i < values.length; i++) {
    const value: unknown = values[i];
    if (!nonEmpty(value) && !finite(value)) return `parameter ${at}: every ${name} value must be a non-blank string or a finite number`;
    const key = JSONStringify(value);
    if (includesValue(seen, key)) return `parameter ${at}: the ${name} value ${key} is listed twice`;
    append(seen, key);
  }
  return null;
}

const UNBOUNDED_LISTS: readonly ("allowed" | "allowedItems")[] = deepFreeze(["allowed", "allowedItems"]);

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
  for (let i = 0; i < UNBOUNDED_LISTS.length; i++) {
    const name = UNBOUNDED_LISTS[i]!;
    if (unbounded[name] === undefined) continue;
    const problem = finiteSetProblem(unbounded[name], at, name);
    if (problem) return problem;
  }
  return null;
}

/** The unit each template quantity is bounded in, or undefined for a quantity the template does not bound. */
function unitOf(template: DeviceClassTemplate, quantity: unknown): string | undefined {
  for (let i = 0; i < template.requires.length; i++) {
    if (template.requires[i]!.quantity === quantity) return template.requires[i]!.unit;
  }
  return undefined;
}

/** Why a command map is malformed for this class, or null. Coverage gaps are `commandMapGaps`. */
function commandMapProblem(commandMap: unknown, template: DeviceClassTemplate): string | null {
  if (!isRecord(commandMap) || !ArrayIsArray(commandMap.commands) || (commandMap.commands as unknown[]).length === 0) {
    return "the command map must list at least one command";
  }
  if (extraKeys(commandMap, ["commands"]).length > 0) return "the command map holds only commands";
  const commands = commandMap.commands as unknown[];
  const commandNames = newList<string>(0);
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (!isRecord(command) || !nonEmpty(command.name)) return `command ${i} needs a name`;
    if (extraKeys(command, ["name", "params"]).length > 0) return `command ${JSONStringify(command.name)} has keys other than name and params`;
    if (includesValue(commandNames, command.name)) return `command ${JSONStringify(command.name)} is declared twice`;
    append(commandNames, command.name);
    if (!ArrayIsArray(command.params)) return `command ${JSONStringify(command.name)} needs a params list`;
    const params = command.params as unknown[];
    const paramNames = newList<string>(0);
    for (let j = 0; j < params.length; j++) {
      const param = params[j];
      if (!isRecord(param) || !nonEmpty(param.name)) return `command ${JSONStringify(command.name)} has a parameter without a name`;
      const at = `${command.name}.${param.name}`;
      if (extraKeys(param, ["name", "quantity", "unit", "allowed", "unbounded"]).length > 0) {
        return `parameter ${at} has keys other than name, quantity, unit, allowed and unbounded`;
      }
      if (includesValue(paramNames, param.name)) return `parameter ${at} is declared twice`;
      append(paramNames, param.name);
      const mapped = param.quantity !== undefined || param.unit !== undefined;
      if (mapped === (param.unbounded !== undefined)) {
        return `parameter ${at} must either set a quantity (quantity and unit) or say why it sets none (unbounded)`;
      }
      if (mapped) {
        const unit = unitOf(template, param.quantity);
        if (unit === undefined) return `parameter ${at} sets ${JSONStringify(param.quantity)}, which this class does not bound`;
        if (param.unit !== unit) return `parameter ${at} sets ${text(param.quantity)} in ${JSONStringify(param.unit)}, not ${unit}`;
        if (param.allowed !== undefined) {
          const allowed: unknown = param.allowed;
          if (!ArrayIsArray(allowed) || allowed.length === 0) return `parameter ${at}: allowed, when given, lists at least one value`;
          const seen = newList<number>(0);
          for (let k = 0; k < allowed.length; k++) {
            const value: unknown = allowed[k];
            if (!finite(value)) return `parameter ${at}: an allowed value of a physical parameter is a finite number`;
            if (includesValue(seen, value)) return `parameter ${at}: allowed lists ${text(value)} twice`;
            append(seen, value);
          }
        }
      } else if (param.allowed !== undefined) {
        return `parameter ${at}: allowed values belong to a parameter that sets a quantity; one that sets none says why (unbounded)`;
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
  const set = newList<string>(0);
  for (let i = 0; i < commandMap.commands.length; i++) {
    const params = commandMap.commands[i]!.params;
    for (let j = 0; j < params.length; j++) if (nonEmpty(params[j]!.quantity)) append(set, params[j]!.quantity as string);
  }
  const gaps = newList<string>(0);
  for (let i = 0; i < template.requires.length; i++) {
    const quantity = template.requires[i]!.quantity;
    if (quantity !== template.deadline && !includesValue(set, quantity)) append(gaps, quantity);
  }
  return gaps;
}

/** No quantities, and no device-controlled entries: what an envelope whose map sets every quantity carries. */
const NO_QUANTITIES: readonly string[] = deepFreeze(newList<string>(0));
const NO_DEVICE_CONTROLLED: readonly DeviceControlledQuantity[] = deepFreeze(newList<DeviceControlledQuantity>(0));

const DEVICE_CONTROLLED_KEYS: readonly string[] = deepFreeze(["quantity", "enforcement", "detail"]);

/** The quantities a deviceControlled list names, in its order. */
function controlledQuantities(controlled: readonly DeviceControlledQuantity[]): string[] {
  return mapList(controlled, (d) => d.quantity);
}

/** `controlled` in template order, each entry copied field by field. */
function inTemplateOrder(controlled: readonly DeviceControlledQuantity[], template: DeviceClassTemplate): DeviceControlledQuantity[] {
  const out = newList<DeviceControlledQuantity>(0);
  for (let i = 0; i < template.requires.length; i++) {
    for (let j = 0; j < controlled.length; j++) {
      const d = controlled[j]!;
      if (d.quantity === template.requires[i]!.quantity) append(out, { quantity: d.quantity, enforcement: d.enforcement, detail: d.detail });
    }
  }
  return out;
}

/**
 * Why a `deviceControlled` list is malformed for this template, or null. Each
 * entry is exactly {quantity, enforcement, detail}: a required quantity other
 * than the deadline, named once and in template order, "telemetry" or
 * "cutoff", and a non-blank detail. A confirmed body carries the list only
 * when non-empty (one canonical form per decision); the runtime envelope
 * always carries it, so `allowEmpty` is for the runtime.
 */
function deviceControlledProblem(controlled: unknown, template: DeviceClassTemplate, allowEmpty: boolean): string | null {
  if (!ArrayIsArray(controlled)) return "deviceControlled must be a list";
  if (controlled.length === 0) return allowEmpty ? null : "deviceControlled, when present, lists at least one quantity";
  let previous = -1;
  for (let i = 0; i < controlled.length; i++) {
    const entry: unknown = controlled[i];
    if (!isRecord(entry) || extraKeys(entry, DEVICE_CONTROLLED_KEYS).length > 0) return "each deviceControlled entry is exactly {quantity, enforcement, detail}";
    let at = -1;
    for (let j = 0; j < template.requires.length; j++) if (template.requires[j]!.quantity === entry.quantity) at = j;
    if (at < 0) return `deviceControlled names ${quoted(entry.quantity)}, which is not a quantity of a ${template.id}`;
    if (entry.quantity === template.deadline) {
      return `deviceControlled names the deadline ${template.deadline}: the runtime stops a job on its elapsed time`;
    }
    if (at <= previous) return "deviceControlled lists each quantity once, in template order";
    previous = at;
    if (!includesValue(DEVICE_CONTROL_ENFORCEMENTS, entry.enforcement)) return `${text(entry.quantity)}: enforcement must be "telemetry" or "cutoff"`;
    if (!nonEmpty(entry.detail)) return `${text(entry.quantity)}: a device-controlled quantity needs a detail naming its telemetry channel or its cutoff`;
  }
  return null;
}

/**
 * Why the command map's coverage and `deviceControlled` disagree, or null.
 * Every quantity no declared parameter sets must be confirmed device-controlled,
 * and a quantity some parameter sets never is: its limit is enforced on that
 * parameter at dispatch.
 */
function coverageProblem(gaps: readonly string[], controlled: readonly string[]): string | null {
  const unconfirmed = filterList(gaps, (q) => !includesValue(controlled, q));
  if (unconfirmed.length > 0) {
    return `no declared parameter sets ${joinStrings(unconfirmed, ", ")}, and the operator has not confirmed it as device-controlled (enforced by telemetry or an independent cutoff)`;
  }
  const settable = filterList(controlled, (q) => !includesValue(gaps, q));
  if (settable.length > 0) return `deviceControlled names ${joinStrings(settable, ", ")}, but a declared parameter sets it`;
  return null;
}

/**
 * Why an enumerated physical parameter allows a value outside its quantity's
 * confirmed limit: one problem per value, and empty when every allowed value fits.
 */
function enumeratedProblems(commandMap: CommandMapV1, limits: readonly unknown[]): string[] {
  const problems = newList<string>(0);
  for (let i = 0; i < commandMap.commands.length; i++) {
    const command = commandMap.commands[i]!;
    for (let j = 0; j < command.params.length; j++) {
      const param = command.params[j]!;
      if (param.allowed === undefined || param.quantity === undefined) continue;
      let limit: Record<string, unknown> | undefined;
      for (let k = 0; k < limits.length; k++) {
        const candidate: unknown = limits[k];
        if (isRecord(candidate) && candidate.quantity === param.quantity) limit = candidate;
      }
      if (limit === undefined || !finite(limit.min) || !finite(limit.max)) continue;
      for (let k = 0; k < param.allowed.length; k++) {
        const value: unknown = param.allowed[k];
        if (!finite(value) || value < (limit.min as number) || value > (limit.max as number)) {
          append(problems, `parameter ${command.name}.${param.name} allows ${text(value)}, outside the ${param.quantity} limit ${text(limit.min)}..${text(limit.max)}`);
        }
      }
    }
  }
  return problems;
}

function checkInput(input: SafetyEnvelopeInput): { template: DeviceClassTemplate } {
  const reasons = newList<string>(0);
  const template = templateOf(input?.deviceClass);
  if (!template) append(reasons, `unknown deviceClass ${quoted(input?.deviceClass)}`);
  if (!nonEmpty(input?.device?.deviceId)) append(reasons, "device.deviceId is required");
  if (!nonEmpty(input?.device?.adapterType)) append(reasons, "device.adapterType is required");
  if (!isAdapterManifestDigest(input?.device?.adapterVersion)) {
    append(reasons, "device.adapterVersion must be the adapter's manifest digest, sha256: + 64 lowercase hex");
  }
  if (!ArrayIsArray(input?.intake?.limits)) append(reasons, "intake.limits must be an array");
  if (!ArrayIsArray(input?.references)) append(reasons, "references must be an array");
  if (template && input?.commandMap !== undefined) {
    const problem = commandMapProblem(input.commandMap, template);
    if (problem) append(reasons, `commandMap: ${problem}`);
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
  const limits = newList<EnvelopeLimit>(0);
  const questions = newList<EnvelopeQuestion>(0);
  const dropped = newList<DroppedInput>(0);
  const referenceBounds = newList<ReferenceBound>(0);

  for (let q = 0; q < template.requires.length; q++) {
    const req = template.requires[q]!;
    const ask = (why: string, asked: string) => append(questions, { about: req.quantity, ask: asked, why });
    const range = `the range of ${toLowerCase(req.label)} in ${req.unit}`;

    const answers = filterList(input.intake.limits, (l) => l?.quantity === req.quantity);
    const usableAnswers = newList<IntakeLimit>(0);
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i]!;
      if (a.unit !== req.unit) {
        append(dropped, { quantity: req.quantity, reason: `operator answer in ${JSONStringify(a.unit)}, not ${req.unit}` });
        continue;
      }
      const problem = rangeProblem(a.min, a.max);
      if (problem) {
        append(dropped, { quantity: req.quantity, reason: `operator answer ${problem}` });
        continue;
      }
      append(usableAnswers, a);
    }

    const references = newList<ReferenceFinding>(0);
    const asked = filterList(input.references, (x) => x?.quantity === req.quantity);
    for (let i = 0; i < asked.length; i++) {
      const r = asked[i]!;
      if (!nonEmpty(r.citation?.doc) || !nonEmpty(r.citation?.section)) {
        append(dropped, { quantity: req.quantity, reason: "a reference without a citation (doc and section) cannot propose a limit" });
      } else if (r.citation.url !== undefined && !nonEmpty(r.citation.url)) {
        append(dropped, { quantity: req.quantity, reason: `a reference from ${r.citation.doc} has a blank url` });
      } else if (!nonEmpty(r.claim)) {
        append(dropped, { quantity: req.quantity, reason: `a reference from ${r.citation.doc} states no claim` });
      } else if (!nonEmpty(r.retrievedAt) || !NumberIsFinite(DateParse(r.retrievedAt))) {
        append(dropped, { quantity: req.quantity, reason: `a reference from ${r.citation.doc} has no valid retrievedAt` });
      } else if (r.unit !== req.unit) {
        append(dropped, { quantity: req.quantity, reason: `a reference from ${r.citation.doc} is in ${JSONStringify(r.unit)}, not ${req.unit}` });
      } else if (boundProblem(r.value)) {
        append(dropped, { quantity: req.quantity, reason: `a reference from ${r.citation.doc} ${boundProblem(r.value)}` });
      } else {
        append(references, r);
      }
    }
    // Each source keeps exactly what it cites, so the bound can be checked wherever the body is compiled.
    const referenceSources: LimitSource[] = mapList(references, (r) => ({
      kind: "reference" as const,
      citation: citationOf(r.citation),
      retrievedAt: r.retrievedAt,
      claim: r.claim,
      value: sidesOf(r.value),
      unit: req.unit,
    }));
    const { min, max } = tightestBound(mapList(references, (r) => r.value));
    if (references.length > 0) {
      append(referenceBounds, {
        quantity: req.quantity,
        unit: req.unit,
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        sources: referenceSources,
      });
    }

    const distinct = newList<string>(0);
    for (let i = 0; i < usableAnswers.length; i++) {
      const stated = `${usableAnswers[i]!.min}..${usableAnswers[i]!.max}`;
      if (!includesValue(distinct, stated)) append(distinct, stated);
    }
    if (distinct.length > 1) {
      ask(req.why, `You gave ${joinStrings(distinct, " and ")} ${req.unit} for ${toLowerCase(req.label)}. Which is it?`);
      continue;
    }
    if (usableAnswers.length > 0) {
      const a = usableAnswers[0]!;
      // A reference tighter than the operator's answer, on either side, is asked about, never silently loosened past.
      const tighter = filterList(
        references,
        (r) => (r.value.min !== undefined && r.value.min > (a.min as number)) || (r.value.max !== undefined && r.value.max < (a.max as number)),
      );
      for (let i = 0; i < tighter.length; i++) {
        const r = tighter[i]!;
        ask(
          req.why,
          `${r.citation.doc} (${r.citation.section}) gives ${describeBound(r.value, req.unit)}; you gave ${a.min}..${a.max}. Confirm your range or tighten it.`,
        );
      }
      if (tighter.length > 0) continue;
      const sources = newList<LimitSource>(0);
      append(sources, { kind: "operator", field: a.field });
      for (let i = 0; i < referenceSources.length; i++) append(sources, referenceSources[i]!);
      append(limits, {
        quantity: req.quantity,
        unit: req.unit,
        param: req.param,
        min: a.min as number,
        max: a.max as number,
        proposedBy: "operator",
        sources,
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
        ask(req.why, `The references give ${describeBound({ min, max }, req.unit)} for ${toLowerCase(req.label)}. What is the ${missing} it may be?`);
        continue;
      }
      append(limits, { quantity: req.quantity, unit: req.unit, param: req.param, min, max, proposedBy: "reference", sources: referenceSources });
      continue;
    }
    ask(req.why, `What is ${range}?`);
  }

  const commandMap = input.commandMap ?? null;
  if (commandMap === null) {
    append(questions, {
      about: "command-map",
      ask: "The adapter must declare its commands, and which parameters set which quantities.",
      why: "the runtime refuses anything outside the declared command surface; it cannot be guessed",
    });
  } else {
    // One question per quantity no declared parameter sets. The operator adds the
    // parameter that sets it, or confirms it device-controlled and how its limit is
    // enforced. Its limit stays required either way: "no command sets it" is not
    // "the device cannot cause it" (astra pack 173).
    const gaps = commandMapGaps(commandMap, template);
    for (let i = 0; i < gaps.length; i++) {
      append(questions, {
        about: `device-controlled:${gaps[i]!}`,
        ask: `No declared command parameter sets ${gaps[i]!}. Add the parameter that sets it to the command map, or confirm it as device-controlled and say how its limit is enforced: by telemetry, or by an independent cutoff. Its limit is still required. If the device physically lacks it, choose the device class without it.`,
        why: "a limit no parameter maps to cannot be checked at dispatch, so it must be enforced another way, never dropped",
      });
    }
  }

  const eStop = input.intake.eStop ?? null;
  if (eStop === null) {
    append(questions, { about: "e-stop", ask: "How is this device stopped in an emergency?", why: "every device needs a declared stop" });
  } else if (!includesValue(ESTOP_MECHANISMS, eStop.mechanism)) {
    throw new EnvelopeRefused([`intake.eStop.mechanism ${quoted(eStop.mechanism)} is not hardware, adapter-stop or none`]);
  } else if (eStop.mechanism === "none" && template.movesOrHeats) {
    append(questions, {
      about: "e-stop",
      ask: "This device moves or heats, and no emergency stop was declared. How is it stopped?",
      why: "a device that moves or heats cannot be confirmed without an e-stop",
    });
  } else if (eStop.mechanism === "adapter-stop" && !nonEmpty(eStop.stopCommand)) {
    append(questions, { about: "e-stop", ask: "Which adapter command stops the device?", why: "an adapter stop needs its command" });
  } else if (eStop.mechanism === "adapter-stop" && commandMap !== null && !includesValue(declaredCommands(commandMap), eStop.stopCommand)) {
    append(questions, {
      about: "e-stop",
      ask: `The stop command ${JSONStringify(eStop.stopCommand)} is not one of the adapter's declared commands. Which declared command stops the device?`,
      why: "a stop the runtime cannot send is no stop",
    });
  }

  const rate = input.intake.maxCommandsPerMinute;
  if (rate === undefined) {
    append(questions, {
      about: "command-rate",
      ask: "How many commands per minute may be sent to this device at most?",
      why: "the runtime check rate-limits commands; the operator sets the limit",
    });
  } else if (!NumberIsInteger(rate) || rate < 1) {
    throw new EnvelopeRefused([`intake.maxCommandsPerMinute must be an integer >= 1 (got ${text(rate)})`]);
  }

  const supervision = input.intake.supervision ?? null;
  if (supervision === null) {
    append(questions, {
      about: "supervision",
      ask: "Who watches this device while it runs: attended, unattended, or remote-supervised?",
      why: "how the device is supervised is the operator's to state",
    });
  } else if (supervisionProblem(supervision)) {
    throw new EnvelopeRefused([`intake.${supervisionProblem(supervision)}`]);
  } else if (supervision === "unattended" && template.movesOrHeats) {
    append(questions, {
      about: "supervision",
      ask: "This device moves or heats, and v1 does not allow it to run unattended. Attended, or remote-supervised?",
      why: supervisionPolicyProblem(supervision, eStop, template) as string,
    });
  } else if (supervision === "remote-supervised" && eStop !== null && eStop.mechanism !== "adapter-stop") {
    append(questions, {
      about: "e-stop",
      ask: "Remote supervision needs a stop the supervisor can trigger remotely. Which adapter command stops the device?",
      why: supervisionPolicyProblem(supervision, eStop, template) as string,
    });
  }

  const givenHazards = input.intake.hazards;
  if (givenHazards === undefined) {
    append(questions, {
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
  /**
   * The required quantities no parameter of the confirmed command map sets,
   * which the device can still cause (its firmware, a fixed program, a stored
   * method): exactly those quantities, never the deadline. Each keeps its limit
   * and states how that limit is enforced (astra pack 173).
   */
  deviceControlled?: DeviceControlledQuantity[];
}

/** How a device-controlled quantity's limit is enforced, since no command can set it. */
export type DeviceControlEnforcement = "telemetry" | "cutoff";

/** The enforcement kinds, frozen. */
export const DEVICE_CONTROL_ENFORCEMENTS: readonly DeviceControlEnforcement[] = deepFreeze(["telemetry", "cutoff"] as DeviceControlEnforcement[]);

/**
 * A required quantity no command sets but the device can cause. Its limit is
 * still required and still enforced:
 *   - "telemetry": the runtime reads it during the job and stops the job when
 *     it leaves the limit; a runtime with no such reading refuses the job;
 *   - "cutoff": an independent interlock bounds it (a thermostat, a fuse, a
 *     firmware-fixed program), which `detail` names.
 * Physical absence is never declared here: only a template that does not list
 * the quantity makes it absent.
 */
export interface DeviceControlledQuantity {
  quantity: string;
  enforcement: DeviceControlEnforcement;
  /** The telemetry channel or the cutoff, in the operator's words; committed. */
  detail: string;
}

/** The part of a confirmed envelope the digest commits, including who confirmed it and when. */
export interface SafetyEnvelopeBody {
  envelopeVersion: 1;
  deviceClass: string;
  device: DeviceIdentity;
  /** In template order, one per required quantity: a device-controlled quantity keeps its limit too. */
  limits: EnvelopeLimit[];
  eStop: EStopDeclaration;
  maxCommandsPerMinute: number;
  supervision: Supervision;
  /** In canonical order; empty means the operator said none. */
  hazards: Hazard[];
  commandMap: CommandMapV1;
  /**
   * The required quantities no declared parameter sets, as the operator
   * confirmed them device-controlled, in template order. Omitted when there are
   * none, so an envelope whose map sets every quantity commits exactly what it
   * did before this field existed.
   */
  deviceControlled?: DeviceControlledQuantity[];
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
      if (!nonEmpty(source.retrievedAt) || !NumberIsFinite(DateParse(source.retrievedAt))) return "a reference source needs a valid retrievedAt";
      if (source.unit !== unit) return `a reference source must cite the limit's unit ${unit} (got ${JSONStringify(source.unit)})`;
      const bound = boundProblem(source.value);
      if (bound) return `a reference source ${bound}`;
      if (extraKeys(source.value as Record<string, unknown>, ["min", "max"]).length > 0) return "a reference source's value holds only min and max";
      return null;
    }
    case "override": {
      if (extraKeys(source, ["kind", "reason", "overrides"]).length > 0) return "an override source holds only kind, reason and overrides";
      if (!nonEmpty(source.reason)) return "an override needs the operator's reason";
      if (!ArrayIsArray(source.overrides) || (source.overrides as unknown[]).length === 0) return "an override must name the citations it overrides";
      const overrides = source.overrides as unknown[];
      for (let i = 0; i < overrides.length; i++) {
        const problem = citationProblem(overrides[i]);
        if (problem) return `an override ${problem}`;
      }
      return null;
    }
    default:
      return `a source of kind ${quoted(source.kind)} is not operator, reference or override`;
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
  if (!ArrayIsArray(sources) || (sources as unknown[]).length === 0) return [`${quantity}: a limit must name its sources`];
  const typed = sources as LimitSource[];
  for (let i = 0; i < typed.length; i++) {
    const problem = sourceProblem(typed[i], unit);
    if (problem) return [`${quantity}: ${problem}`];
  }
  let operators = 0;
  const references = newList<Extract<LimitSource, { kind: "reference" }>>(0);
  const overrides = newList<Extract<LimitSource, { kind: "override" }>>(0);
  for (let i = 0; i < typed.length; i++) {
    const source = typed[i]!;
    if (source.kind === "operator") operators++;
    else if (source.kind === "reference") append(references, source);
    else append(overrides, source);
  }
  const bound = tightestBound(mapList(references, (r) => r.value));
  const min = limit.min as number;
  const max = limit.max as number;
  if (limit.proposedBy === "reference") {
    if (operators > 0 || overrides.length > 0 || references.length === 0) {
      return [`${quantity}: a limit a reference proposed must come from references alone`];
    }
    if (bound.min !== min || bound.max !== max) {
      return [`${quantity}: a limit a reference proposed must be exactly the bound its references cite (${bound.min === undefined && bound.max === undefined ? "none" : describeBound(bound, unit)}), not ${min}..${max} ${unit}`];
    }
    return [];
  }
  const problems = newList<string>(0);
  if (operators !== 1) append(problems, `${quantity}: an operator's limit names exactly one operator source`);
  const loosens = (bound.min !== undefined && min < bound.min) || (bound.max !== undefined && max > bound.max);
  if (loosens && overrides.length !== 1) {
    append(problems, `${quantity}: ${min}..${max} ${unit} loosens the cited bound ${describeBound(bound, unit)}, so it must carry exactly one override with the operator's reason`);
  } else if (loosens && canonicalJson(overrides[0]!.overrides) !== canonicalJson(mapList(references, (r) => r.citation))) {
    append(problems, `${quantity}: the override must name exactly the cited references, in order`);
  } else if (!loosens && overrides.length > 0) {
    append(problems, `${quantity}: an override is recorded, but ${min}..${max} ${unit} loosens no cited bound`);
  }
  return problems;
}

const BODY_KEYS: readonly string[] = deepFreeze(["envelopeVersion", "deviceClass", "device", "limits", "eStop", "maxCommandsPerMinute", "supervision", "hazards", "commandMap", "deviceControlled", "confirmation"]);
const LIMIT_KEYS: readonly string[] = deepFreeze(["quantity", "unit", "param", "min", "max", "proposedBy", "sources"]);
const DEVICE_KEYS: readonly string[] = deepFreeze(["deviceId", "adapterType", "adapterVersion", "vendor", "model"]);

/**
 * Every rule a confirmed body must meet, whoever built it. Confirm runs it on
 * the body it produces, and both compilers run it on the body they are given,
 * so a hand-built body that matches its registered digest still passes only
 * what confirm would. Every shape is closed: a key the body does not define
 * is refused, never committed and ignored.
 */
export function confirmedBodyProblems(envelope: SafetyEnvelopeBody): string[] {
  const problems = newList<string>(0);
  if (!isRecord(envelope)) return ["the envelope is not an object"];
  const template = templateOf(envelope.deviceClass);
  if (!template) return [`unknown deviceClass ${quoted(envelope.deviceClass)}`];
  const extra = extraKeys(envelope, BODY_KEYS);
  if (extra.length > 0) append(problems, `the envelope holds keys it does not define: ${joinStrings(extra, ", ")}`);
  if (envelope.envelopeVersion !== 1) append(problems, "envelopeVersion must be 1");
  const device = (isRecord(envelope.device) ? envelope.device : ObjectCreate(null)) as Record<string, unknown>;
  if (!nonEmpty(device.deviceId)) append(problems, "device.deviceId is required");
  if (!nonEmpty(device.adapterType)) append(problems, "device.adapterType is required");
  if (!isAdapterManifestDigest(device.adapterVersion)) {
    append(problems, "device.adapterVersion must be the adapter's manifest digest, sha256: + 64 lowercase hex");
  }
  if (device.vendor !== undefined && !nonEmpty(device.vendor)) append(problems, "device.vendor, when given, must not be blank");
  if (device.model !== undefined && !nonEmpty(device.model)) append(problems, "device.model, when given, must not be blank");
  if (extraKeys(device, DEVICE_KEYS).length > 0) {
    append(problems, "device holds only deviceId, adapterType, adapterVersion, vendor and model");
  }
  const confirmation = (isRecord(envelope.confirmation) ? envelope.confirmation : ObjectCreate(null)) as Record<string, unknown>;
  if (!nonEmpty(confirmation.confirmedBy)) append(problems, "confirmedBy is required");
  if (!nonEmpty(confirmation.confirmedAt) || !NumberIsFinite(DateParse(confirmation.confirmedAt as string))) {
    append(problems, "confirmedAt must be an ISO-8601 time");
  }
  if (extraKeys(confirmation, ["confirmedBy", "confirmedAt"]).length > 0) append(problems, "confirmation holds only confirmedBy and confirmedAt");
  let controlled: readonly string[] = NO_QUANTITIES;
  if (hasOwn(envelope, "deviceControlled")) {
    const shape = deviceControlledProblem(envelope.deviceControlled, template, false);
    if (shape) append(problems, shape);
    else controlled = controlledQuantities(envelope.deviceControlled as DeviceControlledQuantity[]);
  }
  if (!ArrayIsArray(envelope.limits) || envelope.limits.length !== template.requires.length) {
    append(problems, `limits must hold exactly one limit per required quantity, in template order (${joinStrings(mapList(template.requires, (r) => r.quantity), ", ")})`);
  } else {
    for (let i = 0; i < template.requires.length; i++) {
      const req = template.requires[i]!;
      const limit: unknown = envelope.limits[i];
      if (!isRecord(limit) || limit.quantity !== req.quantity) {
        append(problems, `limit ${i} must be ${req.quantity}`);
        continue;
      }
      if (extraKeys(limit, LIMIT_KEYS).length > 0) append(problems, `${req.quantity}: a limit holds only ${joinStrings(LIMIT_KEYS, ", ")}`);
      if (limit.unit !== req.unit || !inSet(UNITS, limit.unit)) append(problems, `${req.quantity} must be in ${req.unit} (got ${JSONStringify(limit.unit)})`);
      if (limit.param !== req.param) append(problems, `${req.quantity} must bound the parameter ${req.param}`);
      const range = rangeProblem(limit.min, limit.max);
      if (range) append(problems, `${req.quantity}: ${range}`);
      if (limit.proposedBy !== "operator" && limit.proposedBy !== "reference") append(problems, `${req.quantity}: proposedBy must be operator or reference`);
      else if (!range) {
        const provenance = provenanceProblems(limit, req.quantity, req.unit);
        for (let j = 0; j < provenance.length; j++) append(problems, provenance[j]!);
      }
    }
  }
  if (isRecord(envelope.eStop) && extraKeys(envelope.eStop, envelope.eStop.mechanism === "adapter-stop" ? ["mechanism", "stopCommand"] : ["mechanism"]).length > 0) {
    append(problems, "eStop holds only its mechanism, and an adapter stop's command");
  }
  const stop = eStopProblem(envelope.eStop, template, envelope.commandMap);
  if (stop) append(problems, stop);
  const rate = rateProblem(envelope.maxCommandsPerMinute);
  if (rate) append(problems, rate);
  const supervision = supervisionProblem(envelope.supervision);
  if (supervision) append(problems, supervision);
  const hazards = hazardsProblem(envelope.hazards);
  if (hazards) append(problems, hazards);
  const hazardsOrder = hazardsCanonicalProblem(envelope.hazards);
  if (hazardsOrder) append(problems, hazardsOrder);
  const policy = supervisionPolicyProblem(envelope.supervision, envelope.eStop, template);
  if (policy) append(problems, policy);
  const map = commandMapProblem(envelope.commandMap, template);
  if (map) append(problems, `commandMap: ${map}`);
  else {
    const coverage = coverageProblem(commandMapGaps(envelope.commandMap, template), controlled);
    if (coverage) append(problems, `commandMap: ${coverage}`);
    if (ArrayIsArray(envelope.limits)) {
      const enumerated = enumeratedProblems(envelope.commandMap, envelope.limits);
      for (let i = 0; i < enumerated.length; i++) append(problems, `commandMap: ${enumerated[i]!}`);
    }
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
  const reasons = newList<string>(0);
  const template = templateOf(draft.deviceClass);
  if (!template) throw new EnvelopeRefused([`unknown deviceClass ${quoted(draft.deviceClass)}`]);
  if (!nonEmpty(decision.confirmedBy)) append(reasons, "confirmedBy is required");
  if (!nonEmpty(decision.confirmedAt) || !NumberIsFinite(DateParse(decision.confirmedAt))) {
    append(reasons, "confirmedAt must be an ISO-8601 time");
  }

  // Keyed by quantity, with no prototype: a lookup never reads an inherited value.
  const bounds = ObjectCreate(null) as Record<string, ReferenceBound>;
  for (let i = 0; i < draft.referenceBounds.length; i++) bounds[draft.referenceBounds[i]!.quantity] = draft.referenceBounds[i]!;
  const limits = ObjectCreate(null) as Record<string, EnvelopeLimit>;
  for (let i = 0; i < draft.limits.length; i++) limits[draft.limits[i]!.quantity] = draft.limits[i]!;
  const answered = newList<string>(0);
  const edited = newList<string>(0);
  const edits = decision.edits ?? newList<EnvelopeEdit>(0);
  for (let e = 0; e < edits.length; e++) {
    const edit = edits[e]!;
    let req: QuantityRequirement | undefined;
    for (let i = 0; i < template.requires.length; i++) if (template.requires[i]!.quantity === edit.quantity) req = template.requires[i];
    if (!req) {
      append(reasons, `edit for ${JSONStringify(edit.quantity)}: not a quantity this device class bounds`);
      continue;
    }
    if (includesValue(edited, edit.quantity)) {
      append(reasons, `edit for ${edit.quantity}: given twice; one confirmation states one range`);
      continue;
    }
    append(edited, edit.quantity);
    const problem = rangeProblem(edit.min, edit.max);
    if (problem) {
      append(reasons, `edit for ${edit.quantity}: ${problem}`);
      continue;
    }
    const bound = hasOwn(bounds, edit.quantity) ? bounds[edit.quantity] : undefined;
    // Own sides only: a side the references do not give is never read through a prototype.
    const boundMin = bound !== undefined && hasOwn(bound, "min") ? bound.min : undefined;
    const boundMax = bound !== undefined && hasOwn(bound, "max") ? bound.max : undefined;
    const loosens = bound !== undefined && ((boundMin !== undefined && edit.min < boundMin) || (boundMax !== undefined && edit.max > boundMax));
    if (loosens && !nonEmpty(edit.override?.reason)) {
      append(
        reasons,
        `edit for ${edit.quantity}: ${edit.min}..${edit.max} ${req.unit} loosens the cited bound ${describeBound(bound, req.unit)}; an override needs a reason`,
      );
      continue;
    }
    const boundSources = bound?.sources ?? newList<LimitSource>(0);
    const citations = newList<Citation>(0);
    for (let i = 0; i < boundSources.length; i++) {
      const source = boundSources[i]!;
      if (source.kind === "reference") append(citations, source.citation);
    }
    const sources = newList<LimitSource>(0);
    append(sources, { kind: "operator", field: "confirmation" });
    for (let i = 0; i < boundSources.length; i++) append(sources, boundSources[i]!);
    if (loosens) append(sources, { kind: "override", reason: (edit.override as { reason: string }).reason, overrides: citations });
    limits[edit.quantity] = {
      quantity: req.quantity,
      unit: req.unit,
      param: req.param,
      min: edit.min,
      max: edit.max,
      proposedBy: "operator",
      sources,
    };
    append(answered, edit.quantity);
  }

  // The quantities the operator confirms device-controlled: no declared parameter sets them, but the
  // device can still cause them, so each keeps its limit and names how that limit is enforced
  // (astra pack 173). Each answers its coverage question; its limit question still needs an answer.
  const controlled = newList<DeviceControlledQuantity>(0);
  const declared: unknown = decision.deviceControlled;
  if (declared !== undefined) {
    const gaps = draft.commandMap === null ? newList<string>(0) : commandMapGaps(draft.commandMap, template);
    const quantities = mapList(template.requires, (r) => r.quantity);
    if (!ArrayIsArray(declared)) append(reasons, "deviceControlled must be a list of {quantity, enforcement, detail}");
    else {
      for (let i = 0; i < declared.length; i++) {
        const entry: unknown = declared[i];
        if (!isRecord(entry) || extraKeys(entry, DEVICE_CONTROLLED_KEYS).length > 0) {
          append(reasons, "each deviceControlled entry is exactly {quantity, enforcement, detail}");
          continue;
        }
        const quantity: unknown = entry.quantity;
        if (typeof quantity !== "string" || !includesValue(quantities, quantity)) {
          append(reasons, `deviceControlled names ${quoted(quantity)}, which is not a quantity of a ${template.id}`);
        } else if (quantity === template.deadline) {
          append(reasons, `deviceControlled names the deadline ${quantity}: the runtime stops a job on its elapsed time`);
        } else if (includesValue(controlledQuantities(controlled), quantity)) {
          append(reasons, `deviceControlled names ${quantity} twice`);
        } else if (!includesValue(gaps, quantity)) {
          append(reasons, `deviceControlled names ${quantity}, but a declared parameter sets it`);
        } else if (!includesValue(DEVICE_CONTROL_ENFORCEMENTS, entry.enforcement)) {
          append(reasons, `${quantity}: enforcement must be "telemetry" or "cutoff"`);
        } else if (!nonEmpty(entry.detail)) {
          append(reasons, `${quantity}: a device-controlled quantity needs a detail naming its telemetry channel or its cutoff`);
        } else {
          append(controlled, { quantity, enforcement: entry.enforcement as DeviceControlEnforcement, detail: entry.detail });
          append(answered, `device-controlled:${quantity}`);
        }
      }
    }
  }

  const eStop = decision.eStop ?? draft.eStop;
  if (decision.eStop) append(answered, "e-stop");
  const rate = decision.maxCommandsPerMinute ?? draft.maxCommandsPerMinute;
  if (decision.maxCommandsPerMinute !== undefined) append(answered, "command-rate");
  const supervision = decision.supervision ?? draft.supervision;
  if (decision.supervision !== undefined) append(answered, "supervision");
  const hazards = decision.hazards ?? draft.hazards;
  if (decision.hazards !== undefined) append(answered, "hazards");

  for (let i = 0; i < draft.questions.length; i++) {
    const q = draft.questions[i]!;
    if (!includesValue(answered, q.about)) append(reasons, `unanswered: ${q.ask}`);
  }
  for (let i = 0; i < template.requires.length; i++) {
    if (!hasOwn(limits, template.requires[i]!.quantity)) append(reasons, `no confirmed limit for ${template.requires[i]!.quantity}`);
  }
  if (draft.commandMap === null) append(reasons, "the adapter has not declared its commands; draft again with its command map");
  const stopProblem = eStopProblem(eStop, template, draft.commandMap);
  if (stopProblem) append(reasons, stopProblem);
  const rateIssue = rateProblem(rate);
  if (rateIssue) append(reasons, rateIssue);
  const supervisionIssue = supervisionProblem(supervision);
  if (supervisionIssue) append(reasons, supervisionIssue);
  const hazardsIssue = hazardsProblem(hazards);
  if (hazardsIssue) append(reasons, hazardsIssue);
  if (reasons.length > 0 || !eStop || !hazards || !draft.commandMap) throw new EnvelopeRefused(reasons);

  const envelope: SafetyEnvelopeBody = {
    envelopeVersion: 1,
    deviceClass: draft.deviceClass,
    device: { ...draft.device },
    limits: mapList(template.requires, (r) => limits[r.quantity]!),
    // Only the declaration's own fields are committed.
    eStop: {
      mechanism: eStop.mechanism,
      ...(eStop.mechanism === "adapter-stop" ? { stopCommand: eStop.stopCommand } : {}),
    },
    maxCommandsPerMinute: rate as number,
    supervision: supervision as Supervision,
    hazards: canonicalHazards(hazards),
    commandMap: draft.commandMap,
    // In template order, and only when there is one: the digest of every other envelope is unchanged.
    ...(controlled.length > 0 ? { deviceControlled: inTemplateOrder(controlled, template) } : {}),
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
  const problems = newList<string>(0);
  if (!nonEmpty(statement.deviceId)) append(problems, "the registration needs the deviceId");
  if (!isSafetyEnvelopeDigest(statement.envelopeDigest)) {
    append(problems, "the registration's envelopeDigest must be 0x + 64 lowercase hex");
  }
  if (!nonEmpty(statement.registeredAt) || !NumberIsFinite(DateParse(statement.registeredAt))) {
    append(problems, "the registration's registeredAt must be an ISO-8601 time");
  }
  return problems;
}

function statementDigestOf(statement: Record<string, unknown>): SHA256 {
  const canonical = canonicalJson({
    domain: SAFETY_ENVELOPE_REGISTRATION_DOMAIN,
    deviceId: statement.deviceId,
    envelopeDigest: statement.envelopeDigest,
    registeredAt: statement.registeredAt,
  });
  return `sha256:${sha256Hex(canonical)}` as SHA256;
}

/**
 * LO-EV-1's signing preimage of a tagged digest: its UTF-8, the 71 bytes of
 * `sha256:` + 64 lowercase hex (`signingPreimage` in evidence/signing-preimage.ts),
 * built from intrinsics captured at load.
 */
function taggedDigestPreimage(tagged: string): Uint8Array {
  const bytes = isTaggedSha256(tagged) ? asciiBytes(tagged) : null;
  if (bytes === null) throw new EnvelopeRefused([`not a tagged sha256 digest: ${quoted(tagged)}`]);
  return bytes;
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
  return taggedDigestPreimage(registrationStatementDigest(statement));
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
  const signature = fixedHexBytes(record.signature, 64);
  if (signature === null) {
    throw new EnvelopeRefused(["the registration's signature is not an Ed25519 signature (128 hex characters)"]);
  }
  let verified = false;
  try {
    verified = verifyRegistration(taggedDigestPreimage(statementDigestOf(record)), signature) === true;
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
 * It reads only the snapshot it checked, never `confirmed` again, and builds
 * every array by index from intrinsics captured at load, so a prototype
 * method replaced after load cannot change an emitted value (astra pack 164).
 * The result is frozen.
 */
export function compileSafetyEnvelope(
  confirmed: ConfirmedSafetyEnvelope,
  registration: SafetyEnvelopeRegistration,
  verifyRegistration: RegistrationVerifier,
): CompiledSafetyEnvelope {
  const { body: envelope, digest: committedDigest } = committedSnapshot(confirmed, registration, verifyRegistration);
  const template = templateOf(envelope.deviceClass)!;

  // One job input per command-settable quantity. A device-controlled quantity keeps its limit, in the
  // conformance evidence below, but no command sets it, so a job cannot ask for it (astra pack 173).
  const controlled = controlledQuantities(envelope.deviceControlled ?? NO_DEVICE_CONTROLLED);
  const inputs = newList<number>(0);
  for (let i = 0; i < template.requires.length; i++) if (!includesValue(controlled, template.requires[i]!.quantity)) append(inputs, i);
  const parameters = mapList(inputs, (i): CsdParameter => {
    const req = template.requires[i]!;
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
  const definitions = mapList(inputs, (i): ParameterDefinition => {
    const req = template.requires[i]!;
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

  return deepFreeze({
    parameters,
    evidence: {
      "envelope-conformance": {
        description: `The job's signals stayed inside the operator-confirmed safety envelope ${committedDigest}.`,
        required: ["telemetry within the confirmed limits"],
        primitives: [
          {
            id: "telemetry.envelope_conformance",
            params: { envelope: mapList(envelope.limits, (l) => ({ metric: l.quantity, unit: l.unit, min: l.min, max: l.max })) },
          },
        ],
      },
    },
    composition: { parameters: definitions, outputPorts: { ...template.outputPorts } },
    envelopeDigest: committedDigest as SafetyEnvelopeDigest,
  });
}

/** The time units a deadline quantity may use (for the runtime schema). */
export function isTimeUnit(unit: unknown): boolean {
  return inSet(TIME_UNITS, unit);
}

/** The v1 supervision policy, exported for the runtime schema. */
export function supervisionPolicy(
  supervision: unknown,
  eStop: EStopDeclaration | null | undefined,
  deviceClass: string,
): string | null {
  const template = templateOf(deviceClass);
  return template ? supervisionPolicyProblem(supervision, eStop, template) : null;
}

/**
 * Why a command map is malformed for a known class, or disagrees with
 * `deviceControlled` about which required quantities it sets; null when it is complete.
 */
export function commandMapIssue(commandMap: unknown, deviceClass: string, deviceControlled: readonly string[] = NO_QUANTITIES): string | null {
  const template = templateOf(deviceClass);
  if (!template) return `unknown deviceClass ${quoted(deviceClass)}`;
  const problem = commandMapProblem(commandMap, template);
  if (problem) return problem;
  return coverageProblem(commandMapGaps(commandMap as CommandMapV1, template), deviceControlled);
}

/**
 * Why a runtime envelope's `deviceControlled` list is malformed for a known
 * class, or null. Unlike a confirmed body's, it is always present, and empty
 * when the map sets every required quantity.
 */
export function deviceControlledIssue(deviceControlled: unknown, deviceClass: string): string | null {
  const template = templateOf(deviceClass);
  if (!template) return `unknown deviceClass ${quoted(deviceClass)}`;
  return deviceControlledProblem(deviceControlled, template, true);
}

/** Why an enumerated physical parameter of `commandMap` allows a value outside its limit in `limits`; empty when none does. */
export function enumeratedLimitIssues(commandMap: CommandMapV1, limits: readonly unknown[]): string[] {
  return enumeratedProblems(commandMap, limits);
}

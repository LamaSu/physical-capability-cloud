/**
 * The reference runtime check of OperationalEnvelopeV1 (N86 part 2; the
 * runtime half of R8's HIGH 8 and 9). `operational-envelope.ts` states a
 * STRICT consumer contract that two runtimes enforce at command dispatch, the
 * kernel's SafetyGovernor (TypeScript) and pcc-node (Python). This is that
 * contract as ONE pure function: the governor calls it, and pcc-node proves
 * parity against `fixtures/onboarding/envelope-runtime-check-v1.json`.
 *
 * `checkRuntimeCommand(envelope, command, state)` checks, in this order, and
 * the first failure decides. `code` is the stable cross-language identifier;
 * `reason` is a human message and is not part of the contract.
 *   1. envelope-invalid: the envelope is not a valid OperationalEnvelopeV1.
 *   2. state-invalid: the runtime's state is malformed.
 *   3. adapter-mismatch: the running adapter is not the one the envelope commits.
 *   4. command-malformed: the command is not plain data exactly {name, params}.
 *   5. unknown-command: the command is not in `envelope.commands`.
 *   6. The stop (`eStop.stopCommand` of an adapter stop), sent through THIS
 *      ordinary dispatch check, skips 7 and 8 (the deadline and the rate). It is
 *      still held to 1 to 5 and 9 to 12, so a stop to an unverified adapter, or
 *      under unreadable time, is refused here. A genuine EMERGENCY stop never
 *      comes through this check: see `emergencyStopOf` (astra pack 174).
 *   7. past-deadline: the job has run longer than the deadline limit's max.
 *   8. rate-limited: `maxCommandsPerMinute` were already sent in (now - 60 s, now].
 *   9. undeclared-param, 10. missing-param: the params are exactly the declared ones.
 *  11. not-a-number, out-of-range, value-not-allowed: a parameter that sets a
 *      quantity carries a finite number inside its limit's [min, max], 0 a real
 *      bound, no unit conversion; an enumerated physical parameter (`allowed`)
 *      carries one of its listed values.
 *  12. value-not-allowed: an unbounded parameter carries one of `allowed`, or a
 *      non-empty list of distinct items from `allowedItems`.
 *
 * Authority (astra packs 164 and 167). The decision depends only on this
 * module, R8's captured-intrinsic helpers, and intrinsics `primordials.ts`
 * captured at load, never on a method looked up at call time, and never on a
 * retained mutable object reachable after load:
 *   - zod is not consulted. It is third-party code that calls ambient methods,
 *     and a schema is a mutable object reachable after load. Rule 1 checks the
 *     envelope structurally, field by field. On plain JSON data the tests show
 *     it accepts and refuses exactly what OperationalEnvelopeV1Schema does.
 *     Beyond plain JSON it reads the plain copy: a proxy or an accessor is
 *     refused, and a member whose value is undefined is dropped, as JSON would
 *     drop it (astra pack 174).
 *   - No RegExp: one can be recompiled in place, even frozen
 *     (RegExp.prototype.compile, Annex B). Digests are checked by R8's
 *     structural predicates, code unit by code unit.
 *   - Each input is read once, as a plain frozen copy, through property
 *     descriptors, so no getter, proxy trap or other code supplied with it runs.
 *     Internal records have a null prototype, so a value written onto
 *     Object.prototype is never read as theirs.
 * The boundary, named honestly (astra pack 169): rule 1 checks the envelope's
 * structure. "That validation establishes structure, not authority; trusted
 * delivery or registry commitment remains separately necessary." The runtime
 * must obtain the envelope from the registry's signed registration (R8's
 * compileOperationalEnvelope), never from the party issuing commands. And a
 * realm whose intrinsics were replaced BEFORE `primordials.ts` loaded is
 * beyond any in-process check.
 *
 * Time (astra pack 174). Every time in the state is an epoch millisecond: a
 * safe integer, so no subtraction overflows. A send time after `nowMs` is
 * refused as state-invalid, never ignored: a clock that stepped back must not
 * open the rate window.
 *
 * The emergency stop is not this check. A genuine emergency stop must never be
 * refused because the clock is wrong, the rate is spent, or ordinary
 * authorization state is unavailable. The governor keeps a dedicated stop path
 * that invokes the active adapter's pre-wired stop primitive directly, and that
 * escalates to the hardware stop or watchdog when the adapter's identity cannot
 * be trusted, instead of sending an envelope command through an unknown adapter.
 * `emergencyStopOf(envelope)` tells it which primitive the envelope pre-wired.
 *
 * Pure: it never reads a clock (the runtime passes the times in), performs no
 * I/O, and never throws for any input.
 */

import type { OperationalEnvelopeV1 } from "./operational-envelope.js";
import {
  commandMapIssue,
  deviceControlledIssue,
  enumeratedLimitIssues,
  DEVICE_CLASS_TEMPLATES,
  HAZARDS,
  isAdapterManifestDigest,
  isSafetyEnvelopeDigest,
  isTimeUnit,
  supervisionPolicy,
  SUPERVISION_MODES,
  type DeviceClassTemplate,
  type EStopDeclaration,
} from "./safety-envelope.js";
import {
  append,
  ArrayIsArray,
  ArrayPrototype,
  deepFreeze,
  defineIndex,
  filterList,
  hasOwn,
  includesValue,
  isProxy,
  joinStrings,
  JSONStringify,
  mapList,
  newList,
  NumberIsFinite,
  NumberIsInteger,
  ObjectCreate,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectGetPrototypeOf,
  ObjectIs,
  ObjectKeys,
  ObjectPrototype,
  quoted,
  text,
  trim,
} from "./primordials.js";

export interface RuntimeCommand {
  name: string;
  params: Record<string, unknown>;
}

export interface RuntimeState {
  /** The running adapter's release manifest digest (sha256:<64 hex>), as the runtime computed it. */
  adapterManifestDigest: string;
  /** When the current job started, and now: epoch milliseconds, from the runtime's clock. */
  jobStartedAtMs: number;
  nowMs: number;
  /** When each command already sent to this device was sent (epoch ms), any order, any length. */
  recentCommandsAtMs: readonly number[];
}

export type RuntimeRefusalCode =
  | "envelope-invalid"
  | "adapter-mismatch"
  | "state-invalid"
  | "command-malformed"
  | "unknown-command"
  | "undeclared-param"
  | "missing-param"
  | "not-a-number"
  | "out-of-range"
  | "value-not-allowed"
  | "past-deadline"
  | "rate-limited";

export type RuntimeDecision = { allowed: true } | { allowed: false; code: RuntimeRefusalCode; reason: string };

type Envelope = OperationalEnvelopeV1;
type CommandSpec = Envelope["commands"][number];
type ParamSpec = CommandSpec["params"][number];
type Unbounded = NonNullable<ParamSpec["unbounded"]>;
type Limit = Envelope["limits"][number];

const ALLOWED: RuntimeDecision = ObjectFreeze({ allowed: true as const });

function refuse(code: RuntimeRefusalCode, reason: string): RuntimeDecision {
  return ObjectFreeze({ allowed: false as const, code, reason });
}

/** The rate window: commands sent in (now - 60 s, now] count against `maxCommandsPerMinute`. */
const WINDOW_MS = 60000;

/** Milliseconds per deadline time unit (R8's isTimeUnit units); a null-prototype table, frozen at load. */
const MS_PER_TIME_UNIT: Readonly<Record<string, number>> = (() => {
  const table = ObjectCreate(null) as Record<string, number>;
  table.s = 1000;
  table.min = 60000;
  table.h = 3600000;
  return ObjectFreeze(table);
})();

/** A deadline unit in milliseconds, or NaN for a unit the table lacks: a deadline then refuses every command (rule 7). */
function msPerTimeUnit(unit: string): number {
  return hasOwn(MS_PER_TIME_UNIT, unit) ? MS_PER_TIME_UNIT[unit]! : NaN;
}

// ── Plain data, read once ───────────────────────────────────────────
// R8's plainCopy (safety-envelope.ts), copied here because R8 does not export it.

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
 * nesting deeper than 64. An undefined member is dropped, and -0 becomes 0.
 * Copied objects have a null prototype, and copied array elements are
 * installed as own data properties, so building the copy runs no inherited
 * setter either.
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

/** `value` as one frozen plain copy; throws NotPlainData when it is not plain JSON data. */
function frozenCopy(value: unknown, what: string): unknown {
  return deepFreeze(plainCopy(value, what, newList<object>(0), 0));
}

/** Why a copy failed, for the reason; reads nothing but our own NotPlainData. */
function notPlainReason(err: unknown, what: string): string {
  if (typeof err === "object" && err !== null && ObjectGetPrototypeOf(err) === NOT_PLAIN_DATA) {
    return `${(err as NotPlainData).message}: ${what} must be plain JSON data, and no code supplied with it may run`;
  }
  return `${what} could not be read as plain JSON data`;
}

// ── Small structural predicates ─────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !ArrayIsArray(v);
}

function nonBlank(v: unknown): v is string {
  return typeof v === "string" && trim(v).length > 0;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && NumberIsFinite(v);
}

/** Why `v` does not hold exactly `keys` (each present, nothing else), or null. */
function shapeProblem(v: Record<string, unknown>, keys: readonly string[], what: string): string | null {
  const own = ObjectKeys(v);
  for (let i = 0; i < own.length; i++) {
    if (!includesValue(keys, own[i])) return `${what} holds a key it does not define, ${quoted(own[i])}`;
  }
  for (let i = 0; i < keys.length; i++) {
    if (!hasOwn(v, keys[i]!)) return `${what} needs ${keys[i]!}`;
  }
  return null;
}

function templateOf(deviceClass: unknown): DeviceClassTemplate | undefined {
  return typeof deviceClass === "string" && hasOwn(DEVICE_CLASS_TEMPLATES, deviceClass) ? DEVICE_CLASS_TEMPLATES[deviceClass] : undefined;
}

/** The declared command named `name`, by index (names are unique in a valid envelope). */
function commandOf(commands: readonly CommandSpec[], name: unknown): CommandSpec | undefined {
  for (let i = 0; i < commands.length; i++) if (commands[i]!.name === name) return commands[i];
  return undefined;
}

function paramOf(params: readonly ParamSpec[], name: string): ParamSpec | undefined {
  for (let i = 0; i < params.length; i++) if (params[i]!.name === name) return params[i];
  return undefined;
}

function limitOf(limits: readonly Limit[], quantity: unknown): Limit | undefined {
  for (let i = 0; i < limits.length; i++) if (limits[i]!.quantity === quantity) return limits[i];
  return undefined;
}

/** A value as text for a reason, never calling a method on it. */
function describe(v: unknown): string {
  if (typeof v === "string") return JSONStringify(v);
  if (ArrayIsArray(v)) return `a list of ${v.length}`;
  return isRecord(v) ? "an object" : text(v);
}

// ── Rule 1: the envelope, structurally ──────────────────────────────

const ENVELOPE_KEYS: readonly string[] = deepFreeze([
  "envelopeVersion",
  "envelopeDigest",
  "deviceClass",
  "deviceId",
  "adapterType",
  "adapterVersion",
  "strict",
  "limits",
  "deviceControlled",
  "commands",
  "deadlineQuantity",
  "maxCommandsPerMinute",
  "eStop",
  "supervision",
  "hazards",
]);
const LIMIT_KEYS: readonly string[] = deepFreeze(["quantity", "unit", "min", "max"]);
const ADAPTER_STOP_KEYS: readonly string[] = deepFreeze(["mechanism", "stopCommand"]);
const MECHANISM_KEYS: readonly string[] = deepFreeze(["mechanism"]);

/** Exactly the template's quantities, in its order and units, each a finite [min, max] with min <= max. */
function limitsProblem(limits: unknown, template: DeviceClassTemplate): string | null {
  const required = template.requires;
  if (!ArrayIsArray(limits) || limits.length !== required.length) {
    return `limits must be exactly ${joinStrings(mapList(required, (r) => r.quantity), ", ")}, in that order`;
  }
  for (let i = 0; i < required.length; i++) {
    const limit: unknown = limits[i];
    const req = required[i]!;
    if (!isRecord(limit)) return `limit ${i} must be an object {quantity, unit, min, max}`;
    const shape = shapeProblem(limit, LIMIT_KEYS, `limit ${i}`);
    if (shape !== null) return shape;
    if (limit.quantity !== req.quantity) return `limit ${i} must be ${req.quantity}`;
    if (limit.unit !== req.unit) return `${req.quantity} is in ${req.unit}`;
    if (!finite(limit.min) || !finite(limit.max)) return `${req.quantity} needs a finite min and a finite max`;
    if (limit.min > limit.max) return `${req.quantity}: min must not be above max`;
  }
  return null;
}

/**
 * The e-stop union, closed per mechanism. An adapter stop names one of the
 * declared commands; a declared command's name is non-blank (commandMapIssue
 * checked it first), so a blank stopCommand is refused here too.
 */
function eStopProblem(eStop: unknown, commands: readonly CommandSpec[], template: DeviceClassTemplate): string | null {
  if (!isRecord(eStop)) return "eStop must be an object";
  const mechanism = eStop.mechanism;
  if (mechanism === "adapter-stop") {
    const shape = shapeProblem(eStop, ADAPTER_STOP_KEYS, "an adapter-stop eStop");
    if (shape !== null) return shape;
    if (commandOf(commands, eStop.stopCommand) === undefined) return "the stop command must be one of the declared commands";
    return null;
  }
  if (mechanism === "hardware" || mechanism === "none") {
    const shape = shapeProblem(eStop, MECHANISM_KEYS, `a ${mechanism} eStop`);
    if (shape !== null) return shape;
    if (mechanism === "none" && template.movesOrHeats) return "a device that moves or heats needs an e-stop";
    return null;
  }
  return `eStop mechanism ${quoted(mechanism)} is not hardware, adapter-stop or none`;
}

/** The confirmed hazards, each a known hazard, once, in canonical order (an empty list is the operator's none). */
function hazardsProblem(hazards: unknown): string | null {
  if (!ArrayIsArray(hazards)) return "hazards must be a list (an empty list is the operator's none)";
  const canonical = filterList(HAZARDS as readonly string[], (h) => includesValue(hazards, h));
  if (canonical.length !== hazards.length) return "hazards must each be a known hazard, listed once";
  for (let i = 0; i < canonical.length; i++) {
    if (canonical[i] !== hazards[i]) return "hazards must be in canonical order";
  }
  return null;
}

/**
 * Why `e` is not a valid OperationalEnvelopeV1, or null: every rule
 * OperationalEnvelopeV1Schema enforces (its fields, closed shapes and
 * superRefine), checked with captured intrinsics only. The command map is
 * R8's own rule, `commandMapIssue`, which the schema's superRefine also runs.
 */
function envelopeProblem(e: unknown): string | null {
  if (!isRecord(e)) return "it must be an object";
  const shape = shapeProblem(e, ENVELOPE_KEYS, "the envelope");
  if (shape !== null) return shape;
  if (e.envelopeVersion !== 1) return "envelopeVersion must be 1";
  if (!isSafetyEnvelopeDigest(e.envelopeDigest)) return "envelopeDigest must be 0x + 64 lowercase hex";
  if (!nonBlank(e.deviceId)) return "deviceId must not be blank";
  if (!nonBlank(e.adapterType)) return "adapterType must not be blank";
  if (!isAdapterManifestDigest(e.adapterVersion)) {
    return "adapterVersion must be sha256: + 64 lowercase hex (the adapter's manifest digest)";
  }
  if (e.strict !== true) return "strict must be true; v1 has no lenient mode";
  const rate = e.maxCommandsPerMinute;
  if (typeof rate !== "number" || !NumberIsInteger(rate) || rate < 1) return "maxCommandsPerMinute must be an integer >= 1";
  if (!includesValue(SUPERVISION_MODES, e.supervision)) {
    return `supervision ${quoted(e.supervision)} is not attended, unattended or remote-supervised`;
  }
  const template = templateOf(e.deviceClass);
  if (template === undefined) return `unknown deviceClass ${quoted(e.deviceClass)}`;
  const limits = limitsProblem(e.limits, template);
  if (limits !== null) return limits;
  const controlledIssue = deviceControlledIssue(e.deviceControlled, template.id);
  if (controlledIssue !== null) return controlledIssue;
  const controlled = mapList(e.deviceControlled as readonly { quantity: string }[], (d) => d.quantity);
  const map = ObjectCreate(null) as { commands: unknown };
  map.commands = e.commands;
  const commands = commandMapIssue(map, template.id, controlled);
  if (commands !== null) return `commands: ${commands}`;
  const enumerated = enumeratedLimitIssues(map as { commands: CommandSpec[] }, e.limits as readonly unknown[]);
  if (enumerated.length > 0) return `commands: ${enumerated[0]!}`;
  const stop = eStopProblem(e.eStop, e.commands as readonly CommandSpec[], template);
  if (stop !== null) return stop;
  const policy = supervisionPolicy(e.supervision, e.eStop as EStopDeclaration, template.id);
  if (policy !== null) return policy;
  const hazards = hazardsProblem(e.hazards);
  if (hazards !== null) return hazards;
  if (e.deadlineQuantity !== template.deadline) return `the deadline of a ${template.id} is ${template.deadline}`;
  const deadline = limitOf(e.limits as readonly Limit[], template.deadline);
  if (deadline === undefined || !isTimeUnit(deadline.unit)) return "the deadline must name a limit in s, min or h";
  return null;
}

// ── Rule 2: the runtime's state ─────────────────────────────────────

/** The largest integer a double holds exactly; epoch times stay inside it, so no difference of two overflows. */
const MAX_SAFE_MS = 9007199254740991;

/** An epoch millisecond: an integer within the safe range (astra pack 174: finite inputs must not overflow). */
function epochMs(v: unknown): v is number {
  return typeof v === "number" && NumberIsInteger(v) && v <= MAX_SAFE_MS && v >= -MAX_SAFE_MS;
}

function stateProblem(s: unknown): string | null {
  if (!isRecord(s)) return "the state must be an object";
  if (!isAdapterManifestDigest(s.adapterManifestDigest)) {
    return "adapterManifestDigest must be sha256: + 64 lowercase hex (the running adapter's manifest digest)";
  }
  if (!epochMs(s.jobStartedAtMs) || !epochMs(s.nowMs)) return "jobStartedAtMs and nowMs must be epoch milliseconds: safe integers";
  if (s.jobStartedAtMs > s.nowMs) return "jobStartedAtMs is after nowMs";
  const recent = s.recentCommandsAtMs;
  if (!ArrayIsArray(recent)) return "recentCommandsAtMs must be a list of epoch milliseconds";
  for (let i = 0; i < recent.length; i++) {
    const at: unknown = recent[i];
    if (!epochMs(at)) return `recentCommandsAtMs[${i}] must be an epoch millisecond: a safe integer`;
    // Refused, never ignored: a clock that stepped back would otherwise open the rate window (astra pack 174).
    if (at > s.nowMs) return `recentCommandsAtMs[${i}] is after nowMs: a send time in the future means the clock stepped back`;
  }
  return null;
}

// ── Rule 4: the command's shape ─────────────────────────────────────

const COMMAND_KEYS: readonly string[] = deepFreeze(["name", "params"]);

function commandProblem(c: unknown): string | null {
  if (!isRecord(c)) return "a command must be an object, exactly {name, params}";
  const shape = shapeProblem(c, COMMAND_KEYS, "a command");
  if (shape !== null) return shape;
  if (!nonBlank(c.name)) return "a command's name must be a non-blank string";
  if (!isRecord(c.params)) return "a command's params must be a plain object of parameter values";
  return null;
}

// ── Rule 12: what an unbounded parameter may carry ──────────────────

/**
 * True when `value` is `===` one of `allowed` (same type and value), or, when
 * `allowedItems` is given, a non-empty list of distinct items (by JSON), each
 * `===` one of `allowedItems`. The list is dense and has the standard
 * prototype: it is part of the plain copy. Membership is checked before
 * distinctness, so only strings and numbers are ever serialized.
 */
function carriesAllowed(unbounded: Unbounded, value: unknown): boolean {
  if (unbounded.allowed !== undefined && includesValue(unbounded.allowed, value)) return true;
  const items = unbounded.allowedItems;
  if (items === undefined || !ArrayIsArray(value) || value.length === 0) return false;
  const seen = newList<string>(0);
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (!includesValue(items, item)) return false;
    const key = JSONStringify(item);
    if (includesValue(seen, key)) return false;
    append(seen, key);
  }
  return true;
}

// ── The check ───────────────────────────────────────────────────────

/**
 * Whether the runtime may send `command` to the device `envelope` governs,
 * given the runtime's `state`. The first failing rule decides (see the module
 * comment). Pure: it never reads a clock and never throws.
 */
export function checkRuntimeCommand(envelope: unknown, command: unknown, state: unknown): RuntimeDecision {
  // 1. The envelope: one plain frozen copy, valid as OperationalEnvelopeV1.
  let env: Envelope;
  try {
    env = frozenCopy(envelope, "envelope") as Envelope;
  } catch (err) {
    return refuse("envelope-invalid", notPlainReason(err, "the envelope"));
  }
  const envelopeIssue = envelopeProblem(env);
  if (envelopeIssue !== null) return refuse("envelope-invalid", `the envelope is not a valid OperationalEnvelopeV1: ${envelopeIssue}`);

  // 2. The runtime's state.
  let st: RuntimeState;
  try {
    st = frozenCopy(state, "state") as RuntimeState;
  } catch (err) {
    return refuse("state-invalid", notPlainReason(err, "the state"));
  }
  const stateIssue = stateProblem(st);
  if (stateIssue !== null) return refuse("state-invalid", stateIssue);

  // 3. The running adapter is the one the envelope commits.
  if (st.adapterManifestDigest !== env.adapterVersion) {
    return refuse("adapter-mismatch", `the running adapter ${st.adapterManifestDigest} is not the adapter the envelope commits, ${env.adapterVersion}`);
  }

  // 4. The command: one plain frozen copy, exactly {name, params}.
  let cmd: RuntimeCommand;
  try {
    cmd = frozenCopy(command, "command") as RuntimeCommand;
  } catch (err) {
    return refuse("command-malformed", notPlainReason(err, "the command"));
  }
  const commandIssue = commandProblem(cmd);
  if (commandIssue !== null) return refuse("command-malformed", commandIssue);

  // 5. A declared command.
  const spec = commandOf(env.commands, cmd.name);
  if (spec === undefined) return refuse("unknown-command", `${quoted(cmd.name)} is not one of the envelope's commands`);

  // 6. The stop, through this ordinary dispatch, skips the deadline and the rate (7 and 8). It has
  //    already passed 1 to 5, and 9 to 12 still apply. The EMERGENCY stop is a separate path (emergencyStopOf).
  const eStop = env.eStop;
  const isStop = eStop.mechanism === "adapter-stop" && cmd.name === eStop.stopCommand;
  if (!isStop) {
    // 7. The deadline: the max of the deadline limit, in ms. Refused past it, and refused when it cannot be computed.
    const deadline = limitOf(env.limits, env.deadlineQuantity);
    const deadlineMs = deadline === undefined ? NaN : deadline.max * msPerTimeUnit(deadline.unit);
    const elapsedMs = st.nowMs - st.jobStartedAtMs;
    if (!(elapsedMs <= deadlineMs)) {
      return refuse("past-deadline", `the job has run ${elapsedMs} ms, past its ${env.deadlineQuantity} deadline of ${deadlineMs} ms`);
    }
    // 8. The rate: commands sent in (now - 60 s, now]. Refused when this one would exceed the limit.
    const windowStart = st.nowMs - WINDOW_MS;
    const recent = st.recentCommandsAtMs;
    let sent = 0;
    for (let i = 0; i < recent.length; i++) {
      const at = recent[i]!;
      if (at > windowStart && at <= st.nowMs) sent++;
    }
    if (!(sent < env.maxCommandsPerMinute)) {
      return refuse("rate-limited", `${sent} commands were sent in the last 60 s; the envelope allows ${env.maxCommandsPerMinute} per minute`);
    }
  }

  const declared = spec.params;
  const params = cmd.params;

  // 9. No parameter the command does not declare.
  const given = ObjectKeys(params);
  for (let i = 0; i < given.length; i++) {
    if (paramOf(declared, given[i]!) === undefined) {
      return refuse("undeclared-param", `${quoted(spec.name)} does not declare the parameter ${quoted(given[i])}`);
    }
  }

  // 10. Every declared parameter, present: a device default would be unbounded.
  for (let i = 0; i < declared.length; i++) {
    if (!hasOwn(params, declared[i]!.name)) {
      return refuse("missing-param", `${quoted(spec.name)} needs ${quoted(declared[i]!.name)}; every declared parameter is required`);
    }
  }

  // 11. Bounded parameters, in declaration order: a finite JSON number in the declared unit (no conversion),
  //     inside the limit's [min, max], 0 a bound like any other.
  for (let i = 0; i < declared.length; i++) {
    const p = declared[i]!;
    if (p.quantity === undefined) continue;
    const value = params[p.name];
    if (!finite(value)) {
      return refuse("not-a-number", `${quoted(p.name)} sets ${p.quantity} and must be a finite number in ${text(p.unit)}, not ${describe(value)}`);
    }
    const limit = limitOf(env.limits, p.quantity);
    if (limit === undefined) return refuse("out-of-range", `${p.quantity} has no confirmed limit`);
    if (!(value >= limit.min && value <= limit.max)) {
      return refuse("out-of-range", `${quoted(p.name)} = ${value} ${limit.unit} is outside the confirmed ${p.quantity} [${limit.min}, ${limit.max}] ${limit.unit}`);
    }
    // An enumerated physical parameter carries one of its listed values (each already inside the limit).
    if (p.allowed !== undefined && !includesValue(p.allowed, value)) {
      return refuse("value-not-allowed", `${quoted(p.name)} = ${value} ${limit.unit} is not one of its listed ${p.quantity} values`);
    }
  }

  // 12. Unbounded parameters: only an allowed value, or a list of allowed items.
  for (let i = 0; i < declared.length; i++) {
    const p = declared[i]!;
    if (p.unbounded === undefined) continue;
    if (!carriesAllowed(p.unbounded, params[p.name])) {
      return refuse("value-not-allowed", `${quoted(p.name)} may not carry ${describe(params[p.name])}: it sets no physical quantity, so only its listed values pass`);
    }
  }

  // 13.
  return ALLOWED;
}

// ── The emergency stop: a separate path ─────────────────────────────

/** The stop primitive an envelope pre-wired: the device's own hardware stop, its adapter's stop command, or none. */
export type EmergencyStop = { mechanism: "hardware" } | { mechanism: "adapter-stop"; stopCommand: string } | { mechanism: "none" };

/**
 * Which stop primitive `envelope` pre-wired, for the governor's dedicated
 * emergency-stop path (astra pack 174). It depends on the envelope alone: no
 * clock, no rate, no command, and no authorization state. It returns null when
 * the envelope is not a valid OperationalEnvelopeV1; the governor must then use
 * the hardware stop or watchdog. "none" is only valid for a class that neither
 * moves nor heats: there is nothing to stop beyond ending the job.
 *
 * It decides nothing about the adapter. When the running adapter's identity
 * cannot be trusted, the governor escalates to the hardware stop instead of
 * sending this command through it.
 */
export function emergencyStopOf(envelope: unknown): EmergencyStop | null {
  let env: Envelope;
  try {
    env = frozenCopy(envelope, "envelope") as Envelope;
  } catch {
    return null;
  }
  if (envelopeProblem(env) !== null) return null;
  const eStop = env.eStop;
  if (eStop.mechanism === "adapter-stop") return ObjectFreeze({ mechanism: "adapter-stop" as const, stopCommand: eStop.stopCommand });
  return ObjectFreeze({ mechanism: eStop.mechanism });
}

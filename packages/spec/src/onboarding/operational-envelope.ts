/**
 * The runtime safety envelope (ADK R8): the JSON the device-side checks
 * enforce, compiled only from the confirmed envelope a device's registration
 * record committed. Two runtimes consume it, the kernel's SafetyGovernor
 * (TypeScript, private) and pcc-node (Python), so its shape and schema live
 * here in the public spec (adk, bus #4075).
 *
 * The consumer contract. It is STRICT, and v1 has no lenient mode:
 *   - No envelope, no commands. A runtime never fills a missing envelope or a
 *     missing limit from built-in defaults. The kernel's DEFAULT_ENVELOPE is
 *     exactly what this replaces (bus #4074, G2).
 *   - The command surface is closed. A command not in `commands` is refused,
 *     and so is a parameter the command does not declare (G3).
 *   - A parameter that sets a quantity must carry a finite JSON number, in
 *     the declared unit, inside that limit's [min, max] inclusive. A numeric
 *     string is refused, never coerced (G4). A value in another unit is
 *     refused; v1 defines no conversions. 0 is a bound like any other, never
 *     "no limit" (G1). A parameter that sets a quantity may also list the
 *     only values it may carry (`allowed`, an enumerated physical parameter
 *     such as a temperature preset); its value must then be one of them, and
 *     each is inside the limit. A parameter declared `unbounded` claims it
 *     sets no physical quantity (the committed map says why). It passes only a
 *     single value in its `allowed` list, or a non-empty list of distinct items
 *     each in its `allowedItems`, compared by type and value; there is no
 *     free-form parameter. Every such set is listed in its one order: numbers
 *     ascending, then strings ascending by UTF-16 code unit (astra pack 176).
 *   - `telemetryChannels` are the readings the adapter takes, in ascending id
 *     order, each the template quantity it reports, in that quantity's unit.
 *     Every one is enforced. The runtime dispatches a command other than the
 *     stop only when each channel's latest reading is a finite number, taken
 *     no more than `maxAgeMs` earlier, inside its quantity's limit. While a
 *     job runs, a reading that breaks this stops the job. An adapter that
 *     cannot serve a channel cannot run the job.
 *   - Every template quantity has a limit. `deviceControlled` names the ones
 *     no declared parameter sets but the device can still cause (firmware, a
 *     fixed program, a stored method). Each names the channel of
 *     `telemetryChannels` that reports it and so enforces its limit. Its one
 *     enforcement is "telemetry". An independent cutoff joins only as an
 *     interlock registered with its own attestation (operator item 124).
 *     Only a template that does not list a quantity makes it physically
 *     absent (astra packs 173 and 176).
 *   - The adapter is the one the envelope commits: a runtime refuses an
 *     adapter whose release manifest digest is not `adapterVersion`.
 *   - At most `maxCommandsPerMinute` commands in any 60-second window, per
 *     device. The stop command is exempt from the rate, the deadline and the
 *     telemetry readings. A genuine EMERGENCY stop is a separate path, never
 *     ordinary dispatch: the governor calls the adapter's pre-wired stop
 *     directly, and escalates to the hardware stop when the adapter's
 *     identity cannot be trusted (astra pack 174).
 *   - A job that runs past the confirmed maximum of `deadlineQuantity` is
 *     stopped. This is elapsed time, measured by the runtime: no command
 *     parameter needs to set it, though one may (its value is then checked
 *     against the same limit).
 *   - The stop is wired before the first command: `hardware` is the device's
 *     own stop, and `adapter-stop` sends `eStop.stopCommand`, one of `commands`.
 *   - Engaged e-stop, maintenance and lockout/tagout stay independent,
 *     mutable runtime checks; this envelope does not replace them.
 *
 * `envelopeDigest` names the confirmed envelope this came from, the one the
 * registry's signed registration commits. A digest is not a signature: it
 * proves nothing by itself, and it matters where it is committed.
 *
 * Like safety-envelope.ts, compile and the schema's refinements call only
 * intrinsics `primordials.ts` captured at load, so a prototype method
 * replaced after load cannot change what is emitted (astra pack 164), and no
 * format is checked with a RegExp (astra pack 167). The candidate is frozen
 * before zod sees it: zod is third-party code that calls ambient methods, so
 * it only gates success or failure, and what is returned is the frozen object
 * compile built.
 *
 * `OperationalEnvelopeV1Schema` describes the contract and gates compile. It
 * is a zod schema: an object graph anyone holding it can change (its checks
 * live in `_def`), and its parse calls ambient methods. Compile is safe with
 * it, because a changed schema can only refuse, or pass the candidate compile
 * built from the checked snapshot. A runtime that validates an envelope in a
 * process where untrusted code ran after load must not take the schema as
 * its authority. That runtime check is structural and is built from the same
 * captured intrinsics.
 */

import { z } from "zod";

import { UnitSchema } from "../csd/composition.js";
import {
  DEVICE_CLASS_TEMPLATES,
  EnvelopeRefused,
  HAZARDS,
  SUPERVISION_MODES,
  checkCommittedEnvelope,
  commandMapIssue,
  DEVICE_CONTROL_ENFORCEMENTS,
  deviceControlledIssue,
  enumeratedLimitIssues,
  isAdapterManifestDigest,
  isCanonicalValueSet,
  isSafetyEnvelopeDigest,
  isTelemetryChannelId,
  isTimeUnit,
  MAX_TELEMETRY_AGE_MS,
  supervisionPolicy,
  telemetryChannelsIssue,
  type CommandMapV1,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeRegistration,
} from "./safety-envelope.js";
import {
  deepFreeze,
  filterList,
  hasOwn,
  includesValue,
  joinStrings,
  JSONStringify,
  mapList,
  newList,
  append,
  quoted,
  text,
  trim,
} from "./primordials.js";

const NonBlank = z.string().refine((s) => trim(s).length > 0, { message: "must not be blank" });

/** No quantities, no device-controlled entries and no channels: what an envelope whose map sets every quantity carries. */
const NO_QUANTITIES: readonly string[] = deepFreeze(newList<string>(0));
const NO_DEVICE_CONTROLLED: readonly { quantity: string; enforcement: "telemetry"; channel: string }[] = deepFreeze([]);
const NO_CHANNELS: readonly { id: string; quantity: string; unit: string; maxAgeMs: number }[] = deepFreeze([]);

/** A telemetry channel id: a lowercase token, checked without a RegExp. */
const ChannelId = z.string().refine((s): boolean => isTelemetryChannelId(s), {
  message: 'must be a lowercase token: a letter, then letters, digits, ".", "_" or "-", at most 64 long',
});

/** True when no two values are equal by type and value (compared as their JSON). */
function allDistinct(values: readonly unknown[]): boolean {
  const seen = newList<string>(0);
  for (let i = 0; i < values.length; i++) {
    const key = JSONStringify(values[i]);
    if (includesValue(seen, key)) return false;
    append(seen, key);
  }
  return true;
}

export const OperationalLimitSchema = z
  .object({
    quantity: NonBlank,
    unit: UnitSchema,
    min: z.number().finite(),
    max: z.number().finite(),
  })
  .strict()
  .refine((l) => l.min <= l.max, { message: "min must not be above max" });
export type OperationalLimit = z.infer<typeof OperationalLimitSchema>;

export const OperationalEStopSchema = z.discriminatedUnion("mechanism", [
  z.object({ mechanism: z.literal("hardware") }).strict(),
  z.object({ mechanism: z.literal("adapter-stop"), stopCommand: NonBlank }).strict(),
  z.object({ mechanism: z.literal("none") }).strict(),
]);

const FiniteSet = z
  .array(z.union([NonBlank, z.number().finite()]))
  .min(1)
  .refine((values) => allDistinct(values), { message: "an allowed value is listed twice" })
  .refine((values) => isCanonicalValueSet(values), { message: "a value set is listed in its one order: numbers ascending, then strings by UTF-16 code unit" });

/**
 * A parameter that sets no physical quantity: why, and the only values it may
 * carry. A single value must be in `allowed`; a list must be non-empty, with
 * distinct items, each in `allowedItems`. At least one of the two is given.
 */
export const OperationalUnboundedSchema = z
  .object({
    reason: NonBlank,
    allowed: FiniteSet.optional(),
    allowedItems: FiniteSet.optional(),
  })
  .strict()
  .refine((u) => u.allowed !== undefined || u.allowedItems !== undefined, { message: "an unbounded parameter must list allowed values or allowed list items" });

export const OperationalCommandSchema = z
  .object({
    name: NonBlank,
    params: z.array(
      z
        .object({
          name: NonBlank,
          quantity: NonBlank.optional(),
          unit: UnitSchema.optional(),
          /** An enumerated physical parameter's only values, ascending, each inside the limit of `quantity`. */
          allowed: z
            .array(z.number().finite())
            .min(1)
            .refine((values) => isCanonicalValueSet(values), { message: "allowed values are listed once each, in ascending order" })
            .optional(),
          unbounded: OperationalUnboundedSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

function templateOf(deviceClass: string) {
  return hasOwn(DEVICE_CLASS_TEMPLATES, deviceClass) ? DEVICE_CLASS_TEMPLATES[deviceClass] : undefined;
}

export const OperationalEnvelopeV1Schema = z
  .object({
    envelopeVersion: z.literal(1),
    envelopeDigest: z.string().refine((s): boolean => isSafetyEnvelopeDigest(s), { message: "must be 0x + 64 lowercase hex" }),
    deviceClass: NonBlank,
    deviceId: NonBlank,
    adapterType: NonBlank,
    /** The adapter release manifest digest the envelope commits; a runtime refuses any other adapter. */
    adapterVersion: z
      .string()
      .refine((s): boolean => isAdapterManifestDigest(s), { message: "must be sha256: + 64 lowercase hex (the adapter's manifest digest)" }),
    strict: z.literal(true),
    limits: z.array(OperationalLimitSchema).min(1),
    /** The readings the adapter takes, in ascending id order; every one is enforced. May be empty. */
    telemetryChannels: z.array(
      z
        .object({
          id: ChannelId,
          quantity: NonBlank,
          unit: UnitSchema,
          maxAgeMs: z.number().int().min(1).max(MAX_TELEMETRY_AGE_MS),
        })
        .strict(),
    ),
    /**
     * Template quantities no declared parameter sets but the device can cause, in template order, each
     * keeping its limit and naming the channel that enforces it (astra packs 173 and 176). May be empty.
     */
    deviceControlled: z.array(
      z
        .object({ quantity: NonBlank, enforcement: z.enum(DEVICE_CONTROL_ENFORCEMENTS as unknown as ["telemetry"]), channel: ChannelId })
        .strict(),
    ),
    commands: z.array(OperationalCommandSchema).min(1),
    /** The limit whose max is a whole job's deadline. */
    deadlineQuantity: NonBlank,
    maxCommandsPerMinute: z.number().int().min(1),
    eStop: OperationalEStopSchema,
    /** How the device is supervised while it runs, as the operator confirmed it. */
    supervision: z.enum(SUPERVISION_MODES),
    /** The hazards the operator confirmed, each once; an empty list is the operator's "none". */
    hazards: z.array(z.enum(HAZARDS)).refine((h) => allDistinct(h), { message: "a hazard is listed twice" }),
  })
  .strict()
  .superRefine((env, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const template = templateOf(env.deviceClass);
    // Only a class with a template: a runtime validating this schema accepts nothing compile would refuse.
    if (!template) {
      issue(["deviceClass"], `unknown deviceClass ${quoted(env.deviceClass)}`);
      return;
    }
    // One canonical order, as confirm commits it (a duplicate is reported by the hazards refinement).
    const canonical = filterList(HAZARDS as readonly string[], (h) => includesValue(env.hazards, h));
    if (canonical.length === env.hazards.length) {
      for (let i = 0; i < canonical.length; i++) {
        if (canonical[i] !== env.hazards[i]) {
          issue(["hazards"], "hazards must be in canonical order");
          break;
        }
      }
    }
    // `telemetryChannels`: ascending ids, each a non-deadline template quantity in its unit.
    const channelsProblem = telemetryChannelsIssue(env.telemetryChannels, env.deviceClass);
    if (channelsProblem) issue(["telemetryChannels"], channelsProblem);
    // `deviceControlled`: required quantities no command sets, in template order, never the deadline,
    // each through a channel that resolves (a malformed channel list resolves none).
    const controlledProblem = deviceControlledIssue(env.deviceControlled, env.deviceClass, channelsProblem ? NO_CHANNELS : env.telemetryChannels);
    if (controlledProblem) issue(["deviceControlled"], controlledProblem);
    const controlled = controlledProblem ? NO_QUANTITIES : mapList(env.deviceControlled, (d) => d.quantity);
    // Exactly the template's quantities, in its order and units: a device-controlled one keeps its limit.
    if (env.limits.length !== template.requires.length) {
      issue(["limits"], `limits must be exactly ${joinStrings(mapList(template.requires, (r) => r.quantity), ", ")}`);
    }
    for (let i = 0; i < template.requires.length; i++) {
      const req = template.requires[i]!;
      const limit = env.limits[i];
      if (!limit) continue;
      if (limit.quantity !== req.quantity) issue(["limits", i, "quantity"], `limit ${i} must be ${req.quantity}`);
      else if (limit.unit !== req.unit) issue(["limits", i, "unit"], `${req.quantity} is in ${req.unit}`);
    }
    if (env.eStop.mechanism === "none" && template.movesOrHeats) {
      issue(["eStop", "mechanism"], "a device that moves or heats needs an e-stop");
    }
    const stop = env.eStop;
    if (stop.mechanism === "adapter-stop" && filterList(env.commands, (c) => c.name === stop.stopCommand).length === 0) {
      issue(["eStop", "stopCommand"], "the stop command must be one of the declared commands");
    }
    const policy = supervisionPolicy(env.supervision, env.eStop, env.deviceClass);
    if (policy) issue(["supervision"], policy);
    const map = commandMapIssue({ commands: env.commands }, env.deviceClass, controlled);
    if (map) issue(["commands"], map);
    else {
      const enumerated = enumeratedLimitIssues({ commands: env.commands } as CommandMapV1, env.limits);
      for (let i = 0; i < enumerated.length; i++) issue(["commands"], enumerated[i]!);
    }
    const deadlines = filterList(env.limits, (l) => l.quantity === env.deadlineQuantity);
    const deadline = deadlines.length > 0 ? deadlines[0] : undefined;
    if (env.deadlineQuantity !== template.deadline) {
      issue(["deadlineQuantity"], `the deadline of a ${template.id} is ${template.deadline}`);
    } else if (!deadline || !isTimeUnit(deadline.unit)) {
      issue(["deadlineQuantity"], "the deadline must name a limit in s, min or h");
    }
  });
export type OperationalEnvelopeV1 = z.infer<typeof OperationalEnvelopeV1Schema>;

/**
 * Compile the envelope the registry's signed registration commits into the
 * runtime envelope. It reads only the snapshot `checkCommittedEnvelope`
 * returns, never `confirmed` again, builds every array by index from
 * intrinsics captured at load, and refuses anything confirm would refuse,
 * and anything the schema refuses. The result is frozen.
 */
export function compileOperationalEnvelope(
  confirmed: ConfirmedSafetyEnvelope,
  registration: SafetyEnvelopeRegistration,
  verifyRegistration: RegistrationVerifier,
): OperationalEnvelopeV1 {
  const { envelope, envelopeDigest: committedDigest } = checkCommittedEnvelope(confirmed, registration, verifyRegistration);
  const template = templateOf(envelope.deviceClass)!;
  const eStop =
    envelope.eStop.mechanism === "adapter-stop"
      ? { mechanism: "adapter-stop" as const, stopCommand: envelope.eStop.stopCommand as string }
      : { mechanism: envelope.eStop.mechanism };
  // Built from the checked snapshot by index, with own data properties only: no
  // prototype method or setter takes part (astra packs 158 and 164).
  const candidate = deepFreeze({
    envelopeVersion: 1 as const,
    envelopeDigest: committedDigest,
    deviceClass: envelope.deviceClass,
    deviceId: envelope.device.deviceId,
    adapterType: envelope.device.adapterType,
    adapterVersion: envelope.device.adapterVersion,
    strict: true,
    limits: mapList(envelope.limits, (l) => ({ quantity: l.quantity, unit: l.unit, min: l.min, max: l.max })),
    telemetryChannels: mapList(envelope.telemetryMap?.channels ?? NO_CHANNELS, (c) => ({ id: c.id, quantity: c.quantity, unit: c.unit, maxAgeMs: c.maxAgeMs })),
    deviceControlled: mapList(envelope.deviceControlled ?? NO_DEVICE_CONTROLLED, (d) => ({ quantity: d.quantity, enforcement: d.enforcement, channel: d.channel })),
    commands: mapList(envelope.commandMap.commands, (c) => ({
      name: c.name,
      params: mapList(c.params, (p) =>
        p.unbounded !== undefined
          ? {
              name: p.name,
              unbounded: {
                reason: p.unbounded.reason,
                ...(p.unbounded.allowed !== undefined ? { allowed: mapList(p.unbounded.allowed, (v) => v) } : {}),
                ...(p.unbounded.allowedItems !== undefined ? { allowedItems: mapList(p.unbounded.allowedItems, (v) => v) } : {}),
              },
            }
          : { name: p.name, quantity: p.quantity, unit: p.unit, ...(p.allowed !== undefined ? { allowed: mapList(p.allowed, (v) => v) } : {}) },
      ),
    })),
    deadlineQuantity: template.deadline,
    maxCommandsPerMinute: envelope.maxCommandsPerMinute,
    eStop,
    supervision: envelope.supervision,
    hazards: mapList(envelope.hazards, (h) => h),
  });
  // Frozen before zod reads it: zod calls ambient methods, so it may only say yes or no, never change the candidate.
  const parsed = OperationalEnvelopeV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new EnvelopeRefused(
      mapList(parsed.error.issues, (i) => `${joinStrings(mapList(i.path, (k) => text(k)), ".") || "envelope"}: ${i.message}`),
    );
  }
  // What was built and validated is what is returned. Zod's parsed copy is not used: zod rebuilds objects and arrays by assignment.
  return candidate as OperationalEnvelopeV1;
}

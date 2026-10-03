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
 *     "no limit" (G1). A parameter declared `unbounded` sets no physical
 *     quantity (the committed map says why), and it passes only a value in its
 *     `allowed` list, compared by type and value; there is no free-form
 *     parameter.
 *   - The adapter is the one the envelope commits: a runtime refuses an
 *     adapter whose release manifest digest is not `adapterVersion`.
 *   - At most `maxCommandsPerMinute` commands in any 60-second window, per
 *     device. The stop command is exempt: a stop is always sent.
 *   - A job that runs past the confirmed maximum of `deadlineQuantity` is
 *     stopped.
 *   - The stop is wired before the first command: `hardware` is the device's
 *     own stop, and `adapter-stop` sends `eStop.stopCommand`, one of `commands`.
 *   - Engaged e-stop, maintenance and lockout/tagout stay independent,
 *     mutable runtime checks; this envelope does not replace them.
 *
 * `envelopeDigest` names the confirmed envelope this came from, the one the
 * registry's signed registration commits. A digest is not a signature: it
 * proves nothing by itself, and it matters where it is committed.
 */

import { z } from "zod";

import { UnitSchema } from "../csd/composition.js";
import {
  ADAPTER_MANIFEST_DIGEST_PATTERN,
  DEVICE_CLASS_TEMPLATES,
  EnvelopeRefused,
  HAZARDS,
  SUPERVISION_MODES,
  checkCommittedEnvelope,
  commandMapIssue,
  isTimeUnit,
  supervisionPolicy,
  type ConfirmedSafetyEnvelope,
  type RegistrationVerifier,
  type SafetyEnvelopeRegistration,
} from "./safety-envelope.js";

const NonBlank = z.string().refine((s) => s.trim().length > 0, { message: "must not be blank" });

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

/** A parameter that sets no physical quantity: why, and the only values it may carry. */
export const OperationalUnboundedSchema = z
  .object({
    reason: NonBlank,
    allowed: z
      .array(z.union([NonBlank, z.number().finite()]))
      .min(1)
      .refine((values) => new Set(values.map((v) => JSON.stringify(v))).size === values.length, { message: "an allowed value is listed twice" }),
  })
  .strict();

export const OperationalCommandSchema = z
  .object({
    name: NonBlank,
    params: z.array(
      z
        .object({
          name: NonBlank,
          quantity: NonBlank.optional(),
          unit: UnitSchema.optional(),
          unbounded: OperationalUnboundedSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

function templateOf(deviceClass: string) {
  return Object.prototype.hasOwnProperty.call(DEVICE_CLASS_TEMPLATES, deviceClass)
    ? DEVICE_CLASS_TEMPLATES[deviceClass]
    : undefined;
}

export const OperationalEnvelopeV1Schema = z
  .object({
    envelopeVersion: z.literal(1),
    envelopeDigest: z.string().regex(/^0x[0-9a-f]{64}$/, { message: "must be 0x + 64 lowercase hex" }),
    deviceClass: NonBlank,
    deviceId: NonBlank,
    adapterType: NonBlank,
    /** The adapter release manifest digest the envelope commits; a runtime refuses any other adapter. */
    adapterVersion: z.string().regex(ADAPTER_MANIFEST_DIGEST_PATTERN, { message: "must be sha256: + 64 lowercase hex (the adapter's manifest digest)" }),
    strict: z.literal(true),
    limits: z.array(OperationalLimitSchema).min(1),
    commands: z.array(OperationalCommandSchema).min(1),
    /** The limit whose max is a whole job's deadline. */
    deadlineQuantity: NonBlank,
    maxCommandsPerMinute: z.number().int().min(1),
    eStop: OperationalEStopSchema,
    /** How the device is supervised while it runs, as the operator confirmed it. */
    supervision: z.enum(SUPERVISION_MODES),
    /** The hazards the operator confirmed, each once; an empty list is the operator's "none". */
    hazards: z.array(z.enum(HAZARDS)).refine((h) => new Set(h).size === h.length, { message: "a hazard is listed twice" }),
  })
  .strict()
  .superRefine((env, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const template = templateOf(env.deviceClass);
    // Only a class with a template: a runtime validating this schema accepts nothing compile would refuse.
    if (!template) {
      issue(["deviceClass"], `unknown deviceClass ${JSON.stringify(env.deviceClass)}`);
      return;
    }
    // One canonical order, as confirm commits it (a duplicate is reported by the hazards refinement).
    const canonical = HAZARDS.filter((h) => env.hazards.includes(h));
    if (canonical.length === env.hazards.length && canonical.some((h, i) => h !== env.hazards[i])) {
      issue(["hazards"], "hazards must be in canonical order");
    }
    // Exactly the template's quantities, in its order and units.
    if (env.limits.length !== template.requires.length) {
      issue(["limits"], `limits must be exactly ${template.requires.map((r) => r.quantity).join(", ")}`);
    }
    template.requires.forEach((req, i) => {
      const limit = env.limits[i];
      if (!limit) return;
      if (limit.quantity !== req.quantity) issue(["limits", i, "quantity"], `limit ${i} must be ${req.quantity}`);
      else if (limit.unit !== req.unit) issue(["limits", i, "unit"], `${req.quantity} is in ${req.unit}`);
    });
    if (env.eStop.mechanism === "none" && template.movesOrHeats) {
      issue(["eStop", "mechanism"], "a device that moves or heats needs an e-stop");
    }
    const stop = env.eStop;
    if (stop.mechanism === "adapter-stop" && !env.commands.some((c) => c.name === stop.stopCommand)) {
      issue(["eStop", "stopCommand"], "the stop command must be one of the declared commands");
    }
    const policy = supervisionPolicy(env.supervision, env.eStop, env.deviceClass);
    if (policy) issue(["supervision"], policy);
    const map = commandMapIssue({ commands: env.commands }, env.deviceClass);
    if (map) issue(["commands"], map);
    const deadline = env.limits.find((l) => l.quantity === env.deadlineQuantity);
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
 * returns, never `confirmed` again, and refuses anything confirm would
 * refuse, and anything the schema refuses.
 */
export function compileOperationalEnvelope(
  confirmed: ConfirmedSafetyEnvelope,
  registration: SafetyEnvelopeRegistration,
  verifyRegistration: RegistrationVerifier,
): OperationalEnvelopeV1 {
  const { envelope, envelopeDigest: committedDigest } = checkCommittedEnvelope(confirmed, registration, verifyRegistration);
  const template = DEVICE_CLASS_TEMPLATES[envelope.deviceClass]!;
  const eStop =
    envelope.eStop.mechanism === "adapter-stop"
      ? { mechanism: "adapter-stop" as const, stopCommand: envelope.eStop.stopCommand as string }
      : { mechanism: envelope.eStop.mechanism };
  // Built from the checked snapshot with literals and map only, which install
  // values directly (no assignment a polluted prototype's setter could intercept).
  const candidate = {
    envelopeVersion: 1 as const,
    envelopeDigest: committedDigest,
    deviceClass: envelope.deviceClass,
    deviceId: envelope.device.deviceId,
    adapterType: envelope.device.adapterType,
    adapterVersion: envelope.device.adapterVersion,
    strict: true,
    limits: envelope.limits.map((l) => ({ quantity: l.quantity, unit: l.unit, min: l.min, max: l.max })),
    commands: envelope.commandMap.commands.map((c) => ({
      name: c.name,
      params: c.params.map((p) =>
        p.unbounded !== undefined
          ? { name: p.name, unbounded: { reason: p.unbounded.reason, allowed: [...p.unbounded.allowed] } }
          : { name: p.name, quantity: p.quantity, unit: p.unit },
      ),
    })),
    deadlineQuantity: template.deadline,
    maxCommandsPerMinute: envelope.maxCommandsPerMinute,
    eStop,
    supervision: envelope.supervision,
    hazards: [...envelope.hazards],
  };
  const parsed = OperationalEnvelopeV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new EnvelopeRefused(parsed.error.issues.map((i) => `${i.path.join(".") || "envelope"}: ${i.message}`));
  }
  // What was built and validated is what is returned, frozen. Zod's parsed copy
  // is not used: zod rebuilds objects and arrays by assignment.
  return deepFreeze(candidate) as OperationalEnvelopeV1;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

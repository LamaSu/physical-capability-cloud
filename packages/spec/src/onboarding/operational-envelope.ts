/**
 * The runtime safety envelope (ADK R8): the JSON the device-side checks
 * enforce, compiled only from an operator-confirmed safety envelope. Two
 * runtimes consume it, the kernel's SafetyGovernor (TypeScript, private) and
 * pcc-node (Python), so its shape and schema live here in the public spec
 * (adk, bus #4075).
 *
 * The consumer contract. It is STRICT, and v1 has no lenient mode:
 *   - No envelope, no commands. A runtime never fills a missing envelope or a
 *     missing limit from built-in defaults. The kernel's DEFAULT_ENVELOPE is
 *     exactly what this replaces (bus #4074, G2).
 *   - Limits are keyed by QUANTITY, not by a command's parameter name. Each
 *     adapter maps the command parameters it sends to quantities in its own
 *     table (an OT-2 aspirate's `volume` is `aspirate_volume` in uL). A command
 *     carrying a quantity this envelope does not bound is refused (G3).
 *   - A value must be a finite JSON number, in the limit's unit, inside
 *     [min, max] inclusive. A numeric string is refused, never coerced (G4). A
 *     value in another unit is refused; v1 defines no conversions. 0 is a
 *     bound like any other, never "no limit" (G1).
 *   - At most `maxCommandsPerMinute` commands in any 60-second window.
 *   - The stop is wired before the first command: `hardware` is the device's
 *     own stop, and `adapter-stop` sends `stopCommand`.
 *
 * `envelopeDigest` names the confirmed envelope this came from. A digest is
 * not a signature: it proves nothing by itself, and it matters where it is
 * committed (the device's registration record).
 */

import { z } from "zod";

import { UnitSchema } from "../csd/composition.js";
import {
  DEVICE_CLASS_TEMPLATES,
  EnvelopeRefused,
  HAZARDS,
  SUPERVISION_MODES,
  computeSafetyEnvelopeDigest,
  type ConfirmedSafetyEnvelope,
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
    strict: z.literal(true),
    limits: z.array(OperationalLimitSchema).min(1),
    maxCommandsPerMinute: z.number().int().min(1),
    eStop: OperationalEStopSchema,
    /** How the device is supervised while it runs, as the operator confirmed it. */
    supervision: z.enum(SUPERVISION_MODES),
    /** The hazards the operator confirmed, each once; an empty list is the operator's "none". */
    hazards: z.array(z.enum(HAZARDS)).refine((h) => new Set(h).size === h.length, { message: "a hazard is listed twice" }),
  })
  .strict()
  .superRefine((env, ctx) => {
    const seen = new Set<string>();
    env.limits.forEach((l, i) => {
      if (seen.has(l.quantity)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limits", i, "quantity"], message: `${l.quantity} is bounded twice` });
      }
      seen.add(l.quantity);
    });
    // One canonical order, as confirm commits it (a duplicate is reported by the hazards refinement).
    const canonical = HAZARDS.filter((h) => env.hazards.includes(h));
    if (canonical.length === env.hazards.length && canonical.some((h, i) => h !== env.hazards[i])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hazards"], message: "hazards must be in canonical order" });
    }
    const template = templateOf(env.deviceClass);
    // "none" only for a known class that neither moves nor heats; an unknown class fails closed.
    if (env.eStop.mechanism === "none" && (!template || template.movesOrHeats)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eStop", "mechanism"],
        message: "a device that moves or heats, or of an unknown class, needs an e-stop",
      });
    }
    if (!template) return;
    for (const req of template.requires) {
      const i = env.limits.findIndex((l) => l.quantity === req.quantity);
      if (i < 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limits"], message: `${req.quantity} has no limit` });
      } else if (env.limits[i]!.unit !== req.unit) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limits", i, "unit"], message: `${req.quantity} is in ${req.unit}` });
      }
    }
  });
export type OperationalEnvelopeV1 = z.infer<typeof OperationalEnvelopeV1Schema>;

/**
 * Compile a CONFIRMED envelope into the runtime envelope. Refuses one whose
 * digest no longer matches its content, and anything the schema refuses.
 */
export function compileOperationalEnvelope(confirmed: ConfirmedSafetyEnvelope): OperationalEnvelopeV1 {
  const { envelope } = confirmed;
  if (computeSafetyEnvelopeDigest(envelope) !== confirmed.envelopeDigest) {
    throw new EnvelopeRefused(["the envelope changed after it was confirmed; it must be confirmed again"]);
  }
  if (!templateOf(envelope.deviceClass)) {
    throw new EnvelopeRefused([`unknown deviceClass ${JSON.stringify(String(envelope.deviceClass))}`]);
  }
  // A malformed body goes to the schema as it is, so it is refused with a reason, not a TypeError.
  const mechanism: unknown = envelope.eStop?.mechanism;
  const eStop = mechanism === "adapter-stop" ? { mechanism, stopCommand: envelope.eStop.stopCommand } : { mechanism };
  const limits: unknown = Array.isArray(envelope.limits)
    ? envelope.limits.map((l) => ({ quantity: l?.quantity, unit: l?.unit, min: l?.min, max: l?.max }))
    : envelope.limits;
  const parsed = OperationalEnvelopeV1Schema.safeParse({
    envelopeVersion: 1,
    envelopeDigest: confirmed.envelopeDigest,
    deviceClass: envelope.deviceClass,
    deviceId: envelope.device?.deviceId,
    adapterType: envelope.device?.adapterType,
    strict: true,
    limits,
    maxCommandsPerMinute: envelope.maxCommandsPerMinute,
    eStop,
    supervision: envelope.supervision,
    hazards: envelope.hazards,
  });
  if (!parsed.success) {
    throw new EnvelopeRefused(parsed.error.issues.map((i) => `${i.path.join(".") || "envelope"}: ${i.message}`));
  }
  return parsed.data;
}

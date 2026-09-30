/**
 * PUT /api/capabilities/:capId/availability — the capability's owner sets when
 * it can take work (board N83; rehearsal R0 finding G11).
 *
 * GET /api/operators/:slug/status reports a capability with no availability as
 * "partial" and tells the operator to set mode=always or windows[]. But no route
 * could set it: PATCH and PUT /api/capabilities/:id do not exist, and re-POSTing
 * /api/capabilities returns the existing row unchanged.
 *
 * Authorization fails closed, and accepts only a PROVEN identity (astra pack 111):
 *   - On master only a SIWE session proves who the caller is. An API key's
 *     operatorId comes from public self-service provisioning, which accepts any
 *     email or wallet address with no proof, so a key can impersonate any owner
 *     (HIGH 1). A key-authenticated caller therefore gets 403
 *     proven_identity_required until proven identity binds keys (WP-A #326).
 *   - The actor is the SIWE session's wallet address (api-gate sets userId and no
 *     apiKeyId). It must equal the kernel's operatorAddress as a validated EVM
 *     address compared ASCII-case-insensitively: no Unicode case folding, so a
 *     lookalike such as the Kelvin sign can never collide (HIGH 2). An
 *     email-owned kernel cannot be written here until verified-email identity
 *     exists.
 *   - No principal gets 401. A non-owner, or a capability whose kernel is
 *     missing, gets 403.
 * The route sits under /availability on purpose. Master's public allowlist
 * matches /api/capabilities/:id for EVERY method, so a write on that exact path
 * would skip authentication (WP-A #326 makes the allowlist method-aware).
 *
 * The body is validated strictly and stored in the canonical column shape
 * (serializeAvailability). "delegate-to-agent" is refused: its agentEndpoint is
 * a URL the gateway would POST to, so storing one invites SSRF until a caller
 * validates such targets.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { getRepos } from "../db.js";
import { serializeAvailability, type AvailabilityRecord } from "./operator-channels.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Actor = { kind: "siwe"; address: string } | { kind: "api-key" } | { kind: "none" };

/**
 * Who authenticated this request, as api-gate recorded it: an API key sets
 * apiKeyId (and copies the key's self-declared operatorId into userId); a SIWE
 * session sets only userId, the address the wallet signature proved.
 */
function requestActor(req: FastifyRequest): Actor {
  const r = req as unknown as { apiKeyId?: unknown; userId?: unknown };
  if (typeof r.apiKeyId === "string" && r.apiKeyId !== "") return { kind: "api-key" };
  if (typeof r.userId === "string" && r.userId !== "") return { kind: "siwe", address: r.userId };
  return { kind: "none" };
}

/** Two EVM addresses are the same account: both well-formed, hex compared case-insensitively (ASCII only). */
function sameEvmAddress(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    EVM_ADDRESS.test(a) &&
    EVM_ADDRESS.test(b) &&
    a.toLowerCase() === b.toLowerCase()
  );
}

/** True when the runtime's IANA time-zone database knows the zone. */
function isKnownTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const CRON_FIELDS: ReadonlyArray<{ min: number; max: number; names?: readonly string[] }> = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

/**
 * A standard five-field POSIX cron expression, checked value by value: `*`,
 * `n`, `a-b`, lists, and `/step` on `*` or a range, within each field's range
 * (month and weekday names allowed). No scheduler consumes cron yet, so this is
 * the full grammar the column may hold.
 */
function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const spec = CRON_FIELDS[i]!;
    const value = (tok: string): number | null => {
      const upper = tok.toUpperCase();
      const named = spec.names?.indexOf(upper) ?? -1;
      if (named >= 0) return spec.min === 1 ? named + 1 : named;
      if (!/^[0-9]{1,2}$/.test(tok)) return null;
      const n = Number(tok);
      return n >= spec.min && n <= spec.max ? n : null;
    };
    return field.split(",").every((item) => {
      const [range, step, extra] = item.split("/");
      if (extra !== undefined || range === undefined || range === "") return false;
      if (step !== undefined && !(/^[0-9]{1,2}$/.test(step) && Number(step) >= 1)) return false;
      if (range === "*") return true;
      const bounds = range.split("-");
      if (bounds.length > 2) return false;
      const lo = value(bounds[0]!);
      if (lo === null) return false;
      if (bounds.length === 1) return step === undefined;
      const hi = value(bounds[1]!);
      return hi !== null && lo <= hi;
    });
  });
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const IsoInstant = z.string().datetime({ offset: true });
const Timezone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/, "Must be an IANA timezone, e.g. America/Los_Angeles")
  .refine(isKnownTimezone, { message: "Unknown timezone: not in the runtime's IANA database" });

const AvailabilityWindowSchema = z
  .object({
    start: z.string().min(1).max(40),
    end: z.string().min(1).max(40),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    timezone: Timezone.optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.daysOfWeek !== undefined) {
      // Recurring: wall-clock HH:mm; an overnight window (22:00-06:00) is allowed.
      if (!HHMM.test(w.start) || !HHMM.test(w.end)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a recurring window (daysOfWeek) uses HH:mm start and end" });
      }
      return;
    }
    const ok =
      IsoInstant.safeParse(w.start).success &&
      IsoInstant.safeParse(w.end).success &&
      Date.parse(w.start) < Date.parse(w.end);
    if (!ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a one-shot window uses ISO-8601 instants with start before end" });
    }
  });

export const AvailabilityUpdateSchema = z
  .object({
    mode: z.enum(["always", "windows", "cron", "manual-claim"]),
    windows: z.array(AvailabilityWindowSchema).min(1).max(50).optional(),
    cron: z.string().min(1).max(120).optional(),
    timezone: Timezone.optional(),
    describe: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (a.mode === "windows" && a.windows === undefined) fail('mode "windows" needs windows[]');
    if (a.mode !== "windows" && a.windows !== undefined) fail('windows[] goes only with mode "windows"');
    if (a.mode === "cron" && a.cron === undefined) fail('mode "cron" needs cron');
    if (a.mode !== "cron" && a.cron !== undefined) fail('cron goes only with mode "cron"');
    if (a.cron !== undefined && !isValidCron(a.cron)) fail("cron must be a valid 5-field POSIX expression");
  });

export async function capabilityAvailabilityRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { capId: string }; Body: unknown }>(
    "/api/capabilities/:capId/availability",
    async (req, reply) => {
      const actor = requestActor(req);
      if (actor.kind === "none") {
        return reply.code(401).send({
          error: "authentication_required",
          message: "Setting availability requires the kernel operator's wallet-signed (SIWE) session.",
        });
      }
      if (actor.kind === "api-key") {
        return reply.code(403).send({
          error: "proven_identity_required",
          message:
            "Setting availability needs a wallet-signed (SIWE) session for the kernel's operator address. " +
            "API keys from self-service provisioning do not prove identity yet (WP-A #326).",
        });
      }

      const repos = getRepos();
      const capability = repos.capabilities.findById(req.params.capId);
      if (!capability) {
        return reply.code(404).send({ error: "capability_not_found" });
      }
      const kernel = repos.kernels.findById(capability.kernelId);
      if (!kernel || !sameEvmAddress(kernel.operatorAddress, actor.address)) {
        return reply.code(403).send({
          error: "not_capability_owner",
          message: "Only the operator of this capability's kernel can set its availability.",
        });
      }

      const body = req.body;
      if (body !== null && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (b.mode === "delegate-to-agent" || "agentEndpoint" in b) {
          return reply.code(400).send({
            error: "unsupported_mode",
            message:
              'mode "delegate-to-agent" and agentEndpoint are not accepted here: the gateway would POST to that URL. ' +
              'Use "always", "windows", "cron" or "manual-claim".',
          });
        }
      }
      const parsed = AvailabilityUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_availability",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }

      const availability = serializeAvailability(parsed.data as AvailabilityRecord);
      repos.capabilities.update(capability.id, { availability });
      return reply.code(200).send({
        capability: { id: capability.id, kernelId: capability.kernelId, availability },
      });
    },
  );
}

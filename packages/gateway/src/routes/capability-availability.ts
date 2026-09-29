/**
 * PUT /api/capabilities/:capId/availability — the capability's owner sets when
 * it can take work (board N83; rehearsal R0 finding G11).
 *
 * GET /api/operators/:slug/status reports a capability with no availability as
 * "partial" and tells the operator to set mode=always or windows[]. But no route
 * could set it: PATCH and PUT /api/capabilities/:id do not exist, and re-POSTing
 * /api/capabilities returns the existing row unchanged.
 *
 * Authorization fails closed:
 *   - The actor is the principal api-gate authenticated: the API key's
 *     operatorId, else the SIWE session's address. Never a body field or header.
 *   - No actor gets 401. Anyone but the operator of the capability's kernel
 *     (its operatorAddress) gets 403, and so does a capability whose kernel is
 *     missing.
 *   - Identities compare with WP-A's fold: trimmed, case-insensitive, and never
 *     true for an id that folds to empty.
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

/**
 * The authenticated principal, or null. Same semantics as WP-A's helpers
 * (#326) and #395's auth/actor.ts; converge on WP-A's once those merge.
 */
function authenticatedActor(req: FastifyRequest): string | null {
  const r = req as unknown as { operatorId?: unknown; userId?: unknown };
  for (const candidate of [r.operatorId, r.userId]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

function normalizeIdentity(id: unknown): string {
  return String(id ?? "").trim().toLowerCase();
}

function sameIdentity(a: unknown, b: unknown): boolean {
  const x = normalizeIdentity(a);
  return x.length > 0 && x === normalizeIdentity(b);
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const IsoInstant = z.string().datetime({ offset: true });
const Timezone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/, "Must be an IANA timezone, e.g. America/Los_Angeles");

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
    if (a.cron !== undefined && a.cron.trim().split(/\s+/).length !== 5) fail("cron is a 5-field POSIX expression");
  });

export async function capabilityAvailabilityRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { capId: string }; Body: unknown }>(
    "/api/capabilities/:capId/availability",
    async (req, reply) => {
      const actor = authenticatedActor(req);
      if (actor === null) {
        return reply.code(401).send({
          error: "authentication_required",
          message: "Setting availability requires the capability owner's API key or wallet session.",
        });
      }

      const repos = getRepos();
      const capability = repos.capabilities.findById(req.params.capId);
      if (!capability) {
        return reply.code(404).send({ error: "capability_not_found" });
      }
      const kernel = repos.kernels.findById(capability.kernelId);
      if (!kernel || !sameIdentity(kernel.operatorAddress, actor)) {
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

/**
 * Human-node skill capabilities — gateway routes.
 *
 * Nine endpoints under `/api/skills/*` that make humans first-class capability
 * providers: register a skill, discover skills by type / location / rate /
 * reputation, hire a skill (creates a `SkillJob`), and drive that job through
 * its accept → start → complete lifecycle. Completion proof rides the existing
 * capture flow's shape (photo + WebAuthn); payout rides the existing fiat-ramp
 * endpoints. Escrow wiring is a follow-on PR (the job carries an `escrowId`
 * slot).
 *
 * Storage: SQLite via @pcc/store (skill_capabilities + skill_jobs), following
 * the marketplace / requests persistence pattern — skills and jobs survive
 * gateway redeploys. The full SkillCapability / SkillJob lives in a JSON column
 * alongside the scalar columns the discovery filters use.
 *
 * Pattern fidelity: Zod `safeParse` guards every body/query, error responses
 * use the `{ error, message, details? }` shape, ids are minted with
 * `randomUUID()`, and the haversine helper is the same formula used by
 * `@pcc/dht`'s location filter.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  SkillRegistrationSchema,
  SkillUpdateSchema,
  SkillHireSchema,
  SkillJobAcceptSchema,
  CompletionProofSchema,
  type SkillCapability,
  type SkillJob,
} from "@pcc/spec";
import { schema, eq } from "@pcc/store";
import { getStore, initStore } from "../db.js";

// ---------------------------------------------------------------------------
// Store access — see compose.ts for the lazy-init rationale.
// ---------------------------------------------------------------------------

function db() {
  try {
    return getStore().db;
  } catch {
    if (
      (process.env.VITEST || process.env.NODE_ENV === "test") &&
      !process.env.PCC_DB_PATH &&
      !process.env.DATABASE_URL
    ) {
      process.env.PCC_DB_PATH = ":memory:";
    }
    return initStore({ seed: false }).db;
  }
}

const DEFAULT_SERVICE_RADIUS_KM = 50;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const REPUTATION_PER_COMPLETION = 20;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function listSkills(): SkillCapability[] {
  const rows = db().select().from(schema.skillCapabilities).all();
  return rows.map((r) => r.data as SkillCapability);
}

function getSkill(id: string): SkillCapability | undefined {
  const row = db()
    .select()
    .from(schema.skillCapabilities)
    .where(eq(schema.skillCapabilities.id, id))
    .get();
  return row ? (row.data as SkillCapability) : undefined;
}

function saveSkill(s: SkillCapability): void {
  const cols = {
    humanDid: s.humanDid,
    skillType: s.skillType,
    hourlyRateUsd: s.hourlyRateUSD,
    reputation: s.reputation,
    active: s.active,
    updatedAt: s.updatedAt,
    data: s,
  };
  db()
    .insert(schema.skillCapabilities)
    .values({ id: s.id, createdAt: s.registeredAt, ...cols })
    .onConflictDoUpdate({ target: schema.skillCapabilities.id, set: cols })
    .run();
}

function getJob(jobId: string): SkillJob | undefined {
  const row = db()
    .select()
    .from(schema.skillJobs)
    .where(eq(schema.skillJobs.jobId, jobId))
    .get();
  return row ? (row.data as SkillJob) : undefined;
}

function listJobsForSkill(skillId: string): SkillJob[] {
  const rows = db()
    .select()
    .from(schema.skillJobs)
    .where(eq(schema.skillJobs.skillId, skillId))
    .all();
  return rows.map((r) => r.data as SkillJob);
}

function saveJob(j: SkillJob): void {
  const cols = {
    skillId: j.skillId,
    status: j.status,
    updatedAt: j.updatedAt,
    data: j,
  };
  db()
    .insert(schema.skillJobs)
    .values({ jobId: j.jobId, createdAt: j.createdAt, ...cols })
    .onConflictDoUpdate({ target: schema.skillJobs.jobId, set: cols })
    .run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in km between two `{ lat, lng }` points. */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Clamp a reputation score to the inclusive 0..1000 range. */
function clampReputation(r: number): number {
  return Math.max(0, Math.min(1000, r));
}

/**
 * Send a 409 conflict with a `status` discriminator so callers can branch on
 * the specific business rule that failed (e.g. `"out_of_range"`). Carries the
 * same value in `error` for consumers that read the standard error shape.
 */
function conflict(reply: FastifyReply, status: string, message: string): FastifyReply {
  return reply.status(409).send({ error: status, status, message });
}

// ---------------------------------------------------------------------------
// Query schema (GET /api/skills filter + pagination)
// ---------------------------------------------------------------------------

const ListSkillsQuerySchema = z.object({
  skillType: z.string().min(1).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radiusKm: z.coerce.number().nonnegative().optional(),
  minRate: z.coerce.number().optional(),
  maxRate: z.coerce.number().optional(),
  minReputation: z.coerce.number().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
});

const ListSkillJobsQuerySchema = z.object({
  status: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function skillsRoutes(app: FastifyInstance): Promise<void> {
  // ═════════════════════════════════════════════════════════════════
  // POST /api/skills/register — a human registers a skill
  // ═════════════════════════════════════════════════════════════════

  app.post("/api/skills/register", async (req, reply) => {
    const parsed = SkillRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Invalid skill registration body",
        details: parsed.error.flatten(),
      });
    }

    const now = new Date().toISOString();
    const skill: SkillCapability = {
      id: `skill_${randomUUID()}`,
      humanDid: parsed.data.humanDid,
      name: parsed.data.name,
      description: parsed.data.description,
      skillType: parsed.data.skillType,
      certifications: parsed.data.certifications ?? [],
      hourlyRateUSD: parsed.data.hourlyRateUSD,
      location: parsed.data.location,
      serviceRadiusKm: parsed.data.serviceRadiusKm ?? DEFAULT_SERVICE_RADIUS_KM,
      weeklyAvailableHours: parsed.data.weeklyAvailableHours,
      reputation: 0,
      completedJobs: 0,
      active: true,
      registeredAt: now,
      updatedAt: now,
    };
    saveSkill(skill);
    return reply.status(201).send(skill);
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /api/skills — paginated discovery with filters
  // ═════════════════════════════════════════════════════════════════

  app.get("/api/skills", async (req, reply) => {
    const parsed = ListSkillsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_query",
        message: "Invalid query params",
        details: parsed.error.flatten(),
      });
    }
    const q = parsed.data;
    let list = listSkills();

    if (q.skillType !== undefined) {
      const t = q.skillType;
      list = list.filter((s) => s.skillType === t);
    }
    // Location intersection: the poster's point must be within
    // (radiusKm + skill.serviceRadiusKm) of the skill's location. radiusKm is
    // the poster's own search radius (0 if omitted) — added to the skill's
    // advertised service radius.
    if (q.lat !== undefined && q.lng !== undefined) {
      const point = { lat: q.lat, lng: q.lng };
      const extra = q.radiusKm ?? 0;
      list = list.filter(
        (s) => haversineKm(point, s.location) <= extra + s.serviceRadiusKm,
      );
    }
    if (q.minRate !== undefined) {
      const minRate = q.minRate;
      list = list.filter((s) => s.hourlyRateUSD >= minRate);
    }
    if (q.maxRate !== undefined) {
      const maxRate = q.maxRate;
      list = list.filter((s) => s.hourlyRateUSD <= maxRate);
    }
    if (q.minReputation !== undefined) {
      const minRep = q.minReputation;
      list = list.filter((s) => s.reputation >= minRep);
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? DEFAULT_LIMIT;
    const total = list.length;
    const entries = list.slice(offset, offset + limit);
    return { entries, total, offset, limit };
  });

  // ═════════════════════════════════════════════════════════════════
  // GET /api/skills/:id — single skill
  // ═════════════════════════════════════════════════════════════════

  app.get<{ Params: { id: string } }>("/api/skills/:id", async (req, reply) => {
    const skill = getSkill(req.params.id);
    if (!skill) {
      return reply.status(404).send({
        error: "not_found",
        message: `No skill with id=${req.params.id}`,
      });
    }
    return skill;
  });

  // ═════════════════════════════════════════════════════════════════
  // PATCH /api/skills/:id — humanDid-gated edit
  // ═════════════════════════════════════════════════════════════════

  app.patch<{ Params: { id: string } }>("/api/skills/:id", async (req, reply) => {
    const parsed = SkillUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Invalid skill update body",
        details: parsed.error.flatten(),
      });
    }

    const skill = getSkill(req.params.id);
    if (!skill) {
      return reply.status(404).send({
        error: "not_found",
        message: `No skill with id=${req.params.id}`,
      });
    }
    if (parsed.data.humanDid !== skill.humanDid) {
      return reply.status(403).send({
        error: "forbidden",
        message: "humanDid does not match the skill owner",
      });
    }

    if (parsed.data.description !== undefined) skill.description = parsed.data.description;
    if (parsed.data.hourlyRateUSD !== undefined) skill.hourlyRateUSD = parsed.data.hourlyRateUSD;
    if (parsed.data.serviceRadiusKm !== undefined) skill.serviceRadiusKm = parsed.data.serviceRadiusKm;
    if (parsed.data.weeklyAvailableHours !== undefined)
      skill.weeklyAvailableHours = parsed.data.weeklyAvailableHours;
    if (parsed.data.active !== undefined) skill.active = parsed.data.active;
    skill.updatedAt = new Date().toISOString();
    saveSkill(skill);
    return skill;
  });

  // ═════════════════════════════════════════════════════════════════
  // POST /api/skills/:id/hire — poster creates a job for a skill
  // ═════════════════════════════════════════════════════════════════

  app.post<{ Params: { id: string } }>("/api/skills/:id/hire", async (req, reply) => {
    const parsed = SkillHireSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Invalid hire body",
        details: parsed.error.flatten(),
      });
    }
    const body = parsed.data;

    const skill = getSkill(req.params.id);
    if (!skill) {
      return reply.status(404).send({
        error: "not_found",
        message: `No skill with id=${req.params.id}`,
      });
    }
    if (!skill.active) {
      return conflict(reply, "inactive_skill", "Skill is not accepting jobs");
    }
    if (haversineKm(body.location, skill.location) > skill.serviceRadiusKm) {
      return conflict(
        reply,
        "out_of_range",
        `Job location is outside the skill's ${skill.serviceRadiusKm}km service radius`,
      );
    }
    if (body.minReputation !== undefined && skill.reputation < body.minReputation) {
      return conflict(
        reply,
        "reputation_too_low",
        `Skill reputation ${skill.reputation} is below required ${body.minReputation}`,
      );
    }
    const minBudget = skill.hourlyRateUSD * body.expectedDurationHours;
    if (body.budgetUSD < minBudget) {
      return conflict(
        reply,
        "budget_insufficient",
        `Budget ${body.budgetUSD} is below ${minBudget} (rate ${skill.hourlyRateUSD} × ${body.expectedDurationHours}h)`,
      );
    }

    const now = new Date().toISOString();
    const job: SkillJob = {
      jobId: `sjob_${randomUUID()}`,
      skillId: skill.id,
      posterDid: body.posterDid,
      description: body.description,
      budgetUSD: body.budgetUSD,
      expectedDurationHours: body.expectedDurationHours,
      location: body.location,
      status: "pending_acceptance",
      createdAt: now,
      updatedAt: now,
    };
    saveJob(job);
    return reply.status(201).send(job);
  });

  // ═════════════════════════════════════════════════════════════════
  // POST /api/skills/jobs/:jobId/accept — skill owner accepts the job
  // ═════════════════════════════════════════════════════════════════

  app.post<{ Params: { jobId: string } }>(
    "/api/skills/jobs/:jobId/accept",
    async (req, reply) => {
      const parsed = SkillJobAcceptSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid accept body",
          details: parsed.error.flatten(),
        });
      }

      const job = getJob(req.params.jobId);
      if (!job) {
        return reply.status(404).send({
          error: "not_found",
          message: `No job with jobId=${req.params.jobId}`,
        });
      }
      if (job.status !== "pending_acceptance") {
        return conflict(
          reply,
          "invalid_status",
          `Job is ${job.status}, expected pending_acceptance`,
        );
      }
      const skill = getSkill(job.skillId);
      if (!skill) {
        return reply.status(404).send({
          error: "not_found",
          message: `Skill ${job.skillId} for this job no longer exists`,
        });
      }
      if (parsed.data.humanDid !== skill.humanDid) {
        return reply.status(403).send({
          error: "forbidden",
          message: "humanDid does not match the skill owner",
        });
      }

      const now = new Date().toISOString();
      job.status = "accepted";
      job.acceptedAt = now;
      job.updatedAt = now;
      saveJob(job);
      return job;
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // POST /api/skills/jobs/:jobId/start — accepted → in_progress
  // ═════════════════════════════════════════════════════════════════

  app.post<{ Params: { jobId: string } }>(
    "/api/skills/jobs/:jobId/start",
    async (req, reply) => {
      const job = getJob(req.params.jobId);
      if (!job) {
        return reply.status(404).send({
          error: "not_found",
          message: `No job with jobId=${req.params.jobId}`,
        });
      }
      if (job.status !== "accepted") {
        return conflict(
          reply,
          "invalid_status",
          `Job is ${job.status}, expected accepted`,
        );
      }

      const now = new Date().toISOString();
      job.status = "in_progress";
      job.startedAt = now;
      job.updatedAt = now;
      saveJob(job);
      return job;
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // POST /api/skills/jobs/:jobId/complete — in_progress → completed
  // ═════════════════════════════════════════════════════════════════

  app.post<{ Params: { jobId: string } }>(
    "/api/skills/jobs/:jobId/complete",
    async (req, reply) => {
      const parsed = CompletionProofSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid completion proof body",
          details: parsed.error.flatten(),
        });
      }
      const proof = parsed.data;

      const job = getJob(req.params.jobId);
      if (!job) {
        return reply.status(404).send({
          error: "not_found",
          message: `No job with jobId=${req.params.jobId}`,
        });
      }
      if (job.status !== "in_progress") {
        return conflict(
          reply,
          "invalid_status",
          `Job is ${job.status}, expected in_progress`,
        );
      }

      const now = new Date().toISOString();
      job.status = "completed";
      job.completedAt = now;
      job.updatedAt = now;
      if (proof.photoBase64 || proof.webauthnSignature) {
        job.proofBundleId = `proof_${randomUUID()}`;
      }
      saveJob(job);

      // Bump the skill's reputation + completion count. The skill should
      // always exist, but guard defensively so completion never 500s.
      const skill = getSkill(job.skillId);
      if (skill) {
        skill.completedJobs += 1;
        skill.reputation = clampReputation(skill.reputation + REPUTATION_PER_COMPLETION);
        skill.updatedAt = now;
        saveSkill(skill);
      }

      return job;
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // GET /api/skills/jobs/:jobId — single job
  // ═════════════════════════════════════════════════════════════════

  app.get<{ Params: { jobId: string } }>(
    "/api/skills/jobs/:jobId",
    async (req, reply) => {
      const job = getJob(req.params.jobId);
      if (!job) {
        return reply.status(404).send({
          error: "not_found",
          message: `No job with jobId=${req.params.jobId}`,
        });
      }
      return job;
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // GET /api/skills/:id/jobs — jobs for a skill (descending createdAt)
  // ═════════════════════════════════════════════════════════════════

  app.get<{ Params: { id: string } }>(
    "/api/skills/:id/jobs",
    async (req, reply) => {
      const parsed = ListSkillJobsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_query",
          message: "Invalid query params",
          details: parsed.error.flatten(),
        });
      }
      const { status } = parsed.data;
      let entries = listJobsForSkill(req.params.id);
      if (status !== undefined) {
        entries = entries.filter((j) => j.status === status);
      }
      entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { entries, count: entries.length };
    },
  );
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

/** Clear both stores. Test reset hook. */
export function _clearSkillsForTests(): void {
  const d = db();
  d.delete(schema.skillCapabilities).run();
  d.delete(schema.skillJobs).run();
}

/** Preload a fully-formed skill into the store. Test helper. */
export function _seedSkillForTests(skill: SkillCapability): void {
  saveSkill(skill);
}

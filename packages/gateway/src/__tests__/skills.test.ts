import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { SkillCapability } from "@pcc/spec";
import {
  skillsRoutes,
  _clearSkillsForTests,
  _seedSkillForTests,
} from "../routes/skills.js";

let app: FastifyInstance;

// San Francisco / New York — far enough apart (~4100km) to fall outside any
// realistic service radius, used to exercise the location filters.
const SF = { lat: 37.7749, lng: -122.4194 };
const NYC = { lat: 40.7128, lng: -74.006 };

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(skillsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _clearSkillsForTests();
});

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function registerSkill(overrides: Record<string, unknown> = {}) {
  const payload = {
    humanDid: "did:pcc:alice",
    name: "Alice the Plumber",
    description: "Licensed plumber, 10 years",
    skillType: "plumbing",
    hourlyRateUSD: 50,
    location: SF,
    weeklyAvailableHours: 40,
    ...overrides,
  };
  return app.inject({ method: "POST", url: "/api/skills/register", payload });
}

function makeSeedSkill(overrides: Partial<SkillCapability> = {}): SkillCapability {
  const now = new Date().toISOString();
  return {
    id: "skill_seed",
    humanDid: "did:pcc:seed",
    name: "Seeded Skill",
    description: "seeded",
    skillType: "plumbing",
    certifications: [],
    hourlyRateUSD: 50,
    location: SF,
    serviceRadiusKm: 50,
    weeklyAvailableHours: 40,
    reputation: 0,
    completedJobs: 0,
    active: true,
    registeredAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Drive a skill from a fresh hire through accept + start to in_progress. */
async function driveToInProgress(skill: {
  id: string;
  humanDid: string;
  location: { lat: number; lng: number };
  hourlyRateUSD: number;
}): Promise<string> {
  const hireRes = await app.inject({
    method: "POST",
    url: `/api/skills/${skill.id}/hire`,
    payload: {
      posterDid: "did:pcc:bob",
      description: "Fix the kitchen sink",
      budgetUSD: skill.hourlyRateUSD * 2,
      expectedDurationHours: 2,
      location: skill.location,
    },
  });
  const job = hireRes.json();
  await app.inject({
    method: "POST",
    url: `/api/skills/jobs/${job.jobId}/accept`,
    payload: { humanDid: skill.humanDid },
  });
  await app.inject({
    method: "POST",
    url: `/api/skills/jobs/${job.jobId}/start`,
    payload: {},
  });
  return job.jobId as string;
}

// ───────────────────────────────────────────────────────────────────────────
// POST /api/skills/register
// ───────────────────────────────────────────────────────────────────────────

describe("POST /api/skills/register", () => {
  it("creates a skill (201) with reputation=0, completedJobs=0, defaults", async () => {
    const res = await registerSkill();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^skill_/);
    expect(body.reputation).toBe(0);
    expect(body.completedJobs).toBe(0);
    expect(body.active).toBe(true);
    expect(body.serviceRadiusKm).toBe(50); // default applied when omitted
    expect(body.certifications).toEqual([]);
    expect(body.registeredAt).toBeDefined();
  });

  it("rejects an invalid payload (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skills/register",
      payload: { humanDid: "did:pcc:alice" }, // missing name, skillType, rate, ...
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/skills (discovery + filters + pagination)
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/skills", () => {
  it("returns the empty default shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], total: 0, offset: 0, limit: 20 });
  });

  it("filters by skillType", async () => {
    await registerSkill({ skillType: "plumbing" });
    await registerSkill({ skillType: "hvac-repair" });
    const res = await app.inject({
      method: "GET",
      url: "/api/skills?skillType=hvac-repair",
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.entries[0].skillType).toBe("hvac-repair");
  });

  it("filters by location radius", async () => {
    await registerSkill({ location: SF });
    await registerSkill({ location: NYC });
    const res = await app.inject({
      method: "GET",
      url: `/api/skills?lat=${SF.lat}&lng=${SF.lng}&radiusKm=10`,
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.entries[0].location.lat).toBeCloseTo(SF.lat);
  });

  it("filters by rate range (minRate + maxRate)", async () => {
    await registerSkill({ hourlyRateUSD: 30 });
    await registerSkill({ hourlyRateUSD: 50 });
    await registerSkill({ hourlyRateUSD: 80 });
    const res = await app.inject({
      method: "GET",
      url: "/api/skills?minRate=40&maxRate=60",
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.entries[0].hourlyRateUSD).toBe(50);
  });

  it("filters by minReputation", async () => {
    await registerSkill(); // reputation 0
    _seedSkillForTests(makeSeedSkill({ id: "skill_high", reputation: 500 }));
    const res = await app.inject({
      method: "GET",
      url: "/api/skills?minReputation=100",
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.entries[0].id).toBe("skill_high");
  });

  it("paginates with offset + limit", async () => {
    await registerSkill();
    await registerSkill();
    await registerSkill();
    const res = await app.inject({
      method: "GET",
      url: "/api/skills?offset=1&limit=1",
    });
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.entries).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/skills/:id
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/skills/:id", () => {
  it("returns a single skill, 404 for unknown", async () => {
    const created = (await registerSkill()).json();
    const ok = await app.inject({ method: "GET", url: `/api/skills/${created.id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(created.id);

    const missing = await app.inject({ method: "GET", url: "/api/skills/skill_nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("not_found");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /api/skills/:id
// ───────────────────────────────────────────────────────────────────────────

describe("PATCH /api/skills/:id", () => {
  it("succeeds with a matching humanDid", async () => {
    const created = (await registerSkill()).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/skills/${created.id}`,
      payload: { humanDid: "did:pcc:alice", hourlyRateUSD: 99, active: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hourlyRateUSD).toBe(99);
    expect(body.active).toBe(false);
  });

  it("rejects a mismatched humanDid (403)", async () => {
    const created = (await registerSkill()).json();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/skills/${created.id}`,
      payload: { humanDid: "did:pcc:mallory", description: "hijack" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/skills/:id/hire
// ───────────────────────────────────────────────────────────────────────────

describe("POST /api/skills/:id/hire", () => {
  it("creates a job for an active skill (201)", async () => {
    const skill = (await registerSkill()).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/hire`,
      payload: {
        posterDid: "did:pcc:bob",
        description: "Fix the sink",
        budgetUSD: 200,
        expectedDurationHours: 2,
        location: SF,
      },
    });
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.jobId).toMatch(/^sjob_/);
    expect(job.skillId).toBe(skill.id);
    expect(job.status).toBe("pending_acceptance");
  });

  it("rejects an inactive skill (409 inactive_skill)", async () => {
    const skill = (await registerSkill()).json();
    await app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}`,
      payload: { humanDid: "did:pcc:alice", active: false },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/hire`,
      payload: {
        posterDid: "did:pcc:bob",
        description: "x",
        budgetUSD: 200,
        expectedDurationHours: 2,
        location: SF,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe("inactive_skill");
  });

  it("rejects an insufficient budget (409 budget_insufficient)", async () => {
    const skill = (await registerSkill({ hourlyRateUSD: 50 })).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/hire`,
      payload: {
        posterDid: "did:pcc:bob",
        description: "x",
        budgetUSD: 50, // needs 50 * 2 = 100
        expectedDurationHours: 2,
        location: SF,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe("budget_insufficient");
  });

  it("rejects an out-of-range location (409 out_of_range)", async () => {
    const skill = (await registerSkill({ location: SF })).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/hire`,
      payload: {
        posterDid: "did:pcc:bob",
        description: "x",
        budgetUSD: 200,
        expectedDurationHours: 2,
        location: NYC,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe("out_of_range");
  });

  it("rejects low reputation when minReputation is set (409 reputation_too_low)", async () => {
    const skill = (await registerSkill()).json(); // reputation 0
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/hire`,
      payload: {
        posterDid: "did:pcc:bob",
        description: "x",
        budgetUSD: 200,
        expectedDurationHours: 2,
        location: SF,
        minReputation: 100,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe("reputation_too_low");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Job lifecycle: accept → start → complete
// ───────────────────────────────────────────────────────────────────────────

describe("job lifecycle", () => {
  it("accept transitions pending_acceptance → accepted", async () => {
    const skill = (await registerSkill()).json();
    const job = (
      await app.inject({
        method: "POST",
        url: `/api/skills/${skill.id}/hire`,
        payload: {
          posterDid: "did:pcc:bob",
          description: "x",
          budgetUSD: 200,
          expectedDurationHours: 2,
          location: SF,
        },
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${job.jobId}/accept`,
      payload: { humanDid: "did:pcc:alice" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("accepted");
    expect(body.acceptedAt).toBeDefined();
  });

  it("accept rejects a mismatched humanDid (403)", async () => {
    const skill = (await registerSkill()).json();
    const job = (
      await app.inject({
        method: "POST",
        url: `/api/skills/${skill.id}/hire`,
        payload: {
          posterDid: "did:pcc:bob",
          description: "x",
          budgetUSD: 200,
          expectedDurationHours: 2,
          location: SF,
        },
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${job.jobId}/accept`,
      payload: { humanDid: "did:pcc:mallory" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("start transitions accepted → in_progress with a timestamp", async () => {
    const skill = (await registerSkill()).json();
    const job = (
      await app.inject({
        method: "POST",
        url: `/api/skills/${skill.id}/hire`,
        payload: {
          posterDid: "did:pcc:bob",
          description: "x",
          budgetUSD: 200,
          expectedDurationHours: 2,
          location: SF,
        },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${job.jobId}/accept`,
      payload: { humanDid: "did:pcc:alice" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${job.jobId}/start`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("in_progress");
    expect(body.startedAt).toBeDefined();
  });

  it("start rejects a job in the wrong status (409)", async () => {
    const skill = (await registerSkill()).json();
    const job = (
      await app.inject({
        method: "POST",
        url: `/api/skills/${skill.id}/hire`,
        payload: {
          posterDid: "did:pcc:bob",
          description: "x",
          budgetUSD: 200,
          expectedDurationHours: 2,
          location: SF,
        },
      })
    ).json();
    // No accept — still pending_acceptance.
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${job.jobId}/start`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it("complete transitions in_progress → completed, increments completedJobs, bumps reputation", async () => {
    const skill = (await registerSkill()).json();
    const jobId = await driveToInProgress(skill);
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${jobId}/complete`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");

    const after = (await app.inject({ method: "GET", url: `/api/skills/${skill.id}` })).json();
    expect(after.completedJobs).toBe(1);
    expect(after.reputation).toBe(20);
  });

  it("complete sets proofBundleId when photoBase64 is supplied", async () => {
    const skill = (await registerSkill()).json();
    const jobId = await driveToInProgress(skill);
    const res = await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${jobId}/complete`,
      payload: { photoBase64: "iVBORw0KGgoAAAANS", notes: "done" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proofBundleId).toMatch(/^proof_/);
  });

  it("complete clamps reputation at 1000", async () => {
    _seedSkillForTests(makeSeedSkill({ id: "skill_cap", reputation: 990 }));
    const jobId = await driveToInProgress({
      id: "skill_cap",
      humanDid: "did:pcc:seed",
      location: SF,
      hourlyRateUSD: 50,
    });
    await app.inject({
      method: "POST",
      url: `/api/skills/jobs/${jobId}/complete`,
      payload: {},
    });
    const after = (await app.inject({ method: "GET", url: "/api/skills/skill_cap" })).json();
    expect(after.reputation).toBe(1000); // 990 + 20 clamped to 1000
    expect(after.completedJobs).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Job queries
// ───────────────────────────────────────────────────────────────────────────

describe("job queries", () => {
  it("GET job returns it, 404 for unknown", async () => {
    const skill = (await registerSkill()).json();
    const job = (
      await app.inject({
        method: "POST",
        url: `/api/skills/${skill.id}/hire`,
        payload: {
          posterDid: "did:pcc:bob",
          description: "x",
          budgetUSD: 200,
          expectedDurationHours: 2,
          location: SF,
        },
      })
    ).json();
    const ok = await app.inject({ method: "GET", url: `/api/skills/jobs/${job.jobId}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().jobId).toBe(job.jobId);

    const missing = await app.inject({ method: "GET", url: "/api/skills/jobs/sjob_nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("GET skill jobs returns an array, filterable by status", async () => {
    const skill = (await registerSkill()).json();
    // Two jobs: one stays pending, one is driven to in_progress.
    await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/hire`,
      payload: {
        posterDid: "did:pcc:bob",
        description: "pending one",
        budgetUSD: 200,
        expectedDurationHours: 2,
        location: SF,
      },
    });
    await driveToInProgress(skill);

    const all = (
      await app.inject({ method: "GET", url: `/api/skills/${skill.id}/jobs` })
    ).json();
    expect(all.count).toBe(2);
    expect(all.entries).toHaveLength(2);

    const inProgress = (
      await app.inject({
        method: "GET",
        url: `/api/skills/${skill.id}/jobs?status=in_progress`,
      })
    ).json();
    expect(inProgress.count).toBe(1);
    expect(inProgress.entries[0].status).toBe("in_progress");
  });
});

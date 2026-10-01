/**
 * Tests for the job-status vocabulary on PATCH /api/jobs/:jobId/status.
 *
 * Regression guard for the running↔in_progress mismatch: the API canonicalised
 * on `in_progress`, but the agent docs advertised `running`, so doc-following
 * clients got a 400. The route now accepts the full canonical set and tolerates
 * `running` as an input alias, normalising it to `in_progress`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { JOB_STATUSES, normalizeJobStatus } from "../config/job-status.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

async function patchStatus(
  app: FastifyInstance,
  jobId: string,
  status: string,
) {
  return app.inject({
    method: "PATCH",
    url: `/api/jobs/${jobId}/status`,
    payload: { status },
  });
}

describe("PATCH /api/jobs/:jobId/status — status vocabulary", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("accepts the canonical `in_progress` status (the value the docs now advertise)", async () => {
    // job-003 is seeded as "queued"
    const res = await patchStatus(app, "job-003", "in_progress");
    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe("in_progress");
  });

  it("tolerates the legacy `running` alias and normalises it to `in_progress`", async () => {
    const res = await patchStatus(app, "job-001", "running");
    expect(res.statusCode).toBe(200);
    // Stored + returned vocabulary stays canonical — never echoes the alias.
    expect(res.json().job.status).toBe("in_progress");
  });

  it("accepts every canonical status without a 400", async () => {
    for (const status of JOB_STATUSES) {
      const res = await patchStatus(app, "job-001", status);
      expect(res.statusCode, `status ${status} should be accepted`).toBe(200);
      expect(res.json().job.status).toBe(status);
    }
  });

  it("rejects an unknown status with 400 and lists the canonical set", async () => {
    const res = await patchStatus(app, "job-001", "bogus");
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_status");
    // Advertises the canonical vocabulary, including in_progress…
    expect(body.message).toContain("in_progress");
    // …and does not present the alias as a canonical value.
    expect(body.message).not.toContain("running");
  });

  it("persists the normalised status (visible on subsequent GET)", async () => {
    await patchStatus(app, "job-002", "running");
    const res = await app.inject({ method: "GET", url: "/api/jobs/job-002" });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe("in_progress");
  });
});

// ── Inherited property names are not statuses ───────────────────────────────
// normalizeJobStatus resolved the alias through a plain-object index, so it
// read INHERITED properties: "constructor", "toString", "__proto__" and the
// like came back as a function or an object. That is truthy, so it passed the
// validation and then failed at the database bind (a 500) instead of a 400.

const INHERITED = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
  "__defineGetter__",
  "__lookupGetter__",
];

describe("normalizeJobStatus reads OWN keys only", () => {
  it.each(INHERITED)("[neg] the inherited property name %s is not a status: null", (name) => {
    expect(normalizeJobStatus(name)).toBeNull();
  });

  it("control: every canonical status is itself and the one alias still normalizes", () => {
    for (const status of JOB_STATUSES) expect(normalizeJobStatus(status)).toBe(status);
    expect(normalizeJobStatus("running")).toBe("in_progress");
    expect(normalizeJobStatus("flying")).toBeNull();
  });

  it("control: a value that is not a string is not a status, and does not throw", () => {
    for (const value of [123, null, undefined, {}, [], true]) {
      expect(normalizeJobStatus(value as never), String(value)).toBeNull();
    }
  });
});

describe("PATCH /api/jobs/:jobId/status — an inherited property name is a 400, never a 500", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it.each(INHERITED)("[neg] status %s: 400 invalid_status and the job is untouched", async (name) => {
    const before = getRepos().jobs.findById("job-001")?.status;
    const res = await patchStatus(app, "job-001", name);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("invalid_status");
    expect(getRepos().jobs.findById("job-001")?.status).toBe(before);
  });
});

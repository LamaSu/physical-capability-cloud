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
import { JOB_STATUSES } from "../config/job-status.js";
import { actAsJobParty, SEED_OPERATORS } from "./helpers/job-read-party.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });

  actAsJobParty(app, null); // job reads are object-authorized (F3); the GET below names its caller
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
    // Seeded "executing", the local kernel's own status, which a generic writer
    // never overwrites (N85); start it queued.
    getRepos().jobs.updateStatus("job-001", "queued");
    const res = await patchStatus(app, "job-001", "running");
    expect(res.statusCode).toBe(200);
    // Stored + returned vocabulary stays canonical — never echoes the alias.
    expect(res.json().job.status).toBe("in_progress");
  });

  it("accepts every canonical status without a 400", async () => {
    // job-bio-42 has no settlement record (its workflow has no escrow). On a paid
    // job the terminal statuses belong to its settlement path (N85,
    // settlement-owned-status.test.ts). It is seeded "executing", the local
    // kernel's own status, and a completed job is closed too: a generic writer
    // moves neither. So start each target from queued, not from the last target.
    for (const status of JOB_STATUSES) {
      getRepos().jobs.updateStatus("job-bio-42", "queued");
      const res = await patchStatus(app, "job-bio-42", status);
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
    getRepos().jobs.updateStatus("job-002", "queued"); // seeded "executing", as above
    await patchStatus(app, "job-002", "running");
    // job-002 runs on kernel-sf; its operator reads it.
    const res = await app.inject({ method: "GET", url: "/api/jobs/job-002", headers: { "x-test-principal": SEED_OPERATORS["kernel-sf"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe("in_progress");
  });
});

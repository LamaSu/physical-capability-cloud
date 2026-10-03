/**
 * A kernel in emergency stop takes no new work, on every path (adk #4446).
 *
 * kernel-estop-job-submit.test.ts covers POST /api/jobs/submit. This file covers
 * the other places a job is created on a kernel, and the queues that hand work
 * to a kernel's node:
 *
 * JOB-CREATING paths. Each must refuse a kernel whose stored policy has
 * `emergencyStop: true` with 409 `kernel_emergency_stopped`, before any write or
 * escrow, and must answer 503 `policy_unavailable` (never "not stopped") when the
 * policy cannot be read. No policy row means not stopped.
 *   - JobFacade.submit (POST /api/jobs/submit, and the composition executor)
 *   - createJobFromSession (every paid path)
 *   - POST /api/negotiate/session/:id/commit and /retry-settlement: a session made
 *     BEFORE the stop must not be committed after it
 *   - the A2A commit leg (pcc-submit)
 *   - POST /api/setup/test-job
 *
 * DISPATCH paths. The queue a node polls must not hand out work to start for a
 * stopped kernel:
 *   - GET /api/operator/jobs (queued, pending and paused jobs) answers 200 with
 *     an empty queue and `emergencyStop: true`;
 *   - GET /api/operator/approvals?status=approved (the queue the OT-2 daemon
 *     polls) does the same. The stop itself rejects only PENDING approvals, so
 *     an approval granted before the stop was still handed out.
 * A node treats a non-200 as "no jobs" and falls back to the public job list on
 * a 404, so a stopped kernel's queue is a 200 with nothing in it: it reads as an
 * empty queue to an old node and says why to a new one. An unreadable policy is
 * a 503, never an answer from the queue.
 *
 * This file imports only modules that exist before the change, so it runs
 * unchanged on the old code and every [repro] case fails there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq, sql } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { setupRoutes } from "../routes/setup.js";
import { createJobFromSession } from "../routes/paid-job-flow.js";
import { commitPccSession, createPccQuote } from "../routes/a2a-tasks.js";
import { createProductionBinding } from "../routes/compose.js";
import { getJobFacade } from "../facades/index.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";

const { jobs, negotiationSessions, executionScopes, escrows, pendingApprovals } = schema;

// The gateway's own in-process kernel is a test double here. `ready` stays false
// (JobFacade treats an uninitialised service as "external kernel", the production
// shape) except where a test sets it for POST /api/setup/test-job.
const ks = vi.hoisted(() => ({
  ready: false,
  localKernelId: "kernel-local-stub",
  submitJob: vi.fn(),
}));
vi.mock("../services/kernel-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/kernel-service.js")>();
  return {
    ...original,
    getKernelService: () => {
      if (!ks.ready) throw new Error("[kernel-service] Not initialised");
      return {
        config: { kernelId: ks.localKernelId },
        submitJob: ks.submitJob,
        getJobStatus: async () => ({ status: "completed", progress: 100 }),
      };
    },
  };
});

const OWNER = "estop-paths-owner@x.test";
const BUYER = "estop-paths-buyer@x.test";
const ADMIN_SECRET = "estop-paths-admin-secret";
const savedAdminKey = process.env.PCC_ADMIN_KEY;
const savedMockSettlement = process.env.MOCK_SETTLEMENT;
const UNREADABLE = "{not json";
const STOPPED = "kernel_emergency_stopped";
const UNAVAILABLE = "policy_unavailable";

/** apiGate in front: the owner-guarded operator routes. */
let app: FastifyInstance;
/** No apiGate: the negotiation and setup routes carry no identity of their own. */
let negApp: FastifyInstance;
let setupApp: FastifyInstance;
let ownerKey = "";
let buyerKey = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const asBuyer = () => ({ authorization: `Bearer ${buyerKey}` });
const asAdmin = () => ({ ...asBuyer(), "x-admin-key": ADMIN_SECRET });

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A kernel registered by OWNER through the real write path, with one fdm capability. */
async function ownedKernel(prefix: string): Promise<{ kernelId: string; capabilityId: string }> {
  const kernelId = uid(prefix);
  const res = await app.inject({
    method: "POST",
    url: "/api/kernels",
    headers: asOwner(),
    payload: { id: kernelId, name: `Estop ${kernelId}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  const capabilityId = `cap-${kernelId}-fdm`;
  getRepos().capabilities.insert({
    id: capabilityId,
    kernelId,
    type: "fdm",
    name: "FDM",
    materials: ["PLA"],
    assuranceTiers: [0],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
  return { kernelId, capabilityId };
}

const stop = async (kernelId: string) => {
  const res = await app.inject({
    method: "POST",
    url: "/api/operator/emergency-stop",
    headers: asOwner(),
    payload: { kernelId, reason: "estop-paths test" },
  });
  expect(res.statusCode, res.body).toBe(200);
};
const resume = async (kernelId: string) => {
  const res = await app.inject({
    method: "POST",
    url: "/api/operator/emergency-resume",
    headers: asOwner(),
    payload: { kernelId },
  });
  expect(res.statusCode, res.body).toBe(200);
};

/** Overwrite the stored policy with garbage: the row exists but cannot be read. */
function makeUnreadable(kernelId: string): void {
  getStore().db.run(
    sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
        VALUES (${kernelId}, ${UNREADABLE}, ${new Date().toISOString()}, ${"test"})`,
  );
}

const jobsFor = (kernelId: string) =>
  getStore().db.select().from(jobs).all().filter((j) => j.kernelId === kernelId).length;
const scopesFor = (kernelId: string) =>
  getStore().db.select().from(executionScopes).all().filter((s) => s.kernelId === kernelId).length;
const escrowCount = () => getStore().db.select().from(escrows).all().length;
const sessionRow = (id: string) =>
  getStore().db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();

/** Nothing was created for the kernel: no job, no scope. */
function expectNothingCreated(kernelId: string): void {
  expect(jobsFor(kernelId), "jobs").toBe(0);
  expect(scopesFor(kernelId), "execution scopes").toBe(0);
}

/** A negotiation session driven to "reviewing" (create, quote, review), ready for /commit. */
async function reviewedSession(kernelId: string): Promise<string> {
  const created = await negApp.inject({
    method: "POST",
    url: "/api/negotiate/session",
    payload: { userAgentId: uid("agent"), kernelId, capabilityType: "fdm" },
  });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().session.id as string;
  expect((await negApp.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` })).statusCode).toBe(200);
  expect((await negApp.inject({ method: "POST", url: `/api/negotiate/session/${id}/review` })).statusCode).toBe(200);
  expect(sessionRow(id)?.status).toBe("reviewing");
  return id;
}

function insertQueuedJob(kernelId: string, status = "queued"): string {
  const id = uid("job-estop");
  getRepos().jobs.insert({
    id,
    stepId: `step-${id}`,
    cwmId: `cwm-${id}`,
    capabilityId: `cap-${kernelId}-fdm`,
    kernelId,
    status,
    assignedDevices: [],
    startedAt: new Date().toISOString(),
    progress: 0,
    assuranceTier: 0,
  } as never);
  return id;
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  buyerKey = provisionApiKey({ operatorId: BUYER, scopes: ["operator"] }).rawKey;

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();

  negApp = Fastify({ logger: false });
  await negApp.register(negotiationRoutes);
  await negApp.ready();

  setupApp = Fastify({ logger: false });
  await setupApp.register(setupRoutes);
  await setupApp.ready();
});

afterAll(async () => {
  await app.close();
  await negApp.close();
  await setupApp.close();
  closeStore();
  if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedAdminKey;
  if (savedMockSettlement === undefined) delete process.env.MOCK_SETTLEMENT;
  else process.env.MOCK_SETTLEMENT = savedMockSettlement;
});

beforeEach(() => {
  ks.ready = false;
  ks.localKernelId = "kernel-local-stub";
  ks.submitJob.mockReset();
  ks.submitJob.mockResolvedValue({ jobId: "test-job-stub", deviceId: "dev-stub", status: "accepted" });
});

// ═════════════════════════════════════════════════════════════════════════════
// JOB-CREATING PATHS
// ═════════════════════════════════════════════════════════════════════════════

describe("JobFacade.submit (POST /api/jobs/submit, the composition executor)", () => {
  const submit = (kernelId: string, capabilityId: string) =>
    getJobFacade().submit({ stepId: uid("step"), kernelId, capabilityId }, BUYER);

  it("control: with no policy row the job is accepted", async () => {
    const { kernelId, capabilityId } = await ownedKernel("facade-open");
    const result = await submit(kernelId, capabilityId);
    expect(result.success).toBe(true);
    expect(jobsFor(kernelId)).toBe(1);
  });

  it("[repro] a stopped kernel is refused 409 kernel_emergency_stopped, and nothing is written", async () => {
    const { kernelId, capabilityId } = await ownedKernel("facade-stop");
    await stop(kernelId);
    const result = await submit(kernelId, capabilityId);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(STOPPED);
    expect(result.error.httpStatus).toBe(409);
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("a policy PUT can no longer act as a side-door stop (refvertical #4850): refused 400, the kernel still takes jobs", async () => {
    const { kernelId, capabilityId } = await ownedKernel("facade-put");
    const put = await app.inject({
      method: "PUT",
      url: `/api/operator/policy/${kernelId}`,
      headers: asOwner(),
      payload: { version: 1, approvalMode: "manual", emergencyStop: true },
    });
    expect(put.statusCode, put.body).toBe(400);
    expect(put.json().error).toBe("emergency_stop_immutable_via_policy_write");
    // The refused PUT changed nothing: the kernel is NOT stopped as a side effect.
    const result = await submit(kernelId, capabilityId);
    expect(result.success).toBe(true);
    expect(jobsFor(kernelId)).toBe(1);
  });

  it("control: a policy with emergencyStop false takes jobs", async () => {
    const { kernelId, capabilityId } = await ownedKernel("facade-false");
    const put = await app.inject({
      method: "PUT",
      url: `/api/operator/policy/${kernelId}`,
      headers: asOwner(),
      payload: { version: 1, approvalMode: "manual", emergencyStop: false },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect((await submit(kernelId, capabilityId)).success).toBe(true);
  });

  it("[repro] a policy that cannot be read is 503 policy_unavailable, never 'not stopped'; nothing is written", async () => {
    const { kernelId, capabilityId } = await ownedKernel("facade-unreadable");
    makeUnreadable(kernelId);
    const result = await submit(kernelId, capabilityId);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(UNAVAILABLE);
    expect(result.error.httpStatus).toBe(503);
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("control: bad input is still a 400 (a stopped kernel does not hide it)", async () => {
    const { kernelId } = await ownedKernel("facade-400");
    await stop(kernelId);
    const result = await getJobFacade().submit({ kernelId } as never, BUYER);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.httpStatus).toBe(400);
  });
});

describe("composition executor (createProductionBinding submits each step through JobFacade)", () => {
  const step = (kernelId: string, capabilityId: string) =>
    ({ index: 0, capabilityId, kernelId, assuranceTier: 0, capabilityType: "fdm" }) as never;

  it("control: a step on a kernel with no policy row submits a job", async () => {
    const { kernelId, capabilityId } = await ownedKernel("compose-open");
    await createProductionBinding().runStep!(step(kernelId, capabilityId));
    expect(jobsFor(kernelId)).toBe(1);
  });

  it("[repro] a step on a stopped kernel fails, and no job is created", async () => {
    const { kernelId, capabilityId } = await ownedKernel("compose-stop");
    await stop(kernelId);
    await expect(createProductionBinding().runStep!(step(kernelId, capabilityId))).rejects.toThrow(
      /Job submission failed/,
    );
    expect(jobsFor(kernelId)).toBe(0);
  });

  it("[repro] a step whose kernel policy cannot be read fails, and no job is created", async () => {
    const { kernelId, capabilityId } = await ownedKernel("compose-unreadable");
    makeUnreadable(kernelId);
    await expect(createProductionBinding().runStep!(step(kernelId, capabilityId))).rejects.toThrow(
      /Job submission failed/,
    );
    expect(jobsFor(kernelId)).toBe(0);
  });
});

describe("createJobFromSession (every paid path creates its job, escrow and scope here)", () => {
  it("control: with no policy row it creates the job, escrow and scope", async () => {
    const { kernelId } = await ownedKernel("cjfs-open");
    const id = await reviewedSession(kernelId);
    const created = await createJobFromSession(sessionRow(id)!);
    expect(created.jobId).toBeTruthy();
    expect(jobsFor(kernelId)).toBe(1);
    expect(scopesFor(kernelId)).toBe(1);
  });

  it("[repro] a stopped kernel: rejects with kernel_emergency_stopped before any job, escrow or scope", async () => {
    const { kernelId } = await ownedKernel("cjfs-stop");
    const id = await reviewedSession(kernelId);
    await stop(kernelId);
    const escrowsBefore = escrowCount();
    await expect(createJobFromSession(sessionRow(id)!)).rejects.toMatchObject({ code: STOPPED, status: 409 });
    expectNothingCreated(kernelId);
    expect(escrowCount()).toBe(escrowsBefore);
    expect(sessionRow(id)?.jobId).toBeNull();
  });

  it("[repro] a policy that cannot be read: rejects with policy_unavailable before any write", async () => {
    const { kernelId } = await ownedKernel("cjfs-unreadable");
    const id = await reviewedSession(kernelId);
    makeUnreadable(kernelId);
    const escrowsBefore = escrowCount();
    await expect(createJobFromSession(sessionRow(id)!)).rejects.toMatchObject({ code: UNAVAILABLE, status: 503 });
    expectNothingCreated(kernelId);
    expect(escrowCount()).toBe(escrowsBefore);
  });
});

describe("POST /api/negotiate/session/:id/commit: a session made before the stop cannot be committed after it", () => {
  const commit = (id: string) => negApp.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit` });

  it("control: with no policy row the commit creates the job", async () => {
    const { kernelId } = await ownedKernel("commit-open");
    const id = await reviewedSession(kernelId);
    const res = await commit(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(jobsFor(kernelId)).toBe(1);
    expect(sessionRow(id)?.status).toBe("committed");
  });

  it("[repro] stopped after the session was reviewed: 409, the session stays 'reviewing', no job, no scope", async () => {
    const { kernelId } = await ownedKernel("commit-stop");
    const id = await reviewedSession(kernelId);
    await stop(kernelId);
    const res = await commit(id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe(STOPPED);
    expect(sessionRow(id)?.status).toBe("reviewing");
    expect(sessionRow(id)?.jobId).toBeNull();
    expectNothingCreated(kernelId);
  });

  it("[repro] a policy that cannot be read: 503 policy_unavailable, the session stays 'reviewing'", async () => {
    const { kernelId } = await ownedKernel("commit-unreadable");
    const id = await reviewedSession(kernelId);
    makeUnreadable(kernelId);
    const res = await commit(id);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe(UNAVAILABLE);
    expect(sessionRow(id)?.status).toBe("reviewing");
    expectNothingCreated(kernelId);
  });

  it("[repro] once the kernel is resumed the same session commits", async () => {
    const { kernelId } = await ownedKernel("commit-resume");
    const id = await reviewedSession(kernelId);
    await stop(kernelId);
    expect((await commit(id)).statusCode).toBe(409);
    await resume(kernelId);
    const res = await commit(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(jobsFor(kernelId)).toBe(1);
  });
});

describe("POST /api/negotiate/session/:id/retry-settlement: the re-mint path creates a job", () => {
  const retry = (id: string) => negApp.inject({ method: "POST", url: `/api/negotiate/session/${id}/retry-settlement` });
  async function failedSession(kernelId: string): Promise<string> {
    const id = await reviewedSession(kernelId);
    getStore().db.update(negotiationSessions).set({ status: "settlement_failed" }).where(eq(negotiationSessions.id, id)).run();
    return id;
  }

  it("control: with no policy row the retry creates the job", async () => {
    const { kernelId } = await ownedKernel("retry-open");
    const id = await failedSession(kernelId);
    const res = await retry(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(jobsFor(kernelId)).toBe(1);
  });

  it("[repro] a stopped kernel: 409, the session stays 'settlement_failed', no job", async () => {
    const { kernelId } = await ownedKernel("retry-stop");
    const id = await failedSession(kernelId);
    await stop(kernelId);
    const res = await retry(id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe(STOPPED);
    expect(sessionRow(id)?.status).toBe("settlement_failed");
    expectNothingCreated(kernelId);
  });

  it("[repro] a policy that cannot be read: 503 policy_unavailable, no job", async () => {
    const { kernelId } = await ownedKernel("retry-unreadable");
    const id = await failedSession(kernelId);
    makeUnreadable(kernelId);
    const res = await retry(id);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe(UNAVAILABLE);
    expect(sessionRow(id)?.status).toBe("settlement_failed");
    expectNothingCreated(kernelId);
  });
});

describe("A2A pcc-submit: the commit leg (commitPccSession)", () => {
  const quoted = async (kernelId: string) =>
    (await createPccQuote({ userAgentId: uid("a2a"), kernelId, capabilityType: "fdm" })).sessionId;

  it("control: with no policy row the commit creates the job", async () => {
    const { kernelId } = await ownedKernel("a2a-open");
    const sessionId = await quoted(kernelId);
    const res = await commitPccSession(sessionId);
    expect(res.status).toBe("committed");
    expect(jobsFor(kernelId)).toBe(1);
  });

  it("[repro] a session quoted before the stop cannot be committed after it", async () => {
    const { kernelId } = await ownedKernel("a2a-stop");
    const sessionId = await quoted(kernelId);
    await stop(kernelId);
    await expect(commitPccSession(sessionId)).rejects.toMatchObject({ code: STOPPED, status: 409 });
    expect(sessionRow(sessionId)?.status).toBe("quoted");
    expect(sessionRow(sessionId)?.jobId).toBeNull();
    expectNothingCreated(kernelId);
  });

  it("[repro] a policy that cannot be read: the commit is refused and the session is left as it was", async () => {
    const { kernelId } = await ownedKernel("a2a-unreadable");
    const sessionId = await quoted(kernelId);
    makeUnreadable(kernelId);
    await expect(commitPccSession(sessionId)).rejects.toMatchObject({ code: UNAVAILABLE, status: 503 });
    expect(sessionRow(sessionId)?.status).toBe("quoted");
    expectNothingCreated(kernelId);
  });

  it("control: a new pcc-quote on a stopped kernel is still refused, as before", async () => {
    const { kernelId } = await ownedKernel("a2a-newquote");
    await stop(kernelId);
    await expect(
      createPccQuote({ userAgentId: uid("a2a"), kernelId, capabilityType: "fdm" }),
    ).rejects.toThrow(/emergency stop/i);
  });
});

describe("POST /api/setup/test-job", () => {
  const testJob = (payload: Record<string, unknown>) =>
    setupApp.inject({ method: "POST", url: "/api/setup/test-job", payload: payload as never });

  it("control: a kernel with no policy row gets its test job", async () => {
    ks.ready = true;
    const { kernelId } = await ownedKernel("setup-open");
    const res = await testJob({ kernelId });
    expect(res.statusCode, res.body).toBe(200);
    expect(jobsFor(kernelId)).toBe(1);
  });

  it("[repro] a stopped kernel: 409, no job row, nothing handed to the local kernel service", async () => {
    ks.ready = true;
    const { kernelId } = await ownedKernel("setup-stop");
    await stop(kernelId);
    const res = await testJob({ kernelId, deviceId: "dev-stub" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe(STOPPED);
    expect(jobsFor(kernelId)).toBe(0);
    expect(ks.submitJob).not.toHaveBeenCalled();
  });

  it("[repro] the gateway's OWN kernel, which actually runs the job, is checked too", async () => {
    ks.ready = true;
    const local = await ownedKernel("setup-local");
    const other = await ownedKernel("setup-other");
    ks.localKernelId = local.kernelId;
    await stop(local.kernelId);
    const res = await testJob({ kernelId: other.kernelId, deviceId: "dev-stub" });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe(STOPPED);
    expect(jobsFor(other.kernelId)).toBe(0);
    expect(ks.submitJob).not.toHaveBeenCalled();
  });

  it("[repro] a policy that cannot be read: 503 policy_unavailable, no job row", async () => {
    ks.ready = true;
    const { kernelId } = await ownedKernel("setup-unreadable");
    makeUnreadable(kernelId);
    const res = await testJob({ kernelId, deviceId: "dev-stub" });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe(UNAVAILABLE);
    expect(jobsFor(kernelId)).toBe(0);
    expect(ks.submitJob).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DISPATCH: the queues a node polls
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/operator/jobs: a stopped kernel's queue hands out no work", () => {
  const queue = (headers: Record<string, string>, kernelId: string, status = "queued") =>
    app.inject({ method: "GET", url: `/api/operator/jobs?kernelId=${kernelId}&status=${status}`, headers });

  it("control: a kernel that is not stopped hands out its queued jobs, in the same shape as before", async () => {
    const { kernelId } = await ownedKernel("queue-open");
    const id = insertQueuedJob(kernelId);
    const res = await queue(asOwner(), kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs.map((j: { id: string }) => j.id)).toEqual([id]);
    expect(res.json().emergencyStop).toBeUndefined();
  });

  it("[repro] stopped: a 200 with an empty queue and emergencyStop true, though a job is queued", async () => {
    const { kernelId } = await ownedKernel("queue-stop");
    insertQueuedJob(kernelId);
    await stop(kernelId);
    const res = await queue(asOwner(), kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs).toEqual([]);
    expect(res.json().emergencyStop).toBe(true);
  });

  it("[repro] the admin's read of the queue is empty too", async () => {
    const { kernelId } = await ownedKernel("queue-admin");
    insertQueuedJob(kernelId);
    await stop(kernelId);
    const res = await queue(asAdmin(), kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs).toEqual([]);
    expect(res.json().emergencyStop).toBe(true);
  });

  it.each(["pending", "paused"])("[repro] status=%s (work a node would start or resume) is empty too", async (status) => {
    const { kernelId } = await ownedKernel(`queue-${status}`);
    insertQueuedJob(kernelId, status);
    await stop(kernelId);
    const res = await queue(asOwner(), kernelId, status);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs).toEqual([]);
    expect(res.json().emergencyStop).toBe(true);
  });

  it("[repro] a repeated status parameter cannot get around the stop: held back and says so", async () => {
    const { kernelId } = await ownedKernel("queue-array");
    insertQueuedJob(kernelId);
    await stop(kernelId);
    const res = await app.inject({
      method: "GET",
      url: `/api/operator/jobs?kernelId=${kernelId}&status=queued&status=queued`,
      headers: asOwner(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs).toEqual([]);
    expect(res.json().emergencyStop).toBe(true);
  });

  it.each(["in_progress", "completed"])("control: status=%s is not new work and is still listed while stopped", async (status) => {
    const { kernelId } = await ownedKernel(`queue-${status}`);
    const id = insertQueuedJob(kernelId, status);
    await stop(kernelId);
    const res = await queue(asOwner(), kernelId, status);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs.map((j: { id: string }) => j.id)).toEqual([id]);
  });

  it("[repro] a policy that cannot be read is 503 policy_unavailable, not a queue", async () => {
    const { kernelId } = await ownedKernel("queue-unreadable");
    insertQueuedJob(kernelId);
    makeUnreadable(kernelId);
    const res = await queue(asOwner(), kernelId);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe(UNAVAILABLE);
    expect(res.json().jobs).toBeUndefined();
  });

  it("[repro] resuming hands the queued job out again", async () => {
    const { kernelId } = await ownedKernel("queue-resume");
    const id = insertQueuedJob(kernelId);
    await stop(kernelId);
    expect((await queue(asOwner(), kernelId)).json().jobs).toEqual([]);
    await resume(kernelId);
    const res = await queue(asOwner(), kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs.map((j: { id: string }) => j.id)).toEqual([id]);
  });

  it("control: a non-owner is still refused 403 before the stop is looked at", async () => {
    const { kernelId } = await ownedKernel("queue-stranger");
    await stop(kernelId);
    const res = await queue(asBuyer(), kernelId);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().emergencyStop).toBeUndefined();
  });
});

describe("GET /api/operator/approvals?status=approved: the queue the OT-2 daemon polls", () => {
  /** An approval the owner's own 'auto' policy approved, before the stop. */
  async function approvedApproval(kernelId: string): Promise<string> {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/operator/policy/${kernelId}`,
      headers: asOwner(),
      payload: { approvalMode: "auto" },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/approvals",
      headers: asOwner(),
      payload: { kernelId, capabilityType: "liquid-handler" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approval.status).toBe("approved");
    return res.json().approval.id as string;
  }
  const approved = (kernelId?: string) =>
    app.inject({
      method: "GET",
      url: `/api/operator/approvals?status=approved${kernelId ? `&kernelId=${kernelId}` : ""}`,
      headers: asOwner(),
    });

  it("control: the owner's approved approval is handed out while the kernel is not stopped", async () => {
    const { kernelId } = await ownedKernel("appr-open");
    const id = await approvedApproval(kernelId);
    const res = await approved(kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approvals.map((a: { id: string }) => a.id)).toEqual([id]);
    expect(res.json().emergencyStop).toBeUndefined();
  });

  it("the stop itself rejects only PENDING approvals: an approved one is still approved afterwards", async () => {
    const { kernelId } = await ownedKernel("appr-keeps");
    const id = await approvedApproval(kernelId);
    await stop(kernelId);
    const row = getStore().db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get();
    expect(row?.status).toBe("approved");
  });

  it("[repro] stopped: the approved queue is empty and says emergencyStop true", async () => {
    const { kernelId } = await ownedKernel("appr-stop");
    await approvedApproval(kernelId);
    await stop(kernelId);
    const res = await approved(kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approvals).toEqual([]);
    expect(res.json().emergencyStop).toBe(true);
  });

  it("[repro] the unfiltered-by-kernel form leaves a stopped kernel's approved approvals out", async () => {
    const { kernelId } = await ownedKernel("appr-stop-all");
    const id = await approvedApproval(kernelId);
    await stop(kernelId);
    const res = await approved();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approvals.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it("[repro] the unfiltered-by-kernel form also leaves out a kernel whose policy cannot be read", async () => {
    const { kernelId } = await ownedKernel("appr-unreadable-all");
    const id = await approvedApproval(kernelId);
    makeUnreadable(kernelId);
    const res = await approved();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approvals.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it("[repro] a repeated status parameter cannot get around the stop: held back and says so", async () => {
    const { kernelId } = await ownedKernel("appr-array");
    await approvedApproval(kernelId);
    await stop(kernelId);
    const res = await app.inject({
      method: "GET",
      url: `/api/operator/approvals?status=approved&status=approved&kernelId=${kernelId}`,
      headers: asOwner(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approvals).toEqual([]);
    expect(res.json().emergencyStop).toBe(true);
  });

  it("control: the history view (no status filter) still lists the approval while stopped", async () => {
    const { kernelId } = await ownedKernel("appr-history");
    const id = await approvedApproval(kernelId);
    await stop(kernelId);
    const res = await app.inject({
      method: "GET",
      url: `/api/operator/approvals?kernelId=${kernelId}`,
      headers: asOwner(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approvals.map((a: { id: string }) => a.id)).toContain(id);
  });

  it("[repro] a policy that cannot be read is 503 policy_unavailable, not a queue", async () => {
    const { kernelId } = await ownedKernel("appr-unreadable");
    await approvedApproval(kernelId);
    makeUnreadable(kernelId);
    const res = await approved(kernelId);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json().error).toBe(UNAVAILABLE);
    expect(res.json().approvals).toBeUndefined();
  });

  it("[repro] resuming hands the approved approval out again", async () => {
    const { kernelId } = await ownedKernel("appr-resume");
    const id = await approvedApproval(kernelId);
    await stop(kernelId);
    expect((await approved(kernelId)).json().approvals).toEqual([]);
    await resume(kernelId);
    const res = await approved(kernelId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().approvals.map((a: { id: string }) => a.id)).toEqual([id]);
  });
});

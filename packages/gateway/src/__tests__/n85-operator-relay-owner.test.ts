/**
 * N85 (b), a LIVE Gate A hole: the operator relay (routes/operator-relay.ts) has
 * no owner checks. WP-C guards only POST /api/operator/heartbeat in that file.
 * apiGate admits ANY key and key provisioning is public, so any caller could:
 *
 *   - GET  /api/operator/jobs?kernelId=K   list ANY kernel's job queue;
 *   - POST /api/operator/evidence          insert an evidence bundle for ANY job;
 *   - POST /api/operator/job-status        set ANY job's status. Once a paid job
 *     is 'completed', /complete answers 409 and settlement.facade.ts reads
 *     'completed' as settled, so any key could strand any paid job's settlement.
 *
 * These three are now owner-or-admin, the same rule as GET
 * /api/operator/policy/:kernelId: a presented admin secret must be the right one
 * (403 otherwise, never a downgrade to the owner's authority), else a PRESENT
 * actor (401 before any body validation) who owns the JOB's kernel (403
 * not_kernel_owner; a placeholder-owned kernel is the admin's alone). Order:
 * 401, 400 (body), 404 (job), 403 (owner). Nothing is written on a refusal.
 *
 * Reproduced at 7258121d before any code changed: the file imports only modules
 * that exist there, so it runs unchanged on that base and every [neg] case
 * fails there.
 *
 * Driven over HTTP through the REAL apiGate and real API keys ("app"), and
 * through the same routes with NO apiGate ("bareApp"): the handlers must refuse
 * on their own and never rely on apiGate having run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";

const ADMIN_SECRET = "n85b-relay-admin-secret";
const OWNER = "n85b-relay-owner@x.test";
const STRANGER = "n85b-relay-stranger@x.test";
const ZERO = "0x0000000000000000000000000000000000000000";
const savedAdminKey = process.env.PCC_ADMIN_KEY;

/** apiGate in front: the production shape. */
let app: FastifyInstance;
/** The same routes with NO apiGate: the handlers must refuse on their own. */
let bareApp: FastifyInstance;
let ownerKey = "";
let strangerKey = "";
let zeroKey = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

const OWNER_KERNEL = uid("kernel-n85b-owner");
const STRANGER_KERNEL = uid("kernel-n85b-stranger");
const UNOWNED_KERNEL = uid("kernel-n85b-unowned");

const asKey = (k: string) => ({ authorization: `Bearer ${k}` });
const asOwner = () => asKey(ownerKey);
const asStranger = () => asKey(strangerKey);
/** The admin secret behind apiGate also needs SOME valid key (apiGate admits any key). */
const asAdmin = () => ({ ...asKey(strangerKey), "x-admin-key": ADMIN_SECRET });
/** The admin secret alone: only reaches a handler on the bare app. */
const adminSecretOnly = () => ({ "x-admin-key": ADMIN_SECRET });

type Headers = Record<string, string>;
const postStatus = (on: FastifyInstance, headers: Headers, payload: unknown) =>
  on.inject({ method: "POST", url: "/api/operator/job-status", headers, payload: payload as never });
const postEvidence = (on: FastifyInstance, headers: Headers, payload: unknown) =>
  on.inject({ method: "POST", url: "/api/operator/evidence", headers, payload: payload as never });
const getJobs = (on: FastifyInstance, headers: Headers, query: string) =>
  on.inject({ method: "GET", url: `/api/operator/jobs${query}`, headers });

/** A job on `kernelId` (capability first: jobs.capability_id is NOT NULL and an FK). */
function insertJob(id: string, kernelId: string, status = "queued"): void {
  const capabilityId = `cap-${kernelId}-n85b`;
  if (!getRepos().capabilities.findById(capabilityId)) {
    getRepos().capabilities.insert({
      id: capabilityId,
      kernelId,
      type: "n85b-test",
      name: "N85b test capability",
      materials: [],
      assuranceTiers: [0],
      pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
      availability: {},
      location: { lat: 0, lng: 0 },
    } as never);
  }
  getRepos().jobs.insert({
    id,
    stepId: `step-${id}`,
    cwmId: `cwm-${id}`,
    capabilityId,
    kernelId,
    status,
    assignedDevices: [],
    startedAt: new Date().toISOString(),
    progress: 0,
    assuranceTier: 0,
  } as never);
}
function newJob(kernelId = OWNER_KERNEL, status = "queued"): string {
  const id = uid("job-n85b");
  insertJob(id, kernelId, status);
  return id;
}
const statusOf = (jobId: string) => getRepos().jobs.findById(jobId)?.status;
const completedAtOf = (jobId: string) => getRepos().jobs.findById(jobId)?.completedAt ?? null;
const bundlesOf = (jobId: string) => getRepos().evidence.findByJob(jobId);

const EVIDENCE = { printed: true, returncode: 0 };

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  strangerKey = provisionApiKey({ operatorId: STRANGER, scopes: ["operator"] }).rawKey;
  zeroKey = provisionApiKey({ operatorId: ZERO, scopes: ["operator"] }).rawKey;

  const { getKernelFacade } = await import("../facades/index.js");
  const a = await getKernelFacade().register({ id: OWNER_KERNEL, name: "N85b owner kernel" }, OWNER);
  expect(a.success).toBe(true);
  const b = await getKernelFacade().register({ id: STRANGER_KERNEL, name: "N85b stranger kernel" }, STRANGER);
  expect(b.success).toBe(true);
  // A legacy row whose owner is the unowned zero-address placeholder.
  getRepos().kernels.insert({
    id: UNOWNED_KERNEL,
    name: "Legacy unowned kernel",
    operatorAddress: ZERO,
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 0,
    publicKey: `0x${"00".repeat(32)}`,
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "0.1.0",
  } as never);

  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(operatorRelayRoutes);
  await app.ready();

  bareApp = Fastify({ logger: false });
  await bareApp.register(operatorRelayRoutes);
  await bareApp.ready();
});

afterAll(async () => {
  await app?.close();
  await bareApp?.close();
  closeStore();
  if (savedAdminKey === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = savedAdminKey;
});

// ── POST /api/operator/job-status ───────────────────────────────────────────

describe("N85 b: POST /api/operator/job-status is owner-or-admin", () => {
  it("[neg] a STRANGER cannot set the status of the owner's job (completed would strand its settlement): 403, status UNCHANGED", async () => {
    for (const status of ["completed", "cancelled", "failed", "running"]) {
      const jobId = newJob(OWNER_KERNEL, "in_progress");
      const res = await postStatus(app, asStranger(), { jobId, status });
      expect(res.statusCode, `${status}: ${res.body}`).toBe(403);
      expect(res.json().error).toBe("not_kernel_owner");
      expect(statusOf(jobId), status).toBe("in_progress");
      expect(completedAtOf(jobId), status).toBeNull();
    }
  });

  it("[neg] naming the stranger's OWN kernel in the body does not help: the JOB's kernel decides, 403, unchanged", async () => {
    const jobId = newJob(OWNER_KERNEL, "in_progress");
    const res = await postStatus(app, asStranger(), { jobId, kernelId: STRANGER_KERNEL, status: "completed" });
    expect(res.statusCode, res.body).toBe(403);
    expect(statusOf(jobId)).toBe("in_progress");
    expect(completedAtOf(jobId)).toBeNull();
  });

  it("control: the OWNER sets its job's status (the `running` alias is normalised, completed stamps completedAt)", async () => {
    const jobId = newJob(OWNER_KERNEL, "queued");
    const running = await postStatus(app, asOwner(), { jobId, kernelId: OWNER_KERNEL, status: "running" });
    expect(running.statusCode, running.body).toBe(200);
    expect(running.json()).toMatchObject({ updated: true, jobId, status: "in_progress" });
    expect(statusOf(jobId)).toBe("in_progress");

    const done = await postStatus(app, asOwner(), { jobId, status: "completed" });
    expect(done.statusCode, done.body).toBe(200);
    expect(statusOf(jobId)).toBe("completed");
    expect(completedAtOf(jobId)).not.toBeNull();
  });

  it("control: the correct admin secret sets any job's status (behind apiGate with any key, and alone on the bare app)", async () => {
    const jobId = newJob(OWNER_KERNEL, "queued");
    const viaGate = await postStatus(app, asAdmin(), { jobId, status: "in_progress" });
    expect(viaGate.statusCode, viaGate.body).toBe(200);
    expect(statusOf(jobId)).toBe("in_progress");
    const bare = await postStatus(bareApp, adminSecretOnly(), { jobId, status: "paused" });
    expect(bare.statusCode, bare.body).toBe(200);
    expect(statusOf(jobId)).toBe("paused");
  });
});

// ── POST /api/operator/evidence ─────────────────────────────────────────────

describe("N85 b: POST /api/operator/evidence is owner-or-admin", () => {
  it("[neg] a STRANGER cannot attach evidence to the owner's job: 403, NO bundle stored for the job", async () => {
    const jobId = newJob();
    const res = await postEvidence(app, asStranger(), { jobId, evidence: EVIDENCE });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("not_kernel_owner");
    expect(bundlesOf(jobId)).toEqual([]);
  });

  it("[neg] naming the stranger's OWN kernel in the body does not help: 403, no bundle under either kernel", async () => {
    const jobId = newJob();
    const res = await postEvidence(app, asStranger(), { jobId, kernelId: STRANGER_KERNEL, evidence: EVIDENCE });
    expect(res.statusCode, res.body).toBe(403);
    expect(bundlesOf(jobId)).toEqual([]);
    expect(getRepos().evidence.findByKernel(STRANGER_KERNEL).filter((b) => b.jobId === jobId)).toEqual([]);
  });

  it("[neg] the OWNER cannot attribute a bundle on its job to ANOTHER kernel: the stored kernel is the job's, never the body's", async () => {
    // The body's kernelId is a CLAIM. Evidence filed under a victim kernel would
    // show up in that kernel's compliance report (findByKernel).
    const jobId = newJob(OWNER_KERNEL);
    const res = await postEvidence(app, asOwner(), { jobId, kernelId: STRANGER_KERNEL, evidence: EVIDENCE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().stored).toBe(true);
    const bundles = bundlesOf(jobId);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].kernelId).toBe(OWNER_KERNEL);
    expect(getRepos().evidence.findByKernel(STRANGER_KERNEL).filter((b) => b.jobId === jobId)).toEqual([]);
  });

  it("control: the OWNER attaches evidence to its job (stored under the job's kernel)", async () => {
    const jobId = newJob();
    const res = await postEvidence(app, asOwner(), { jobId, kernelId: OWNER_KERNEL, evidence: EVIDENCE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ stored: true, jobId });
    const bundles = bundlesOf(jobId);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].kernelId).toBe(OWNER_KERNEL);
    expect(bundles[0].id).toBe(res.json().bundleId);
  });

  it("control: the correct admin secret attaches evidence to any job (behind apiGate with any key, and alone on the bare app)", async () => {
    const jobId = newJob();
    const viaGate = await postEvidence(app, asAdmin(), { jobId, evidence: EVIDENCE });
    expect(viaGate.statusCode, viaGate.body).toBe(200);
    const bare = await postEvidence(bareApp, adminSecretOnly(), { jobId, evidence: EVIDENCE });
    expect(bare.statusCode, bare.body).toBe(200);
    expect(bundlesOf(jobId)).toHaveLength(2);
    expect(bundlesOf(jobId).every((b) => b.kernelId === OWNER_KERNEL)).toBe(true);
  });
});

// ── GET /api/operator/jobs ──────────────────────────────────────────────────

describe("N85 b: GET /api/operator/jobs is owner-or-admin", () => {
  it("[neg] a STRANGER cannot list the owner's job queue: 403 and the body carries none of the owner's job ids", async () => {
    const queued = newJob(OWNER_KERNEL, "queued");
    const running = newJob(OWNER_KERNEL, "in_progress");
    for (const query of [
      `?kernelId=${OWNER_KERNEL}`,
      `?kernelId=${OWNER_KERNEL}&status=queued`,
      `?kernelId=${OWNER_KERNEL}&status=in_progress`,
      `?kernelId=${OWNER_KERNEL}&status=`, // an empty status lists every status of the kernel
    ]) {
      const res = await getJobs(app, asStranger(), query);
      expect(res.statusCode, `${query}: ${res.body}`).toBe(403);
      expect(res.json().error).toBe("not_kernel_owner");
      expect(res.body).not.toContain(queued);
      expect(res.body).not.toContain(running);
    }
  });

  it("control: the OWNER lists its own queue, and only its own kernel's jobs", async () => {
    const mine = newJob(OWNER_KERNEL, "queued");
    const theirs = newJob(STRANGER_KERNEL, "queued");
    const res = await getJobs(app, asOwner(), `?kernelId=${OWNER_KERNEL}&status=queued`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json().jobs.map((j: { id: string }) => j.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("control: the correct admin secret lists any kernel's queue (behind apiGate with any key, and alone on the bare app)", async () => {
    const mine = newJob(OWNER_KERNEL, "queued");
    for (const [on, headers] of [[app, asAdmin()], [bareApp, adminSecretOnly()]] as const) {
      const res = await getJobs(on, headers, `?kernelId=${OWNER_KERNEL}&status=queued`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().jobs.map((j: { id: string }) => j.id)).toContain(mine);
    }
  });

  it("without a kernelId it never lists everything: 400 for the owner, a stranger and the admin alike", async () => {
    const jobId = newJob(OWNER_KERNEL, "queued");
    for (const headers of [asOwner(), asStranger(), asAdmin()]) {
      for (const query of ["", "?status=queued", "?kernelId="]) {
        const res = await getJobs(app, headers, query);
        expect(res.statusCode, `${query}: ${res.body}`).toBe(400);
        expect(res.json().error).toBe("kernelId query param required");
        expect(res.body).not.toContain(jobId);
      }
    }
  });
});

// ── No identity ─────────────────────────────────────────────────────────────

describe("N85 b: no identity", () => {
  it("[neg] NO actor at the handler (apiGate absent): 401 on all three, before any body validation or job lookup, nothing written", async () => {
    const real = newJob(OWNER_KERNEL, "in_progress");
    const ghost = uid("job-n85b-ghost");
    // An invalid body, an unknown job and a real job must all answer 401: a 400
    // or a 404 here would mean the handler validated or looked up first, and an
    // unauthenticated 404 vs 403 would also leak which job ids exist.
    for (const body of [{}, { jobId: 123 }, { jobId: ghost, status: "completed" }, { jobId: real, status: "completed" }]) {
      const res = await postStatus(bareApp, {}, body);
      expect(res.statusCode, `job-status ${JSON.stringify(body)}: ${res.body}`).toBe(401);
    }
    for (const body of [
      {},
      { jobId: 123 },
      { jobId: ghost, evidence: EVIDENCE },
      { jobId: real, evidence: EVIDENCE },
      { jobId: real, kernelId: OWNER_KERNEL, evidence: EVIDENCE },
    ]) {
      const res = await postEvidence(bareApp, {}, body);
      expect(res.statusCode, `evidence ${JSON.stringify(body)}: ${res.body}`).toBe(401);
    }
    for (const query of ["", `?kernelId=${OWNER_KERNEL}`, `?kernelId=${uid("kernel-n85b-ghost")}`, `?kernelId=${OWNER_KERNEL}&status=in_progress`]) {
      const res = await getJobs(bareApp, {}, query);
      expect(res.statusCode, `jobs ${query}: ${res.body}`).toBe(401);
      expect(res.body).not.toContain(real);
    }
    expect(statusOf(real)).toBe("in_progress");
    expect(bundlesOf(real)).toEqual([]);
  });

  it("apiGate present and no key: 401 on all three (the gate's own refusal; passes at the base too)", async () => {
    const jobId = newJob(OWNER_KERNEL, "in_progress");
    expect((await postStatus(app, {}, { jobId, status: "completed" })).statusCode).toBe(401);
    expect((await postEvidence(app, {}, { jobId, evidence: EVIDENCE })).statusCode).toBe(401);
    expect((await getJobs(app, {}, `?kernelId=${OWNER_KERNEL}`)).statusCode).toBe(401);
    expect(statusOf(jobId)).toBe("in_progress");
    expect(bundlesOf(jobId)).toEqual([]);
  });
});

// ── The admin secret ────────────────────────────────────────────────────────

describe("N85 b: the admin secret is checked, never assumed", () => {
  it("[neg] a WRONG admin secret is 403 on all three, whatever key rides along (a bad secret is not downgraded to the owner), nothing changed", async () => {
    const jobId = newJob(OWNER_KERNEL, "in_progress");
    const wrong = { "x-admin-key": "not-the-admin-secret" };
    for (const [on, headers] of [
      [app, { ...asStranger(), ...wrong }],
      [app, { ...asOwner(), ...wrong }],
      [bareApp, wrong],
    ] as const) {
      const status = await postStatus(on, headers, { jobId, status: "completed" });
      expect(status.statusCode, `job-status: ${status.body}`).toBe(403);
      expect(status.json().error).toBe("admin_key_invalid");
      const evidence = await postEvidence(on, headers, { jobId, evidence: EVIDENCE });
      expect(evidence.statusCode, `evidence: ${evidence.body}`).toBe(403);
      const list = await getJobs(on, headers, `?kernelId=${OWNER_KERNEL}`);
      expect(list.statusCode, `jobs: ${list.body}`).toBe(403);
      expect(list.body).not.toContain(jobId);
    }
    expect(statusOf(jobId)).toBe("in_progress");
    expect(bundlesOf(jobId)).toEqual([]);
  });

  it("[neg] an EMPTY admin secret is refused too (401 admin_key_required), never a pass", async () => {
    const jobId = newJob(OWNER_KERNEL, "in_progress");
    const empty = { ...asStranger(), "x-admin-key": "" };
    expect((await postStatus(app, empty, { jobId, status: "completed" })).statusCode).toBe(401);
    expect((await postEvidence(app, empty, { jobId, evidence: EVIDENCE })).statusCode).toBe(401);
    expect((await getJobs(app, empty, `?kernelId=${OWNER_KERNEL}`)).statusCode).toBe(401);
    expect(statusOf(jobId)).toBe("in_progress");
    expect(bundlesOf(jobId)).toEqual([]);
  });

  it("[neg] with PCC_ADMIN_KEY unset any presented secret is refused (503), never a pass", async () => {
    const jobId = newJob(OWNER_KERNEL, "in_progress");
    delete process.env.PCC_ADMIN_KEY;
    try {
      const headers = { ...asStranger(), "x-admin-key": ADMIN_SECRET };
      expect((await postStatus(app, headers, { jobId, status: "completed" })).statusCode).toBe(503);
      expect((await postEvidence(app, headers, { jobId, evidence: EVIDENCE })).statusCode).toBe(503);
      expect((await getJobs(app, headers, `?kernelId=${OWNER_KERNEL}`)).statusCode).toBe(503);
    } finally {
      process.env.PCC_ADMIN_KEY = ADMIN_SECRET;
    }
    expect(statusOf(jobId)).toBe("in_progress");
    expect(bundlesOf(jobId)).toEqual([]);
  });
});

// ── An unowned (placeholder) kernel is the admin's alone ────────────────────

describe("N85 b: a job on an UNOWNED placeholder kernel is the admin's alone (fails closed)", () => {
  it("[neg] neither a stranger nor a caller whose own identity IS the zero address can touch it: 403, nothing written", async () => {
    const jobId = newJob(UNOWNED_KERNEL, "in_progress");
    for (const headers of [asStranger(), asOwner(), asKey(zeroKey)]) {
      const status = await postStatus(app, headers, { jobId, status: "completed" });
      expect(status.statusCode, status.body).toBe(403);
      expect(status.json().error).toBe("not_kernel_owner");
      const evidence = await postEvidence(app, headers, { jobId, evidence: EVIDENCE });
      expect(evidence.statusCode, evidence.body).toBe(403);
      const list = await getJobs(app, headers, `?kernelId=${UNOWNED_KERNEL}`);
      expect(list.statusCode, list.body).toBe(403);
      expect(list.body).not.toContain(jobId);
    }
    expect(statusOf(jobId)).toBe("in_progress");
    expect(bundlesOf(jobId)).toEqual([]);
  });

  it("control: the admin secret can act on it", async () => {
    const jobId = newJob(UNOWNED_KERNEL, "queued");
    expect((await postStatus(app, asAdmin(), { jobId, status: "in_progress" })).statusCode).toBe(200);
    expect((await postEvidence(app, asAdmin(), { jobId, evidence: EVIDENCE })).statusCode).toBe(200);
    const list = await getJobs(app, asAdmin(), `?kernelId=${UNOWNED_KERNEL}&status=in_progress`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().jobs.map((j: { id: string }) => j.id)).toContain(jobId);
  });
});

// ── Edge cases: auth, then body (400), then the lookup (404), then the owner (403)

describe("N85 b: edge cases (after authentication)", () => {
  it("an UNKNOWN jobId is 404 job_not_found for the owner on both writes, and nothing is written", async () => {
    const jobId = uid("job-n85b-ghost");
    const status = await postStatus(app, asOwner(), { jobId, status: "completed" });
    expect(status.statusCode, status.body).toBe(404);
    expect(status.json().error).toBe("job_not_found");
    const evidence = await postEvidence(app, asOwner(), { jobId, evidence: EVIDENCE });
    expect(evidence.statusCode, evidence.body).toBe(404);
    expect(evidence.json().error).toBe("job_not_found");
    expect(statusOf(jobId)).toBeUndefined();
    expect(bundlesOf(jobId)).toEqual([]);
  });

  it("an unknown jobId is 404 for the admin too (the lookup precedes the admin pass-through), and 404 for a stranger (the job lookup precedes the owner check)", async () => {
    const jobId = uid("job-n85b-ghost");
    for (const headers of [asAdmin(), asStranger()]) {
      expect((await postStatus(app, headers, { jobId, status: "completed" })).statusCode).toBe(404);
      expect((await postEvidence(app, headers, { jobId, evidence: EVIDENCE })).statusCode).toBe(404);
    }
  });

  it("a NON-STRING jobId is 400 (never looked up) for the owner, the stranger and the admin", async () => {
    for (const headers of [asOwner(), asStranger(), asAdmin()]) {
      for (const jobId of [123, true, { id: "x" }, ["a"], ""]) {
        const status = await postStatus(app, headers, { jobId, status: "completed" });
        expect(status.statusCode, `job-status ${JSON.stringify(jobId)}: ${status.body}`).toBe(400);
        expect(status.json().error).toBe("jobId required");
        const evidence = await postEvidence(app, headers, { jobId, evidence: EVIDENCE });
        expect(evidence.statusCode, `evidence ${JSON.stringify(jobId)}: ${evidence.body}`).toBe(400);
        expect(evidence.json().error).toBe("jobId required");
      }
    }
  });

  it("a NON-STRING kernelId is 400: in the body of both writes, and as a repeated ?kernelId= on the list", async () => {
    const jobId = newJob(OWNER_KERNEL, "queued");
    for (const kernelId of [123, true, { id: "x" }, [OWNER_KERNEL]]) {
      const status = await postStatus(app, asOwner(), { jobId, kernelId, status: "in_progress" });
      expect(status.statusCode, `job-status ${JSON.stringify(kernelId)}: ${status.body}`).toBe(400);
      const evidence = await postEvidence(app, asOwner(), { jobId, kernelId, evidence: EVIDENCE });
      expect(evidence.statusCode, `evidence ${JSON.stringify(kernelId)}: ${evidence.body}`).toBe(400);
    }
    expect(statusOf(jobId)).toBe("queued");
    expect(bundlesOf(jobId)).toEqual([]);
    for (const headers of [asOwner(), asAdmin()]) {
      const list = await getJobs(app, headers, `?kernelId=${OWNER_KERNEL}&kernelId=${STRANGER_KERNEL}`);
      expect(list.statusCode, list.body).toBe(400);
      expect(list.body).not.toContain(jobId);
    }
  });

  it("the body is validated before the lookup and the owner check: a missing status / evidence / invalid status is 400, even on a stranger's attempt", async () => {
    const jobId = newJob(OWNER_KERNEL, "in_progress");
    expect((await postStatus(app, asOwner(), { jobId })).statusCode).toBe(400);
    expect((await postStatus(app, asOwner(), { jobId, status: "flying" })).json().error).toBe("invalid_status");
    expect((await postEvidence(app, asOwner(), { jobId })).statusCode).toBe(400);
    expect((await postStatus(app, asStranger(), { jobId, status: "flying" })).statusCode).toBe(400);
    expect(statusOf(jobId)).toBe("in_progress");
  });

  it("[neg] an INHERITED property name as the status (constructor, toString, __proto__) is 400 invalid_status for the owner and the admin, never a 500, and the job is unchanged", async () => {
    const jobId = newJob(OWNER_KERNEL, "in_progress");
    for (const headers of [asOwner(), asAdmin()]) {
      for (const status of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const res = await postStatus(app, headers, { jobId, status });
        expect(res.statusCode, `${status}: ${res.body}`).toBe(400);
        expect(res.json().error).toBe("invalid_status");
      }
    }
    expect(statusOf(jobId)).toBe("in_progress");
  });

  it("GET for an UNKNOWN kernel is 404 kernel_not_found for a caller with an identity, and an empty list for the admin", async () => {
    const kernelId = uid("kernel-n85b-ghost");
    const owner = await getJobs(app, asOwner(), `?kernelId=${kernelId}`);
    expect(owner.statusCode, owner.body).toBe(404);
    expect(owner.json().error).toBe("kernel_not_found");
    const admin = await getJobs(app, asAdmin(), `?kernelId=${kernelId}`);
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json().jobs).toEqual([]);
  });
});

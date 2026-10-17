/** N174: resetting an emergency stop leaves undispatched work held for an operator decision. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getSafetyGateway, JobRunner } from "@pcc/kernel";
import { schema, eq } from "@pcc/store";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { apiGate } from "../middleware/api-gate.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { operatorRoutes } from "../routes/operator.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { jobRoutes } from "../routes/jobs.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { deviceRelayRoutes } from "../routes/device-relay.js";
import { getKernelService, KernelService } from "../services/kernel-service.js";
import { HOLDABLE_JOB_STATUSES, jobHoldFieldsById } from "../services/job-holds.js";
import { localJobDispatchDecision } from "../services/local-job-dispatch.js";
import { applyUnavailablePolicy } from "./helpers/emergency-stop-policy-cases.js";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn(), isReady: vi.fn().mockReturnValue(true), stop: vi.fn(),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "n174-evidence" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "n174-encrypted-evidence" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn(), releaseMilestone: vi.fn(),
  isWriteEnabled: vi.fn().mockReturnValue(false), getSignerAddress: vi.fn(),
  isBatchEnabled: vi.fn().mockReturnValue(false), getSmartAccountAddress: vi.fn(),
  submitSettlement: vi.fn(), flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]), MilestoneStatus: {}, milestoneStatusName: vi.fn(),
}));
vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false), getSmartAccountAddress: vi.fn(),
  submitSettlement: vi.fn(), flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]), initBatchSettlement: vi.fn(), stopBatchSettlement: vi.fn(),
}));
vi.mock("../services/kernel-service.js", async (importActual) => ({
  ...await importActual<typeof import("../services/kernel-service.js")>(),
  getKernelService: vi.fn(),
}));

const ADMIN = "n174-admin-fixture";
const KERNEL = "kernel-n174-a";
const OTHER_KERNEL = "kernel-n174-b";
const OPERATOR = "operator-n174-a";
const OTHER_OPERATOR = "operator-n174-b";
const BUYER = "0x0000000000000000000000000000000000000174";
const CAPABILITY = "cap-n174-a";
const HEADERS = () => ({ authorization: `Bearer ${operatorKey}`, "x-admin-key": ADMIN });
const CLAIMED = () => ({ authorization: `Bearer ${operatorKey}` });
const OTHER = () => ({ authorization: `Bearer ${otherKey}` });
const BUYER_HEADERS = () => ({ ...OTHER(), "x-test-proven-wallet": BUYER });
let app: FastifyInstance;
let operatorKey: string;
let otherKey: string;
let service: { kernelId: string; hasExplicitConfig: boolean; submitJob: ReturnType<typeof vi.fn>; getJobStatus: ReturnType<typeof vi.fn> };

function seedJob(id: string, status = "queued", kernelId = KERNEL) {
  const template = getRepos().jobs.findAll()[0]!;
  getRepos().jobs.insert({
    ...template, id, status, kernelId,
    capabilityId: kernelId === KERNEL ? CAPABILITY : "cap-n174-b",
    cwmId: `cwm-${id}`, completedAt: null, evidenceBundleId: null,
  });
  return id;
}

function bindBuyer(jobId: string, id = `session-${jobId}`) {
  getStore().db.insert(schema.negotiationSessions).values({
    id, kernelId: KERNEL, jobId, userAgentId: BUYER,
    capabilityType: "fdm", operatorConstraints: {},
    createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z",
  }).run();
}

function held(kernelId = KERNEL, headers = CLAIMED()) {
  return app.inject({ method: "GET", url: `/api/operator/held-jobs?kernelId=${kernelId}`, headers });
}
function poll(status = "queued", kernelId = KERNEL) {
  return app.inject({
    method: "GET", url: `/api/operator/jobs?${new URLSearchParams({ kernelId, status })}`,
    headers: kernelId === KERNEL ? CLAIMED() : OTHER(),
  });
}
async function stop(kernelId = KERNEL, headers = HEADERS()) {
  const res = await app.inject({
    method: "POST", url: "/api/operator/emergency-stop", headers,
    payload: { kernelId, reason: "operator safety test" },
  });
  expect(res.statusCode).toBe(200);
  return res;
}
async function resume(kernelId = KERNEL) {
  const res = await app.inject({
    method: "POST", url: "/api/operator/emergency-resume", headers: HEADERS(), payload: { kernelId },
  });
  expect(res.statusCode).toBe(200);
  return res;
}
function decide(body: Record<string, unknown>, headers = HEADERS()) {
  return app.inject({
    method: "POST", url: "/api/operator/held-jobs", headers, payload: { kernelId: KERNEL, ...body },
  });
}
async function heldIds(kernelId = KERNEL) {
  const res = await held(kernelId, HEADERS());
  expect(res.statusCode).toBe(200);
  return (res.json().heldJobs as Array<{ jobId: string }>).map((j) => j.jobId).sort();
}
async function snapshot() {
  return {
    a: await heldIds(), b: await heldIds(OTHER_KERNEL),
    jobs: getRepos().jobs.findAll().map(({ id, status }) => ({ id, status })),
  };
}
async function stopAndResume() {
  await stop();
  return resume();
}

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MOCK_SETTLEMENT", "true");
  vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", undefined);
  closeStore();
  initStore({ seed: true });
  const repos = getRepos();
  const kernel = repos.kernels.findAll()[0]!;
  const capability = repos.capabilities.findAll()[0]!;
  for (const [kernelId, operatorAddress, id] of [
    [KERNEL, OPERATOR, CAPABILITY], [OTHER_KERNEL, OTHER_OPERATOR, "cap-n174-b"],
  ]) {
    repos.kernels.insert({ ...kernel, id: kernelId, operatorAddress });
    repos.capabilities.insert({ ...capability, id, kernelId, type: "fdm" });
  }
  operatorKey = provisionApiKey({ operatorId: OPERATOR, scopes: ["*"] }).rawKey;
  otherKey = provisionApiKey({ operatorId: OTHER_OPERATOR, scopes: ["*"] }).rawKey;
  service = {
    kernelId: KERNEL, hasExplicitConfig: true,
    submitJob: vi.fn(async ({ jobId }: { jobId: string }) => ({ jobId, deviceId: "device-n174", status: "accepted" })),
    getJobStatus: vi.fn(async () => ({ status: "unknown" })),
  };
  vi.mocked(getKernelService).mockImplementation(() => service as unknown as KernelService);
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as unknown as { provenWallet: string }).provenWallet = proven;
  });
  await app.register(apiGate);
  await app.register(operatorRoutes);
  await app.register(operatorRelayRoutes);
  await app.register(jobRoutes);
  await app.register(jobSubmitRoutes);
  await app.register(paidJobFlowRoutes);
  await app.register(deviceRelayRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("N174 the undispatched hold set", () => {
  it("publishes every dispatchable job-row status in one set", () => {
    expect([...HOLDABLE_JOB_STATUSES].sort()).toEqual(["active", "pending", "queued", "scheduled"]);
  });

  it.each([
    ["queued", "default relay poll and in-process submissions"],
    ["pending", "paid local routing and caller-selected relay poll"],
    ["scheduled", "queued execution-phase alias and caller-selected relay poll"],
    ["active", "mock paid local routing and caller-selected relay poll"],
  ])("engage holds %s work read by %s", async (status) => {
    const id = seedJob(`job-n174-${status}`, status);
    expect((await poll(status)).json().jobs.map((j: { id: string }) => j.id)).toEqual([id]);
    await stop();
    expect(await heldIds()).toEqual([id]);
    expect(getRepos().jobs.findById(id)?.status).toBe(status);
    expect((await poll(status)).json().jobs).toEqual([]);
    await resume();
    expect((await poll(status)).json()).toEqual({ emergencyStop: "clear", jobs: [] });
    expect(localJobDispatchDecision(KERNEL, KERNEL, true, undefined, id)).toEqual({ ok: false, reason: "held" });
  });

  it("does not hold work already executing or finished", async () => {
    for (const status of ["executing", "in_progress", "running", "completing", "completed", "failed", "cancelled", "settled"]) {
      seedJob(`job-n174-finished-${status}`, status);
    }
    await stop();
    expect(await heldIds()).toEqual([]);
  });

  it("submitting while stopped persists queued work and its hold without invoking the kernel", async () => {
    await stop();
    const submitted = await app.inject({
      method: "POST", url: "/api/jobs/submit", headers: CLAIMED(),
      payload: { kernelId: KERNEL, capabilityId: CAPABILITY, stepId: "n174-stopped-step" },
    });
    expect(submitted.statusCode).toBe(200);
    const id = submitted.json().jobId as string;
    expect(submitted.json().status).toBe("queued");
    expect(getRepos().jobs.findById(id)?.status).toBe("queued");
    expect(await heldIds()).toEqual([id]);
    expect(service.submitJob).not.toHaveBeenCalled();
    const reset = await resume();
    expect(reset.json()).toMatchObject({ resumed: true, kernelId: KERNEL, heldCount: 1, confirmRequired: true });
    expect(reset.json().heldJobs).toEqual([{ jobId: id, capabilityId: CAPABILITY, heldAt: expect.any(String) }]);
    expect((await poll()).json().jobs).toEqual([]);
    expect(localJobDispatchDecision(KERNEL, KERNEL, true, undefined, id)).toEqual({ ok: false, reason: "held" });
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("paid routing queues and holds a job when the stop lands after discovery preflight", async () => {
    let stopped = false;
    vi.mocked(getKernelService).mockImplementation(() => {
      if (!stopped) {
        stopped = true;
        const now = new Date().toISOString();
        getStore().db.insert(schema.operatorPolicies).values({
          kernelId: KERNEL, policy: { emergencyStop: true }, updatedAt: now,
        }).onConflictDoUpdate({ target: schema.operatorPolicies.kernelId, set: { policy: { emergencyStop: true }, updatedAt: now } }).run();
      }
      return service as unknown as KernelService;
    });
    const submitted = await app.inject({
      method: "POST", url: "/api/jobs/submit-from-discovery", headers: HEADERS(),
      payload: { kernelId: KERNEL, capabilityType: "fdm", userAgentId: BUYER },
    });
    expect(submitted.statusCode).toBe(201);
    const { jobId, scopeId } = submitted.json() as { jobId: string; scopeId: string };
    expect(getRepos().jobs.findById(jobId)?.status).toBe("queued");
    expect(await heldIds()).toEqual([jobId]);
    expect(service.submitJob).not.toHaveBeenCalled();
    await resume();
    expect((await poll()).json().jobs).toEqual([]);
    const acceptance = await app.inject({
      method: "POST", url: `/api/operator/scopes/${scopeId}/accept`, headers: HEADERS(), payload: {},
    });
    expect(acceptance.statusCode).toBe(409);
    expect(getStore().db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, scopeId)).get()?.status).not.toBe("active");
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("local safety admission rechecks a hold even when the stop was reset during its await", async () => {
    const id = seedJob("job-n174-local-await");
    const local = new KernelService({
      kernelId: KERNEL,
      devices: [{ id: "device-n174-local", type: "machine", adapterType: "mock", config: {} }],
    });
    const run = vi.spyOn(JobRunner.prototype, "run").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(getSafetyGateway(), "validateOnly").mockImplementation(async () => {
      await stop();
      await resume();
      return { allowed: true };
    });
    const result = await local.submitJob({ jobId: id, kernelId: KERNEL, stepId: "n174-local-await" });
    expect(result).toEqual({ jobId: id, deviceId: null, status: "queued", reason: "held" });
    expect(run).not.toHaveBeenCalled();
    expect(await heldIds()).toEqual([id]);
    expect((await poll()).json().jobs).toEqual([]);
  });

  it("a paid job's existing active scope cannot admit or dispatch work after reset while held", async () => {
    const policy = await app.inject({
      method: "PUT", url: `/api/operator/policy/${KERNEL}`, headers: HEADERS(),
      payload: { ...DEFAULT_OPERATOR_POLICY, approvalMode: "auto" },
    });
    expect(policy.statusCode).toBe(200);
    const submitted = await app.inject({
      method: "POST", url: "/api/jobs/submit-from-discovery", headers: HEADERS(),
      payload: { kernelId: KERNEL, capabilityType: "fdm", userAgentId: BUYER },
    });
    expect(submitted.statusCode).toBe(201);
    const { jobId, scopeId } = submitted.json() as { jobId: string; scopeId: string };
    expect(getRepos().jobs.findById(jobId)?.status).toBe("active");
    const scope = getStore().db.select().from(schema.executionScopes).where(eq(schema.executionScopes.id, scopeId)).get()!;
    expect(scope.status).toBe("active");
    await stopAndResume();
    expect(await heldIds()).toEqual([jobId]);
    const newScope = await app.inject({
      method: "POST", url: `/api/relay/${KERNEL}/scope`, headers: HEADERS(),
      payload: { jobId, createdBy: BUYER, allowedTools: [scope.allowedTools[0]] },
    });
    expect(newScope.statusCode).toBe(409);
    expect(newScope.json()).toEqual({ error: "job_held" });
    const admission = await app.inject({
      method: "POST", url: `/api/relay/${KERNEL}/tool-call`, headers: HEADERS(),
      payload: { scopeId, toolName: scope.allowedTools[0], args: {} },
    });
    expect(admission.statusCode).toBe(403);
    expect(admission.json().reason).toBe("job_held");
    // A legacy writer may have queued a scoped call without the current admission checks.
    getStore().db.insert(schema.toolCallRelay).values({
      id: "call-n174-paid-held", kernelId: KERNEL, scopeId, toolName: scope.allowedTools[0]!,
      toolArgs: {}, status: "pending", createdAt: new Date().toISOString(),
    }).run();
    const dispatch = await app.inject({
      method: "GET", url: `/api/relay/${KERNEL}/tool-call/pending`, headers: { ...CLAIMED(), "x-pcc-lease": "1" },
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.json().calls).toEqual([]);
    expect(getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.id, "call-n174-paid-held")).get())
      .toMatchObject({ status: "rejected", error: "job_held" });
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it.each(["PUT", "PATCH"] as const)("a truthy policy %s engages holds, and clearing the policy leaves them held", async (method) => {
    const id = seedJob(`job-n174-policy-${method.toLowerCase()}`);
    const engage = await app.inject({
      method, url: `/api/operator/policy/${KERNEL}`, headers: HEADERS(),
      payload: { version: 1, emergencyStop: "enabled" },
    });
    expect(engage.statusCode).toBe(200);
    expect(await heldIds()).toEqual([id]);
    const reset = await app.inject({
      method, url: `/api/operator/policy/${KERNEL}`, headers: HEADERS(),
      payload: { version: 1, emergencyStop: false },
    });
    expect(reset.statusCode).toBe(200);
    expect(await heldIds()).toEqual([id]);
    expect((await poll()).json()).toEqual({ emergencyStop: "clear", jobs: [] });
  });

  it.each([
    ["in_progress", "queued"],
    ["paused", "pending"],
  ])("a %s job the node returns to %s during the stop is held by the reset", async (from, to) => {
    const id = seedJob(`job-n174-returned-${from}`, from);
    await stop();
    expect(await heldIds()).toEqual([]);
    const returned = await app.inject({
      method: "POST", url: "/api/operator/job-status", headers: CLAIMED(),
      payload: { jobId: id, kernelId: KERNEL, status: to },
    });
    expect(returned.statusCode).toBe(200);
    expect((await resume()).json()).toMatchObject({ heldCount: 1, confirmRequired: true });
    expect(await heldIds()).toEqual([id]);
    expect((await poll(to)).json()).toEqual({ emergencyStop: "clear", jobs: [] });
    expect(localJobDispatchDecision(KERNEL, KERNEL, true, undefined, id)).toEqual({ ok: false, reason: "held" });
  });

  it.each(["PUT", "PATCH"] as const)("a %s that clears the stop holds work returned to the queue during it", async (method) => {
    const id = seedJob(`job-n174-returned-${method.toLowerCase()}`, "in_progress");
    await stop();
    expect((await app.inject({
      method: "POST", url: "/api/operator/job-status", headers: CLAIMED(),
      payload: { jobId: id, kernelId: KERNEL, status: "queued" },
    })).statusCode).toBe(200);
    const reset = await app.inject({
      method, url: `/api/operator/policy/${KERNEL}`, headers: HEADERS(),
      payload: { version: 1, emergencyStop: false },
    });
    expect(reset.statusCode).toBe(200);
    expect(await heldIds()).toEqual([id]);
    expect((await poll()).json()).toEqual({ emergencyStop: "clear", jobs: [] });
  });

  it.each(["resume", "PUT", "PATCH"] as const)("a %s of a kernel that is not stopped holds nothing", async (kind) => {
    const clear = await app.inject({
      method: "PUT", url: `/api/operator/policy/${KERNEL}`, headers: HEADERS(),
      payload: { version: 1, emergencyStop: false },
    });
    expect(clear.statusCode).toBe(200);
    const id = seedJob(`job-n174-not-stopped-${kind.toLowerCase()}`);
    const res = kind === "resume"
      ? await resume()
      : await app.inject({
        method: kind, url: `/api/operator/policy/${KERNEL}`, headers: HEADERS(),
        payload: { version: 1, emergencyStop: false },
      });
    expect(res.statusCode).toBe(200);
    if (kind === "resume") expect(res.json()).toMatchObject({ heldCount: 0, confirmRequired: false });
    expect(await heldIds()).toEqual([]);
    expect((await poll()).json().jobs.map((j: { id: string }) => j.id)).toEqual([id]);
  });

  it("reads holds for more job ids than SQLite binds in one statement", async () => {
    const id = seedJob("job-n174-many-ids");
    await stop();
    const holds = jobHoldFieldsById([...Array.from({ length: 32_767 }, (_, i) => `job-n174-absent-${i}`), id]);
    expect(holds.size).toBe(32_768);
    expect(holds.get(id)).toEqual({ held: true, holdReason: "emergency_stop" });
    expect(holds.get("job-n174-absent-0")).toEqual({ held: false });
  });
});

describe("N174 reset and deliberate operator decisions", () => {
  it("resume and held-jobs return sorted, capped held work and a true total", async () => {
    for (let i = 100; i >= 0; i--) seedJob(`job-n174-page-${String(i).padStart(3, "0")}`);
    await stop();
    const reset = await resume();
    const listing = await held();
    expect(listing.statusCode).toBe(200);
    for (const body of [reset.json(), listing.json()]) {
      expect(body.heldCount).toBe(101);
      expect(body.heldJobs).toHaveLength(100);
      expect(body.heldJobs.map((j: { jobId: string }) => j.jobId)).toEqual(
        Array.from({ length: 100 }, (_, i) => `job-n174-page-${String(i).padStart(3, "0")}`),
      );
    }
    expect(reset.json().confirmRequired).toBe(true);
    expect(reset.json().heldJobs).toEqual(listing.json().heldJobs);
    expect((await poll()).json().jobs).toEqual([]);
  });

  it("a reset with no held jobs requires no confirmation", async () => {
    await stop();
    expect((await resume()).json()).toMatchObject({ heldCount: 0, heldJobs: [], confirmRequired: false });
  });

  it("release by id makes exactly those jobs eligible again and preserves their status", async () => {
    const ids = [seedJob("job-n174-release-a"), seedJob("job-n174-release-b"), seedJob("job-n174-release-c")];
    await stopAndResume();
    const res = await decide({ release: [ids[0], ids[2]] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kernelId: KERNEL, released: [ids[0], ids[2]], cancelled: [], refused: [] });
    expect((await poll()).json().jobs.map((j: { id: string }) => j.id).sort()).toEqual([ids[0], ids[2]].sort());
    expect(await heldIds()).toEqual([ids[1]]);
    for (const id of ids) expect(getRepos().jobs.findById(id)?.status).toBe("queued");
  });

  it("release all uses this kernel's entire held set, including rows beyond the preview", async () => {
    for (let i = 0; i < 101; i++) seedJob(`job-n174-all-${String(i).padStart(3, "0")}`);
    const other = seedJob("job-n174-all-other", "queued", OTHER_KERNEL);
    await stop();
    await stop(OTHER_KERNEL);
    await resume();
    const res = await decide({ release: "all" });
    expect(res.statusCode).toBe(200);
    expect(res.json().released).toHaveLength(101);
    expect(res.json().released).not.toContain(other);
    expect(await heldIds()).toEqual([]);
    expect(await heldIds(OTHER_KERNEL)).toEqual([other]);
  });

  it("a released job beyond the first relay page is eligible despite earlier held jobs", async () => {
    for (let i = 0; i < 51; i++) seedJob(`job-n174-relay-page-${String(i).padStart(3, "0")}`);
    await stopAndResume();
    const released = "job-n174-relay-page-050";
    expect((await decide({ release: [released] })).statusCode).toBe(200);
    expect((await poll()).json().jobs.map((job: { id: string }) => job.id)).toEqual([released]);
    expect((await held()).json().heldCount).toBe(50);
  });

  it("cancel deletes an unpaid hold, while the settlement guard keeps paid work held", async () => {
    const unpaid = seedJob("job-n174-cancel-unpaid");
    const paid = seedJob("job-n174-cancel-paid");
    bindBuyer(paid);
    await stopAndResume();
    const res = await decide({ cancel: [unpaid, paid] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kernelId: KERNEL, released: [], cancelled: [unpaid] });
    expect(res.json().refused).toEqual([{ jobId: paid, reason: "settlement_owned_status" }]);
    expect(getRepos().jobs.findById(unpaid)?.status).toBe("cancelled");
    expect(getRepos().jobs.findById(paid)?.status).toBe("queued");
    expect(await heldIds()).toEqual([paid]);
    expect((await poll()).json().jobs).toEqual([]);
  });

  it("release and cancel can make separate decisions in one request", async () => {
    const release = seedJob("job-n174-combined-release");
    const cancel = seedJob("job-n174-combined-cancel");
    await stopAndResume();
    const res = await decide({ release: [release], cancel: [cancel] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kernelId: KERNEL, released: [release], cancelled: [cancel], refused: [] });
    expect(await heldIds()).toEqual([]);
    expect((await poll()).json().jobs.map((j: { id: string }) => j.id)).toEqual([release]);
  });

  it("claimed operator authority may stop and list, but receives resume's refusal when releasing", async () => {
    const id = seedJob("job-n174-claimed");
    await stop(KERNEL, CLAIMED());
    expect((await held()).statusCode).toBe(200);
    const reset = await app.inject({ method: "POST", url: "/api/operator/emergency-resume", headers: CLAIMED(), payload: { kernelId: KERNEL } });
    expect(reset.statusCode).toBe(403);
    await resume();
    const before = await snapshot();
    const res = await decide({ release: [id] }, CLAIMED());
    expect(res.statusCode).toBe(reset.statusCode);
    expect(res.json()).toEqual(reset.json());
    expect(await snapshot()).toEqual(before);
  });

  it("held-jobs listing uses the poll authority for anonymous and other operators", async () => {
    seedJob("job-n174-list-authority");
    await stop();
    for (const headers of [{}, OTHER()]) {
      const listing = await app.inject({ method: "GET", url: `/api/operator/held-jobs?kernelId=${KERNEL}`, headers });
      const queue = await app.inject({ method: "GET", url: `/api/operator/jobs?kernelId=${KERNEL}`, headers });
      expect(listing.statusCode).toBe(queue.statusCode);
      expect(listing.json()).toEqual(queue.json());
    }
  });

  it("release while stopped returns 409 and changes nothing", async () => {
    const id = seedJob("job-n174-stopped-release");
    await stop();
    const before = await snapshot();
    const res = await decide({ release: [id] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "emergency_stopped" });
    expect(await snapshot()).toEqual(before);
  });

  it("unavailable stop state returns 503 and changes nothing", async () => {
    const id = seedJob("job-n174-unavailable-release");
    await stopAndResume();
    applyUnavailablePolicy(KERNEL, { label: "unavailable", state: "unavailable", policy: null });
    const before = await snapshot();
    const res = await decide({ cancel: [id] });
    expect(res.statusCode).toBe(503);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["foreign", "unheld", "mixed release", "mixed cancel"])("%s ids refuse the entire decision without a kernel disclosure", async (kind) => {
    const own = seedJob("job-n174-negative-own");
    const foreign = seedJob("job-n174-negative-foreign", "queued", OTHER_KERNEL);
    await stop();
    await stop(OTHER_KERNEL);
    await resume();
    const unheld = seedJob("job-n174-negative-unheld");
    const bad = kind === "foreign" ? foreign : unheld;
    const body = kind === "mixed release" ? { release: [own, bad] }
      : kind === "mixed cancel" ? { release: [own], cancel: [bad] }
      : { release: [bad] };
    const before = await snapshot();
    const res = await decide(body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not_held_for_kernel" });
    expect(JSON.stringify(res.json())).not.toContain(OTHER_KERNEL);
    expect(await snapshot()).toEqual(before);
  });
});

describe("N174 request validation leaves every hold unchanged", () => {
  it.each([
    ["neither decision", {}],
    ["unknown key", { release: "all", extra: true }],
    ["empty release", { release: [] }],
    ["empty cancel", { cancel: [] }],
    ["numeric id", { release: [17] }],
    ["null id", { cancel: [null] }],
    ["empty id", { release: [""] }],
    ["whitespace id", { cancel: [" "] }],
    ["release string", { release: "job-n174-validation" }],
    ["cancel all", { cancel: "all" }],
    ["more than 100 release ids", { release: Array.from({ length: 101 }, (_, i) => `job-${i}`) }],
    ["more than 100 cancel ids", { cancel: Array.from({ length: 101 }, (_, i) => `job-${i}`) }],
    ["more than 100 combined ids", {
      release: Array.from({ length: 50 }, (_, i) => `release-${i}`),
      cancel: Array.from({ length: 51 }, (_, i) => `cancel-${i}`),
    }],
    ["same id in both", { release: ["job-n174-validation"], cancel: ["job-n174-validation"] }],
    ["all and overlapping cancel", { release: "all", cancel: ["job-n174-validation"] }],
  ])("%s returns 400", async (_label, body) => {
    seedJob("job-n174-validation");
    await stopAndResume();
    const before = await snapshot();
    const res = await decide(body);
    expect(res.statusCode).toBe(400);
    expect(await snapshot()).toEqual(before);
  });
});

describe("N174 buyer reads and repeated stops", () => {
  it("the buyer's job detail, list, status and execution read show held then released", async () => {
    const id = seedJob("job-n174-buyer-read");
    bindBuyer(id);
    await stopAndResume();
    for (const heldValue of [true, false]) {
      const detail = await app.inject({ method: "GET", url: `/api/jobs/${id}`, headers: BUYER_HEADERS() });
      const listing = await app.inject({ method: "GET", url: `/api/jobs?kernelId=${KERNEL}`, headers: BUYER_HEADERS() });
      const status = await app.inject({ method: "GET", url: `/api/jobs/${id}/status`, headers: BUYER_HEADERS() });
      const execution = await app.inject({ method: "GET", url: `/api/jobs/${id}/execution`, headers: BUYER_HEADERS() });
      for (const response of [detail, listing, status, execution]) expect(response.statusCode).toBe(200);
      for (const dto of [detail.json().job, listing.json().jobs.find((j: { id: string }) => j.id === id), status.json(), execution.json().job]) {
        expect(dto.held).toBe(heldValue);
        if (heldValue) expect(dto.holdReason).toBe("emergency_stop");
        else expect(dto).not.toHaveProperty("holdReason");
      }
      if (heldValue) expect((await decide({ release: [id] })).statusCode).toBe(200);
    }
  });

  it("a job submitted after the first reset is free, then held by a second stop", async () => {
    const first = seedJob("job-n174-first-cycle");
    await stopAndResume();
    const submitted = await app.inject({
      method: "POST", url: "/api/jobs/submit", headers: CLAIMED(),
      payload: { kernelId: KERNEL, capabilityId: CAPABILITY, stepId: "n174-between-cycles", queueOnly: true },
    });
    expect(submitted.statusCode).toBe(200);
    const second = submitted.json().jobId as string;
    expect(await heldIds()).toEqual([first]);
    expect((await poll()).json().jobs.map((j: { id: string }) => j.id)).toEqual([second]);
    await stopAndResume();
    expect(await heldIds()).toEqual([first, second].sort());
    expect((await poll()).json().jobs).toEqual([]);
    expect(service.submitJob).not.toHaveBeenCalled();
  });

  it("engage still rejects pending approvals and pending relay calls while preserving claimed calls", async () => {
    const approval = await app.inject({
      method: "POST", url: "/api/operator/approvals", headers: CLAIMED(),
      payload: { kernelId: KERNEL, agentId: "agent-n174" },
    });
    expect(approval.statusCode).toBe(200);
    const id = approval.json().approval.id as string;
    for (const status of ["pending", "claimed"] as const) {
      getStore().db.insert(schema.toolCallRelay).values({
        id: `call-n174-${status}`, kernelId: KERNEL, toolName: "printer_status", toolArgs: {},
        status, createdAt: new Date().toISOString(),
      }).run();
    }
    await stop();
    expect(getStore().db.select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.id, id)).get()?.status).toBe("rejected");
    const pending = getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.id, "call-n174-pending")).get();
    expect(pending).toMatchObject({ status: "rejected", error: "emergency_stopped", completedAt: expect.any(String) });
    expect(getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.id, "call-n174-claimed")).get()?.status).toBe("claimed");
    await resume();
    expect(getStore().db.select().from(schema.toolCallRelay).where(eq(schema.toolCallRelay.id, "call-n174-pending")).get()?.status).toBe("rejected");
  });
});

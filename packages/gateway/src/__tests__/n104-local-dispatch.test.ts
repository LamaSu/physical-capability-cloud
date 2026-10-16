/** N104: every submission entry point fails closed before in-process actuation. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { JobRunner } from "@pcc/kernel";
import { schema, eq } from "@pcc/store";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { getKernelService, KernelService } from "../services/kernel-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { auditService } from "../services/audit-service.js";
import { UNAVAILABLE_POLICY_CASES, applyUnavailablePolicy } from "./helpers/emergency-stop-policy-cases.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import {
  a2aTasksRoutes,
  __resetA2ATasksForTest,
  commitPccSession,
  createPccQuote,
} from "../routes/a2a-tasks.js";
import { createProductionBinding } from "../routes/compose.js";

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn(), isReady: vi.fn().mockReturnValue(true), stop: vi.fn(),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafy-n104", metadataCid: "bafy-n104-meta" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafy-n104-enc", metadataCid: "bafy-n104-enc-meta" }),
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

const KERNEL = "kernel-nyc";
const ADMIN = "n104-submit-admin";
const headers = { "x-admin-key": ADMIN };
const ENV_KEYS = ["PCC_JOB_SUBMIT_QUEUE_ONLY", "PCC_ADMIN_KEY", "PCC_A2A_AUTH_DISABLED", "MOCK_SETTLEMENT", "PCC_DB_PATH", "NODE_ENV", "KERNEL_CONFIG", "KERNEL_CONFIG_FILE", "KERNEL_ID"] as const;
let savedEnv: Record<string, string | undefined>;
let app: FastifyInstance;
let kernel: { kernelId: unknown; hasExplicitConfig: boolean; submitJob: ReturnType<typeof vi.fn> };

function stopKernel() {
  const { db } = getStore();
  const row = db.select().from(schema.operatorPolicies).where(eq(schema.operatorPolicies.kernelId, KERNEL)).get()!;
  db.update(schema.operatorPolicies).set({ policy: { ...row.policy, emergencyStop: true } })
    .where(eq(schema.operatorPolicies.kernelId, KERNEL)).run();
}

function job(jobId: string) {
  const row = getRepos().jobs.findById(jobId);
  expect(row, `job ${jobId} must be persisted`).toBeDefined();
  return row!;
}

async function reviewSession() {
  const create = await app.inject({
    method: "POST", url: "/api/negotiate/session", headers,
    payload: { kernelId: KERNEL, capabilityType: "fdm", userAgentId: "n104-buyer" },
  });
  expect(create.statusCode).toBe(200);
  const id = create.json().session.id as string;
  expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/review` })).statusCode).toBe(200);
  return id;
}

const paths = [
  {
    name: "POST /api/jobs/submit → JobFacade", dispatches: true,
    async submit() {
      const res = await app.inject({
        method: "POST", url: "/api/jobs/submit",
        payload: { kernelId: KERNEL, stepId: "n104-step" },
      });
      expect(res.statusCode).toBe(200);
      return job(res.json().jobId);
    },
  },
  {
    name: "compose production step → real JobFacade", dispatches: true,
    async submit() {
      const existing = new Set(getStore().db.select().from(schema.jobs).all().map((row) => row.id));
      await createProductionBinding().runStep!({
        index: 0, capabilityType: "fdm", capabilityId: "cap-nyc-fdm", kernelId: KERNEL,
        operatorAddress: "n104-operator", estimatedPriceUSD: 1, estimatedDurationMs: 100,
        assuranceTier: 0, dependsOn: [],
      });
      const added = getStore().db.select().from(schema.jobs).all().filter((row) => !existing.has(row.id));
      expect(added).toHaveLength(1);
      return added[0]!;
    },
  },
  {
    name: "POST /api/jobs/submit-from-discovery → paid flow", dispatches: false,
    async submit() {
      const res = await app.inject({
        method: "POST", url: "/api/jobs/submit-from-discovery", headers,
        payload: { kernelId: KERNEL, capabilityType: "fdm", userAgentId: "n104-buyer" },
      });
      expect(res.statusCode).toBe(201);
      return job(res.json().jobId);
    },
  },
  {
    name: "negotiation commit → paid flow", dispatches: false,
    async submit() {
      const id = await reviewSession();
      const res = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit`, headers });
      expect(res.statusCode).toBe(200);
      return job(res.json().session.jobId);
    },
  },
  {
    name: "negotiation retry-settlement → paid flow", dispatches: false,
    async submit() {
      const id = await reviewSession();
      // Enter the recoverable state without making a network/chain write. Mock
      // recovery follows the same createJobFromSession wiring as a real retry.
      getStore().db.update(schema.negotiationSessions).set({ status: "settlement_failed" })
        .where(eq(schema.negotiationSessions.id, id)).run();
      const res = await app.inject({ method: "POST", url: `/api/negotiate/session/${id}/retry-settlement`, headers });
      expect(res.statusCode).toBe(200);
      return job(res.json().jobId);
    },
  },
  {
    name: "A2A tasks/send pcc-submit → paid flow", dispatches: false,
    async submit() {
      const res = await app.inject({
        method: "POST", url: "/a2a/tasks/send", headers,
        payload: {
          jsonrpc: "2.0", id: "n104", method: "tasks/send",
          params: { skill: "pcc-submit", params: { kernelId: KERNEL, capabilityType: "fdm", userAgentId: "n104-buyer" } },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().error).toBeUndefined();
      const sessionId = res.json().result.pccSessionId as string;
      const session = getStore().db.select().from(schema.negotiationSessions)
        .where(eq(schema.negotiationSessions.id, sessionId)).get()!;
      return job(session.jobId!);
    },
  },
  {
    name: "A2A quoted-session commit → paid flow", dispatches: false,
    async submit() {
      const quoted = await createPccQuote({ kernelId: KERNEL, capabilityType: "fdm", userAgentId: "n104-buyer" });
      await commitPccSession(quoted.sessionId);
      const session = getStore().db.select().from(schema.negotiationSessions)
        .where(eq(schema.negotiationSessions.id, quoted.sessionId)).get()!;
      return job(session.jobId!);
    },
  },
];

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
  process.env.NODE_ENV = "test";
  process.env.PCC_ADMIN_KEY = ADMIN;
  process.env.PCC_A2A_AUTH_DISABLED = "true";
  process.env.MOCK_SETTLEMENT = "true";
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  __resetA2ATasksForTest();
  kernel = {
    kernelId: KERNEL,
    hasExplicitConfig: true,
    submitJob: vi.fn(async (input: { jobId: string }) => ({ jobId: input.jobId, deviceId: "n104-machine", status: "accepted" })),
  };
  vi.mocked(getKernelService).mockImplementation(() => kernel as any);
  app = Fastify({ logger: false });
  await app.register(jobSubmitRoutes);
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(a2aTasksRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeStore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe.each(paths)("N104 $name", (path) => {
  it("queues when the local runtime config was not explicit", async () => {
    kernel.hasExplicitConfig = false;
    expect((await path.submit()).status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it("queues when the initialized KernelService has no kernelId", async () => {
    kernel.kernelId = undefined;
    expect((await path.submit()).status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it("queues when the initialized local kernel does not match", async () => {
    kernel.kernelId = "another-local-kernel";
    expect((await path.submit()).status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it("preserves positive-match behavior while the stop is clear", async () => {
    const created = await path.submit();
    expect(kernel.submitJob).toHaveBeenCalledTimes(path.dispatches ? 1 : 0);
    if (!path.dispatches) expect(created.status).toBe("active");
  });

  it("queues a matching kernel when the operator sets PCC_JOB_SUBMIT_QUEUE_ONLY=true", async () => {
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = "true";
    expect((await path.submit()).status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it("queues a matching kernel when e-stop activates before the dispatch decision", async () => {
    // Trigger a real DB-backed stop only after earlier quote/policy preflight,
    // proving each entry point rechecks at routing rather than relying on it.
    vi.mocked(getKernelService).mockImplementation(() => {
      stopKernel();
      return kernel as any;
    });
    expect((await path.submit()).status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it.each(UNAVAILABLE_POLICY_CASES)("queues unreadable policy: $label", async (policyCase) => {
    // Install after quote/review reads, just as the stop can change before routing.
    let installed = false;
    vi.mocked(getKernelService).mockImplementation(() => {
      if (!installed) {
        installed = true;
        applyUnavailablePolicy(KERNEL, policyCase);
      }
      return kernel as any;
    });
    expect((await path.submit()).status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });
});

describe("N104 local identity and operator-only flag", () => {
  it("preserves discovery's refusal when the kernel is already e-stopped", async () => {
    stopKernel();
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit-from-discovery", headers,
      payload: { kernelId: KERNEL, capabilityType: "fdm", userAgentId: "n104-buyer" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/emergency stop/i);
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it("preserves A2A pcc-submit's refusal when the kernel is already e-stopped", async () => {
    stopKernel();
    const res = await app.inject({
      method: "POST", url: "/a2a/tasks/send", headers,
      payload: {
        jsonrpc: "2.0", id: "n104-stopped", method: "tasks/send",
        params: { skill: "pcc-submit", params: { kernelId: KERNEL, capabilityType: "fdm", userAgentId: "n104-buyer" } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error.message).toMatch(/emergency stop/i);
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it.each(["", 42, false, null])("does not dispatch for unusable local identity %j", async (identity) => {
    kernel.kernelId = identity;
    expect((await paths[0]!.submit()).status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it.each(["false", "TRUE", "1", ""])('only exact "true" enables queue-only mode (%j)', async (value) => {
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = value;
    await paths[0]!.submit();
    expect(kernel.submitJob).toHaveBeenCalledOnce();
  });

  it.each([true, false])("a client cannot override operator queue-only mode with %j", async (value) => {
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = "true";
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit",
      payload: {
        kernelId: KERNEL, stepId: "n104-client-override",
        queueOnly: value, PCC_JOB_SUBMIT_QUEUE_ONLY: value,
        parameters: { queueOnly: value, PCC_JOB_SUBMIT_QUEUE_ONLY: value },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it("a client can request queue-only for its own submission", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit",
      payload: {
        kernelId: KERNEL, stepId: "n104-client-enable",
        queueOnly: true, PCC_JOB_SUBMIT_QUEUE_ONLY: "true",
        parameters: { queueOnly: true, PCC_JOB_SUBMIT_QUEUE_ONLY: "true" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "queued", deviceId: null, reason: "queue_only" });
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it.each([false, "true", "false", "TRUE", 1, 0, null, {}, []])("ignores non-true client queueOnly %j", async (value) => {
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit",
      payload: { kernelId: KERNEL, stepId: "client-strict-boolean", queueOnly: value },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("accepted");
    expect(kernel.submitJob).toHaveBeenCalledOnce();
  });

  it.each([undefined, "true", "TRUE", "0", ""])('production defaults to queue-only for %j', async (value) => {
    process.env.NODE_ENV = "production";
    if (value === undefined) delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
    else process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = value;
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit", payload: { kernelId: KERNEL, stepId: "prod-default" },
    });
    expect(res.json()).toMatchObject({ status: "queued", deviceId: null, reason: "queue_only" });
    expect(kernel.submitJob).not.toHaveBeenCalled();
  });

  it('production exact "false" permits an explicitly configured local kernel', async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_JOB_SUBMIT_QUEUE_ONLY = "false";
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit", payload: { kernelId: KERNEL, stepId: "prod-local-opt-in" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("accepted");
    expect(kernel.submitJob).toHaveBeenCalledOnce();
  });

  it("P1: production's unconfigured placeholder queues without running", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.KERNEL_CONFIG;
    delete process.env.KERNEL_CONFIG_FILE;
    delete process.env.KERNEL_ID;
    const repos = getRepos();
    repos.kernels.insert({ ...repos.kernels.findById(KERNEL)!, id: "kernel_dev_001" });
    repos.capabilities.insert({ ...repos.capabilities.findById("cap-nyc-fdm")!, id: "cap-placeholder", kernelId: "kernel_dev_001" });
    const run = vi.spyOn(JobRunner.prototype, "run").mockImplementation(() => new Promise(() => {}));
    const service = new KernelService();
    expect(service.hasExplicitConfig).toBe(false);
    vi.mocked(getKernelService).mockReturnValue(service);
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit",
      payload: { kernelId: "kernel_dev_001", stepId: "p1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "queued", deviceId: null, reason: "no_configured_local_kernel" });
    expect(job(res.json().jobId).status).toBe("queued");
    expect(run).not.toHaveBeenCalled();
  });

  it("records a late-blocked local job as queued in telemetry and audit", async () => {
    const telemetry = vi.spyOn(pipelineTelemetry, "emit");
    kernel.submitJob.mockImplementation(async ({ jobId }: { jobId: string }) => {
      stopKernel();
      return { jobId, deviceId: null, status: "queued", reason: "emergency_stop" };
    });
    const res = await app.inject({
      method: "POST", url: "/api/jobs/submit", payload: { kernelId: KERNEL, stepId: "late-block" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "queued", deviceId: null });
    expect(kernel.submitJob).toHaveBeenCalledOnce();
    expect.soft(telemetry).toHaveBeenCalledWith(res.json().jobId, "job_submit", "completed", {
      metadata: { kernelId: KERNEL, stepId: "late-block", external: true, reason: "emergency_stop" },
    });
    expect.soft(auditService.query({ resourceId: res.json().jobId, eventType: "job.submitted" }))
      .toEqual([expect.objectContaining({ metadata: expect.objectContaining({ external: true, reason: "emergency_stop" }) })]);
    expect(res.json().reason).toBe("emergency_stop");
  });
});

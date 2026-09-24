/**
 * Producer-side execution-scope minting.
 *
 * Third and last layer of the JobRunner safety boundary:
 *
 *   Layer 1 (packages/kernel, job-runner-safety.test.ts) — JobRunner refuses to
 *           actuate a scoped command with no scope.
 *   Layer 2 (kernel-service-scope.test.ts) — KernelService carries the caller's
 *           scope to that boundary and never mints one of its own.
 *   Layer 3 (here) — the in-process job PRODUCERS mint the scope, bind it to the
 *           job, and record who it was issued to.
 *
 * Layers 1 and 2 are the deny side. Without layer 3 they deny *everything*: a
 * gateway-submitted job carried no scope, so it failed closed at the pre-flight
 * with zero machine.execute calls. So these tests are about whether the grant
 * exists, is bound to the right job and principal, and reaches the device — and,
 * just as importantly, that a caller cannot supply one of their own.
 *
 * Assertions go all the way down to SafetyGateway.validateAndRelay (what the
 * governor actually saw) rather than stopping at the HTTP response, because a
 * 200 here only means the job was *admitted*.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";

// ── Mocks (hoisted before imports) ────────────────────────────────────────────
// Same set as kernel-service-scope.test.ts: Sentry's span wrappers must invoke
// their callbacks or the fire-and-forget runner.run() never executes, and the
// storage/chain clients must not reach the network.
vi.mock("../sentry.js", () => ({
  initSentry: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  Sentry: {
    startSpan: vi.fn().mockImplementation(async (_o: unknown, cb: () => Promise<unknown>) => cb()),
    startSpanManual: vi.fn().mockImplementation((_o: unknown, cb: (span: object) => void) => {
      cb({ end: vi.fn(), setStatus: vi.fn() });
    }),
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
    init: vi.fn(),
    withScope: vi.fn().mockImplementation((cb: (s: object) => void) => cb({ setTag: vi.fn(), setExtra: vi.fn() })),
  },
}));

vi.mock("../sse/stream-hub.js", () => ({
  streamHub: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_producer_scope" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_producer_scope_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xproducer_scope_evidence" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xproducer_scope_release" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "e", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import Fastify, { type FastifyInstance } from "fastify";
import { schema, eq } from "@pcc/store";
import { initStore, closeStore, getStore } from "../db.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { setupRoutes } from "../routes/setup.js";
import { KernelService, initKernelService, resetKernelService } from "../services/kernel-service.js";
import {
  getSafetyGateway,
  initSafetyGateway,
  resetSafetyGateway,
  registerMachineAdapter,
  unregisterMachineAdapter,
} from "@pcc/kernel";
import type { MachineAdapter, KernelConfig } from "@pcc/kernel";

const { executionScopes } = schema;

// ── Test adapter ──────────────────────────────────────────────────────────────

/** Every command that reached the "hardware". Empty = the boundary denied. */
const executed: Array<{ deviceId: string; type: string }> = [];

class RecordingAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "fdm" as const;
  readonly source: MachineAdapter["source"];
  constructor(id: string, kernelId: string) {
    this.id = id;
    this.source = { deviceId: id, deviceType: "controller", kernelId };
  }
  async getStatus(): ReturnType<MachineAdapter["getStatus"]> {
    return "idle";
  }
  async execute(
    command: Parameters<MachineAdapter["execute"]>[0],
  ): ReturnType<MachineAdapter["execute"]> {
    executed.push({ deviceId: this.id, type: command.type });
    return { success: true };
  }
  /** 100 → waitForCompletion() returns on its first poll, so no timers. */
  async getProgress(): Promise<number> {
    return 100;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {}
  async dispose(): Promise<void> {}
}

const REC_TYPE = "test-recording-producer-scope";
const DEVICE_ID = "dev-producer-scope";
const MOCK_DEVICE_ID = "dev-producer-scope-mock";
/** Seeded kernel — initStore({seed:true}) gives it capabilities to resolve. */
const KERNEL_ID = "kernel-nyc";
const PRINCIPAL = "operator-scope-test@example.com";

/** Recording adapter — lets us assert exactly what reached the hardware. */
function makeConfig(): KernelConfig {
  return {
    kernelId: KERNEL_ID,
    mockMode: false,
    devices: [{ id: DEVICE_ID, type: "machine", adapterType: REC_TYPE, config: {} }],
  };
}

/**
 * The real mock adapter. Unlike RecordingAdapter it emits the evidence events a
 * tier-0 bundle needs, so a job on it reaches status "completed" rather than
 * "failed" — which is what the onboarding self-test polls for. Swap it in with
 * useMockAdapterKernel() before hitting /api/setup/test-job.
 */
function makeMockAdapterConfig(): KernelConfig {
  return {
    kernelId: KERNEL_ID,
    mockMode: true,
    devices: [
      {
        id: MOCK_DEVICE_ID,
        type: "machine",
        adapterType: "mock",
        config: { kernelId: KERNEL_ID, jobDurationMs: 50 },
      },
    ],
  };
}

function useMockAdapterKernel(): void {
  resetKernelService();
  initKernelService(makeMockAdapterConfig());
}

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!pred()) throw new Error("waitFor: condition not met within timeout");
}

/** Rows in execution_scopes bound to a given job. */
function scopesForJob(jobId: string) {
  const { db } = getStore();
  return db.select().from(executionScopes).where(eq(executionScopes.jobId, jobId)).all();
}

/**
 * Build the app.
 *
 * `authenticated` installs the one thing the real api-gate middleware
 * contributes to this code path: `req.operatorId`. Both producers read
 * `operatorId ?? apiKeyId` as the principal, so this is what makes
 * `created_by` assertable rather than the unauthenticated fallback.
 */
async function buildApp(opts: { authenticated: boolean }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  if (opts.authenticated) {
    app.addHook("onRequest", async (req) => {
      (req as any).operatorId = PRINCIPAL;
    });
  }
  await app.register(jobSubmitRoutes);
  await app.register(setupRoutes);
  await app.ready();
  return app;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  try { unregisterMachineAdapter(REC_TYPE); } catch { /* not registered */ }
  registerMachineAdapter(REC_TYPE, (device, _cfg, kernelId) => new RecordingAdapter(device.id, kernelId));
});

afterAll(() => {
  try { unregisterMachineAdapter(REC_TYPE); } catch { /* already gone */ }
});

let app: FastifyInstance | null = null;

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  resetKernelService();
  resetSafetyGateway();
  initSafetyGateway();
  initKernelService(makeConfig());
  executed.length = 0;
});

afterEach(async () => {
  await app?.close();
  app = null;
  resetKernelService();
  resetSafetyGateway();
  closeStore();
  // clearAllMocks, NOT restoreAllMocks — restore strips the implementations off
  // the hoisted vi.mock factories above, which turns Sentry.startSpanManual
  // into a no-op that never invokes its callback, so runner.run() silently
  // stops executing for every test after the first.
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Producer 1 — POST /api/jobs/submit (facades/job.facade.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/jobs/submit — mints an execution scope for the job", () => {
  it("creates exactly one scope row bound to the job and the principal", async () => {
    app = await buildApp({ authenticated: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit",
      payload: { jobId: "job-producer-scope-1", stepId: "step-1", kernelId: KERNEL_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("accepted");

    const rows = scopesForJob("job-producer-scope-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].kernelId).toBe(KERNEL_ID);
    expect(rows[0].createdBy).toBe(PRINCIPAL);
    expect(rows[0].status).toBe("active");
    expect(Array.isArray(rows[0].allowedTools)).toBe(true);
    expect(rows[0].allowedTools.length).toBeGreaterThan(0);
    // Bound to a future, so the grant is not born expired.
    expect(new Date(rows[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("hands that exact scope to KernelService.submitJob", async () => {
    const submitSpy = vi.spyOn(KernelService.prototype, "submitJob");
    app = await buildApp({ authenticated: true });

    await app.inject({
      method: "POST",
      url: "/api/jobs/submit",
      payload: { jobId: "job-producer-scope-2", stepId: "step-2", kernelId: KERNEL_ID },
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const params = submitSpy.mock.calls[0][0];
    const row = scopesForJob("job-producer-scope-2")[0];
    expect(row).toBeDefined();
    // The id the boundary was handed is the id that was persisted — not a
    // second, unrecorded scope, and not undefined.
    expect(params.scopeId).toBe(row.id);
    expect(params.agentDid).toBe(`did:pcc:${PRINCIPAL}`);

    submitSpy.mockRestore();
  });

  it("the scope reaches the device: both commands actuate carrying it", async () => {
    const relaySpy = vi.spyOn(getSafetyGateway(), "validateAndRelay");
    app = await buildApp({ authenticated: true });

    await app.inject({
      method: "POST",
      url: "/api/jobs/submit",
      payload: { jobId: "job-producer-scope-3", stepId: "step-3", kernelId: KERNEL_ID },
    });

    // Positive control: before this change `executed` stayed empty forever,
    // because the pre-flight denied the unscoped job.
    await waitFor(() => executed.length >= 2);
    expect(executed.map((e) => e.type)).toEqual(["load_gcode", "start"]);

    const scopeId = scopesForJob("job-producer-scope-3")[0].id;
    const relayed = relaySpy.mock.calls.map((c) => c[0]);
    expect(relayed.map((c) => c.type)).toEqual(["load_gcode", "start"]);
    for (const cmd of relayed) {
      expect(cmd.class).toBe("scoped");
      expect(cmd.scopeId).toBe(scopeId);
      expect(cmd.agentDid).toBe(`did:pcc:${PRINCIPAL}`);
    }
  });

  it("records the unauthenticated principal rather than inventing an operator", async () => {
    app = await buildApp({ authenticated: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit",
      payload: { jobId: "job-producer-scope-4", stepId: "step-4", kernelId: KERNEL_ID },
    });

    expect(res.statusCode).toBe(200);
    const rows = scopesForJob("job-producer-scope-4");
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe("unauthenticated");
  });

  it("mints no scope on the external-kernel path (nothing is dispatched in-process)", async () => {
    app = await buildApp({ authenticated: true });

    // kernel-la is seeded but is not the local kernel, so the facade returns
    // "queued" for a remote operator daemon to pick up. No in-process dispatch
    // means no grant: minting one here would hand out an unused credential
    // that device-relay could still resolve.
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit",
      payload: { jobId: "job-producer-scope-5", stepId: "step-5", kernelId: "kernel-la" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("queued");
    expect(scopesForJob("job-producer-scope-5")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative control — a caller cannot bring their own scope
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/jobs/submit — a caller-supplied scopeId is ignored", () => {
  it("uses the freshly minted scope, never the one in the request body", async () => {
    const submitSpy = vi.spyOn(KernelService.prototype, "submitJob");
    const relaySpy = vi.spyOn(getSafetyGateway(), "validateAndRelay");
    app = await buildApp({ authenticated: true });

    // A scope that exists, is active, and belongs to SOMEBODY ELSE — the
    // strongest form of the attack, since a naive "does this id resolve?"
    // check would wave it through.
    const { db } = getStore();
    const FOREIGN_SCOPE = "scope_foreign_victim_001";
    db.insert(executionScopes).values({
      id: FOREIGN_SCOPE,
      kernelId: KERNEL_ID,
      jobId: "job-belonging-to-someone-else",
      createdBy: "victim-operator@example.com",
      status: "active",
      allowedTools: ["printer_start_job"],
      maxCommands: 200,
      commandCount: 0,
      maxRetries: 5,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }).run();

    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit",
      payload: {
        jobId: "job-producer-scope-attack",
        stepId: "step-attack",
        kernelId: KERNEL_ID,
        // The route body schema is additionalProperties:true, so these DO
        // arrive at the handler. They must not be honoured.
        scopeId: FOREIGN_SCOPE,
        agentDid: "did:pcc:victim-operator@example.com",
      },
    });

    expect(res.statusCode).toBe(200);

    const minted = scopesForJob("job-producer-scope-attack");
    expect(minted).toHaveLength(1);
    expect(minted[0].id).not.toBe(FOREIGN_SCOPE);
    expect(minted[0].createdBy).toBe(PRINCIPAL);

    // THE NEGATIVE CONTROL: what the boundary was handed is the minted scope,
    // and the victim's scope never reached it.
    const params = submitSpy.mock.calls[0][0];
    expect(params.scopeId).toBe(minted[0].id);
    expect(params.scopeId).not.toBe(FOREIGN_SCOPE);
    expect(params.agentDid).toBe(`did:pcc:${PRINCIPAL}`);

    // ...and the same holds all the way down at the governor.
    await waitFor(() => executed.length >= 2);
    const relayed = relaySpy.mock.calls.map((c) => c[0]);
    expect(relayed.length).toBeGreaterThan(0);
    for (const cmd of relayed) {
      expect(cmd.scopeId).toBe(minted[0].id);
      expect(cmd.scopeId).not.toBe(FOREIGN_SCOPE);
      expect(cmd.agentDid).not.toBe("did:pcc:victim-operator@example.com");
    }

    // The victim's grant is untouched — not consumed, not rebound.
    const victim = db.select().from(executionScopes).where(eq(executionScopes.id, FOREIGN_SCOPE)).get();
    expect(victim?.jobId).toBe("job-belonging-to-someone-else");
    expect(victim?.createdBy).toBe("victim-operator@example.com");

    submitSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Producer 2 — POST /api/setup/test-job (routes/setup.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/setup/test-job — mints its own scope", () => {
  it("runs the onboarding self-test to completion against the mock adapter", async () => {
    useMockAdapterKernel();
    const relaySpy = vi.spyOn(getSafetyGateway(), "validateAndRelay");
    app = await buildApp({ authenticated: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/test-job",
      payload: { kernelId: KERNEL_ID, deviceId: MOCK_DEVICE_ID, assuranceTier: 0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceId).toBe(MOCK_DEVICE_ID);

    // "Ran to completion" = the job actuated the device and produced a real
    // evidence bundle. Unscoped, this route returned 500 from submitJob's
    // pre-flight denial and there was no bundle at all.
    expect(typeof body.evidenceBundleId).toBe("string");
    expect(body.evidenceBundleId).toMatch(/^bun_/);
    expect(body.status).not.toBe("failed");
    expect(body.status).not.toBe("unknown");

    // The job row's own terminal state. KernelService writes "completed" when
    // runner.run() resolves; the settlement pipeline then advances it to
    // "evidence_stored". The route's poll loop breaks on neither of those two,
    // so it returns whatever the row reads at its 10 s deadline — which is why
    // this asserts the row, not the poll-deadline snapshot.
    const { db: jobDb } = getStore();
    const jobRow = jobDb.select().from(schema.jobs).where(eq(schema.jobs.id, body.jobId)).get();
    expect(["completed", "evidence_stored", "evidence_submitted", "settled"]).toContain(
      jobRow?.status,
    );

    const rows = scopesForJob(body.jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kernelId).toBe(KERNEL_ID);
    expect(rows[0].createdBy).toBe(PRINCIPAL);
    expect(rows[0].status).toBe("active");

    // One-shot self-test budget: tighter than the paid path's 200/5/1h,
    // because device-relay resolves active scopes by (kernelId, createdBy)
    // without filtering on jobId.
    expect(rows[0].maxCommands).toBe(50);
    expect(rows[0].maxRetries).toBe(1);
    const ttlMs = new Date(rows[0].expiresAt).getTime() - new Date(rows[0].createdAt).getTime();
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000);

    const relayed = relaySpy.mock.calls.map((c) => c[0]);
    expect(relayed.map((c) => c.type)).toEqual(["load_gcode", "start"]);
    for (const cmd of relayed) {
      expect(cmd.class).toBe("scoped");
      expect(cmd.scopeId).toBe(rows[0].id);
      expect(cmd.agentDid).toBe(`did:pcc:${PRINCIPAL}`);
    }
  }, 20_000);

  it("a caller-supplied scopeId in the body is ignored here too", async () => {
    app = await buildApp({ authenticated: true });

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/test-job",
      payload: {
        kernelId: KERNEL_ID,
        deviceId: DEVICE_ID,
        scopeId: "scope_attacker_supplied_002",
        agentDid: "did:pcc:attacker",
      },
    });

    expect(res.statusCode).toBe(200);
    const rows = scopesForJob(res.json().jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe("scope_attacker_supplied_002");
    expect(rows[0].createdBy).toBe(PRINCIPAL);
  });
});

/**
 * N79 through the gateway's own kernel: a job that FAILS ON THE DEVICE gives its escrow back.
 *
 * The route tests (n79-terminal-job-escrow-refund.test.ts) mock the kernel service out. This one runs a real
 * KernelService job on a device that fails, and checks the job's funded mock escrow ends up refunded. The kernel
 * service writes `failed` in four places: {the Sentry lifecycle span, the plain fallback when Sentry throws} x
 * {the device reports failure, the run itself rejects}. Each is driven here.
 *
 * External services (Sentry, SSE, storage, chain) are mocked as in kernel-service-safety.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";

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
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_ks" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_n79_ks_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn(),
  releaseMilestone: vi.fn(),
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

import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { Sentry } from "../sentry.js";
import { KernelService } from "../services/kernel-service.js";
import { schema } from "@pcc/store";
import { initSafetyGateway, resetSafetyGateway, registerMachineAdapter, unregisterMachineAdapter } from "@pcc/kernel";
import type { MachineAdapter, KernelConfig } from "@pcc/kernel";

/** Fails the first machine command, so JobRunner.run() returns {success:false}. */
class FailingAdapter implements MachineAdapter {
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
  async execute(): ReturnType<MachineAdapter["execute"]> {
    return { success: false, message: "simulated device failure" };
  }
  async getProgress(): Promise<number> {
    return 0;
  }
  onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {}
  async dispose(): Promise<void> {}
}

/** Crashes while the run wires up evidence, before the runner's own try, so JobRunner.run() REJECTS. */
class RejectingAdapter extends FailingAdapter {
  override onEvidence(_cb: Parameters<MachineAdapter["onEvidence"]>[0]): void {
    throw new Error("adapter crashed while wiring evidence");
  }
}

const FAIL_TYPE = "test-fail-n79-ks";
const REJECT_TYPE = "test-reject-n79-ks";

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!pred()) throw new Error("waitFor: condition not met within timeout");
}

/** A queued job on a seeded kernel, with a negotiated session and a funded mock escrow, as the paid flow leaves it. */
function seedPaidJob(jobId: string) {
  const repos = getRepos();
  const capability = repos.capabilities.findAll()[0];
  if (!capability) throw new Error("the seeded store has no capability");
  const kernelId = capability.kernelId;
  const cwmId = `cwm-${jobId}`;
  const now = new Date().toISOString();
  repos.jobs.insert({
    id: jobId,
    stepId: "step-1",
    cwmId,
    capabilityId: capability.id,
    kernelId,
    status: "queued",
    assignedDevices: ["dev-n79-fail"],
  });
  getStore()
    .db.insert(schema.negotiationSessions)
    .values({
      id: `sess-${jobId}`,
      status: "committed",
      userAgentId: "user-n79-ks",
      kernelId,
      capabilityType: capability.type,
      operatorConstraints: {},
      jobId,
      cwmId,
      createdAt: now,
      expiresAt: now,
    })
    .run();
  const escrow = repos.escrows.insert({
    id: `esc-${jobId}`,
    cwmId,
    contractAddress: `mock-escrow-${jobId}`,
    payer: "0x0000000000000000000000000000000000000001",
    totalAmount: "10.00",
    currency: "USDC",
    status: "funded",
    createdAt: now,
    deadline: now,
  });
  repos.escrows.insertMilestone({
    id: `ms-${jobId}`,
    escrowId: escrow!.id,
    stepId: "step-1",
    amount: "10.00",
    status: "funded",
    bondAmount: "0",
  });
  return { escrowId: escrow!.id };
}

beforeAll(() => {
  try { unregisterMachineAdapter(FAIL_TYPE); } catch { /* not registered */ }
  try { unregisterMachineAdapter(REJECT_TYPE); } catch { /* not registered */ }
  registerMachineAdapter(FAIL_TYPE, (device, _cfg, kernelId) => new FailingAdapter(device.id, kernelId));
  registerMachineAdapter(REJECT_TYPE, (device, _cfg, kernelId) => new RejectingAdapter(device.id, kernelId));
});

afterAll(() => {
  try { unregisterMachineAdapter(FAIL_TYPE); } catch { /* already gone */ }
  try { unregisterMachineAdapter(REJECT_TYPE); } catch { /* already gone */ }
});

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  resetSafetyGateway();
  initSafetyGateway({ circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 } });
});

afterEach(() => {
  resetSafetyGateway();
  closeStore();
  vi.clearAllMocks();
});

describe("N79: a job that fails on the gateway's own kernel gives its escrow back", () => {
  it.each([
    { path: "Sentry span", sentry: true, adapterType: FAIL_TYPE, how: "the device reports failure" },
    { path: "Sentry span", sentry: true, adapterType: REJECT_TYPE, how: "the run rejects" },
    { path: "plain fallback", sentry: false, adapterType: FAIL_TYPE, how: "the device reports failure" },
    { path: "plain fallback", sentry: false, adapterType: REJECT_TYPE, how: "the run rejects" },
  ])("$path, $how: the job reads failed and its funded mock escrow and milestone read refunded", async ({ sentry, adapterType }) => {
    const jobId = `job-n79-ks-${sentry ? "sentry" : "fallback"}-${adapterType}`;
    const { escrowId } = seedPaidJob(jobId);
    const repos = getRepos();
    if (!sentry) {
      vi.mocked(Sentry.startSpanManual).mockImplementationOnce(() => {
        throw new Error("Sentry not initialised");
      });
    }

    const config: KernelConfig = {
      kernelId: "kernel-n79-ks",
      mockMode: false,
      devices: [{ id: "dev-n79-fail", type: "machine", adapterType, config: {} }],
    };
    const svc = new KernelService(config);
    await svc.submitJob({ jobId, stepId: "step-1", assuranceTier: 0, deviceId: "dev-n79-fail" });

    await waitFor(() => repos.jobs.findById(jobId)?.status === "failed");
    expect(repos.escrows.findById(escrowId)?.status).toBe("refunded");
    expect(repos.escrows.findMilestonesByEscrow(escrowId).map((m) => m.status)).toEqual(["refunded"]);
  });
});

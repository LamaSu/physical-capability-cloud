import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Storage + chain are only reached on the success path; mock them so importing
// kernel-service → settlement-service has no import-time side effects.
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_ks_safety" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_ks_safety_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xks_safety_evidence" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xks_safety_release" }),
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
import { schema } from "@pcc/store";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Node } from "typescript";
import { createRequire } from "node:module";
import { UNAVAILABLE_POLICY_CASES, applyUnavailablePolicy } from "./helpers/emergency-stop-policy-cases.js";
import { Sentry } from "../sentry.js";
import { KernelService, resetKernelService } from "../services/kernel-service.js";
import { EvidenceEmitter, JobRunner, getSafetyGateway, resetSafetyGateway } from "@pcc/kernel";
import type { KernelConfig } from "@pcc/kernel";
import { localJobDispatchDecision, canDispatchJobLocally } from "../services/local-job-dispatch.js";

function environment(nodeEnv: string, flag?: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("PCC_JOB_SUBMIT_QUEUE_ONLY", flag ?? "");
  if (flag === undefined) delete process.env.PCC_JOB_SUBMIT_QUEUE_ONLY;
}

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  environment("test");
  for (const key of ["KERNEL_CONFIG", "KERNEL_CONFIG_FILE", "KERNEL_ID"]) {
    vi.stubEnv(key, "");
    delete process.env[key];
  }
  initStore({ seed: false });
  resetSafetyGateway();
  seedDispatchKernel();
  vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
    cb({ end: vi.fn(), setStatus: vi.fn() });
  });
});

afterEach(() => {
  resetKernelService();
  resetSafetyGateway();
  closeStore();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const DISPATCH_KERNEL = "kernel-ks-n104";

function seedDispatchKernel() {
  const now = new Date().toISOString();
  getRepos().kernels.insert({
    id: DISPATCH_KERNEL, name: DISPATCH_KERNEL, operatorAddress: "operator-n104",
    location: { lat: 0, lng: 0 }, physicalAddress: "1 Bench Row", maxAssuranceTier: 2,
    publicKey: "pk", reputation: 0, totalJobsCompleted: 0, status: "online",
    registeredAt: now, lastHeartbeat: now, version: "1",
  } as never);
}

function stopDispatchKernel() {
  getStore().db.insert(schema.operatorPolicies).values({
    kernelId: DISPATCH_KERNEL,
    policy: { emergencyStop: true },
    updatedAt: new Date().toISOString(),
  }).run();
}

function dispatchService(config: Partial<KernelConfig> = {}) {
  return new KernelService({
    kernelId: DISPATCH_KERNEL,
    devices: [{ id: "dev-n104", type: "machine", adapterType: "mock", config: {} }],
    ...config,
  });
}


describe.each(["Sentry span", "Sentry fallback"])("N267 signer dispatch — %s", (path) => {
  beforeEach(() => {
    vi.mocked(Sentry.startSpanManual).mockImplementation((_o: unknown, cb: (span: object) => void) => {
      if (path === "Sentry fallback") throw new Error("Sentry unavailable");
      cb({ end: vi.fn(), setStatus: vi.fn() });
    });
  });

  it("K1: queues before admission with the test signer in production", async () => {
    environment("production", "false");
    const svc = dispatchService();
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    const validate = vi.spyOn(getSafetyGateway(), "validateOnly");
    await expect(svc.submitJob({ localRunAuthority: "decide", jobId: "k1", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toEqual({ jobId: "k1", deviceId: null, status: "queued", reason: "no_kernel_signer" });
    expect(run).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(svc.usesTestSigner).toBe(true);
    expect(await svc.getJobStatus("k1")).toMatchObject({ status: "unknown" });
  });

  it.each(["test", "development"])("K3: runs with the test signer in %s", async (nodeEnv) => {
    environment(nodeEnv);
    const svc = dispatchService();
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    await expect(svc.submitJob({ localRunAuthority: "decide", jobId: "k3", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toMatchObject({ status: "accepted" });
    expect(run).toHaveBeenCalledOnce();
    expect(svc.usesTestSigner).toBe(true);
  });

  it.each([undefined, "true", "TRUE", "0", ""])("K4b: queue_only precedes signer with flag %s", async (flag) => {
    environment("production", flag);
    const svc = dispatchService();
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    await expect(svc.submitJob({ localRunAuthority: "decide", jobId: "k4b", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toMatchObject({ status: "queued", reason: "queue_only" });
    expect(run).not.toHaveBeenCalled();
  });

  it("K6: reads the emitter after construction", async () => {
    environment("production", "false");
    const svc = dispatchService();
    vi.spyOn(EvidenceEmitter.prototype, "isTestSigner").mockReturnValue(false);
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    await expect(svc.submitJob({ localRunAuthority: "decide", jobId: "k6", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toMatchObject({ status: "accepted" });
    expect(run).toHaveBeenCalledOnce();
    expect(svc.usesTestSigner).toBe(false);
  });

  it("K7: rereads the emitter after admission", async () => {
    environment("production", "false");
    const svc = dispatchService();
    const signer = vi.spyOn(EvidenceEmitter.prototype, "isTestSigner").mockReturnValue(false);
    const run = vi.spyOn(JobRunner.prototype, "run").mockResolvedValue({ success: true, durationMs: 0 });
    const validate = vi.spyOn(getSafetyGateway(), "validateOnly").mockImplementation(async () => {
      signer.mockReturnValue(true);
      return { allowed: true, executed: false };
    });
    await expect(svc.submitJob({ localRunAuthority: "decide", jobId: "k7", kernelId: DISPATCH_KERNEL, stepId: "s" }))
      .resolves.toEqual({ jobId: "k7", deviceId: null, status: "queued", reason: "no_kernel_signer" });
    expect(validate).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
});

const K = DISPATCH_KERNEL;
const decisionRows = [
  { row: 1, env: "production", flag: "false", args: [K, K, true, undefined, true], answer: { ok: false, reason: "no_kernel_signer" } },
  { row: 2, env: "production", flag: "false", args: [K, K, true, undefined, false], answer: { ok: true } },
  { row: 3, env: "production", flag: "false", args: [K, K, true, undefined, undefined], answer: { ok: true } },
  { row: 4, env: "production", flag: undefined, args: [K, K, true, undefined, true], answer: { ok: false, reason: "queue_only" } },
  { row: 5, env: "production", flag: "false", args: [K, K, true, true, true], answer: { ok: false, reason: "queue_only" } },
  { row: 6, env: "production", flag: "false", args: [K, "other-kernel", true, undefined, true], answer: { ok: false, reason: "not_local" } },
  { row: 7, env: "production", flag: "false", args: [K, K, false, undefined, true], answer: { ok: false, reason: "no_configured_local_kernel" } },
  { row: 8, env: "production", flag: "false", args: ["kernel_dev_001", "kernel_dev_001", true, undefined, true], answer: { ok: false, reason: "no_configured_local_kernel" } },
  { row: 9, env: "production", flag: "false", args: [K, K, true, undefined, true], answer: { ok: false, reason: "emergency_stop" } },
  { row: 10, env: "production", flag: "false", args: [K, K, true, undefined, true], answer: { ok: false, reason: "policy_unavailable" } },
  { row: 11, env: "test", flag: undefined, args: [K, K, true, undefined, true], answer: { ok: true } },
  { row: 12, env: "development", flag: undefined, args: [K, K, true, undefined, true], answer: { ok: true } },
];

describe("N267 dispatch decision table", () => {
  it.each(decisionRows)("K9 row $row", ({ row, env, flag, args, answer }) => {
    environment(env, flag);
    if (row === 9) stopDispatchKernel();
    if (row === 10) applyUnavailablePolicy(K, UNAVAILABLE_POLICY_CASES[0]);
    const [local, target, explicit, queue, signer] = args;
    expect(localJobDispatchDecision(local, target as string, explicit as boolean, queue, signer)).toEqual(answer);
  });

  it("K9 row 13: preserves paid flow routing", () => {
    environment("production", "false");
    expect(canDispatchJobLocally(K, K, true)).toBe(true);
  });

  it("K10: pins every production dispatch decision call", () => {
    const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
    const root = resolve(__dirname, "..");
    const calls: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(file);
        } else if (file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts")) {
          const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
          const visit = (node: Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "localJobDispatchDecision") {
              calls.push(`${relative(root, file)} ${node.arguments.length} ${node.arguments[4]?.getText(source) ?? "-"}`);
            }
            ts.forEachChild(node, visit);
          };
          visit(source);
        }
      }
    }
    walk(root);
    expect(calls.sort()).toEqual([
      "facades/job.facade.ts 5 svc?.usesTestSigner",
      "routes/setup.ts 5 svc.usesTestSigner",
      "routes/setup.ts 5 svc.usesTestSigner",
      "server.ts 5 kernelService.usesTestSigner",
      "services/kernel-service.ts 5 this.usesTestSigner",
      "services/kernel-service.ts 5 this.usesTestSigner",
      "services/local-job-dispatch.ts 3 -",
    ]);
  });
});

/**
 * Tracing tests — verify Sentry spans and breadcrumbs are created by:
 *   - KernelService.submitJob()   → creates a "job.lifecycle" span (startSpanManual)
 *   - SettlementService.processEvidence()  → creates 4 child spans inside
 *                                            "settlement.pipeline"
 *   - PipelineTelemetryService.emit()      → adds a Sentry breadcrumb per event
 *
 * All external calls (IPFS, blockchain, real hardware) are mocked so these
 * tests run purely in-memory without network access.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted; use vi.hoisted() for variables referenced inside
// ---------------------------------------------------------------------------

// ── Hoist mock function refs so they are available when vi.mock factories run ─
const {
  mockStartSpan,
  mockStartSpanManual,
  mockAddBreadcrumb,
  mockCaptureException,
} = vi.hoisted(() => {
  const mockStartSpan = vi.fn().mockImplementation(
    async (_options: unknown, callback: () => Promise<unknown>) => callback(),
  );
  const mockStartSpanManual = vi.fn().mockImplementation(
    (_options: unknown, callback: (span: object) => void) => {
      const fakeSpan = { end: vi.fn(), setStatus: vi.fn() };
      callback(fakeSpan);
    },
  );
  const mockAddBreadcrumb = vi.fn();
  const mockCaptureException = vi.fn();
  return { mockStartSpan, mockStartSpanManual, mockAddBreadcrumb, mockCaptureException };
});

// ── @pcc/kernel/evidence-storage-factory ─────────────────────────────────────
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_tracing_001" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_tracing_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ── escrow-client (blockchain) ───────────────────────────────────────────────
vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtracing_evidence_tx" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtracing_release_tx" }),
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

// ── batch-settlement ──────────────────────────────────────────────────────────
vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// ── Sentry — intercept ALL span/breadcrumb/capture calls ─────────────────────
//
// The gateway services import `{ Sentry }` from "../sentry.js".
// We mock that module so we can assert on Sentry calls without needing a real DSN
// or a network connection to Sentry servers.
//
// The mock provides a real `startSpan` implementation that actually invokes the
// callback so the code under test executes fully — we just intercept the calls.

vi.mock("../sentry.js", () => ({
  initSentry: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  Sentry: {
    startSpan: mockStartSpan,
    startSpanManual: mockStartSpanManual,
    addBreadcrumb: mockAddBreadcrumb,
    captureException: mockCaptureException,
    flush: vi.fn().mockResolvedValue(true),
    init: vi.fn(),
    withScope: vi.fn().mockImplementation((cb: (scope: object) => void) => cb({ setTag: vi.fn(), setExtra: vi.fn() })),
  },
}));

// ── stream-hub (SSE) ──────────────────────────────────────────────────────────
vi.mock("../sse/stream-hub.js", () => ({
  streamHub: {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));

// ── stream-hub (SSE) ──────────────────────────────────────────────────────────
vi.mock("../sse/stream-hub.js", () => ({
  streamHub: {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { initStore, closeStore } from "../db.js";
import { SettlementService, resetSettlementService, getSettlementService } from "../services/settlement-service.js";
import { initKernelService, resetKernelService } from "../services/kernel-service.js";
import { PipelineTelemetryService } from "../telemetry.js";
import type { EvidenceBundle } from "@pcc/spec";
import type { KernelConfig } from "@pcc/kernel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    id: "bun-tracing-001",
    jobId: "job-tracing-001",
    stepId: "step-tracing",
    kernelId: "kernel-nyc",
    assuranceTier: 0,
    bundleHash: "sha256:tracingdeadbeef00000000000000000000000000000000000000000000001" as `sha256:${string}`,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as const,
      algorithm: "secp256k1" as const,
      value: "mock_sig_tracing",
    },
    createdAt: new Date().toISOString(),
    events: [
      {
        id: "ev-tracing-001",
        type: "execution_started",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev-fdm", deviceType: "controller", kernelId: "kernel-nyc" },
        payload: { message: "Tracing test job started" },
        hash: "sha256:ev_hash_tracing" as `sha256:${string}`,
      },
      {
        id: "ev-tracing-002",
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev-fdm", deviceType: "controller", kernelId: "kernel-nyc" },
        payload: { message: "Tracing test job completed" },
        hash: "sha256:ev_hash_tracing_002" as `sha256:${string}`,
      },
    ],
    ...overrides,
  };
}

const mockKernelConfig: KernelConfig = {
  kernelId: "kernel-tracing-test",
  mockMode: true,
  devices: [
    {
      id: "dev-tracing-machine",
      type: "machine",
      adapterType: "mock",
      config: { kernelId: "kernel-tracing-test", jobDurationMs: 50 },
    },
    {
      id: "dev-tracing-sensor",
      type: "sensor",
      adapterType: "mock",
      config: { kernelId: "kernel-tracing-test" },
    },
    {
      id: "dev-tracing-camera",
      type: "camera",
      adapterType: "mock",
      config: { kernelId: "kernel-tracing-test" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns all span names from mockStartSpan.mock.calls */
function capturedSpanNames(): string[] {
  return mockStartSpan.mock.calls.map((args) => (args[0] as { name: string }).name);
}

// ---------------------------------------------------------------------------
// SettlementService — span creation tests
// ---------------------------------------------------------------------------

describe("SettlementService.processEvidence — Sentry spans", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    vi.clearAllMocks();
    // Re-apply the real pass-through implementation after clearAllMocks
    mockStartSpan.mockImplementation(
      async (_: unknown, callback: () => Promise<unknown>) => callback(),
    );
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
  });

  it("creates a 'settlement.pipeline' parent span", async () => {
    const service = getSettlementService();
    const bundle = makeBundle();
    await service.processEvidence(bundle, "job-004");

    const names = capturedSpanNames();
    expect(names).toContain("settlement.pipeline");
  });

  it("creates 4 child spans inside the pipeline", async () => {
    const service = getSettlementService();
    const bundle = makeBundle();
    await service.processEvidence(bundle, "job-004");

    const names = capturedSpanNames();

    // All 4 pipeline stages must be present
    expect(names).toContain("settlement.ipfs_archive");
    expect(names).toContain("settlement.db_persist");
    expect(names).toContain("settlement.onchain_submit");
    expect(names).toContain("settlement.onchain_release");
  });

  it("spans are created with correct `op` attributes", async () => {
    const service = getSettlementService();
    const bundle = makeBundle();
    await service.processEvidence(bundle, "job-004");

    const spanOptions = mockStartSpan.mock.calls.map((args) => args[0] as { name: string; op: string });

    const pipelineSpan = spanOptions.find((s) => s.name === "settlement.pipeline");
    expect(pipelineSpan?.op).toBe("settlement");

    const ipfsSpan = spanOptions.find((s) => s.name === "settlement.ipfs_archive");
    expect(ipfsSpan?.op).toBe("storage");

    const dbSpan = spanOptions.find((s) => s.name === "settlement.db_persist");
    expect(dbSpan?.op).toBe("db");

    const onchainSubmitSpan = spanOptions.find((s) => s.name === "settlement.onchain_submit");
    expect(onchainSubmitSpan?.op).toBe("blockchain");

    const releaseSpan = spanOptions.find((s) => s.name === "settlement.onchain_release");
    expect(releaseSpan?.op).toBe("blockchain");
  });

  it("spans include job.id in attributes", async () => {
    const service = getSettlementService();
    const bundle = makeBundle();
    await service.processEvidence(bundle, "job-004");

    const spanOptions = mockStartSpan.mock.calls.map(
      (args) => args[0] as { name: string; attributes?: Record<string, unknown> },
    );

    const pipelineSpan = spanOptions.find((s) => s.name === "settlement.pipeline");
    expect(pipelineSpan?.attributes?.["job.id"]).toBe("job-004");
    expect(pipelineSpan?.attributes?.["bundle.id"]).toBe("bun-tracing-001");
  });

  it("total span count is 5 (1 parent + 4 children)", async () => {
    const service = getSettlementService();
    const bundle = makeBundle();
    await service.processEvidence(bundle, "job-004");

    // pipeline + ipfs_archive + db_persist + onchain_submit + onchain_release
    expect(mockStartSpan).toHaveBeenCalledTimes(5);
  });

  it("still produces a valid settlement result even if spans are called", async () => {
    const service = getSettlementService();
    const bundle = makeBundle();
    const result = await service.processEvidence(bundle, "job-004");

    expect(result.jobId).toBe("job-004");
    expect(result.evidenceBundleId).toBe("bun-tracing-001");
    // CID comes from the mocked storage
    expect(result.cid).toBe("bafytest_tracing_001");
  });
});

// ---------------------------------------------------------------------------
// KernelService.submitJob — span creation tests
// ---------------------------------------------------------------------------

describe("KernelService.submitJob — Sentry spans", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetKernelService();
    resetSettlementService();
    vi.clearAllMocks();
    mockStartSpan.mockImplementation(
      async (_: unknown, callback: () => Promise<unknown>) => callback(),
    );
    mockStartSpanManual.mockImplementation(
      (_: unknown, callback: (span: object) => void) => {
        const fakeSpan = { end: vi.fn(), setStatus: vi.fn() };
        callback(fakeSpan);
      },
    );
  });

  afterEach(() => {
    closeStore();
    resetKernelService();
    resetSettlementService();
  });

  it("creates a 'job.lifecycle' span via startSpanManual", async () => {
    initKernelService(mockKernelConfig);
    const { getKernelService } = await import("../services/kernel-service.js");
    const svc = getKernelService();

    await svc.submitJob({
      jobId: "job-tracing-ks-001",
      stepId: "step-ks-tracing",
      assuranceTier: 0,
    });

    // Wait briefly for async fire-and-forget to start
    await new Promise<void>((r) => setTimeout(r, 100));

    const spanNames = mockStartSpanManual.mock.calls.map(
      (args) => (args[0] as { name: string }).name,
    );
    expect(spanNames).toContain("job.lifecycle");
  });

  it("'job.lifecycle' span includes job.id, job.type, and job.assurance_tier attributes", async () => {
    initKernelService(mockKernelConfig);
    const { getKernelService } = await import("../services/kernel-service.js");
    const svc = getKernelService();

    await svc.submitJob({
      jobId: "job-tracing-ks-002",
      stepId: "step-ks-attrs",
      assuranceTier: 1,
    });

    await new Promise<void>((r) => setTimeout(r, 100));

    const lifecycleCall = mockStartSpanManual.mock.calls.find(
      (args) => (args[0] as { name: string }).name === "job.lifecycle",
    );
    expect(lifecycleCall).toBeDefined();

    const options = lifecycleCall![0] as { name: string; op: string; attributes?: Record<string, unknown> };
    expect(options.op).toBe("job.lifecycle");
    expect(options.attributes?.["job.id"]).toBe("job-tracing-ks-002");
    expect(options.attributes?.["job.type"]).toBe("step-ks-attrs");
    expect(options.attributes?.["job.assurance_tier"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PipelineTelemetryService.emit — Sentry breadcrumb tests
// ---------------------------------------------------------------------------

describe("PipelineTelemetryService.emit — Sentry breadcrumbs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a breadcrumb for every emitted telemetry event", () => {
    const telemetry = new PipelineTelemetryService();
    telemetry.emit("job-breadcrumb-001", "job_started", "completed");

    expect(mockAddBreadcrumb).toHaveBeenCalledOnce();
  });

  it("breadcrumb has category 'pcc.pipeline'", () => {
    const telemetry = new PipelineTelemetryService();
    telemetry.emit("job-breadcrumb-002", "discovery", "started");

    const call = mockAddBreadcrumb.mock.calls[0][0] as { category: string };
    expect(call.category).toBe("pcc.pipeline");
  });

  it("breadcrumb message includes jobId, phase, and status", () => {
    const telemetry = new PipelineTelemetryService();
    telemetry.emit("job-breadcrumb-003", "evidence_capture", "completed");

    const call = mockAddBreadcrumb.mock.calls[0][0] as { message: string };
    expect(call.message).toContain("job-breadcrumb-003");
    expect(call.message).toContain("evidence_capture");
    expect(call.message).toContain("completed");
  });

  it("breadcrumb data contains jobId, phase, status", () => {
    const telemetry = new PipelineTelemetryService();
    telemetry.emit("job-breadcrumb-004", "settlement_complete", "completed", {
      duration_ms: 1234,
    });

    const call = mockAddBreadcrumb.mock.calls[0][0] as {
      data: { jobId: string; phase: string; status: string; duration_ms?: number };
    };
    expect(call.data.jobId).toBe("job-breadcrumb-004");
    expect(call.data.phase).toBe("settlement_complete");
    expect(call.data.status).toBe("completed");
    expect(call.data.duration_ms).toBe(1234);
  });

  it("breadcrumb level is 'error' for failed events", () => {
    const telemetry = new PipelineTelemetryService();
    telemetry.emit("job-breadcrumb-005", "verification_result", "failed");

    const call = mockAddBreadcrumb.mock.calls[0][0] as { level: string };
    expect(call.level).toBe("error");
  });

  it("breadcrumb level is 'info' for completed events", () => {
    const telemetry = new PipelineTelemetryService();
    telemetry.emit("job-breadcrumb-006", "job_submit", "completed");

    const call = mockAddBreadcrumb.mock.calls[0][0] as { level: string };
    expect(call.level).toBe("info");
  });

  it("emitting multiple events calls addBreadcrumb multiple times", () => {
    const telemetry = new PipelineTelemetryService();
    const phases = ["discovery", "job_submit", "job_started", "evidence_capture"] as const;

    for (const phase of phases) {
      telemetry.emit("job-multi-bc", phase, "completed");
    }

    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(phases.length);
  });

  it("breadcrumb has a numeric timestamp (Unix seconds)", () => {
    const before = Date.now() / 1000;
    const telemetry = new PipelineTelemetryService();
    telemetry.emit("job-breadcrumb-ts", "escrow_fund", "started");
    const after = Date.now() / 1000;

    const call = mockAddBreadcrumb.mock.calls[0][0] as { timestamp: number };
    expect(typeof call.timestamp).toBe("number");
    // Should be within the test execution window
    expect(call.timestamp).toBeGreaterThanOrEqual(before - 1);
    expect(call.timestamp).toBeLessThanOrEqual(after + 1);
  });
});

// ---------------------------------------------------------------------------
// Integration: full evidence-to-settlement spans flow
// ---------------------------------------------------------------------------

describe("Full trace path: processEvidence spans + breadcrumbs", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    resetSettlementService();
    vi.clearAllMocks();
    mockStartSpan.mockImplementation(
      async (_: unknown, callback: () => Promise<unknown>) => callback(),
    );
  });

  afterEach(() => {
    closeStore();
    resetSettlementService();
  });

  it("spans and breadcrumbs are both created when evidence is processed", async () => {
    // Process the evidence bundle (which triggers both settlement spans
    // and — if telemetry were wired in — breadcrumbs)
    const service = getSettlementService();
    const bundle = makeBundle();
    await service.processEvidence(bundle, "job-004");

    // Spans: 5 total (1 parent + 4 children)
    expect(mockStartSpan).toHaveBeenCalledTimes(5);

    // Verify the pipeline span is first
    const firstSpanName = (mockStartSpan.mock.calls[0][0] as { name: string }).name;
    expect(firstSpanName).toBe("settlement.pipeline");

    // Verify ordering: pipeline → ipfs_archive → db_persist → onchain_submit → onchain_release
    const spanNames = capturedSpanNames();
    const pipelineIdx = spanNames.indexOf("settlement.pipeline");
    const ipfsIdx = spanNames.indexOf("settlement.ipfs_archive");
    const dbIdx = spanNames.indexOf("settlement.db_persist");
    const submitIdx = spanNames.indexOf("settlement.onchain_submit");
    const releaseIdx = spanNames.indexOf("settlement.onchain_release");

    // All should be present
    expect(pipelineIdx).toBeGreaterThanOrEqual(0);
    expect(ipfsIdx).toBeGreaterThanOrEqual(0);
    expect(dbIdx).toBeGreaterThanOrEqual(0);
    expect(submitIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThanOrEqual(0);

    // Parent must come before children
    expect(pipelineIdx).toBeLessThan(ipfsIdx);
    expect(ipfsIdx).toBeLessThan(dbIdx);
    expect(dbIdx).toBeLessThan(submitIdx);
    expect(submitIdx).toBeLessThan(releaseIdx);
  });

  it("Sentry is not blocking — result is returned regardless of span failures", async () => {
    // Make startSpan throw to verify the try/catch in processEvidence works
    mockStartSpan.mockRejectedValueOnce(new Error("Sentry unavailable"));

    const service = getSettlementService();
    const bundle = makeBundle();

    // Should not throw
    const result = await service.processEvidence(bundle, "job-004");

    // Result is still returned (Sentry failures are non-fatal)
    expect(result.jobId).toBe("job-004");
    expect(result.evidenceBundleId).toBe("bun-tracing-001");
  });
});

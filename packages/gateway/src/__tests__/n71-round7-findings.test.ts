/**
 * N71 round 7 (astra pack 83f, DO-NOT-SHIP at 7d8ba154): the five findings.
 *
 * Each `describe` below reproduces exactly ONE finding from the round-7 verdict
 * (83f-n71-451-scanner-r6-7d8ba154.astra.verdict.md) as a FAILING runtime test,
 * written against the source as it stands at 7d8ba154 (before this round's
 * fixes). This file is added in a tests-only commit; the fixes land afterward
 * in a separate commit, which turns every one of these tests green.
 *
 * Mocks mirror the established patterns elsewhere in this suite:
 *   - telemetry.js: capability-facade.test.ts / kernel-ttl-integration.test.ts
 *   - sentry.js / sse-stream-hub / evidence-storage-factory / escrow-client /
 *     batch-settlement: kernel-service-safety.test.ts
 *   - tracing.js: mocked outright (its real implementation is pure in-memory
 *     and side-effect-free, but mocking it gives a direct assertion surface
 *     on startTrace's own call arguments without reaching into trace-collector
 *     internals).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SENTINEL = "N71-SENTINEL";

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

const { mockStartSpanManual } = vi.hoisted(() => ({
  mockStartSpanManual: vi.fn().mockImplementation((_o: unknown, cb: (span: object) => void) => {
    cb({ end: vi.fn(), setStatus: vi.fn() });
  }),
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

vi.mock("../tracing.js", () => ({
  startTrace: vi.fn().mockReturnValue({ traceId: "r7-test-trace-id", spanId: "r7-test-span-id" }),
  endTrace: vi.fn(),
}));

vi.mock("../sentry.js", () => ({
  initSentry: vi.fn(),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  Sentry: {
    startSpan: vi.fn().mockImplementation(async (_o: unknown, cb: () => Promise<unknown>) => cb()),
    startSpanManual: mockStartSpanManual,
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
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest_r7" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafytest_r7_enc" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xr7_evidence" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xr7_release" }),
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
  flushSettlements: vi.fn().mockResolvedValue({
    epochId: "e", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0,
  }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { initStore, closeStore, getRepos } from "../db.js";
import { JobFacade } from "../facades/job.facade.js";
import { KernelFacade, emitKernelLifecycleEvent } from "../facades/kernel.facade.js";
import { SettlementFacade } from "../facades/settlement.facade.js";
import { KernelService } from "../services/kernel-service.js";
import { runOneSweep } from "../services/kernel-ttl-sweeper.js";
import { pipelineTelemetry } from "../telemetry.js";
import { startTrace } from "../tracing.js";

function emitCallsText(): string {
  const mock = pipelineTelemetry.emit as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls.map((c) => JSON.stringify(c)).join("\n");
}

// ── Shared setup — applies to every test in this file ─────────────────────────

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  vi.clearAllMocks();
});

afterEach(() => {
  closeStore();
});

// ── Finding 1 (CRITICAL): base.facade.ts telemetry carries `message` ─────────

describe("N71 round 7 finding 1 (CRITICAL): NotFoundError's interpolated id must never reach facade telemetry", () => {
  it("[neg] JobFacade.getById on a missing job never puts the sentinel in pipelineTelemetry.emit", async () => {
    const facade = new JobFacade();
    const result = await facade.getById(`pcc_live_${SENTINEL}`);
    expect(result.success).toBe(false);

    const emitMock = pipelineTelemetry.emit as unknown as ReturnType<typeof vi.fn>;
    expect(emitMock).toHaveBeenCalled();
    expect(emitCallsText()).not.toContain(SENTINEL);
  });
});

// ── Finding 2 (CRITICAL): kernel-service.ts startTrace/Sentry.startSpanManual ─

describe("N71 round 7 finding 2 (CRITICAL): startTrace and Sentry.startSpanManual must never receive raw jobId/stepId", () => {
  it("[neg] a submitted job's sentinel jobId/stepId never appear in startTrace's or Sentry.startSpanManual's attributes", async () => {
    const svc = new KernelService({
      kernelId: "kernel-r7-f2",
      mockMode: false,
      devices: [{ id: "dev-r7-f2", type: "machine", adapterType: "mock", config: {} }],
    });

    await svc.submitJob({
      jobId: `pcc_live_${SENTINEL}`,
      kernelId: svc.kernelId,
      stepId: `step_${SENTINEL}`,
      assuranceTier: 0,
      deviceId: "dev-r7-f2",
    });

    const startTraceMock = startTrace as unknown as ReturnType<typeof vi.fn>;
    expect(startTraceMock).toHaveBeenCalled();
    expect(JSON.stringify(startTraceMock.mock.calls[0])).not.toContain(SENTINEL);

    expect(mockStartSpanManual).toHaveBeenCalled();
    const spanOptions = mockStartSpanManual.mock.calls[0]?.[0];
    expect(JSON.stringify(spanOptions)).not.toContain(SENTINEL);
  });
});

// ── Finding 3 (CRITICAL): kernel-service.ts this.config.kernelId is raw config ─

describe("N71 round 7 finding 3 (CRITICAL): this.config.kernelId must never reach pipelineTelemetry raw", () => {
  it("[neg] a KernelService constructed with an adversarial kernelId never puts it in pipelineTelemetry.emit", async () => {
    const svc = new KernelService({
      kernelId: `pcc_live_${SENTINEL}`,
      mockMode: false,
      devices: [{ id: "dev-r7-f3", type: "machine", adapterType: "mock", config: {} }],
    });

    await svc.submitJob({ jobId: "job-r7-f3", kernelId: svc.kernelId, stepId: "s", assuranceTier: 0, deviceId: "dev-r7-f3" });

    const emitMock = pipelineTelemetry.emit as unknown as ReturnType<typeof vi.fn>;
    expect(emitMock).toHaveBeenCalled();
    expect(emitCallsText()).not.toContain(SENTINEL);
  });
});

// ── Finding 4 (CRITICAL): emitKernelLifecycleEvent writes its whole event raw ─

describe("N71 round 7 finding 4 (CRITICAL): emitKernelLifecycleEvent must sanitize every field itself, protecting out-of-scope callers too", () => {
  it("[neg] a direct call with kernelId/capabilityId sentinels and an unknown event name never reaches process.stderr.write unsanitized", () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      emitKernelLifecycleEvent({
        event: "not.a.real.lifecycle.event" as unknown as never,
        kernelId: `pcc_live_${SENTINEL}`,
        capabilityId: `cap_${SENTINEL}`,
      });
      expect(writeSpy).toHaveBeenCalled();
      const allText = writeSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allText).not.toContain(SENTINEL);
      expect(allText).toContain("unknown_event");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("[neg] an out-of-scope caller (kernel-ttl-sweeper.ts) that passes RAW stored ids is still protected at stderr", async () => {
    const kernelFacade = new KernelFacade();
    const sentinelKernelId = `pcc_live_${SENTINEL}_${Date.now().toString(36)}`;
    const registered = await kernelFacade.register({ id: sentinelKernelId, name: "r7 f4 sweep kernel" });
    expect(registered.success).toBe(true);

    // Time-travel: push validUntil into the past so the sweeper flips this row.
    const past = new Date(Date.now() - 60_000).toISOString();
    (getRepos().kernels as any).update(sentinelKernelId, { validUntil: past } as any);

    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = runOneSweep(getRepos());
      expect(result.kernelsExpired).toBeGreaterThanOrEqual(1);
      expect(writeSpy).toHaveBeenCalled();
      const allText = writeSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allText).not.toContain(SENTINEL);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ── Finding 5 (MEDIUM): validateMilestoneIndex uses isNaN, coercion admits "2" ─

describe("N71 round 7 finding 5 (MEDIUM): validateMilestoneIndex must reject non-integers, not just NaN", () => {
  it('[neg] "2", [], Infinity and 1.5 must all throw (coercion currently admits them); "x", {}, NaN, -1 already throw; 0 and 3 pass', () => {
    const facade = new SettlementFacade() as unknown as { validateMilestoneIndex(index: unknown): void };
    for (const bad of ["2", "x", {}, [], Infinity, 1.5, NaN, -1]) {
      expect(() => facade.validateMilestoneIndex(bad), `expected throw for ${JSON.stringify(bad)}`).toThrow();
    }
    expect(() => facade.validateMilestoneIndex(0)).not.toThrow();
    expect(() => facade.validateMilestoneIndex(3)).not.toThrow();
  });
});

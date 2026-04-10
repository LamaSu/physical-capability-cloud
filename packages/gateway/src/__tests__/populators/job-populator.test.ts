import { describe, it, expect } from "vitest";
import {
  populateJobDTO,
  populateJobDetailDTO,
  populateJobList,
  type RawJob,
} from "../../facades/populators/job.populator.js";
import type { PopulationContext } from "../../facades/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let idCounter = 0;

function makeRawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    id: `job-${++idCounter}`,
    stepId: "step-001",
    cwmId: "cwm-001",
    capabilityId: "cap-001",
    kernelId: "kernel-001",
    status: "queued",
    assignedDevices: [],
    startedAt: "2026-01-01T10:00:00.000Z",
    completedAt: null,
    progress: 0,
    evidenceBundleId: null,
    parameters: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PopulationContext> = {}): PopulationContext {
  return {
    currency: "USDC",
    includeReputation: false,
    includeCompliance: false,
    includeHealth: false,
    ...overrides,
  };
}

const mockKernelMap = new Map<string, any>([
  ["kernel-001", { id: "kernel-001", name: "Test Kernel" }],
]);

const mockCapabilityMap = new Map<string, any>([
  ["cap-001", { id: "cap-001", type: "fdm", name: "FDM Printing" }],
]);

// ── populateJobDTO ─────────────────────────────────────────────────────────

describe("populateJobDTO()", () => {
  it("maps id, capabilityId, kernelId, status, progress, assuranceTier", () => {
    const model = makeRawJob({
      id: "job-test",
      capabilityId: "cap-xyz",
      kernelId: "kernel-001",
      status: "running",
      progress: 50,
    });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.id).toBe("job-test");
    expect(dto.capabilityId).toBe("cap-xyz");
    expect(dto.kernelId).toBe("kernel-001");
    expect(dto.status).toBe("running");
    expect(dto.progress).toBe(50);
    expect(dto.assuranceTier).toBe(0);
  });

  it("createdAt uses model.startedAt", () => {
    const model = makeRawJob({ startedAt: "2026-03-15T09:00:00.000Z" });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.createdAt).toBe("2026-03-15T09:00:00.000Z");
  });

  it("createdAt defaults to current ISO string when startedAt is null", () => {
    const before = Date.now();
    const model = makeRawJob({ startedAt: null });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    const after = Date.now();
    const ts = new Date(dto.createdAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 100);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it("updatedAt uses model.completedAt", () => {
    const model = makeRawJob({ completedAt: "2026-03-15T11:00:00.000Z" });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.updatedAt).toBe("2026-03-15T11:00:00.000Z");
  });

  it("updatedAt is undefined when completedAt is null", () => {
    const model = makeRawJob({ completedAt: null });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.updatedAt).toBeUndefined();
  });

  it("kernelName from kernelMap", () => {
    const model = makeRawJob({ kernelId: "kernel-001" });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.kernelName).toBe("Test Kernel");
  });

  it("kernelName is undefined when kernel not in map", () => {
    const model = makeRawJob({ kernelId: "kernel-NOT-IN-MAP" });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.kernelName).toBeUndefined();
  });

  it("capabilityType from capabilityMap", () => {
    const model = makeRawJob({ capabilityId: "cap-001" });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.capabilityType).toBe("fdm");
  });

  it("capabilityType is undefined when capability not in map", () => {
    const model = makeRawJob({ capabilityId: "cap-NOT-IN-MAP" });
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.capabilityType).toBeUndefined();
  });

  it("evidenceCount defaults to 0 when not provided", () => {
    const model = makeRawJob();
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dto.evidenceCount).toBe(0);
  });

  it("evidenceCount uses provided value", () => {
    const model = makeRawJob();
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx(), 5);
    expect(dto.evidenceCount).toBe(5);
  });

  it("escrowStatus from param", () => {
    const model = makeRawJob();
    const dto = populateJobDTO(model, mockKernelMap, mockCapabilityMap, makeCtx(), 0, "funded");
    expect(dto.escrowStatus).toBe("funded");
  });
});

// ── populateJobDetailDTO ───────────────────────────────────────────────────

describe("populateJobDetailDTO()", () => {
  const emptyBundles: any[] = [];

  it("includes timeline and evidenceBundles", () => {
    const model = makeRawJob({ status: "queued" });
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, emptyBundles, makeCtx());
    expect(Array.isArray(dto.timeline)).toBe(true);
    expect(Array.isArray(dto.evidenceBundles)).toBe(true);
  });

  it("timeline starts with queued event", () => {
    const model = makeRawJob({ status: "queued" });
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, emptyBundles, makeCtx());
    const first = dto.timeline[0];
    expect(first.type).toBe("queued");
  });

  it("timeline includes evidence_received events for each bundle", () => {
    const model = makeRawJob({ status: "running" });
    const bundles = [
      { id: "bun-1", jobId: model.id, stepId: "s1", createdAt: "2026-01-01T12:00:00.000Z", bundleHash: "aaa", events: [] },
    ];
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, bundles, makeCtx());
    const evidenceEvent = dto.timeline.find((e) => e.type === "evidence_received");
    expect(evidenceEvent).toBeDefined();
  });

  it("timeline includes verified event for verified bundles", () => {
    const model = makeRawJob({ status: "running" });
    const bundles = [
      { id: "bun-v", jobId: model.id, stepId: "s1", createdAt: "2026-01-01T12:00:00.000Z", bundleHash: "bbb", events: [], verified: true },
    ];
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, bundles, makeCtx());
    const verifiedEvent = dto.timeline.find((e) => e.type === "verified");
    expect(verifiedEvent).toBeDefined();
  });

  it("timeline includes settled event for status=settled", () => {
    const model = makeRawJob({ status: "settled", completedAt: "2026-01-01T15:00:00.000Z" });
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, emptyBundles, makeCtx());
    const settledEvent = dto.timeline.find((e) => e.type === "settled");
    expect(settledEvent).toBeDefined();
  });

  it("timeline includes failed event for status=failed", () => {
    const model = makeRawJob({ status: "failed", completedAt: "2026-01-01T14:00:00.000Z" });
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, emptyBundles, makeCtx());
    const failedEvent = dto.timeline.find((e) => e.type === "failed");
    expect(failedEvent).toBeDefined();
  });

  it("timeline is sorted chronologically", () => {
    const model = makeRawJob({ status: "running", startedAt: "2026-01-01T10:00:00.000Z" });
    const bundles = [
      { id: "b1", jobId: model.id, stepId: "s1", createdAt: "2026-01-01T11:00:00.000Z", bundleHash: "ccc", events: [] },
    ];
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, bundles, makeCtx());
    const times = dto.timeline.map((e) => new Date(e.timestamp).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it("evidenceBundles are EvidenceSummaryDTOs", () => {
    const model = makeRawJob();
    const bundles = [
      {
        id: "bun-dto",
        jobId: model.id,
        stepId: "step-001",
        assuranceTier: 1,
        bundleHash: "ddd",
        createdAt: "2026-01-01T10:00:00.000Z",
        events: [{}, {}],
        verified: true,
      },
    ];
    const dto = populateJobDetailDTO(model, mockKernelMap, mockCapabilityMap, bundles, makeCtx());
    expect(dto.evidenceBundles).toHaveLength(1);
    expect(dto.evidenceBundles[0].id).toBe("bun-dto");
    expect(dto.evidenceBundles[0].assuranceTier).toBe(1);
    expect(dto.evidenceBundles[0].eventCount).toBe(2);
    expect(dto.evidenceBundles[0].verified).toBe(true);
  });
});

// ── populateJobList ────────────────────────────────────────────────────────

describe("populateJobList()", () => {
  it("returns array of JobDTOs", () => {
    const models = [makeRawJob(), makeRawJob()];
    const dtos = populateJobList(models, mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dtos).toHaveLength(2);
    expect(dtos.every((d) => typeof d.id === "string")).toBe(true);
  });

  it("uses evidenceCountMap when provided", () => {
    const model = makeRawJob({ id: "job-ec" });
    const evidenceCountMap = new Map([["job-ec", 7]]);
    const [dto] = populateJobList([model], mockKernelMap, mockCapabilityMap, makeCtx(), evidenceCountMap);
    expect(dto.evidenceCount).toBe(7);
  });

  it("uses escrowStatusMap when provided", () => {
    const model = makeRawJob({ id: "job-esc" });
    const escrowStatusMap = new Map([["job-esc", "active"]]);
    const [dto] = populateJobList(
      [model],
      mockKernelMap,
      mockCapabilityMap,
      makeCtx(),
      undefined,
      escrowStatusMap,
    );
    expect(dto.escrowStatus).toBe("active");
  });

  it("returns empty array when models is empty", () => {
    const dtos = populateJobList([], mockKernelMap, mockCapabilityMap, makeCtx());
    expect(dtos).toEqual([]);
  });
});

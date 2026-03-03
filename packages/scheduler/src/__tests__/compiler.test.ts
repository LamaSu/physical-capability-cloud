import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowCompiler } from "../compiler.js";
import { CapabilityRouter } from "../router.js";
import type { CWM, Capability } from "@pcc/spec";

function mockCapability(overrides?: Partial<Capability>): Capability {
  return {
    id: "cap_mock_001",
    kernelId: "kernel_test_001",
    type: "fdm",
    name: "Mock Printer",
    materials: ["pla", "petg"],
    assuranceTiers: [0, 1, 2],
    pricing: {
      currency: "USDC",
      baseCost: "2.00",
      perMinute: "0.05",
      minimum: "5.00",
    },
    availability: {
      timezone: "UTC",
      windows: {},
    },
    location: { lat: 40.7, lng: -74.0 },
    queueDepth: 0,
    ...overrides,
  };
}

function mockCWM(overrides?: Partial<CWM>): CWM {
  return {
    version: "1.0",
    id: "cwm_test_001",
    name: "Test Workflow",
    steps: [
      {
        id: "step_1",
        capability: "fdm",
        params: { material: "pla" },
        assuranceTier: 1,
        dependsOn: [],
        estimatedDuration: 60,
      },
    ],
    settlement: {
      currency: "USDC",
      maxBudget: "100.00",
      payer: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
    },
    createdAt: new Date().toISOString(),
    submitter: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
    ...overrides,
  };
}

describe("WorkflowCompiler", () => {
  let router: CapabilityRouter;
  let compiler: WorkflowCompiler;

  beforeEach(() => {
    router = new CapabilityRouter();
    router.registerKernel({
      kernelId: "kernel_test_001",
      capabilities: [mockCapability()],
      reputation: 800,
    });
    compiler = new WorkflowCompiler(router);
  });

  it("compiles a simple single-step CWM", async () => {
    const cwm = mockCWM();
    const plan = await compiler.compile(cwm);

    expect(plan.cwmId).toBe("cwm_test_001");
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].kernelId).toBe("kernel_test_001");
    expect(plan.assignments[0].stepId).toBe("step_1");
    expect(parseFloat(plan.totalCost)).toBeGreaterThan(0);
    expect(parseFloat(plan.totalCost)).toBeLessThanOrEqual(100);
  });

  it("compiles multi-step CWM with dependencies", async () => {
    router.registerKernel({
      kernelId: "kernel_courier",
      capabilities: [mockCapability({ id: "cap_courier", type: "courier-pickup", kernelId: "kernel_courier" })],
      reputation: 700,
    });

    const cwm = mockCWM({
      steps: [
        {
          id: "step_1",
          capability: "fdm",
          params: { material: "pla" },
          assuranceTier: 1,
          dependsOn: [],
          estimatedDuration: 30,
        },
        {
          id: "step_2",
          capability: "courier-pickup",
          params: {},
          assuranceTier: 0,
          dependsOn: ["step_1"],
          estimatedDuration: 30,
        },
      ],
    });

    const plan = await compiler.compile(cwm);
    expect(plan.assignments).toHaveLength(2);

    // Step 2 should start after step 1 ends
    const step1End = new Date(plan.assignments[0].scheduledWindow.end).getTime();
    const step2Start = new Date(plan.assignments[1].scheduledWindow.start).getTime();
    expect(step2Start).toBeGreaterThanOrEqual(step1End);
  });

  it("rejects CWM with circular dependencies", async () => {
    const cwm = mockCWM({
      steps: [
        { id: "a", capability: "fdm", params: {}, assuranceTier: 0, dependsOn: ["b"] },
        { id: "b", capability: "fdm", params: {}, assuranceTier: 0, dependsOn: ["a"] },
      ],
    });

    await expect(compiler.compile(cwm)).rejects.toThrow("Circular dependency");
  });

  it("rejects CWM that exceeds budget", async () => {
    const cwm = mockCWM({
      settlement: {
        currency: "USDC",
        maxBudget: "1.00", // very low budget
        payer: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      },
    });

    await expect(compiler.compile(cwm)).rejects.toThrow("exceeds budget");
  });

  it("throws when no kernel matches capability", async () => {
    const cwm = mockCWM({
      steps: [
        { id: "step_1", capability: "cnc-5axis", params: {}, assuranceTier: 0, dependsOn: [] },
      ],
    });

    await expect(compiler.compile(cwm)).rejects.toThrow("No kernel found");
  });
});

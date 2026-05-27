import { describe, it, expect, vi } from "vitest";
import nacl from "tweetnacl";
import { PrismOrchestrator } from "../orchestrator.js";
import type { LlmPlanner, PccClient, StepDraft } from "../types.js";

function newKeyHex(): string {
  return Array.from(nacl.sign.keyPair().secretKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const KNOWN_INSTRUMENTS = ["ot2", "pf400", "thermocycler"];

const VALID_PLAN: StepDraft[] = [
  {
    name: "Aspirate Master Mix",
    instrument: "ot2",
    action: "aspirate",
    reagent: "master_mix",
    volumeUl: 20,
    source: "reservoir.A1",
  },
  {
    name: "Dispense into plate",
    instrument: "ot2",
    action: "dispense",
    volumeUl: 20,
    target: "plate.A1",
  },
];

function mockPlanner(plan: StepDraft[]): LlmPlanner {
  return { plan: vi.fn(async () => plan) };
}

function mockPcc(overrides: Partial<PccClient> = {}): PccClient {
  return {
    submitJob: vi.fn(async () => ({ jobId: "job-1", escrowId: "esc-1" })),
    getJob: vi.fn(async () => ({ id: "job-1", status: "completed" })),
    fundEscrow: vi.fn(async () => ({ escrowId: "esc-1", address: "0xabc" })),
    ...overrides,
  };
}

describe("PrismOrchestrator", () => {
  it("runs the happy path end-to-end and lands in 'settled'", async () => {
    const orch = new PrismOrchestrator({
      planner: mockPlanner(VALID_PLAN),
      knownInstruments: KNOWN_INSTRUMENTS,
      pcc: mockPcc(),
      simSecretKeyHex: newKeyHex(),
      workflowName: "test-wf",
      kernelId: "kernel-test",
      capabilityId: "cap-test",
      fundAmountUSDC: "10",
    });

    const state = await orch.run({ text: "do a thing" });

    expect(state.phase).toBe("settled");
    expect(state.steps).toHaveLength(2);
    expect(state.workflow?.name).toBe("test-wf");
    expect(state.attestation?.result.verdict).toBe("pass");
    expect(state.escrow?.id).toBe("esc-1");
    expect(state.pccJob?.id).toBe("job-1");
    expect(state.error).toBeUndefined();
  }, 15000);

  it("fails fast when LLM emits unknown instrument", async () => {
    const orch = new PrismOrchestrator({
      planner: mockPlanner([
        { name: "x", instrument: "unknown-bot", action: "noop" },
      ]),
      knownInstruments: KNOWN_INSTRUMENTS,
      pcc: mockPcc(),
      simSecretKeyHex: newKeyHex(),
      workflowName: "test-wf",
      kernelId: "kernel-test",
      capabilityId: "cap-test",
      fundAmountUSDC: "10",
    });

    const state = await orch.run({ text: "x" });

    expect(state.phase).toBe("failed");
    expect(state.error?.phase).toBe("ingest");
    expect(state.error?.message).toMatch(/unknown instruments/);
  });

  it("does NOT call PCC if the LLM stage fails", async () => {
    const pcc = mockPcc();
    const orch = new PrismOrchestrator({
      planner: { plan: vi.fn(async () => []) },
      knownInstruments: KNOWN_INSTRUMENTS,
      pcc,
      simSecretKeyHex: newKeyHex(),
      workflowName: "test-wf",
      kernelId: "kernel-test",
      capabilityId: "cap-test",
      fundAmountUSDC: "10",
    });

    const state = await orch.run({ text: "x" });

    expect(state.phase).toBe("failed");
    expect(pcc.submitJob).not.toHaveBeenCalled();
    expect(pcc.fundEscrow).not.toHaveBeenCalled();
  });
});

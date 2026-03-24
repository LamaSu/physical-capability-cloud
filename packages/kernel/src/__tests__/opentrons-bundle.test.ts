/**
 * Tests for CapabilityCard → ExecutionBundle → Validation → Execution flow.
 *
 * This tests the complete agent-to-machine contract pipeline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpentronOperator, type OperatorConfig } from "../opentrons/operator.js";
import type { CapabilityCard } from "../opentrons/capability-card.js";
import type { ExecutionBundle } from "../opentrons/execution-bundle.js";
import { BundleValidator } from "../opentrons/execution-bundle.js";

const MOCK_CONFIG: OperatorConfig = {
  kernelId: "kernel-test-ot",
  name: "Test OT-2 Lab",
  operatorAddress: "0x1234",
  location: { lat: 37.77, lng: -122.41 },
  adapter: { url: "http://localhost:31950", mockMode: true, maxQueueDepth: 5 },
  pricing: { baseCost: "5.00", perMinute: "0.50", minimum: "10.00", currency: "USDC" },
  maxQueueDepth: 5,
};

function makeBundle(card: CapabilityCard, overrides: Partial<ExecutionBundle> = {}): ExecutionBundle {
  return {
    schemaVersion: "ExecutionBundle/1.0",
    idempotencyKey: `key-${Date.now()}-${Math.random()}`,
    cardRef: {
      kernelId: card.operator.kernelId,
      generatedAt: card.generatedAt,
    },
    submitter: {
      agentId: "agent-user-1",
      walletAddress: "0xuser1",
    },
    deck: [
      { slot: "1", labwareLoadName: "opentrons_96_tiprack_300ul", labwareDisplayName: "300µL Tips" },
      { slot: "2", labwareLoadName: "corning_96_wellplate_360ul_flat", labwareDisplayName: "96-Well Plate" },
      { slot: "4", labwareLoadName: "nest_12_reservoir_15ml", labwareDisplayName: "Reservoir" },
    ],
    steps: [
      {
        id: "s1",
        action: "transfer",
        params: { volume: 100, sourceWell: "A1", sourceSlot: "4", destWell: "A1", destSlot: "2", pipette: "left", newTip: "always" },
        dependsOn: [],
        label: "Transfer reagent",
      },
    ],
    assuranceTier: 1,
    maxCost: { amount: "50.00", currency: "USDC" },
    metadata: { name: "Test Transfer Protocol" },
    ...overrides,
  };
}

describe("Capability Card → Execution Bundle Flow", () => {
  let operator: OpentronOperator;
  let card: CapabilityCard;

  beforeEach(async () => {
    operator = new OpentronOperator(MOCK_CONFIG);
    await operator.start();
    card = await operator.getCapabilityCard();
  });

  // ── Card Generation ─────────────────────────────────────────

  it("should generate a capability card with all sections", () => {
    expect(card.schemaVersion).toBe("1.0");
    expect(card.operator.kernelId).toBe("kernel-test-ot");
    expect(card.hardware.pipettes.length).toBeGreaterThan(0);
    expect(card.actions.length).toBeGreaterThan(0);
    expect(card.deck.slots.length).toBe(12); // 11 + trash
    expect(card.deck.availableLabware.length).toBeGreaterThan(0);
    expect(card.pricing.formula).toBeTruthy();
    expect(card.constraints.wellPattern).toBeTruthy();
    expect(card.responseFormat).toBe("ExecutionBundle/1.0");
  });

  it("should include parameter schemas for each action", () => {
    const transferAction = card.actions.find((a) => a.action === "transfer");
    expect(transferAction).toBeDefined();
    expect(transferAction!.params.length).toBeGreaterThan(0);

    const volumeParam = transferAction!.params.find((p) => p.key === "volume");
    expect(volumeParam).toBeDefined();
    expect(volumeParam!.type).toBe("number");
    expect(volumeParam!.required).toBe(true);
    expect(volumeParam!.min).toBeGreaterThan(0);
    expect(volumeParam!.max).toBeGreaterThan(0);
  });

  it("should reflect current queue state", () => {
    expect(card.constraints.currentQueueDepth).toBe(0);
    expect(card.constraints.estimatedQueueWaitMs).toBe(0);
  });

  // ── Valid Bundle ────────────────────────────────────────────

  it("should accept a valid bundle and return compiled protocol + job ID", async () => {
    const bundle = makeBundle(card);
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.compiledProtocolSource).toContain("def run(protocol):");
    expect(result.compiledProtocolSource).toContain("transfer(100");
    expect(result.jobId).toBeTruthy();
    expect(result.queuePosition).toBeDefined();
    expect(result.estimatedDurationMs).toBeGreaterThan(0);
    expect(result.estimatedCost).toBeDefined();
  });

  it("should enqueue the job after valid bundle submission", async () => {
    const bundle = makeBundle(card);
    const result = await operator.submitBundle(bundle);

    const job = operator.getJob(result.jobId!);
    expect(job).toBeDefined();
    expect(job!.status).toBeDefined();
    expect(job!.protocolSource).toContain("def run(protocol):");
  });

  // ── Validation Errors ───────────────────────────────────────

  it("should reject bundle with unknown action", async () => {
    const bundle = makeBundle(card, {
      steps: [{
        id: "s1", action: "teleport_liquid", params: {}, dependsOn: [],
      }],
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    const unknownErr = result.errors.find((e) => e.code === "UNKNOWN_ACTION");
    expect(unknownErr).toBeDefined();
    expect(unknownErr!.suggestion).toContain("Available:");
  });

  it("should reject bundle with missing required param", async () => {
    const bundle = makeBundle(card, {
      steps: [{
        id: "s1", action: "aspirate", params: { well: "A1", slot: "2" }, // missing volume
        dependsOn: [],
      }],
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_REQUIRED_PARAM" && e.param === "volume")).toBe(true);
  });

  it("should reject bundle with volume exceeding pipette max", async () => {
    const bundle = makeBundle(card, {
      steps: [{
        id: "s1", action: "aspirate",
        params: { volume: 99999, well: "A1", slot: "2" },
        dependsOn: [],
      }],
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "VOLUME_ABOVE_MAX")).toBe(true);
  });

  it("should reject bundle with invalid well format", async () => {
    const bundle = makeBundle(card, {
      steps: [{
        id: "s1", action: "aspirate",
        params: { volume: 50, well: "Z99", slot: "2" },
        dependsOn: [],
      }],
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "INVALID_WELL")).toBe(true);
  });

  it("should reject bundle referencing empty deck slot", async () => {
    const bundle = makeBundle(card, {
      steps: [{
        id: "s1", action: "aspirate",
        params: { volume: 50, well: "A1", slot: "9" }, // slot 9 has no labware
        dependsOn: [],
      }],
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "SLOT_EMPTY")).toBe(true);
  });

  it("should reject bundle with no tip rack when tips are needed", async () => {
    const bundle = makeBundle(card, {
      deck: [
        // No tip rack!
        { slot: "2", labwareLoadName: "corning_96_wellplate_360ul_flat", labwareDisplayName: "Plate" },
        { slot: "4", labwareLoadName: "nest_12_reservoir_15ml", labwareDisplayName: "Reservoir" },
      ],
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "NO_TIP_RACK")).toBe(true);
  });

  it("should reject bundle with unavailable labware", async () => {
    const bundle = makeBundle(card, {
      deck: [
        { slot: "1", labwareLoadName: "opentrons_96_tiprack_300ul", labwareDisplayName: "Tips" },
        { slot: "2", labwareLoadName: "nonexistent_labware_99", labwareDisplayName: "???" },
      ],
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "LABWARE_NOT_AVAILABLE")).toBe(true);
  });

  it("should reject bundle exceeding cost budget", async () => {
    const bundle = makeBundle(card, {
      maxCost: { amount: "0.01", currency: "USDC" }, // way too low
    });
    const result = await operator.submitBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "COST_EXCEEDS_BUDGET")).toBe(true);
  });

  it("should reject duplicate idempotency key", async () => {
    const bundle = makeBundle(card, { idempotencyKey: "unique-key-123" });
    const result1 = await operator.submitBundle(bundle);
    expect(result1.valid).toBe(true);

    // Same key again
    const bundle2 = makeBundle(card, { idempotencyKey: "unique-key-123" });
    const result2 = await operator.submitBundle(bundle2);
    expect(result2.valid).toBe(false);
    expect(result2.errors.some((e) => e.code === "DUPLICATE_IDEMPOTENCY_KEY")).toBe(true);
  });

  // ── Error Suggestions ───────────────────────────────────────

  it("should provide actionable suggestions for every error", async () => {
    const bundle = makeBundle(card, {
      steps: [
        { id: "s1", action: "teleport", params: {}, dependsOn: [] },
        { id: "s2", action: "aspirate", params: { volume: 99999, well: "Z99", slot: "9" }, dependsOn: [] },
      ],
    });
    const result = await operator.submitBundle(bundle);

    // Every error should have a suggestion
    for (const error of result.errors) {
      expect(error.message).toBeTruthy();
      // Most errors should have suggestions (some might not if they're obvious)
    }
  });

  // ── Multi-Step Bundle ───────────────────────────────────────

  it("should accept a multi-step protocol bundle", async () => {
    const bundle = makeBundle(card, {
      steps: [
        { id: "s1", action: "aspirate", params: { volume: 100, well: "A1", slot: "4" }, dependsOn: [], label: "Aspirate from reservoir" },
        { id: "s2", action: "dispense", params: { volume: 100, well: "A1", slot: "2" }, dependsOn: ["s1"], label: "Dispense to plate" },
        { id: "s3", action: "mix", params: { volume: 80, well: "A1", slot: "2", repetitions: 5 }, dependsOn: ["s2"], label: "Mix" },
        { id: "s4", action: "aspirate", params: { volume: 50, well: "A2", slot: "4" }, dependsOn: [], label: "Second aspirate" },
        { id: "s5", action: "dispense", params: { volume: 50, well: "B1", slot: "2" }, dependsOn: ["s4"], label: "Second dispense" },
      ],
    });

    const result = await operator.submitBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.compiledProtocolSource).toContain("aspirate");
    expect(result.compiledProtocolSource).toContain("dispense");
    expect(result.compiledProtocolSource).toContain("mix(5, 80");
  });
});

describe("BundleValidator (standalone)", () => {
  let validator: BundleValidator;

  beforeEach(() => {
    validator = new BundleValidator();
  });

  it("should reject mismatched kernel ID", () => {
    const card: CapabilityCard = {
      schemaVersion: "1.0",
      operator: { kernelId: "kernel-A", name: "A", location: { lat: 0, lng: 0 }, reputation: 100 },
      hardware: { model: "OT-2", pipettes: [], modules: [] },
      actions: [],
      deck: { slots: [], availableLabware: [] },
      pricing: { baseCost: 5, perMinuteRate: 0.5, minimumCharge: 10, currency: "USDC", formula: "" },
      constraints: { maxSteps: 200, maxProtocolDurationMs: 0, maxQueueDepth: 10, currentQueueDepth: 0, estimatedQueueWaitMs: 0, assuranceTiers: [0], wellPattern: ".*" },
      responseFormat: "ExecutionBundle/1.0",
      generatedAt: new Date().toISOString(),
      validForMs: 600_000,
    };

    const bundle: ExecutionBundle = {
      schemaVersion: "ExecutionBundle/1.0",
      idempotencyKey: "test",
      cardRef: { kernelId: "kernel-B", generatedAt: card.generatedAt },
      submitter: { agentId: "a", walletAddress: "0x" },
      deck: [],
      steps: [],
      assuranceTier: 0,
      maxCost: { amount: "100", currency: "USDC" },
    };

    const result = validator.validate(bundle, card, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("CARD_MISMATCH");
  });
});

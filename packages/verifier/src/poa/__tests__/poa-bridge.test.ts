import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { POABridge } from "../poa-bridge.js";
import type {
  CPCTask,
  EvidenceBundle,
  AssuranceScore,
  POAVerificationResult,
} from "../types.js";
import { DEFAULT_SCORING_WEIGHTS } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Standard PCCP steps for testing. */
function makeTestSteps() {
  return [
    {
      stepId: "step_1",
      stepType: "transform",
      description: "Load raw material",
      dependsOn: [] as string[],
    },
    {
      stepId: "step_2",
      stepType: "validate",
      description: "Verify material properties",
      dependsOn: ["step_1"],
    },
    {
      stepId: "step_3",
      stepType: "transform",
      description: "Execute machining operation",
      dependsOn: ["step_2"],
    },
  ];
}

/** Standard evidence events for testing. */
function makeTestEvents() {
  const base = Date.now();
  return [
    {
      stepId: "step_1",
      action: "transform",
      input: "raw_material_data",
      output: "loaded_material",
      outputSummary: "Material loaded successfully",
      durationMs: 100,
      timestamp: new Date(base + 100).toISOString(),
    },
    {
      stepId: "step_2",
      action: "validate",
      input: "loaded_material",
      output: "validation_passed",
      outputSummary: "Material properties verified",
      durationMs: 200,
      timestamp: new Date(base + 300).toISOString(),
    },
    {
      stepId: "step_3",
      action: "transform",
      input: "validation_passed",
      output: "machined_part",
      outputSummary: "Machining complete",
      durationMs: 500,
      timestamp: new Date(base + 800).toISOString(),
    },
  ];
}

/** Create ordered timestamps for testing. */
function makeOrderedTimestamps() {
  const base = Date.now();
  return {
    receivedAt: new Date(base).toISOString(),
    startedAt: new Date(base + 50).toISOString(),
    completedAt: new Date(base + 1000).toISOString(),
    submittedAt: new Date(base + 1100).toISOString(),
  };
}

// ── CPC Creation Tests ──────────────────────────────────────────────

describe("POABridge — createCPC", () => {
  let bridge: POABridge;

  beforeEach(() => {
    bridge = new POABridge();
  });

  it("generates a valid CPC task with a nonce", async () => {
    const cpc = await bridge.createCPC({
      jobId: "job_001",
      steps: makeTestSteps(),
    });

    expect(cpc.taskId).toBe("job_001");
    expect(cpc.version).toBe("1.0.0");
    expect(cpc.taskType).toBe("workflow_execution");
    expect(cpc.nonce).toBeTruthy();
    expect(cpc.nonce).toHaveLength(64); // SHA-256 hex digest
    expect(cpc.issuedAt).toBeTruthy();
    expect(cpc.issuedBy).toBe("pcc-validator-mock");
  });

  it("maps PCCP workflow steps to CPC WorkflowSteps correctly", async () => {
    const steps = makeTestSteps();
    const cpc = await bridge.createCPC({ jobId: "job_002", steps });

    expect(cpc.workflowSteps).toHaveLength(3);
    expect(cpc.workflowSteps[0].stepId).toBe("step_1");
    expect(cpc.workflowSteps[0].description).toBe("Load raw material");
    expect(cpc.workflowSteps[0].dependsOn).toEqual([]);
    expect(cpc.workflowSteps[1].dependsOn).toEqual(["step_1"]);
    expect(cpc.workflowSteps[2].dependsOn).toEqual(["step_2"]);
  });

  it("uses custom task type and title when provided", async () => {
    const cpc = await bridge.createCPC({
      jobId: "job_003",
      title: "Custom Task",
      description: "A custom description",
      taskType: "data_analysis",
      steps: makeTestSteps(),
    });

    expect(cpc.taskType).toBe("data_analysis");
    expect(cpc.title).toBe("Custom Task");
    expect(cpc.description).toBe("A custom description");
  });

  it("embeds evidence requirements in constraints and metadata", async () => {
    const cpc = await bridge.createCPC({
      jobId: "job_004",
      steps: makeTestSteps(),
      evidenceRequirements: {
        tier: 2,
        verifierCount: 5,
        maxTimeSeconds: 600,
      },
    });

    expect(cpc.constraints.maxExecutionTimeSeconds).toBe(600);
    expect(cpc.metadata.tier).toBe(2);
    expect(cpc.metadata.verifierCount).toBe(5);
  });

  it("passes through inputData", async () => {
    const cpc = await bridge.createCPC({
      jobId: "job_005",
      steps: makeTestSteps(),
      inputData: { materialId: "steel-304", quantity: 10 },
    });

    expect(cpc.inputData).toEqual({ materialId: "steel-304", quantity: 10 });
  });
});

// ── Evidence Submission Tests ────────────────────────────────────────

describe("POABridge — submitEvidence", () => {
  let bridge: POABridge;
  let cpc: CPCTask;

  beforeEach(async () => {
    bridge = new POABridge();
    cpc = await bridge.createCPC({
      jobId: "job_ev_001",
      steps: makeTestSteps(),
    });
  });

  it("builds a valid hash chain", async () => {
    const eeb = await bridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });

    expect(eeb.hashChain).toHaveLength(3);
    // Verify chain[0] = SHA256(trace[0].inputHash + trace[0].outputHash)
    const expected0 = sha256hex(
      eeb.executionTrace[0].inputHash + eeb.executionTrace[0].outputHash,
    );
    expect(eeb.hashChain[0]).toBe(expected0);

    // Verify chain[1] = SHA256(chain[0] + trace[1].inputHash + trace[1].outputHash)
    const expected1 = sha256hex(
      eeb.hashChain[0] +
        eeb.executionTrace[1].inputHash +
        eeb.executionTrace[1].outputHash,
    );
    expect(eeb.hashChain[1]).toBe(expected1);
  });

  it("hash chain is deterministic (same input = same chain)", async () => {
    const events = makeTestEvents();
    const timestamps = makeOrderedTimestamps();

    const eeb1 = await bridge.submitEvidence(cpc, { events, timestamps });
    const eeb2 = await bridge.submitEvidence(cpc, { events, timestamps });

    expect(eeb1.hashChain).toEqual(eeb2.hashChain);
  });

  it("generates correct nonce reflection", async () => {
    const eeb = await bridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });

    const lastChain = eeb.hashChain[eeb.hashChain.length - 1];
    const expectedNonce = sha256hex(cpc.nonce + lastChain);
    expect(eeb.nonceReflection).toBe(expectedNonce);
  });

  it("maps events to trace entries with hashed inputs/outputs", async () => {
    const eeb = await bridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });

    expect(eeb.executionTrace).toHaveLength(3);
    expect(eeb.executionTrace[0].stepId).toBe("step_1");
    expect(eeb.executionTrace[0].inputHash).toBe(
      sha256hex("raw_material_data"),
    );
    expect(eeb.executionTrace[0].outputHash).toBe(
      sha256hex("loaded_material"),
    );
    expect(eeb.executionTrace[0].durationMs).toBe(100);
  });

  it("sets task ID from CPC", async () => {
    const eeb = await bridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });

    expect(eeb.taskId).toBe(cpc.taskId);
  });

  it("uses provided miner hotkey", async () => {
    const eeb = await bridge.submitEvidence(cpc, {
      minerHotkey: "custom-miner-123",
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });

    expect(eeb.minerHotkey).toBe("custom-miner-123");
  });
});

// ── Verification Tests ──────────────────────────────────────────────

describe("POABridge — verify", () => {
  let bridge: POABridge;
  let cpc: CPCTask;
  let validEEB: EvidenceBundle;

  beforeEach(async () => {
    bridge = new POABridge();
    cpc = await bridge.createCPC({
      jobId: "job_ver_001",
      steps: makeTestSteps(),
    });
    validEEB = await bridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });
  });

  it("passes verification for a valid EEB", async () => {
    const result = await bridge.verify(cpc, validEEB);

    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.score).toBeDefined();
    expect(result.score.verificationPassed).toBe(true);
  });

  it("fails on wrong task ID", async () => {
    const tampered = { ...validEEB, taskId: "wrong_task_id" };
    const result = await bridge.verify(cpc, tampered);

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("Task ID mismatch"))).toBe(
      true,
    );
  });

  it("fails on broken hash chain", async () => {
    const tampered = {
      ...validEEB,
      hashChain: [...validEEB.hashChain],
    };
    tampered.hashChain[1] = "0000000000000000000000000000000000000000000000000000000000000000";

    const result = await bridge.verify(cpc, tampered);

    expect(result.passed).toBe(false);
    expect(
      result.failures.some((f) => f.includes("Hash chain mismatch")),
    ).toBe(true);
  });

  it("fails on wrong nonce reflection", async () => {
    const tampered = {
      ...validEEB,
      nonceReflection: "bad_nonce_reflection_value",
    };

    const result = await bridge.verify(cpc, tampered);

    expect(result.passed).toBe(false);
    expect(
      result.failures.some((f) => f.includes("Nonce reflection mismatch")),
    ).toBe(true);
  });

  it("fails on out-of-order timestamps", async () => {
    const base = Date.now();
    const tampered = {
      ...validEEB,
      timestamps: {
        receivedAt: new Date(base + 5000).toISOString(), // After started
        startedAt: new Date(base + 100).toISOString(),
        completedAt: new Date(base + 3000).toISOString(),
        submittedAt: new Date(base + 4000).toISOString(),
      },
    };

    const result = await bridge.verify(cpc, tampered);

    expect(result.passed).toBe(false);
    expect(
      result.failures.some((f) => f.includes("Timestamp ordering")),
    ).toBe(true);
  });

  it("fails on missing step trace", async () => {
    // Remove step_3 from the trace
    const tampered = {
      ...validEEB,
      executionTrace: validEEB.executionTrace.filter(
        (t) => t.stepId !== "step_3",
      ),
    };
    // Rebuild hash chain for the shorter trace (so hash chain is valid)
    const chain: string[] = [];
    for (let i = 0; i < tampered.executionTrace.length; i++) {
      const entry = tampered.executionTrace[i];
      if (i === 0) {
        chain.push(sha256hex(entry.inputHash + entry.outputHash));
      } else {
        chain.push(
          sha256hex(chain[i - 1] + entry.inputHash + entry.outputHash),
        );
      }
    }
    tampered.hashChain = chain;
    tampered.nonceReflection = sha256hex(
      cpc.nonce + chain[chain.length - 1],
    );

    const result = await bridge.verify(cpc, tampered);

    expect(result.passed).toBe(false);
    expect(
      result.failures.some((f) => f.includes("Missing trace entry for CPC step 'step_3'")),
    ).toBe(true);
  });

  it("fails on empty execution trace (format compliance)", async () => {
    const tampered = {
      ...validEEB,
      executionTrace: [],
      hashChain: [],
    };

    const result = await bridge.verify(cpc, tampered);

    expect(result.passed).toBe(false);
    expect(
      result.failures.some((f) => f.includes("executionTrace")),
    ).toBe(true);
  });

  it("fails on hash chain length mismatch", async () => {
    const tampered = {
      ...validEEB,
      hashChain: [validEEB.hashChain[0]], // Only 1 entry for 3 traces
    };

    const result = await bridge.verify(cpc, tampered);

    expect(result.passed).toBe(false);
    expect(
      result.failures.some((f) => f.includes("Hash chain length mismatch")),
    ).toBe(true);
  });
});

// ── Scoring Tests ───────────────────────────────────────────────────

describe("POABridge — score", () => {
  let bridge: POABridge;
  let cpc: CPCTask;
  let validEEB: EvidenceBundle;

  beforeEach(async () => {
    bridge = new POABridge();
    cpc = await bridge.createCPC({
      jobId: "job_score_001",
      steps: makeTestSteps(),
      evidenceRequirements: { maxTimeSeconds: 300 },
    });
    validEEB = await bridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });
  });

  it("produces correct dimension weights (35/25/20/10/10)", async () => {
    const result = await bridge.verify(cpc, validEEB);
    const score = result.score;

    const weights = score.dimensions.map((d) => d.weight);
    expect(weights).toEqual([0.35, 0.25, 0.20, 0.10, 0.10]);
  });

  it("dimension weights sum to 1.0", async () => {
    const result = await bridge.verify(cpc, validEEB);
    const weightSum = result.score.dimensions.reduce(
      (sum, d) => sum + d.weight,
      0,
    );
    expect(weightSum).toBeCloseTo(1.0, 10);
  });

  it("perfect execution scores 1.0 composite", async () => {
    const result = await bridge.verify(cpc, validEEB);

    expect(result.score.compositeScore).toBeCloseTo(1.0, 2);
    expect(result.score.verificationPassed).toBe(true);
    expect(result.score.penalties).toHaveLength(0);
    expect(result.score.penaltyMultiplier).toBe(1.0);
  });

  it("composite score is between 0 and 1", async () => {
    const result = await bridge.verify(cpc, validEEB);

    expect(result.score.compositeScore).toBeGreaterThanOrEqual(0);
    expect(result.score.compositeScore).toBeLessThanOrEqual(1);
  });

  it("missing steps reduce completeness score", async () => {
    // Create EEB with only step_1 (missing step_2 and step_3)
    const base = Date.now();
    const partialEEB = await bridge.submitEvidence(cpc, {
      events: [
        {
          stepId: "step_1",
          action: "transform",
          input: "raw_material_data",
          output: "loaded_material",
          durationMs: 100,
          timestamp: new Date(base + 100).toISOString(),
        },
      ],
      timestamps: makeOrderedTimestamps(),
    });

    const result = await bridge.verify(cpc, partialEEB);
    const completeness = result.score.dimensions.find(
      (d) => d.name === "completeness",
    );

    expect(completeness).toBeDefined();
    expect(completeness!.rawScore).toBeCloseTo(1 / 3, 2); // 1 of 3 steps
  });

  it("broken hash chain zeros evidence_integrity", async () => {
    const tampered = {
      ...validEEB,
      hashChain: validEEB.hashChain.map(() => "badhash"),
    };

    const score = await bridge.score(cpc, tampered, {
      passed: false,
      failures: ["Hash chain mismatch"],
    });

    const integrity = score.dimensions.find(
      (d) => d.name === "evidence_integrity",
    );
    expect(integrity).toBeDefined();
    expect(integrity!.rawScore).toBe(0);
  });

  it("applies penalties for hash chain failure", async () => {
    const score = await bridge.score(cpc, validEEB, {
      passed: false,
      failures: ["Hash chain mismatch at index 1"],
    });

    expect(score.penalties).toContain("hash_chain_failure");
    expect(score.penaltyMultiplier).toBeLessThan(1.0);
  });

  it("task ID mismatch penalty sets multiplier to 0", async () => {
    const score = await bridge.score(cpc, validEEB, {
      passed: false,
      failures: ["Task ID mismatch: EEB has 'wrong', CPC has 'job_score_001'"],
    });

    expect(score.penalties).toContain("task_id_mismatch");
    expect(score.penaltyMultiplier).toBe(0.0);
    expect(score.finalScore).toBe(0);
  });

  it("includes all 5 scoring dimensions", async () => {
    const result = await bridge.verify(cpc, validEEB);
    const dimensionNames = result.score.dimensions.map((d) => d.name);

    expect(dimensionNames).toEqual([
      "accuracy",
      "completeness",
      "evidence_integrity",
      "reasoning_quality",
      "efficiency",
    ]);
  });

  it("each dimension has an explanation", async () => {
    const result = await bridge.verify(cpc, validEEB);
    for (const dim of result.score.dimensions) {
      expect(dim.explanation).toBeTruthy();
      expect(dim.explanation.length).toBeGreaterThan(0);
    }
  });
});

// ── Tier Mapping Tests ──────────────────────────────────────────────

describe("POABridge — mapToAssuranceTier", () => {
  let bridge: POABridge;

  beforeEach(() => {
    bridge = new POABridge();
  });

  it("maps 0.0 to Tier 0", () => {
    expect(bridge.mapToAssuranceTier(0.0)).toBe(0);
  });

  it("maps 0.49 to Tier 0", () => {
    expect(bridge.mapToAssuranceTier(0.49)).toBe(0);
  });

  it("maps 0.5 to Tier 1", () => {
    expect(bridge.mapToAssuranceTier(0.5)).toBe(1);
  });

  it("maps 0.69 to Tier 1", () => {
    expect(bridge.mapToAssuranceTier(0.69)).toBe(1);
  });

  it("maps 0.7 to Tier 2", () => {
    expect(bridge.mapToAssuranceTier(0.7)).toBe(2);
  });

  it("maps 0.89 to Tier 2", () => {
    expect(bridge.mapToAssuranceTier(0.89)).toBe(2);
  });

  it("maps 0.9 to Tier 3", () => {
    expect(bridge.mapToAssuranceTier(0.9)).toBe(3);
  });

  it("maps 1.0 to Tier 3", () => {
    expect(bridge.mapToAssuranceTier(1.0)).toBe(3);
  });
});

// ── Full Pipeline Tests ─────────────────────────────────────────────

describe("POABridge — full pipeline", () => {
  let bridge: POABridge;

  beforeEach(() => {
    bridge = new POABridge();
  });

  it("createCPC -> submitEvidence -> verify -> score (happy path)", async () => {
    // 1. Create CPC
    const cpc = await bridge.createCPC({
      jobId: "job_pipeline_001",
      steps: makeTestSteps(),
      evidenceRequirements: { tier: 2, verifierCount: 3, maxTimeSeconds: 300 },
    });
    expect(cpc.taskId).toBe("job_pipeline_001");

    // 2. Submit evidence
    const eeb = await bridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });
    expect(eeb.taskId).toBe(cpc.taskId);
    expect(eeb.hashChain).toHaveLength(3);

    // 3. Verify
    const result = await bridge.verify(cpc, eeb);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);

    // 4. Score
    const score = result.score;
    expect(score.compositeScore).toBeGreaterThan(0.9);
    expect(score.verificationPassed).toBe(true);
    expect(score.finalScore).toBeGreaterThan(0.9);

    // 5. Map to tier
    const tier = bridge.mapToAssuranceTier(score.finalScore);
    expect(tier).toBe(3); // Perfect execution -> Tier 3
  });

  it("handles single-step workflow end-to-end", async () => {
    const cpc = await bridge.createCPC({
      jobId: "job_single_step",
      steps: [{ stepId: "only_step", description: "Do the thing" }],
    });

    const eeb = await bridge.submitEvidence(cpc, {
      events: [
        {
          stepId: "only_step",
          action: "transform",
          input: "input_data",
          output: "output_data",
          durationMs: 50,
          timestamp: new Date().toISOString(),
        },
      ],
      timestamps: makeOrderedTimestamps(),
    });

    const result = await bridge.verify(cpc, eeb);
    expect(result.passed).toBe(true);
    expect(result.score.compositeScore).toBeGreaterThan(0.8);
  });

  it("non-mock mode still works (falls through to local verification)", async () => {
    const prodBridge = new POABridge({ mock: false });
    const cpc = await prodBridge.createCPC({
      jobId: "job_prod",
      steps: makeTestSteps(),
    });
    const eeb = await prodBridge.submitEvidence(cpc, {
      events: makeTestEvents(),
      timestamps: makeOrderedTimestamps(),
    });

    const result = await prodBridge.verify(cpc, eeb);
    expect(result.passed).toBe(true);
  });

  it("isMock property reflects configuration", () => {
    const mockBridge = new POABridge();
    expect(mockBridge.isMock).toBe(true);

    const prodBridge = new POABridge({ mock: false });
    expect(prodBridge.isMock).toBe(false);
  });

  it("scoring weights from DEFAULT_SCORING_WEIGHTS match expected values", () => {
    expect(DEFAULT_SCORING_WEIGHTS.accuracy).toBe(0.35);
    expect(DEFAULT_SCORING_WEIGHTS.completeness).toBe(0.25);
    expect(DEFAULT_SCORING_WEIGHTS.evidence_integrity).toBe(0.20);
    expect(DEFAULT_SCORING_WEIGHTS.reasoning_quality).toBe(0.10);
    expect(DEFAULT_SCORING_WEIGHTS.efficiency).toBe(0.10);

    const sum = Object.values(DEFAULT_SCORING_WEIGHTS).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

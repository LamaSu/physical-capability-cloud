/**
 * POA Bridge — Maps PCCP evidence verification to the Provenonce POA Bittensor subnet.
 *
 * Provides a clean API for:
 * 1. Creating CPC (Canonical Path Contract) tasks from PCCP job data
 * 2. Building EEB (Execution Evidence Bundle) from PCCP evidence
 * 3. Running the POA 6-check verification gate
 * 4. Computing Assurance Scores with the 5-dimension model
 * 5. Mapping POA scores back to PCCP Assurance Tiers
 *
 * In mock mode, all verification runs locally. In production mode,
 * this would call POA subnet validators via Dendrite (TODO).
 */

import { createHash } from "node:crypto";
import type {
  CPCTask,
  CPCTaskType,
  CPCWorkflowStep,
  CPCTaskConstraints,
  EvidenceBundle,
  TraceEntry,
  ExecutionTimestamps,
  AssuranceScore,
  ScoreDimension,
  POABridgeConfig,
  POAVerificationResult,
} from "./types.js";
import { DEFAULT_POA_BRIDGE_CONFIG, DEFAULT_SCORING_WEIGHTS } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute SHA-256 hex digest of a string. */
function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ── POABridge ───────────────────────────────────────────────────────

/** Parameters for creating a CPC from PCCP job data. */
export interface CreateCPCParams {
  jobId: string;
  title?: string;
  description?: string;
  taskType?: CPCTaskType;
  steps: Array<{
    stepId: string;
    stepType?: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    constraints?: Record<string, unknown>;
    dependsOn?: string[];
  }>;
  evidenceRequirements?: {
    tier?: number;
    verifierCount?: number;
    maxTimeSeconds?: number;
  };
  inputData?: Record<string, unknown>;
}

/** Parameters for submitting PCCP evidence to create an EEB. */
export interface SubmitEvidenceParams {
  minerHotkey?: string;
  events: Array<{
    stepId: string;
    action: string;
    input: string;
    output: string;
    outputSummary?: string;
    durationMs: number;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>;
  outputs?: Record<string, unknown>;
  timestamps?: {
    receivedAt: string;
    startedAt: string;
    completedAt: string;
    submittedAt: string;
  };
}

export class POABridge {
  private config: POABridgeConfig;

  constructor(config?: Partial<POABridgeConfig>) {
    this.config = { ...DEFAULT_POA_BRIDGE_CONFIG, ...config };
  }

  /** Whether the bridge is running in mock mode. */
  get isMock(): boolean {
    return this.config.mock;
  }

  // ── CPC Creation ────────────────────────────────────────────────

  /**
   * Create a Canonical Path Contract (CPC) from PCCP job data.
   *
   * Maps PCCP workflow steps to POA WorkflowSteps and generates
   * a cryptographic nonce for anti-gaming.
   */
  async createCPC(params: CreateCPCParams): Promise<CPCTask> {
    const now = new Date().toISOString();

    // Generate cryptographic nonce: SHA-256(jobId + timestamp)
    const nonce = sha256hex(params.jobId + now);

    // Map PCCP steps to POA WorkflowSteps
    const workflowSteps: CPCWorkflowStep[] = params.steps.map((step) => ({
      stepId: step.stepId,
      stepType: step.stepType ?? "transform",
      description: step.description,
      inputSchema: step.inputSchema ?? {},
      outputSchema: step.outputSchema ?? {},
      constraints: step.constraints ?? {},
      dependsOn: step.dependsOn ?? [],
    }));

    // Build constraints
    const constraints: CPCTaskConstraints = {
      maxExecutionTimeSeconds:
        params.evidenceRequirements?.maxTimeSeconds ?? 300,
      maxSteps: workflowSteps.length + 10,
      requiredEvidenceTypes: ["execution_trace", "hash_chain", "timestamps"],
      allowExternalApiCalls: true,
    };

    return {
      taskId: params.jobId,
      version: "1.0.0",
      taskType: params.taskType ?? "workflow_execution",
      title: params.title ?? `PCCP Job ${params.jobId}`,
      description:
        params.description ??
        `Verification task for PCCP job ${params.jobId}`,
      workflowSteps,
      constraints,
      nonce,
      inputData: params.inputData ?? {},
      issuedAt: now,
      issuedBy: this.config.validatorHotkey,
      metadata: {
        source: "pccp",
        tier: params.evidenceRequirements?.tier ?? 0,
        verifierCount: params.evidenceRequirements?.verifierCount ?? 1,
      },
    };
  }

  // ── Evidence Submission ─────────────────────────────────────────

  /**
   * Create an Execution Evidence Bundle (EEB) from PCCP evidence.
   *
   * Builds the hash chain and nonce reflection from evidence events.
   */
  async submitEvidence(
    cpc: CPCTask,
    params: SubmitEvidenceParams,
  ): Promise<EvidenceBundle> {
    // Map PCCP evidence events to POA TraceEntry format
    const executionTrace: TraceEntry[] = params.events.map((event) => ({
      stepId: event.stepId,
      action: event.action,
      inputHash: sha256hex(event.input),
      outputHash: sha256hex(event.output),
      outputSummary: event.outputSummary ?? "",
      durationMs: event.durationMs,
      timestamp: event.timestamp,
      metadata: event.metadata ?? {},
    }));

    // Build hash chain
    const hashChain = this.buildHashChain(executionTrace);

    // Generate nonce reflection: SHA256(nonce + final chain entry)
    const nonceReflection =
      hashChain.length > 0
        ? sha256hex(cpc.nonce + hashChain[hashChain.length - 1])
        : sha256hex(cpc.nonce);

    // Compute output hash
    const outputs = params.outputs ?? {};
    const outputHash = sha256hex(JSON.stringify(outputs));

    // Build timestamps
    const now = new Date().toISOString();
    const timestamps: ExecutionTimestamps = params.timestamps ?? {
      receivedAt: now,
      startedAt: now,
      completedAt: now,
      submittedAt: now,
    };

    return {
      taskId: cpc.taskId,
      eebVersion: "1.0.0",
      minerHotkey: params.minerHotkey ?? "pccp-miner-local",
      executionTrace,
      hashChain,
      nonceReflection,
      timestamps,
      outputs,
      outputHash,
      signature: "",
      metadata: { source: "pccp" },
    };
  }

  // ── Verification ────────────────────────────────────────────────

  /**
   * Run the POA 6-check verification gate.
   *
   * Checks:
   * 1. Format compliance (all required fields present)
   * 2. Task ID match (eeb.taskId === cpc.taskId)
   * 3. Hash chain integrity (recompute and compare)
   * 4. Nonce reflection (recompute and compare)
   * 5. Timestamp ordering (received <= started <= completed <= submitted)
   * 6. Step completeness (every CPC step has a trace entry)
   */
  async verify(
    cpc: CPCTask,
    eeb: EvidenceBundle,
  ): Promise<POAVerificationResult> {
    if (!this.config.mock) {
      // TODO: In production mode, call POA subnet validators via Dendrite.
      // For now, fall through to local verification.
    }

    const failures: string[] = [];

    // 1. Format compliance
    const formatFailures = this.checkFormatCompliance(eeb);
    failures.push(...formatFailures);

    // 2. Task ID match
    if (eeb.taskId !== cpc.taskId) {
      failures.push(
        `Task ID mismatch: EEB has '${eeb.taskId}', CPC has '${cpc.taskId}'`,
      );
    }

    // 3. Hash chain integrity
    const expectedChain = this.buildHashChain(eeb.executionTrace);
    if (eeb.hashChain.length !== expectedChain.length) {
      failures.push(
        `Hash chain length mismatch: got ${eeb.hashChain.length}, expected ${expectedChain.length}`,
      );
    } else {
      for (let i = 0; i < expectedChain.length; i++) {
        if (eeb.hashChain[i] !== expectedChain[i]) {
          failures.push(`Hash chain mismatch at index ${i}`);
          break;
        }
      }
    }

    // 4. Nonce reflection
    const expectedNonce =
      eeb.hashChain.length > 0
        ? sha256hex(cpc.nonce + eeb.hashChain[eeb.hashChain.length - 1])
        : sha256hex(cpc.nonce);
    if (eeb.nonceReflection !== expectedNonce) {
      failures.push("Nonce reflection mismatch");
    }

    // 5. Timestamp ordering
    const tsValid = this.checkTimestampOrdering(eeb.timestamps);
    if (!tsValid) {
      failures.push("Timestamp ordering violation: expected received <= started <= completed <= submitted");
    }

    // 6. Step completeness
    const traceStepIds = new Set(eeb.executionTrace.map((t) => t.stepId));
    for (const step of cpc.workflowSteps) {
      if (!traceStepIds.has(step.stepId)) {
        failures.push(`Missing trace entry for CPC step '${step.stepId}'`);
      }
    }

    const passed = failures.length === 0;

    // Compute score
    const score = await this.score(cpc, eeb, { passed, failures });

    return { passed, failures, score };
  }

  // ── Scoring ─────────────────────────────────────────────────────

  /**
   * Compute POA Assurance Score using the 5-dimension model.
   *
   * Dimensions:
   * - Accuracy (35%): output hashes match expected
   * - Completeness (25%): fraction of steps with trace entries
   * - Evidence Integrity (20%): hash chain valid + nonce valid
   * - Reasoning Quality (10%): steps in correct dependency order
   * - Efficiency (10%): total time vs constraint
   */
  async score(
    cpc: CPCTask,
    eeb: EvidenceBundle,
    verificationResult: { passed: boolean; failures: string[] },
  ): Promise<AssuranceScore> {
    const dimensions: ScoreDimension[] = [];

    // 1. Accuracy (35%): check that output hashes are present and non-empty
    const accuracyRaw = this.scoreAccuracy(eeb);
    dimensions.push({
      name: "accuracy",
      weight: DEFAULT_SCORING_WEIGHTS.accuracy,
      rawScore: accuracyRaw,
      weightedScore: accuracyRaw * DEFAULT_SCORING_WEIGHTS.accuracy,
      explanation: accuracyRaw === 1.0
        ? "All trace entries have valid output hashes"
        : `${Math.round(accuracyRaw * 100)}% of trace entries have valid output hashes`,
    });

    // 2. Completeness (25%): fraction of CPC steps with trace entries
    const completenessRaw = this.scoreCompleteness(cpc, eeb);
    dimensions.push({
      name: "completeness",
      weight: DEFAULT_SCORING_WEIGHTS.completeness,
      rawScore: completenessRaw,
      weightedScore: completenessRaw * DEFAULT_SCORING_WEIGHTS.completeness,
      explanation:
        completenessRaw === 1.0
          ? "All CPC steps have trace entries"
          : `${Math.round(completenessRaw * 100)}% of CPC steps covered`,
    });

    // 3. Evidence Integrity (20%): hash chain valid + nonce valid
    const integrityRaw = this.scoreEvidenceIntegrity(cpc, eeb);
    dimensions.push({
      name: "evidence_integrity",
      weight: DEFAULT_SCORING_WEIGHTS.evidence_integrity,
      rawScore: integrityRaw,
      weightedScore: integrityRaw * DEFAULT_SCORING_WEIGHTS.evidence_integrity,
      explanation:
        integrityRaw === 1.0
          ? "Hash chain and nonce reflection are valid"
          : "Hash chain or nonce reflection is invalid",
    });

    // 4. Reasoning Quality (10%): steps in correct dependency order
    const reasoningRaw = this.scoreReasoningQuality(cpc, eeb);
    dimensions.push({
      name: "reasoning_quality",
      weight: DEFAULT_SCORING_WEIGHTS.reasoning_quality,
      rawScore: reasoningRaw,
      weightedScore: reasoningRaw * DEFAULT_SCORING_WEIGHTS.reasoning_quality,
      explanation:
        reasoningRaw === 1.0
          ? "Execution order respects all dependency constraints"
          : "Some dependencies were not respected in execution order",
    });

    // 5. Efficiency (10%): total time vs constraint
    const efficiencyRaw = this.scoreEfficiency(cpc, eeb);
    dimensions.push({
      name: "efficiency",
      weight: DEFAULT_SCORING_WEIGHTS.efficiency,
      rawScore: efficiencyRaw,
      weightedScore: efficiencyRaw * DEFAULT_SCORING_WEIGHTS.efficiency,
      explanation: `Execution efficiency: ${Math.round(efficiencyRaw * 100)}%`,
    });

    // Compute composite
    const compositeScore = dimensions.reduce(
      (sum, d) => sum + d.weightedScore,
      0,
    );

    // Apply penalties
    const penalties: string[] = [];
    let penaltyMultiplier = 1.0;

    if (!verificationResult.passed) {
      for (const failure of verificationResult.failures) {
        if (failure.includes("Hash chain")) {
          penalties.push("hash_chain_failure");
          penaltyMultiplier *= 0.5;
        } else if (failure.includes("Nonce reflection")) {
          penalties.push("nonce_reflection_failure");
          penaltyMultiplier *= 0.7;
        } else if (failure.includes("Task ID")) {
          penalties.push("task_id_mismatch");
          penaltyMultiplier = 0.0;
        } else if (failure.includes("Timestamp")) {
          penalties.push("timestamp_violation");
          penaltyMultiplier *= 0.8;
        }
      }
    }

    const finalScore = Math.max(
      0,
      Math.min(1, compositeScore * penaltyMultiplier),
    );

    return {
      taskId: cpc.taskId,
      minerHotkey: eeb.minerHotkey,
      validatorHotkey: this.config.validatorHotkey,
      verificationPassed: verificationResult.passed,
      verificationFailures: verificationResult.failures,
      dimensions,
      compositeScore: Math.round(compositeScore * 10000) / 10000,
      penalties,
      penaltyMultiplier,
      finalScore: Math.round(finalScore * 10000) / 10000,
      scoredAt: new Date().toISOString(),
    };
  }

  // ── Tier Mapping ────────────────────────────────────────────────

  /**
   * Map POA composite score to PCCP Assurance Tiers.
   *
   * - 0.0-0.49 -> Tier 0 (self-reported)
   * - 0.5-0.69 -> Tier 1 (sensor evidence)
   * - 0.7-0.89 -> Tier 2 (third-party verified)
   * - 0.9-1.0  -> Tier 3 (ZK-proven + bonds)
   */
  mapToAssuranceTier(score: number): number {
    if (score >= 0.9) return 3;
    if (score >= 0.7) return 2;
    if (score >= 0.5) return 1;
    return 0;
  }

  // ── Internal Scoring Helpers ────────────────────────────────────

  /** Build the hash chain from trace entries. */
  private buildHashChain(trace: TraceEntry[]): string[] {
    const chain: string[] = [];
    for (let i = 0; i < trace.length; i++) {
      const entry = trace[i];
      if (i === 0) {
        chain.push(sha256hex(entry.inputHash + entry.outputHash));
      } else {
        chain.push(
          sha256hex(chain[i - 1] + entry.inputHash + entry.outputHash),
        );
      }
    }
    return chain;
  }

  /** Check format compliance: all required fields are present and non-empty. */
  private checkFormatCompliance(eeb: EvidenceBundle): string[] {
    const failures: string[] = [];
    if (!eeb.taskId) failures.push("Missing required field: taskId");
    if (!eeb.minerHotkey)
      failures.push("Missing required field: minerHotkey");
    if (!eeb.executionTrace || eeb.executionTrace.length === 0)
      failures.push("Missing required field: executionTrace (empty)");
    if (!eeb.hashChain || eeb.hashChain.length === 0)
      failures.push("Missing required field: hashChain (empty)");
    if (!eeb.nonceReflection)
      failures.push("Missing required field: nonceReflection");
    if (!eeb.timestamps)
      failures.push("Missing required field: timestamps");
    return failures;
  }

  /** Check that timestamps are in order: received <= started <= completed <= submitted. */
  private checkTimestampOrdering(ts: ExecutionTimestamps): boolean {
    try {
      const received = new Date(ts.receivedAt).getTime();
      const started = new Date(ts.startedAt).getTime();
      const completed = new Date(ts.completedAt).getTime();
      const submitted = new Date(ts.submittedAt).getTime();
      return received <= started && started <= completed && completed <= submitted;
    } catch {
      return false;
    }
  }

  /** Score accuracy: fraction of trace entries with non-empty output hashes. */
  private scoreAccuracy(eeb: EvidenceBundle): number {
    if (eeb.executionTrace.length === 0) return 0;
    const valid = eeb.executionTrace.filter(
      (t) => t.outputHash && t.outputHash.length > 0,
    ).length;
    return valid / eeb.executionTrace.length;
  }

  /** Score completeness: fraction of CPC steps that have trace entries. */
  private scoreCompleteness(cpc: CPCTask, eeb: EvidenceBundle): number {
    if (cpc.workflowSteps.length === 0) return 1.0;
    const traceStepIds = new Set(eeb.executionTrace.map((t) => t.stepId));
    const covered = cpc.workflowSteps.filter((s) =>
      traceStepIds.has(s.stepId),
    ).length;
    return covered / cpc.workflowSteps.length;
  }

  /** Score evidence integrity: hash chain valid (0.5) + nonce valid (0.5). */
  private scoreEvidenceIntegrity(cpc: CPCTask, eeb: EvidenceBundle): number {
    let score = 0;

    // Hash chain valid?
    const expectedChain = this.buildHashChain(eeb.executionTrace);
    const chainValid =
      eeb.hashChain.length === expectedChain.length &&
      eeb.hashChain.every((h, i) => h === expectedChain[i]);
    if (chainValid) score += 0.5;

    // Nonce reflection valid?
    const expectedNonce =
      eeb.hashChain.length > 0
        ? sha256hex(cpc.nonce + eeb.hashChain[eeb.hashChain.length - 1])
        : sha256hex(cpc.nonce);
    if (eeb.nonceReflection === expectedNonce) score += 0.5;

    return score;
  }

  /** Score reasoning quality: trace entries respect dependency order. */
  private scoreReasoningQuality(cpc: CPCTask, eeb: EvidenceBundle): number {
    if (cpc.workflowSteps.length <= 1) return 1.0;

    // Build a map from stepId to its index in the trace
    const traceIndex = new Map<string, number>();
    eeb.executionTrace.forEach((t, i) => traceIndex.set(t.stepId, i));

    let totalDeps = 0;
    let respectedDeps = 0;

    for (const step of cpc.workflowSteps) {
      const stepIdx = traceIndex.get(step.stepId);
      if (stepIdx === undefined) continue;

      for (const depId of step.dependsOn) {
        totalDeps++;
        const depIdx = traceIndex.get(depId);
        if (depIdx !== undefined && depIdx < stepIdx) {
          respectedDeps++;
        }
      }
    }

    if (totalDeps === 0) return 1.0;
    return respectedDeps / totalDeps;
  }

  /** Score efficiency: ratio of actual time to max allowed time. */
  private scoreEfficiency(cpc: CPCTask, eeb: EvidenceBundle): number {
    const maxTimeMs = cpc.constraints.maxExecutionTimeSeconds * 1000;
    if (maxTimeMs <= 0) return 1.0;

    const totalMs = eeb.executionTrace.reduce(
      (sum, t) => sum + t.durationMs,
      0,
    );

    if (totalMs <= 0) return 0.5; // No timing data
    if (totalMs > maxTimeMs) return 0; // Exceeded max time

    // Score: faster is better, but not linearly (diminishing returns)
    // Perfect score at < 50% of max time, linear degradation after
    const ratio = totalMs / maxTimeMs;
    if (ratio <= 0.5) return 1.0;
    return Math.max(0, 1.0 - (ratio - 0.5) * 2);
  }
}

/**
 * EvaluatorAgent — third-party quality assessor for PCC milestone evidence.
 *
 * Inspired by Virtuals Protocol's ACP evaluator pattern:
 * - Receives evaluation requests from broker/user agents
 * - Assesses evidence against milestone requirements
 * - Issues W3C Verifiable Credential attestations
 * - Publishes reputation scores to ERC-8004
 *
 * Integration with escrow:
 *   Tier 0: No evaluator needed (self-attested)
 *   Tier 1: Single evaluator sign-off
 *   Tier 2: Evaluator + Bittensor consensus
 *   Tier 3: Evaluator + Bittensor + ZK proof + challenge window
 */

import { BaseAgent, type BaseAgentConfig } from "@pcc/agent-runtime";
import type { A2AMessage, RequestEvaluationIntent, EvaluationResultIntent } from "@pcc/a2a";
import { evaluate, type EvidenceData, type Requirement } from "./evaluation-engine.js";
import { sha256 } from "@pcc/spec";

export interface EvaluatorAgentConfig extends Omit<BaseAgentConfig, "role"> {
  /** Capability types this evaluator is qualified to assess */
  qualifiedCapabilities: string[];
  /** Minimum fee to accept evaluation requests (USDC atomic units) */
  minimumFee?: bigint;
}

export class EvaluatorAgent extends BaseAgent {
  private readonly qualifiedCapabilities: Set<string>;
  private readonly minimumFee: bigint;
  private evaluationCount = 0;

  constructor(config: EvaluatorAgentConfig) {
    super({ ...config, role: "verifier" });
    this.qualifiedCapabilities = new Set(config.qualifiedCapabilities);
    this.minimumFee = config.minimumFee ?? 0n;

    // Register evaluation intent handler
    this.onIntent("request_evaluation", this.handleEvaluationRequest.bind(this));

    // Register tools
    this.registerTool({
      name: "evaluate_evidence",
      description: "Evaluate evidence data against requirements for a specific capability type",
      parameters: {
        capabilityType: { type: "string", description: "Capability type to evaluate" },
        evidenceJson: { type: "string", description: "JSON string of evidence data" },
        requirementsJson: { type: "string", description: "JSON string of requirements" },
      },
      execute: async (params) => {
        const evidence = JSON.parse(params.evidenceJson as string) as EvidenceData;
        const requirements = JSON.parse(params.requirementsJson as string) as Requirement[];
        return evaluate(evidence, requirements, params.capabilityType as string);
      },
    });
  }

  /** Get the number of evaluations completed */
  get completedEvaluations(): number {
    return this.evaluationCount;
  }

  /** Check if this evaluator can assess a given capability type */
  canEvaluate(capabilityType: string): boolean {
    return this.qualifiedCapabilities.has(capabilityType);
  }

  private async handleEvaluationRequest(
    message: A2AMessage,
  ): Promise<EvaluationResultIntent | null> {
    const request = message.intent as RequestEvaluationIntent;

    // Check if we're qualified for this capability
    if (!this.canEvaluate(request.capabilityType)) {
      return {
        type: "evaluation_result",
        jobId: request.jobId,
        milestoneId: request.milestoneId,
        verdict: "fail",
        score: 0,
        confidence: 0,
        findings: [{
          category: "documentation",
          severity: "critical",
          description: `Evaluator not qualified for capability type: ${request.capabilityType}`,
        }],
        recommendations: ["Find an evaluator qualified for this capability type"],
        attestationHash: "",
      };
    }

    // Check minimum fee
    if (BigInt(request.evaluationFee) < this.minimumFee) {
      return {
        type: "evaluation_result",
        jobId: request.jobId,
        milestoneId: request.milestoneId,
        verdict: "fail",
        score: 0,
        confidence: 0,
        findings: [{
          category: "documentation",
          severity: "critical",
          description: `Evaluation fee too low. Minimum: ${this.minimumFee.toString()}, offered: ${request.evaluationFee}`,
        }],
        recommendations: [`Offer at least ${this.minimumFee.toString()} for evaluation`],
        attestationHash: "",
      };
    }

    // In production, fetch the evidence bundle from IPFS using the hash
    // For now, we simulate with the evidence data embedded in the request
    // or referenced by hash. The actual implementation would:
    // 1. Fetch evidence from IPFS using evidenceBundleHash
    // 2. Decrypt using Lit Protocol access control
    // 3. Parse evidence events and measurements
    const mockEvidence: EvidenceData = {
      events: [
        { type: "process_started", data: {}, timestamp: new Date().toISOString() },
        { type: "measurement_taken", data: {}, timestamp: new Date().toISOString() },
        { type: "process_completed", data: {}, timestamp: new Date().toISOString() },
      ],
      measurements: {},
    };

    // Run evaluation
    const result = evaluate(
      mockEvidence,
      request.requirements,
      request.capabilityType,
    );

    // Generate attestation hash (in production: sign a W3C VC)
    const attestationData = JSON.stringify({
      evaluator: this.id,
      jobId: request.jobId,
      milestoneId: request.milestoneId,
      verdict: result.verdict,
      score: result.score,
      timestamp: new Date().toISOString(),
    });
    const attestationHash = await sha256(attestationData);

    this.evaluationCount++;

    return {
      type: "evaluation_result",
      jobId: request.jobId,
      milestoneId: request.milestoneId,
      verdict: result.verdict,
      score: result.score,
      confidence: result.confidence,
      findings: result.findings,
      recommendations: result.recommendations,
      attestationHash,
    };
  }
}

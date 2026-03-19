/**
 * Reputation Bridge — auto-publishes PCC assurance tier changes and
 * job completion results to the ERC-8004 Reputation Registry.
 *
 * Bridges PCC's internal reputation system (Assurance Tiers + VCs)
 * to the on-chain ERC-8004 standard so PCC agents are discoverable
 * and rated by external platforms (8004scan, Daydreams, ZyFAI, etc.)
 */

import type { ReputationFeedback } from "@pcc/spec";
import { assuranceTierToReputation, PCC_REPUTATION_TAGS } from "@pcc/spec";

/** Job completion data used to generate reputation feedback */
export interface JobCompletionData {
  operatorAgentId: bigint;
  jobId: string;
  capabilityType: string;
  /** Quality score from evaluator (0-100) */
  qualityScore: number;
  /** Time from job start to completion in seconds */
  completionTimeSeconds: number;
  /** Original SLA time in seconds */
  slaTimeSeconds: number;
  /** Evidence bundle CID on IPFS */
  evidenceCid: string;
  /** Evidence bundle hash */
  evidenceHash: `0x${string}`;
  /** Gateway endpoint for this kernel */
  endpoint: string;
}

/**
 * Generate ERC-8004 reputation feedback entries from a completed PCC job.
 *
 * Returns multiple feedback entries — one per metric:
 * - quality: evaluator's quality score
 * - responseTime: how fast vs SLA
 * - evidenceCompleteness: based on evaluator confidence
 */
export function generateJobFeedback(data: JobCompletionData): ReputationFeedback[] {
  const feedbacks: ReputationFeedback[] = [];

  // Quality score (0-100)
  feedbacks.push({
    agentId: data.operatorAgentId,
    value: BigInt(data.qualityScore),
    valueDecimals: 0,
    tag1: PCC_REPUTATION_TAGS.QUALITY,
    tag2: data.capabilityType,
    endpoint: data.endpoint,
    feedbackURI: `ipfs://${data.evidenceCid}`,
    feedbackHash: data.evidenceHash,
  });

  // Response time (milliseconds)
  const responseTimeMs = data.completionTimeSeconds * 1000;
  feedbacks.push({
    agentId: data.operatorAgentId,
    value: BigInt(responseTimeMs),
    valueDecimals: 0,
    tag1: PCC_REPUTATION_TAGS.RESPONSE_TIME,
    tag2: data.capabilityType,
    endpoint: data.endpoint,
  });

  // Completion rate (did they beat SLA?)
  const slaRatio = data.completionTimeSeconds / data.slaTimeSeconds;
  // 100 = met SLA exactly, >100 = beat SLA, <100 = missed SLA
  const completionScore = Math.min(100, Math.round((1 / slaRatio) * 100));
  feedbacks.push({
    agentId: data.operatorAgentId,
    value: BigInt(completionScore),
    valueDecimals: 0,
    tag1: PCC_REPUTATION_TAGS.COMPLETION_RATE,
    tag2: data.capabilityType,
    endpoint: data.endpoint,
  });

  return feedbacks;
}

/**
 * Generate ERC-8004 reputation feedback for an assurance tier change.
 */
export function generateAssuranceTierFeedback(
  agentId: bigint,
  newTier: 0 | 1 | 2 | 3,
  endpoint: string,
): ReputationFeedback {
  const { value, tag1, tag2 } = assuranceTierToReputation(newTier);
  return {
    agentId,
    value: BigInt(value),
    valueDecimals: 0,
    tag1,
    tag2,
    endpoint,
  };
}

/**
 * Generate ERC-8004 reputation feedback for uptime reporting.
 * @param uptimePercent - e.g., 99.77
 */
export function generateUptimeFeedback(
  agentId: bigint,
  uptimePercent: number,
  endpoint: string,
): ReputationFeedback {
  // Store with 2 decimals: 99.77% → value=9977, decimals=2
  return {
    agentId,
    value: BigInt(Math.round(uptimePercent * 100)),
    valueDecimals: 2,
    tag1: PCC_REPUTATION_TAGS.UPTIME,
    endpoint,
  };
}

/**
 * TMP Procurement Modes -- ERC-8195 Task Management Protocol integration.
 *
 * Maps PCC manufacturing milestones to structured procurement tasks.
 * Each mode defines how workers are selected, priced, and verified.
 */

import type { Id, Address, Amount, Timestamp } from "./common.js";

/** TMP procurement modes from ERC-8195 */
export type TMPMode = "bounty" | "claim" | "pitch" | "benchmark" | "auction";

/**
 * TMP mode selector bytes4 values.
 * Computed as bytes4(keccak256("TMP.mode.<name>")).
 */
export const TMP_MODE_SELECTORS: Record<TMPMode, string> = {
  bounty: "0x1a2b3c4d",
  claim: "0x2b3c4d5e",
  pitch: "0x3c4d5e6f",
  benchmark: "0x4d5e6f70",
  auction: "0x5e6f7081",
};

/** Human-readable descriptions per mode */
export const TMP_MODE_DESCRIPTIONS: Record<TMPMode, string> = {
  bounty:
    "Open call -- anyone qualified can submit deliverables before the deadline.",
  claim:
    "Pre-assigned worker claims the task and stakes collateral for accountability.",
  pitch:
    "Workers propose approaches; the best pitch is selected before work begins.",
  benchmark:
    "Automated verification against metric targets using sensor data, ZK proofs, or Bittensor.",
  auction:
    "Price-competitive bidding (english, dutch, or reverse) to find the best deal.",
};

// ── Per-Mode Configurations ──────────────────────────────────────────

export interface BountyConfig {
  mode: "bounty";
  submissionDeadline: Timestamp;
}

export interface ClaimConfig {
  mode: "claim";
  /** Percentage of reward staked by the worker (e.g., 10 = 10%) */
  stakePercent: number;
  deliveryDeadline: Timestamp;
}

export interface PitchConfig {
  mode: "pitch";
  pitchDeadline: Timestamp;
  maxPitches?: number;
}

export interface BenchmarkConfig {
  mode: "benchmark";
  /** Target metric expression, e.g., "dimensional_accuracy >= 0.95" */
  metricTarget: string;
  /** Optional on-chain validator address */
  validatorAddress?: Address;
  /** Which proof pipeline to use for verification */
  proofType:
    | "sensor_evidence"
    | "zk_proof"
    | "merkle_commitment"
    | "bittensor_verification"
    | "oracle_verification";
}

export interface AuctionConfig {
  mode: "auction";
  subtype: "english" | "dutch" | "reverse";
  bidDeadline: Timestamp;
  maxPrice: Amount;
  reservePrice?: Amount;
}

export type ModeConfig =
  | BountyConfig
  | ClaimConfig
  | PitchConfig
  | BenchmarkConfig
  | AuctionConfig;

// ── Milestone-to-TMP Linking ─────────────────────────────────────────

/** Links a PCC escrow milestone to a TMP procurement task */
export interface MilestoneProcurement {
  milestoneId: Id;
  /** TMP on-chain task ID (set after task creation) */
  tmpTaskId?: string;
  /** TMP contract address on the settlement chain */
  tmpContractAddress?: Address;
  mode: TMPMode;
  modeConfig: ModeConfig;
  status: "pending" | "active" | "completed" | "expired";
  createdAt?: Timestamp;
  completedAt?: Timestamp;
}

// ── Mode Selection Heuristic ─────────────────────────────────────────

/** Result from the mode selection heuristic */
export interface ModeSelectionResult {
  recommendedMode: TMPMode;
  /** Confidence in the recommendation (0-1) */
  confidence: number;
  /** Human-readable explanation for the choice */
  reasoning: string;
  /** Second-best option if the primary is not suitable */
  alternativeMode?: TMPMode;
}

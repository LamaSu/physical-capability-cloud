/**
 * TMP Mode Selector -- heuristic that recommends a procurement mode
 * for each manufacturing step based on capability type, assurance tier,
 * and step metadata.
 *
 * Decision tree:
 * 1. Is verification automated (sensor data, ZK proof)? -> BENCHMARK
 * 2. Is the worker pre-assigned?                        -> CLAIM
 * 3. Do workers need to propose approaches?             -> PITCH
 * 4. Is price the primary differentiator?               -> AUCTION
 * 5. Open to anyone qualified?                          -> BOUNTY
 */

import type {
  CapabilityType,
  AssuranceTier,
  ModeSelectionResult,
  TMPMode,
} from "@pcc/spec";

/** Step metadata that informs mode selection */
export interface StepMetadata {
  /** If true, a specific worker/kernel has already been chosen */
  workerPreAssigned?: boolean;
  /** If true, the step requires creative proposals from workers */
  requiresProposal?: boolean;
  /** If true, price competition is the primary differentiator */
  priceCompetitive?: boolean;
  /** If true, verification can be fully automated via sensors/proofs */
  automatedVerification?: boolean;
}

/**
 * Default manufacturing-step-to-mode mappings.
 * Each entry maps a capability type (or keyword) to its recommended TMP mode.
 */
const CAPABILITY_MODE_MAP: Record<string, TMPMode> = {
  // Automated verification -> BENCHMARK
  "cnc-3axis": "benchmark",
  "cnc-5axis": "benchmark",
  "fdm": "benchmark",
  "sla": "benchmark",
  "sls": "benchmark",
  "mjf": "benchmark",
  "lathe": "benchmark",

  // Open submission -> BOUNTY
  "inspection": "bounty",
  "custom": "bounty",

  // Workers propose approaches -> PITCH
  "surface-treatment": "pitch",
  "laser-cut": "pitch",
  "waterjet": "pitch",
  "sheet-metal": "pitch",
  "injection-mold": "pitch",

  // Pre-assigned worker -> CLAIM
  "assembly": "claim",
  "calibration": "claim",

  // Price-competitive -> AUCTION
  "courier-pickup": "auction",
  "courier-delivery": "auction",
  "material-procurement": "auction",
};

/**
 * Higher assurance tiers bias toward BENCHMARK or CLAIM
 * because they require stronger verification guarantees.
 */
function tierBias(tier: AssuranceTier): TMPMode | null {
  if (tier >= 2) return "benchmark";
  return null;
}

/**
 * Select the recommended TMP procurement mode for a manufacturing step.
 *
 * @param capabilityType - The type of capability required (e.g., "cnc-3axis", "fdm")
 * @param assuranceTier - The SLA tier (0-3)
 * @param metadata - Optional step-level hints that override defaults
 * @returns ModeSelectionResult with recommended mode, confidence, and reasoning
 */
export function selectMode(
  capabilityType: CapabilityType,
  assuranceTier: AssuranceTier,
  metadata?: StepMetadata,
): ModeSelectionResult {
  // 1. Explicit metadata overrides
  if (metadata?.automatedVerification) {
    return {
      recommendedMode: "benchmark",
      confidence: 0.95,
      reasoning: `Automated verification available for ${capabilityType}; Benchmark mode ensures objective metric evaluation.`,
      alternativeMode: "claim",
    };
  }

  if (metadata?.workerPreAssigned) {
    return {
      recommendedMode: "claim",
      confidence: 0.9,
      reasoning: `Worker is pre-assigned for ${capabilityType}; Claim mode adds stake-based accountability.`,
      alternativeMode: "benchmark",
    };
  }

  if (metadata?.requiresProposal) {
    return {
      recommendedMode: "pitch",
      confidence: 0.85,
      reasoning: `Step requires creative proposals for ${capabilityType}; Pitch mode lets workers propose approaches.`,
      alternativeMode: "bounty",
    };
  }

  if (metadata?.priceCompetitive) {
    return {
      recommendedMode: "auction",
      confidence: 0.85,
      reasoning: `Price is the primary differentiator for ${capabilityType}; Auction mode finds the best deal.`,
      alternativeMode: "bounty",
    };
  }

  // 2. High-assurance tier bias
  const tierOverride = tierBias(assuranceTier);
  if (tierOverride && assuranceTier >= 3) {
    return {
      recommendedMode: tierOverride,
      confidence: 0.9,
      reasoning: `Tier ${assuranceTier} requires strong verification; Benchmark mode provides automated proof.`,
      alternativeMode: "claim",
    };
  }

  // 3. Capability type lookup
  const mapped = CAPABILITY_MODE_MAP[capabilityType];
  if (mapped) {
    const confidence = tierOverride === mapped ? 0.9 : 0.8;
    return {
      recommendedMode: mapped,
      confidence,
      reasoning: `${capabilityType} is best matched to ${mapped} mode based on manufacturing workflow patterns.`,
      alternativeMode: mapped === "benchmark" ? "claim" :
                       mapped === "claim" ? "benchmark" :
                       mapped === "pitch" ? "bounty" :
                       mapped === "auction" ? "bounty" :
                       "claim",
    };
  }

  // 4. Default: BOUNTY (open call)
  return {
    recommendedMode: "bounty",
    confidence: 0.6,
    reasoning: `No specific mode mapping for ${capabilityType}; defaulting to open Bounty mode.`,
    alternativeMode: "pitch",
  };
}

/**
 * Get all available modes with their descriptions.
 */
export function getAvailableModes(): Array<{
  mode: TMPMode;
  description: string;
  selector: string;
}> {
  // Import the constants at the function level to avoid circular dependency issues
  const modes: TMPMode[] = ["bounty", "claim", "pitch", "benchmark", "auction"];
  const descriptions: Record<TMPMode, string> = {
    bounty: "Open call -- anyone qualified can submit deliverables before the deadline.",
    claim: "Pre-assigned worker claims the task and stakes collateral for accountability.",
    pitch: "Workers propose approaches; the best pitch is selected before work begins.",
    benchmark: "Automated verification against metric targets using sensor data, ZK proofs, or Bittensor.",
    auction: "Price-competitive bidding (english, dutch, or reverse) to find the best deal.",
  };
  const selectors: Record<TMPMode, string> = {
    bounty: "0x1a2b3c4d",
    claim: "0x2b3c4d5e",
    pitch: "0x3c4d5e6f",
    benchmark: "0x4d5e6f70",
    auction: "0x5e6f7081",
  };

  return modes.map((mode) => ({
    mode,
    description: descriptions[mode],
    selector: selectors[mode],
  }));
}

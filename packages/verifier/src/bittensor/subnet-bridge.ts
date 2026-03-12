/**
 * BittensorSubnetBridge — TypeScript bridge to the Bittensor verification subnet.
 *
 * Provides a clean API for submitting evidence for decentralized verification
 * via the Bittensor miner network. Uses MockValidator internally to simulate
 * the subnet during development/demo. In production, this would make real
 * dendrite calls to Bittensor subnet miners.
 *
 * Usage:
 *   const bridge = new BittensorSubnetBridge();
 *   const result = await bridge.submitForVerification(hash, data, tier);
 */

import { MockValidator } from "./mock-validator.js";
import type {
  ValidatorConfig,
  SubnetMetrics,
  MinerInfo,
  VerificationResult,
} from "./types.js";

export class BittensorSubnetBridge {
  private validator: MockValidator;
  private available: boolean = false;

  constructor(config?: Partial<ValidatorConfig>) {
    this.validator = new MockValidator(config);
    // Auto-initialize with default miner pool
    this.validator.initializeMiners(8);
    this.available = true;
  }

  /**
   * Submit evidence for decentralized verification via the Bittensor subnet.
   *
   * @param bundleHash - SHA-256 hash of the evidence bundle
   * @param bundleData - JSON-serialized EvidenceBundle
   * @param requiredTier - Assurance tier (0-3)
   * @returns Aggregated verification result from subnet miners
   */
  async submitForVerification(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
  ): Promise<VerificationResult> {
    if (!this.available) {
      throw new Error("Bittensor subnet bridge is not available");
    }

    return this.validator.verify(bundleHash, bundleData, requiredTier);
  }

  /** Get current subnet metrics */
  getMetrics(): SubnetMetrics {
    return this.validator.getMetrics();
  }

  /** Get miner leaderboard, sorted by incentive */
  getMinerLeaderboard(): MinerInfo[] {
    return this.validator.getMinerLeaderboard();
  }

  /** Check if the subnet bridge is available and has active miners */
  isAvailable(): boolean {
    return this.available && this.validator.isReady();
  }

  /** Disable the bridge (simulates subnet going offline) */
  disable(): void {
    this.available = false;
  }

  /** Enable the bridge (simulates subnet coming online) */
  enable(): void {
    this.available = true;
  }

  /** Get the underlying validator (for testing/debugging) */
  getValidator(): MockValidator {
    return this.validator;
  }
}

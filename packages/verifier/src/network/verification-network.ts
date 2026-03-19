/**
 * VerificationNetwork — main coordinator for the private verification network.
 *
 * Manages a pool of VerifierNodes, broadcasts verification requests,
 * collects responses, and runs consensus via ConsensusEngine. This is the
 * production replacement for BittensorSubnetBridge.
 *
 * Currently in-memory (all nodes are local objects). In production, nodes
 * would be remote HTTP endpoints and the coordinator would use fetch()
 * to broadcast requests.
 */

import type {
  VerificationRequest,
  ConsensusResult,
  NetworkConfig,
  NetworkStatus,
} from "./types.js";
import { DEFAULT_NETWORK_CONFIG } from "./types.js";
import { VerifierNode } from "./verifier-node.js";
import { ConsensusEngine } from "./consensus-engine.js";
import { randomBytes } from "node:crypto";

export class VerificationNetwork {
  private nodes: Map<string, VerifierNode> = new Map();
  private config: NetworkConfig;
  private consensus: ConsensusEngine;
  private totalVerifications: number = 0;
  private cumulativeConsensusScore: number = 0;

  constructor(config?: Partial<NetworkConfig>) {
    this.config = { ...DEFAULT_NETWORK_CONFIG, ...config };
    this.consensus = new ConsensusEngine(this.config);
  }

  /** Register a node in the network */
  addNode(node: VerifierNode): void {
    this.nodes.set(node.id, node);
  }

  /** Remove a node from the network */
  removeNode(nodeId: string): boolean {
    return this.nodes.delete(nodeId);
  }

  /** Get a registered node by ID */
  getNode(nodeId: string): VerifierNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Submit an evidence bundle for verification across the network.
   *
   * Flow:
   *   1. Check quorum (enough online nodes)
   *   2. Build a VerificationRequest
   *   3. Broadcast to all online nodes
   *   4. Collect responses (with timeout)
   *   5. Penalize non-responders
   *   6. Run consensus on collected responses
   *   7. Return ConsensusResult
   */
  async submitForVerification(request: VerificationRequest): Promise<ConsensusResult> {
    // Collect online nodes
    const onlineNodes = [...this.nodes.values()].filter(
      (n) => n.getStatus() === "online",
    );

    if (onlineNodes.length < this.config.minNodes) {
      throw new Error(
        `Insufficient nodes for quorum: ${onlineNodes.length} online, ${this.config.minNodes} required`,
      );
    }

    // Broadcast to all online nodes and collect responses
    const responsePromises = onlineNodes.map(async (node) => {
      try {
        return await node.verify(request);
      } catch {
        // Node failed to verify — treat as non-response
        return null;
      }
    });

    const settledResponses = await Promise.all(responsePromises);

    // Separate successes from failures
    const validResponses = settledResponses.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );

    const respondedNodeIds = new Set(validResponses.map((r) => r.nodeId));
    const nonResponders = onlineNodes
      .filter((n) => !respondedNodeIds.has(n.id))
      .map((n) => n.id);

    // Penalize non-responders
    if (nonResponders.length > 0) {
      this.consensus.penalizeNonResponders(nonResponders);
    }

    // Check that we still have quorum after filtering failures
    if (validResponses.length < this.config.minNodes) {
      throw new Error(
        `Insufficient valid responses for quorum: ${validResponses.length} responses, ${this.config.minNodes} required`,
      );
    }

    // Build stake map for consensus
    const nodeStakes = new Map<string, number>();
    for (const node of onlineNodes) {
      nodeStakes.set(node.id, node.getStake());
    }

    // Run consensus
    const result = await this.consensus.runConsensus(validResponses, nodeStakes);

    // Sync reputation back to nodes
    const reputations = this.consensus.getNodeReputations();
    for (const [nodeId, rep] of reputations) {
      const node = this.nodes.get(nodeId);
      if (node) {
        const currentRep = node.getReputation();
        const diff = rep - currentRep;
        if (Math.abs(diff) > 0.001) {
          // Reset to consensus engine's value by computing delta
          node.updateReputation(diff);
        }
      }
    }

    // Update network stats
    this.totalVerifications++;
    this.cumulativeConsensusScore += result.consensusScore;

    return result;
  }

  /** Get a summary of the network's current status */
  getNetworkStatus(): NetworkStatus {
    const allNodes = [...this.nodes.values()];
    const activeNodes = allNodes.filter((n) => n.getStatus() === "online").length;

    return {
      nodes: allNodes.length,
      activeNodes,
      totalVerifications: this.totalVerifications,
      averageConsensusScore:
        this.totalVerifications > 0
          ? Math.round((this.cumulativeConsensusScore / this.totalVerifications) * 1000) / 1000
          : 0,
    };
  }

  /** Get the underlying consensus engine (for advanced queries) */
  getConsensusEngine(): ConsensusEngine {
    return this.consensus;
  }

  /** Get all registered node IDs */
  getNodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  /** Get count of registered nodes */
  getNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Helper: create a VerificationRequest with auto-generated requestId
   * and timestamp. Convenience for callers.
   */
  static createRequest(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    requesterAddress: string = "0x0000000000000000000000000000000000000000",
  ): VerificationRequest {
    return {
      requestId: `vreq_${randomBytes(12).toString("hex")}`,
      bundleHash,
      bundleData,
      requiredTier,
      timestamp: new Date().toISOString(),
      requesterAddress,
    };
  }
}

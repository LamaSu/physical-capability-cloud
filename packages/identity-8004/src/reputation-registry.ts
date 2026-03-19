/**
 * ERC-8004 Reputation Registry Client — submit and query feedback for PCC agents.
 */

import type { PublicClient, WalletClient } from "viem";
import type { ReputationFeedback, ReputationSummary } from "@pcc/spec";
import { reputationRegistryAbi } from "./abis.js";
import { getRegistryAddresses } from "./constants.js";

export interface ReputationRegistryConfig {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  registryAddress?: `0x${string}`;
}

export class ReputationRegistryClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly address: `0x${string}`;

  constructor(config: ReputationRegistryConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;

    if (config.registryAddress) {
      this.address = config.registryAddress;
    } else {
      const chainId = config.publicClient.chain?.id;
      if (!chainId) throw new Error("Chain ID required");
      this.address = getRegistryAddresses(chainId).reputationRegistry;
    }
  }

  /** Submit feedback for an agent. Caller must NOT be the agent owner. */
  async giveFeedback(feedback: ReputationFeedback): Promise<void> {
    if (!this.walletClient) throw new Error("WalletClient required for write operations");

    const hash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account!,
      address: this.address,
      abi: reputationRegistryAbi,
      functionName: "giveFeedback",
      args: [
        feedback.agentId,
        feedback.value,
        feedback.valueDecimals,
        feedback.tag1 ?? "",
        feedback.tag2 ?? "",
        feedback.endpoint ?? "",
        feedback.feedbackURI ?? "",
        feedback.feedbackHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Revoke previously submitted feedback. */
  async revokeFeedback(agentId: bigint, feedbackIndex: bigint): Promise<void> {
    if (!this.walletClient) throw new Error("WalletClient required for write operations");

    const hash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account!,
      address: this.address,
      abi: reputationRegistryAbi,
      functionName: "revokeFeedback",
      args: [agentId, feedbackIndex],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /**
   * Get aggregated reputation summary for an agent.
   * @param clientAddresses - REQUIRED: addresses of feedback submitters to include
   * @param tag1 - Optional filter by tag1
   * @param tag2 - Optional filter by tag2
   */
  async getSummary(
    agentId: bigint,
    clientAddresses: `0x${string}`[],
    tag1?: string,
    tag2?: string,
  ): Promise<ReputationSummary> {
    const result = await this.publicClient.readContract({
      address: this.address,
      abi: reputationRegistryAbi,
      functionName: "getSummary",
      args: [agentId, clientAddresses, tag1 ?? "", tag2 ?? ""],
    }) as [bigint, bigint, number];

    return {
      count: result[0],
      summaryValue: result[1],
      summaryValueDecimals: result[2],
    };
  }

  /** Get all client addresses that have submitted feedback for an agent. */
  async getClients(agentId: bigint): Promise<`0x${string}`[]> {
    return await this.publicClient.readContract({
      address: this.address,
      abi: reputationRegistryAbi,
      functionName: "getClients",
      args: [agentId],
    }) as `0x${string}`[];
  }
}

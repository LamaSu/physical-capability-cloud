/**
 * ERC-8004 Identity Registry Client — register PCC kernels as on-chain agents.
 */

import type { PublicClient, WalletClient } from "viem";
import { parseEventLogs } from "viem";
import type { MetadataEntry, AgentRegistrationFile } from "@pcc/spec";
import { identityRegistryAbi } from "./abis.js";
import { getRegistryAddresses } from "./constants.js";

export interface IdentityRegistryConfig {
  /** viem public client for reads */
  publicClient: PublicClient;
  /** viem wallet client for writes (optional — read-only if omitted) */
  walletClient?: WalletClient;
  /** Override registry address (otherwise looked up by chain ID) */
  registryAddress?: `0x${string}`;
}

export class IdentityRegistryClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly address: `0x${string}`;

  constructor(config: IdentityRegistryConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;

    if (config.registryAddress) {
      this.address = config.registryAddress;
    } else {
      const chainId = config.publicClient.chain?.id;
      if (!chainId) throw new Error("Chain ID required — set chain on publicClient or provide registryAddress");
      this.address = getRegistryAddresses(chainId).identityRegistry;
    }
  }

  /**
   * Register a new agent with a URI and optional metadata.
   * Returns the minted agentId (ERC-721 tokenId).
   */
  async register(agentURI: string, metadata?: MetadataEntry[]): Promise<bigint> {
    if (!this.walletClient) throw new Error("WalletClient required for write operations");

    const args = metadata && metadata.length > 0
      ? [agentURI, metadata.map(m => ({ metadataKey: m.metadataKey, metadataValue: m.metadataValue }))]
      : [agentURI];

    const hash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account!,
      address: this.address,
      abi: identityRegistryAbi,
      functionName: "register",
      args: args as any,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    // Parse Registered event to extract agentId
    const events = parseEventLogs({
      abi: identityRegistryAbi,
      eventName: "Registered",
      logs: receipt.logs,
    });

    if (events.length > 0) {
      return (events[0] as any).args.agentId as bigint;
    }

    throw new Error("Registration succeeded but Registered event not found in receipt");
  }

  /** Update the agent URI (registration file location). */
  async setAgentURI(agentId: bigint, newURI: string): Promise<void> {
    if (!this.walletClient) throw new Error("WalletClient required for write operations");
    const hash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account!,
      address: this.address,
      abi: identityRegistryAbi,
      functionName: "setAgentURI",
      args: [agentId, newURI],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Set a metadata key-value pair on an agent. */
  async setMetadata(agentId: bigint, key: string, value: Uint8Array): Promise<void> {
    if (!this.walletClient) throw new Error("WalletClient required for write operations");
    const hash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account!,
      address: this.address,
      abi: identityRegistryAbi,
      functionName: "setMetadata",
      args: [agentId, key, `0x${Buffer.from(value).toString("hex")}`],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Get metadata value for a key. */
  async getMetadata(agentId: bigint, key: string): Promise<`0x${string}`> {
    return await this.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: "getMetadata",
      args: [agentId, key],
    }) as `0x${string}`;
  }

  /** Get the wallet address associated with an agent. */
  async getAgentWallet(agentId: bigint): Promise<`0x${string}`> {
    return await this.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    }) as `0x${string}`;
  }

  /** Get the owner of an agent (ERC-721 ownerOf). */
  async ownerOf(agentId: bigint): Promise<`0x${string}`> {
    return await this.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    }) as `0x${string}`;
  }

  /** Get the agent URI (ERC-721 tokenURI). */
  async getAgentURI(agentId: bigint): Promise<string> {
    return await this.publicClient.readContract({
      address: this.address,
      abi: identityRegistryAbi,
      functionName: "tokenURI",
      args: [agentId],
    }) as string;
  }
}

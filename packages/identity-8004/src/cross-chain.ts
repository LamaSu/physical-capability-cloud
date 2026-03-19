/**
 * Cross-Chain ERC-8004 Registration — register PCC agents on multiple chains.
 *
 * ERC-8004 uses per-chain singletons. A PCC kernel can register on Base,
 * Ethereum, and other chains to maximize discoverability. The Agent
 * Registration File's `registrations[]` array holds all cross-chain IDs.
 *
 * This module manages the multi-chain registration lifecycle.
 */

import type {
  AgentRegistrationFile,
  AgentRegistration,
  AgentRegistryId,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChainRegistration {
  chainId: number;
  chainName: string;
  registryAddress: `0x${string}`;
  agentId?: bigint;
  registered: boolean;
  txHash?: `0x${string}`;
  registeredAt?: string;
}

export interface CrossChainRegistrationPlan {
  kernelId: string;
  targetChains: ChainRegistration[];
  agentURI: string;
  status: "pending" | "in_progress" | "completed" | "partial";
}

// ---------------------------------------------------------------------------
// Supported chains for ERC-8004 registration
// ---------------------------------------------------------------------------

export const SUPPORTED_CHAINS: Array<{
  chainId: number;
  chainName: string;
  registryAddress: `0x${string}`;
  rpcUrl: string;
}> = [
  {
    chainId: 84532,
    chainName: "Base Sepolia",
    registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    rpcUrl: "https://sepolia.base.org",
  },
  {
    chainId: 11155111,
    chainName: "Ethereum Sepolia",
    registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    rpcUrl: "https://rpc.sepolia.org",
  },
  // Mainnet addresses (TODO: add when canonical singletons are deployed)
  // { chainId: 8453, chainName: "Base", registryAddress: "0x...", rpcUrl: "https://mainnet.base.org" },
  // { chainId: 1, chainName: "Ethereum", registryAddress: "0x...", rpcUrl: "https://eth.llamarpc.com" },
];

// ---------------------------------------------------------------------------
// Cross-Chain Registration Manager
// ---------------------------------------------------------------------------

export class CrossChainRegistrationManager {
  private registrations = new Map<string, CrossChainRegistrationPlan>();

  /**
   * Create a registration plan for a kernel across multiple chains.
   */
  createPlan(
    kernelId: string,
    agentURI: string,
    targetChainIds?: number[],
  ): CrossChainRegistrationPlan {
    const targets = targetChainIds
      ? SUPPORTED_CHAINS.filter(c => targetChainIds.includes(c.chainId))
      : SUPPORTED_CHAINS;

    const plan: CrossChainRegistrationPlan = {
      kernelId,
      targetChains: targets.map(c => ({
        chainId: c.chainId,
        chainName: c.chainName,
        registryAddress: c.registryAddress,
        registered: false,
      })),
      agentURI,
      status: "pending",
    };

    this.registrations.set(kernelId, plan);
    return plan;
  }

  /**
   * Record a successful registration on a specific chain.
   */
  recordRegistration(
    kernelId: string,
    chainId: number,
    agentId: bigint,
    txHash: `0x${string}`,
  ): void {
    const plan = this.registrations.get(kernelId);
    if (!plan) throw new Error(`No registration plan for kernel ${kernelId}`);

    const chain = plan.targetChains.find(c => c.chainId === chainId);
    if (!chain) throw new Error(`Chain ${chainId} not in plan for kernel ${kernelId}`);

    chain.agentId = agentId;
    chain.registered = true;
    chain.txHash = txHash;
    chain.registeredAt = new Date().toISOString();

    // Update plan status
    const allRegistered = plan.targetChains.every(c => c.registered);
    const anyRegistered = plan.targetChains.some(c => c.registered);
    plan.status = allRegistered ? "completed" : anyRegistered ? "partial" : "in_progress";
  }

  /**
   * Get the registrations array for an Agent Registration File.
   * Only includes chains where registration is complete.
   */
  getRegistrationsForFile(kernelId: string): AgentRegistration[] {
    const plan = this.registrations.get(kernelId);
    if (!plan) return [];

    return plan.targetChains
      .filter(c => c.registered && c.agentId !== undefined)
      .map(c => ({
        agentId: Number(c.agentId!),
        agentRegistry: `eip155:${c.chainId}:${c.registryAddress}` as AgentRegistryId,
      }));
  }

  /**
   * Update an Agent Registration File with all cross-chain registrations.
   */
  updateRegistrationFile(
    kernelId: string,
    existingFile: AgentRegistrationFile,
  ): AgentRegistrationFile {
    const registrations = this.getRegistrationsForFile(kernelId);
    return {
      ...existingFile,
      registrations,
    };
  }

  /** Get the registration plan for a kernel. */
  getPlan(kernelId: string): CrossChainRegistrationPlan | undefined {
    return this.registrations.get(kernelId);
  }

  /** Get all plans. */
  getAllPlans(): CrossChainRegistrationPlan[] {
    return [...this.registrations.values()];
  }
}

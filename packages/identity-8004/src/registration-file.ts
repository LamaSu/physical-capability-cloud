/**
 * Agent Registration File generator — converts PCC kernel configs into
 * ERC-8004 Agent Registration Files for on-chain discovery.
 *
 * Served at: /.well-known/agent-registration.json
 */

import type {
  AgentRegistrationFile,
  AgentService,
  AgentRegistryId,
  TrustModel,
} from "@pcc/spec";

/** Minimal kernel info needed for registration file generation */
export interface KernelRegistrationInput {
  name: string;
  description: string;
  avatarURL?: string;
  /** Base URL of the PCC gateway for this kernel */
  gatewayURL: string;
  /** On-chain agent ID from ERC-8004 registration */
  agentId?: number;
  /** Chain ID where the agent is registered */
  chainId?: number;
  /** Identity registry address on that chain */
  registryAddress?: `0x${string}`;
  /** Whether this kernel supports x402 payments */
  x402Support?: boolean;
  /** Assurance tier determines trust model */
  assuranceTier?: 0 | 1 | 2 | 3;
  /** Whether MCP endpoint is available */
  hasMcp?: boolean;
  /** Additional capabilities to advertise */
  capabilities?: string[];
}

/**
 * Generate an ERC-8004 Agent Registration File from a PCC kernel config.
 */
export function generateRegistrationFile(
  kernel: KernelRegistrationInput,
): AgentRegistrationFile {
  const services: AgentService[] = [];

  // A2A endpoint (PCC's primary agent communication protocol)
  services.push({
    name: "A2A",
    endpoint: `${kernel.gatewayURL}/a2a`,
    version: "1.0",
  });

  // Web API endpoint
  services.push({
    name: "web",
    endpoint: `${kernel.gatewayURL}/api`,
  });

  // MCP endpoint (if available)
  if (kernel.hasMcp !== false) {
    services.push({
      name: "MCP",
      endpoint: `${kernel.gatewayURL}/mcp`,
      version: "2024-11-05",
    });
  }

  // DID service
  services.push({
    name: "DID",
    endpoint: `${kernel.gatewayURL}/api/identity`,
  });

  // OASF with capability skills
  if (kernel.capabilities?.length) {
    services.push({
      name: "OASF",
      endpoint: `${kernel.gatewayURL}/api/capabilities`,
      skills: kernel.capabilities,
      domains: ["manufacturing", "physical-infrastructure"],
    });
  }

  // Build registrations array
  const registrations: AgentRegistrationFile["registrations"] = [];
  if (kernel.agentId !== undefined && kernel.chainId && kernel.registryAddress) {
    registrations.push({
      agentId: kernel.agentId,
      agentRegistry: `eip155:${kernel.chainId}:${kernel.registryAddress}` as AgentRegistryId,
    });
  }

  // Determine trust models based on assurance tier
  const supportedTrust: TrustModel[] = ["reputation"];
  const tier = kernel.assuranceTier ?? 0;
  if (tier >= 2) supportedTrust.push("crypto-economic");
  if (tier >= 3) supportedTrust.push("tee-attestation");

  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: kernel.name,
    description: kernel.description,
    image: kernel.avatarURL,
    services,
    x402Support: kernel.x402Support ?? true,
    active: true,
    registrations,
    supportedTrust,
  };
}

/**
 * Generate the domain verification file for `.well-known/agent-registration.json`.
 * This proves domain control per the ERC-8004 spec.
 */
export function generateDomainVerification(
  agentId: number,
  chainId: number,
  registryAddress: `0x${string}`,
): { registrations: AgentRegistrationFile["registrations"] } {
  return {
    registrations: [
      {
        agentId,
        agentRegistry: `eip155:${chainId}:${registryAddress}` as AgentRegistryId,
      },
    ],
  };
}

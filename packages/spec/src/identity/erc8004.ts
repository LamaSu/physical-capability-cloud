/**
 * ERC-8004: Trustless Agents — type definitions for PCC integration.
 *
 * Three registries: Identity (ERC-721), Reputation, Validation.
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
 *
 * These types are browser-safe (no runtime code).
 */

// ---------------------------------------------------------------------------
// Global Agent Identifier
// ---------------------------------------------------------------------------

/**
 * ERC-8004 global agent identifier.
 * Format: `eip155:{chainId}:{identityRegistryAddress}`
 */
export type AgentRegistryId = `eip155:${number}:0x${string}`;

// ---------------------------------------------------------------------------
// Identity Registry Types
// ---------------------------------------------------------------------------

/** Metadata key-value entry for agent registration */
export interface MetadataEntry {
  metadataKey: string;
  metadataValue: Uint8Array;
}

/** Service type in an Agent Registration File */
export type AgentServiceType =
  | "web"
  | "A2A"
  | "MCP"
  | "OASF"
  | "ENS"
  | "DID"
  | "email";

/** A service endpoint in the Agent Registration File */
export interface AgentService {
  name: AgentServiceType;
  endpoint: string;
  version?: string;
  /** OASF-only: agent skill identifiers */
  skills?: string[];
  /** OASF-only: agent domain identifiers */
  domains?: string[];
}

/** Trust model supported by the agent */
export type TrustModel =
  | "reputation"
  | "crypto-economic"
  | "tee-attestation"
  | "zkml";

/** Cross-chain registration pointer */
export interface AgentRegistration {
  agentId: number;
  agentRegistry: AgentRegistryId;
}

/**
 * ERC-8004 Agent Registration File — served at agentURI or
 * `.well-known/agent-registration.json`.
 */
export interface AgentRegistrationFile {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  image?: string;
  services: AgentService[];
  x402Support: boolean;
  active: boolean;
  registrations: AgentRegistration[];
  supportedTrust: TrustModel[];
}

// ---------------------------------------------------------------------------
// Reputation Registry Types
// ---------------------------------------------------------------------------

/** Feedback submitted to the Reputation Registry */
export interface ReputationFeedback {
  agentId: bigint;
  /** Signed int128 value */
  value: bigint;
  /** Decimal places (0-18) */
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: `0x${string}`;
}

/** Summary returned by `getSummary` */
export interface ReputationSummary {
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

/** Single feedback record */
export interface FeedbackRecord {
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  isRevoked: boolean;
}

/**
 * Standard reputation tags for PCC capabilities.
 * Maps Assurance Tiers to ERC-8004 feedback semantics.
 */
export const PCC_REPUTATION_TAGS = {
  /** Assurance tier level (tag2: tier-0 through tier-3) */
  ASSURANCE: "assurance",
  /** Job quality score (0-100) */
  QUALITY: "quality",
  /** Machine uptime percentage (2 decimals: 9977 = 99.77%) */
  UPTIME: "uptime",
  /** Response time in milliseconds */
  RESPONSE_TIME: "responseTime",
  /** Evidence completeness score (0-100) */
  EVIDENCE_COMPLETENESS: "evidenceCompleteness",
  /** Job completion rate (0-100) */
  COMPLETION_RATE: "completionRate",
} as const;

// ---------------------------------------------------------------------------
// Validation Registry Types
// ---------------------------------------------------------------------------

/** Validation request record */
export interface ValidationRequest {
  validatorAddress: `0x${string}`;
  agentId: bigint;
  requestURI: string;
  requestHash: `0x${string}`;
}

/** Validation response record */
export interface ValidationResponse {
  requestHash: `0x${string}`;
  /** 0-100 (0 = fail, 100 = pass) */
  response: number;
  responseURI?: string;
  responseHash?: `0x${string}`;
  tag?: string;
}

/** Validation status returned by `getValidationStatus` */
export interface ValidationStatus {
  validatorAddress: `0x${string}`;
  agentId: bigint;
  response: number;
  responseHash: `0x${string}`;
  tag: string;
  lastUpdate: bigint;
}

/** Validation summary returned by `getSummary` */
export interface ValidationSummary {
  count: bigint;
  averageResponse: number;
}

// ---------------------------------------------------------------------------
// Off-chain Feedback File (IPFS)
// ---------------------------------------------------------------------------

/** Off-chain feedback file stored on IPFS, referenced by feedbackURI */
export interface FeedbackFile {
  agentRegistry: AgentRegistryId;
  agentId: number;
  clientAddress: `eip155:${number}:0x${string}`;
  createdAt: string; // ISO 8601
  value: number;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  /** MCP-specific context */
  mcp?: { tool?: string; prompt?: string; resource?: string };
  /** A2A-specific context */
  a2a?: { skills?: string[]; contextId?: string; taskId?: string };
  /** Proof of payment (x402 receipt) */
  proofOfPayment?: {
    fromAddress: string;
    toAddress: string;
    chainId: string;
    txHash: string;
  };
}

// ---------------------------------------------------------------------------
// PCC-specific helpers
// ---------------------------------------------------------------------------

/**
 * Maps PCC Assurance Tier to ERC-8004 reputation value.
 * Tier 0 → 0-25, Tier 1 → 26-50, Tier 2 → 51-75, Tier 3 → 76-100.
 */
export function assuranceTierToReputation(tier: 0 | 1 | 2 | 3): {
  value: number;
  tag1: string;
  tag2: string;
} {
  return {
    value: tier * 25,
    tag1: PCC_REPUTATION_TAGS.ASSURANCE,
    tag2: `tier-${tier}`,
  };
}

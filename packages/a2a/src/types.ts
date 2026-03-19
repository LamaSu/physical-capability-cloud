/**
 * Agent-to-Agent Protocol Types
 *
 * Every agent on the network has an AgentCard (its public identity + capabilities).
 * Agents communicate through typed Messages in Conversations.
 * Messages carry Intents — structured requests/responses that agents understand.
 */

import type { Address, Id } from "@pcc/spec";

// ── Agent Identity ──────────────────────────────────────────────

/** The roles an agent can play in the PCC network */
export type AgentRole =
  | "user"          // End-user agent: holds wallet, submits jobs, negotiates
  | "scheduler"     // Control plane: routes, quotes, plans workflows
  | "broker"        // Discovery: finds hubs, matches needs to capabilities
  | "kernel"        // Shop operator: accepts jobs, produces evidence
  | "verifier"      // Verification: attests evidence bundles
  | "courier"       // Logistics: handles pickup/delivery
  | "arbiter";      // Dispute resolution

/** An agent's public identity card — what it advertises to the network */
export interface AgentCard {
  id: Id;
  /** ERC-8004 agent ID (on-chain) — 0n if not registered yet */
  erc8004Id?: bigint;
  /** Human-readable name */
  name: string;
  /** Role */
  role: AgentRole;
  /** Wallet address this agent controls */
  walletAddress: Address;
  /** What this agent can do (role-specific) */
  capabilities: string[];
  /** Endpoint to reach this agent */
  endpoint: string;
  /** Agent description for other agents */
  description: string;
  /** Supported intents this agent can handle */
  supportedIntents: string[];
  /** Public key for message verification */
  publicKey: string;
  /** Reputation score (from ERC-8004 reputation registry) */
  reputation?: number;
}

// ── Messages ────────────────────────────────────────────────────

/** Message envelope — all agent communication goes through this */
export interface A2AMessage {
  id: Id;
  conversationId: Id;
  /** Who sent this */
  from: Id;
  /** Who this is for */
  to: Id;
  /** The structured intent */
  intent: Intent;
  /** When it was sent */
  timestamp: string;
  /** Reference to a previous message this is replying to */
  inReplyTo?: Id;
  /** Signature from sender's wallet */
  signature?: string;
}

/** A conversation between agents */
export interface Conversation {
  id: Id;
  /** Participants */
  participants: Id[];
  /** Messages in order */
  messages: A2AMessage[];
  /** Current state */
  status: "active" | "completed" | "failed" | "expired";
  /** What this conversation is about */
  topic: string;
  createdAt: string;
  updatedAt: string;
}

// ── Intents ─────────────────────────────────────────────────────
// These are the structured operations agents can request/respond to.

export type Intent =
  // Discovery
  | DiscoverCapabilitiesIntent
  | CapabilitiesResponseIntent
  | DiscoverHubsIntent
  | HubsResponseIntent
  // Quoting & Negotiation
  | RequestQuoteIntent
  | QuoteResponseIntent
  | NegotiateIntent
  | NegotiationResponseIntent
  // Contract Builder
  | GetBuildOptionsIntent
  | BuildOptionsResponseIntent
  | BuildContractIntent
  | ContractBuiltResponseIntent
  // Job Lifecycle
  | SubmitWorkflowIntent
  | WorkflowAcceptedIntent
  | JobStatusQueryIntent
  | JobStatusResponseIntent
  | JobCompletedIntent
  // Payment
  | PaymentRequestIntent
  | PaymentConfirmationIntent
  | EscrowFundedIntent
  // Logistics
  | RequestCourierIntent
  | CourierAssignedIntent
  | CourierStatusIntent
  // Verification
  | RequestVerificationIntent
  | VerificationResultIntent
  // Evaluation (third-party quality assessment — Virtuals ACP pattern)
  | RequestEvaluationIntent
  | EvaluationResultIntent
  // Funding
  | RequestFundingIntent
  | DelegateBudgetIntent
  | ClaimRewardsIntent
  // General
  | TextMessageIntent
  | ErrorIntent;

// ── Discovery Intents ───────────────────────────────────────────

export interface DiscoverCapabilitiesIntent {
  type: "discover_capabilities";
  /** What kind of capability the user needs */
  capabilityType?: string;
  material?: string;
  /** Max acceptable price */
  maxPrice?: string;
  /** Desired assurance tier */
  assuranceTier?: number;
  /** Location preference (lat/lng) */
  nearLocation?: { lat: number; lng: number };
  /** Free-text description of what they need */
  query?: string;
}

export interface CapabilitiesResponseIntent {
  type: "capabilities_response";
  matches: Array<{
    kernelId: string;
    kernelName: string;
    capabilityId: string;
    capabilityName: string;
    type: string;
    materials: string[];
    price: string;
    currency: string;
    assuranceTiers: number[];
    queueDepth: number;
    estimatedAvailability: string;
    reputation: number;
    location: { lat: number; lng: number };
    distance?: number;
  }>;
  totalMatches: number;
}

export interface DiscoverHubsIntent {
  type: "discover_hubs";
  /** What the user needs done — natural language */
  description: string;
  /** Specific requirements */
  requirements?: Record<string, unknown>;
  nearLocation?: { lat: number; lng: number };
}

export interface HubsResponseIntent {
  type: "hubs_response";
  hubs: Array<{
    kernelId: string;
    name: string;
    address: string;
    location: { lat: number; lng: number };
    capabilities: string[];
    reputation: number;
    availableSlots: number;
  }>;
}

// ── Quoting & Negotiation Intents ───────────────────────────────

export interface RequestQuoteIntent {
  type: "request_quote";
  /** What capability is needed */
  capabilityType: string;
  /** Parameters for the job */
  params: Record<string, unknown>;
  /** File hash if applicable */
  fileHash?: string;
  /** Desired assurance tier */
  assuranceTier: number;
  /** Deadline */
  deadline?: string;
  /** Quantity */
  quantity?: number;
}

export interface QuoteResponseIntent {
  type: "quote_response";
  quoteId: string;
  /** Quoted price per unit */
  pricePerUnit: string;
  /** Total price */
  totalPrice: string;
  currency: string;
  /** When the job can start */
  estimatedStart: string;
  /** When the job will finish */
  estimatedCompletion: string;
  /** Assurance tier offered */
  assuranceTier: number;
  /** Bond required from operator */
  operatorBond: string;
  /** Valid until */
  validUntil: string;
  /** The kernel offering this quote */
  kernelId: string;
  kernelName: string;
  /** Available options/upgrades */
  options?: Array<{
    name: string;
    description: string;
    additionalCost: string;
  }>;
}

export interface NegotiateIntent {
  type: "negotiate";
  quoteId: string;
  /** What the user wants changed */
  counterOffer?: {
    maxPrice?: string;
    preferredStart?: string;
    assuranceTier?: number;
  };
  /** Free-text negotiation */
  message?: string;
}

export interface NegotiationResponseIntent {
  type: "negotiation_response";
  quoteId: string;
  accepted: boolean;
  /** Updated quote if counter-offered */
  revisedQuote?: QuoteResponseIntent;
  message?: string;
}

// ── Job Lifecycle Intents ───────────────────────────────────────

export interface SubmitWorkflowIntent {
  type: "submit_workflow";
  /** The full CWM */
  cwm: Record<string, unknown>;
  /** Accepted quote IDs for each step */
  acceptedQuotes: Record<string, string>;
  /** User's wallet for escrow funding */
  payerWallet: string;
}

export interface WorkflowAcceptedIntent {
  type: "workflow_accepted";
  planId: string;
  escrowAddress: string;
  /** Amount to fund */
  totalEscrowAmount: string;
  currency: string;
  /** Per-step breakdown */
  milestones: Array<{
    stepId: string;
    amount: string;
    kernelId: string;
    estimatedStart: string;
    estimatedEnd: string;
  }>;
}

export interface JobStatusQueryIntent {
  type: "job_status_query";
  jobId?: string;
  planId?: string;
}

export interface JobStatusResponseIntent {
  type: "job_status_response";
  planId: string;
  overallStatus: string;
  steps: Array<{
    stepId: string;
    status: string;
    progress: number;
    kernelName: string;
    evidenceBundleId?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
}

export interface JobCompletedIntent {
  type: "job_completed";
  jobId: string;
  stepId: string;
  evidenceBundleHash: string;
  /** Summary of what was done */
  summary: string;
}

// ── Payment Intents ─────────────────────────────────────────────

export interface PaymentRequestIntent {
  type: "payment_request";
  /** What this payment is for */
  reason: "escrow_funding" | "x402_service" | "courier_payment";
  amount: string;
  currency: string;
  /** Where to send */
  payTo: string;
  /** Contract to interact with */
  contractAddress?: string;
  /** Deadline */
  deadline: string;
}

export interface PaymentConfirmationIntent {
  type: "payment_confirmation";
  transactionHash: string;
  amount: string;
  currency: string;
  network: string;
  payer: string;
}

export interface EscrowFundedIntent {
  type: "escrow_funded";
  escrowAddress: string;
  transactionHash: string;
  totalAmount: string;
  milestoneCount: number;
}

// ── Logistics Intents ───────────────────────────────────────────

export interface RequestCourierIntent {
  type: "request_courier";
  jobId: string;
  pickupAddress: string;
  pickupLocation: { lat: number; lng: number };
  deliveryAddress: string;
  deliveryLocation: { lat: number; lng: number };
  packageWeight?: number;
  packageDimensions?: { x: number; y: number; z: number };
  priority: "economy" | "standard" | "express";
}

export interface CourierAssignedIntent {
  type: "courier_assigned";
  jobId: string;
  courierService: string;
  externalDeliveryId: string;
  estimatedPickup: string;
  estimatedDelivery: string;
  trackingUrl?: string;
  cost: string;
  currency: string;
}

export interface CourierStatusIntent {
  type: "courier_status";
  externalDeliveryId: string;
  status: "pending" | "driver_assigned" | "en_route_pickup" | "picked_up" | "in_transit" | "delivered" | "failed";
  currentLocation?: { lat: number; lng: number };
  estimatedArrival?: string;
}

// ── Verification Intents ────────────────────────────────────────

export interface RequestVerificationIntent {
  type: "request_verification";
  jobId: string;
  stepId: string;
  evidenceBundleHash: string;
  assuranceTier: number;
  fee: string;
}

export interface VerificationResultIntent {
  type: "verification_result";
  jobId: string;
  stepId: string;
  result: "valid" | "invalid" | "inconclusive";
  confidence: number;
  attestationHash: string;
  findings: Array<{ check: string; passed: boolean; details: string }>;
}

// ── Evaluation Intents (third-party quality assessment) ─────────
// Inspired by Virtuals ACP evaluator pattern — specialized agents
// assess whether deliverables meet requirements before escrow release.

export interface RequestEvaluationIntent {
  type: "request_evaluation";
  jobId: string;
  milestoneId: string;
  /** Hash of the evidence bundle to evaluate */
  evidenceBundleHash: string;
  /** Capability type being evaluated */
  capabilityType: string;
  /** Assurance tier determines evaluation rigor */
  assuranceTier: number;
  /** Specific requirements the evaluator should check */
  requirements: Array<{
    name: string;
    expectedValue?: string;
    tolerance?: string;
    unit?: string;
  }>;
  /** Fee offered for evaluation (USDC atomic units) */
  evaluationFee: string;
}

export interface EvaluationResultIntent {
  type: "evaluation_result";
  jobId: string;
  milestoneId: string;
  /** Overall verdict */
  verdict: "pass" | "fail" | "conditional";
  /** Quality score 0-100 */
  score: number;
  /** Confidence in the evaluation 0-1 */
  confidence: number;
  /** Detailed findings */
  findings: Array<{
    category: "dimensional" | "material" | "process" | "documentation" | "safety";
    severity: "critical" | "major" | "minor" | "observation";
    description: string;
    /** Reference into evidence bundle */
    evidenceRef?: string;
    expectedValue?: string;
    actualValue?: string;
  }>;
  /** Recommendations for the operator */
  recommendations: string[];
  /** Hash of signed attestation VC */
  attestationHash: string;
  /** IPFS CID of full evaluation report */
  reportCid?: string;
}

// ── Contract Builder Intents ────────────────────────────────────

export interface GetBuildOptionsIntent {
  type: "get_build_options";
  /** Which capability type to configure */
  capabilityType: string;
  /** Current user selections (for constraint resolution) */
  currentSelections?: Record<string, unknown>;
  /** Specific machine profile to use */
  profileId?: string;
}

export interface BuildOptionsResponseIntent {
  type: "build_options_response";
  capabilityType: string;
  templateName: string;
  /** Parameter groups with full definitions */
  groups: Array<{
    name: string;
    params: Array<{
      key: string;
      type: string;
      label: string;
      description?: string;
      required: boolean;
      group: string;
      visible: boolean;
      options?: Array<{
        value: string;
        label: string;
        description?: string;
        pricingImpact?: { mode: string; value: string; label?: string };
      }>;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      defaultValue?: unknown;
      multi?: boolean;
      pricingImpact?: { mode: string; value: string; label?: string };
    }>;
  }>;
  basePrice: string;
  currency: string;
  machineInfo?: { profileId: string; machineName: string; kernelId: string };
}

export interface BuildContractIntent {
  type: "build_contract";
  capabilityType: string;
  /** User's parameter selections */
  selections: Record<string, unknown>;
  /** Desired assurance tier */
  assuranceTier: number;
  /** Specific machine profile */
  profileId?: string;
}

export interface ContractBuiltResponseIntent {
  type: "contract_built_response";
  isValid: boolean;
  totalPrice: string;
  currency: string;
  /** Itemized price breakdown */
  priceBreakdown: Array<{
    paramKey: string;
    paramLabel: string;
    selectedValue: string;
    amount: string;
    impactLabel?: string;
  }>;
  /** CWM step ready for workflow submission */
  cwmStep: {
    capability: string;
    params: Record<string, unknown>;
    assuranceTier: number;
  };
  /** Validation errors (empty if valid) */
  validationErrors: Array<{ paramKey: string; message: string }>;
  templateName: string;
  machineInfo?: { profileId: string; machineName: string; kernelId: string };
}

// ── Funding Intents ──────────────────────────────────────────

/** Agent requests funds from treasury or parent agent */
export interface RequestFundingIntent {
  type: "request_funding";
  /** Amount requested (human-readable, e.g., "10.00") */
  amount: string;
  /** Currency of the request */
  currency: string;
  /** Why the funds are needed */
  reason: "operational" | "escrow_funding" | "gas_topup" | "service_payment";
  /** Which chain to fund on */
  chain: string;
  /** Recipient wallet address (Solana base58 or EVM hex) */
  recipientAddress: string;
}

/** Agent delegates a spending budget to a sub-agent */
export interface DelegateBudgetIntent {
  type: "delegate_budget";
  /** Delegatee agent ID */
  delegateeId: string;
  /** Max amount the delegatee can spend */
  maxAmount: string;
  /** Currency */
  currency: string;
  /** Which chain the budget applies to */
  chain: string;
  /** Duration in seconds this delegation is valid */
  validForSeconds: number;
  /** Which intent types the delegatee can spend on */
  allowedIntents: string[];
}

/** Kernel agent claims DePIN rewards for completed work */
export interface ClaimRewardsIntent {
  type: "claim_rewards";
  /** Job IDs that generated these rewards */
  jobIds: string[];
  /** Total reward amount */
  totalReward: string;
  /** Currency */
  currency: string;
  /** Chain to claim on */
  chain: string;
  /** Evidence bundle hashes proving the work */
  evidenceHashes: string[];
  /** Recipient address for the rewards */
  recipientAddress: string;
}

// ── General Intents ─────────────────────────────────────────────

export interface TextMessageIntent {
  type: "text_message";
  text: string;
}

export interface ErrorIntent {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
}

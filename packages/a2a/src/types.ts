/**
 * Agent-to-Agent Protocol Types
 *
 * Every agent on the network has an AgentCard (its public identity + capabilities).
 * Agents communicate through typed Messages in Conversations.
 * Messages carry Intents — structured requests/responses that agents understand.
 */

import type { Address, Id, EncryptedEnvelope } from "@pcc/spec";

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
  /** End-to-end encrypted envelope (when present, intent payload is encrypted) */
  encrypted?: EncryptedEnvelope;
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
  // Unbrowse (external data/action layer)
  | UnbrowseQueryIntent
  | UnbrowseResultIntent
  | UnbrowseShareSkillIntent
  | UnbrowseSkillSharedIntent
  // Setup
  | SetupDetectIntent
  | SetupDetectResultIntent
  | SetupConfigureIntent
  | SetupConfigureResultIntent
  | SetupValidateIntent
  | SetupValidateResultIntent
  // UI render (dynamic UI protocol for conversational setup flows)
  | UIRenderRequestIntent
  // IP / Story Protocol
  | IPRegisterIntent
  | IPRegisterResultIntent
  | IPRevenueQueryIntent
  | IPRevenueResultIntent
  | IPClaimRevenueIntent
  | IPClaimResultIntent
  | IPProposeSplitIntent
  | IPSplitResponseIntent
  // Sovereign Wealth Fund
  | SWFRegisterParticipantIntent
  | SWFRegisterParticipantResultIntent
  | SWFQueryDividendsIntent
  | SWFDividendsResultIntent
  | SWFClaimDividendsIntent
  | SWFClaimResultIntent
  // Anomaly Detection
  | AnomalyDetectedIntent
  | ProtocolFailureIntent
  | TrustDowngradeIntent
  | SystemAlertIntent
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

// ── Unbrowse Intents (external data/action layer) ───────────────
// Unbrowse gives agents direct API access to any website, 100x faster
// than browser automation. Agents discover, share, and reuse API skills.

/** Agent requests external data via Unbrowse (resolve intent against a URL) */
export interface UnbrowseQueryIntent {
  type: "unbrowse_query";
  /** Natural language description of what data/action is needed */
  query: string;
  /** Target URL to query (e.g., supplier site, marketplace) */
  targetUrl?: string;
  /** Limit results */
  maxResults?: number;
  /** Whether this is a read-only query (default: true) */
  dryRun?: boolean;
}

/** Response containing Unbrowse results */
export interface UnbrowseResultIntent {
  type: "unbrowse_result";
  /** The query that produced these results */
  query: string;
  /** Results from the Unbrowse marketplace or live capture */
  results: Array<{
    /** Unbrowse skill ID */
    skillId: string;
    /** Domain the skill targets */
    domain: string;
    /** What the skill does */
    intent: string;
    /** Confidence score (0-1) */
    confidence: number;
    /** Data returned by the skill (if executed) */
    data?: unknown;
    /** How the data was obtained */
    source?: "marketplace" | "capture" | "dom_fallback";
  }>;
  /** Total results found */
  totalResults: number;
  /** Resolution time in ms */
  durationMs: number;
}

/** Agent shares a discovered Unbrowse skill with the network */
export interface UnbrowseShareSkillIntent {
  type: "unbrowse_share_skill";
  /** Unbrowse skill ID to share */
  skillId: string;
  /** Domain the skill targets */
  domain: string;
  /** What the skill does */
  intent: string;
  /** Who discovered this skill */
  discoveredBy: string;
  /** When it was discovered */
  discoveredAt: string;
}

/** Acknowledgement that a shared skill was received */
export interface UnbrowseSkillSharedIntent {
  type: "unbrowse_skill_shared";
  /** The skill that was shared */
  skillId: string;
  /** How many agents now know about this skill */
  networkReach: number;
}

// ── Setup Intents ────────────────────────────────────────────────
// These allow agents to orchestrate kernel/device setup flows programmatically.

/** Request: detect current config state — no params needed, agent figures out what to check */
export interface SetupDetectIntent {
  type: "setup_detect";
}

/** Response: detected config state */
export interface SetupDetectResultIntent {
  type: "setup_detect_result";
  gateway: { running: boolean; url: string; version?: string };
  database: { initialized: boolean; kernels: number; devices: number; jobs: number };
  chain: { connected: boolean; network?: string; walletAddress?: string; balance?: string };
  adapters: Array<{ id: string; type: string; adapterType: string; healthy: boolean }>;
  storage: { type: string; connected: boolean };
  identity: { registered: boolean; agentId?: string; did?: string };
  overall: "ready" | "partial" | "unconfigured";
  /** Human-readable list of what is not configured */
  missing: string[];
}

/** Request: configure a subsystem (adapter, chain, storage, identity, or full) */
export interface SetupConfigureIntent {
  type: "setup_configure";
  subsystem: "adapter" | "chain" | "storage" | "identity" | "full";
  config: Record<string, unknown>;
}

/** Response: configuration result */
export interface SetupConfigureResultIntent {
  type: "setup_configure_result";
  subsystem: string;
  success: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

/** Request: validate full setup — pass a JSON config string or omit to validate current env */
export interface SetupValidateIntent {
  type: "setup_validate";
  /** JSON string of config to validate. Omit to validate the currently loaded config. */
  config?: string;
}

/** Response: validation results with per-check pass/warn/fail status */
export interface SetupValidateResultIntent {
  type: "setup_validate_result";
  valid: boolean;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
  errors: string[];
  warnings: string[];
}

// ── Setup Payload Types (re-exported aliases for consumers) ───────
// These mirror the intent shapes but without the `type` discriminant,
// matching the task-spec naming convention for payload interfaces.

export type SetupDetectPayload = Omit<SetupDetectIntent, "type">;
export type SetupDetectResultPayload = Omit<SetupDetectResultIntent, "type">;
export type SetupConfigurePayload = Omit<SetupConfigureIntent, "type">;
export type SetupConfigureResultPayload = Omit<SetupConfigureResultIntent, "type">;
export type SetupValidatePayload = Omit<SetupValidateIntent, "type">;
export type SetupValidateResultPayload = Omit<SetupValidateResultIntent, "type">;

// ── UI Render Request Intent ─────────────────────────────────────
// Allows the setup agent to request the dashboard to render dynamic UI
// components during a conversational setup flow.

/** Component types the setup agent can request the dashboard to render */
export type UIRenderComponent =
  | "photo_capture"
  | "network_scan_results"
  | "machine_config_preview"
  | "test_results"
  | "setup_complete"
  | "text_input"
  | "selection";

/** Request from the setup agent to the dashboard to render a UI component */
export interface UIRenderRequestIntent {
  type: "ui_render_request";
  /** Which component to render */
  component: UIRenderComponent;
  /** Component-specific props (e.g., options for selection, config for preview) */
  props: Record<string, unknown>;
}

// ── IP / Story Protocol Intents ──────────────────────────────────
// Agents can manage IP registration, revenue queries, claims, and
// revenue-split negotiation via these typed intents.

/** Request to register a CSD capability as a Story Protocol IP Asset */
export interface IPRegisterIntent {
  type: "ip_register";
  /** PCC capability ID to register as IP */
  capabilityId: string;
  /** Wallet address of the CSD designer (receives royalty tokens) */
  designerAddress: string;
  /** Human-readable designer name */
  designerName: string;
  /** Percentage of all derivative revenue that flows to this IP (default 5) */
  commercialRevShare?: number;
}

/** Response containing the Story Protocol IP Asset registration details */
export interface IPRegisterResultIntent {
  type: "ip_register_result";
  /** Story Protocol IP Account address (0x...) */
  ipId: string;
  /** Registration transaction hash */
  txHash: string;
  /** PIL license terms ID assigned to this IP */
  licenseTermsId: string;
  /** Whether registration succeeded */
  success: boolean;
  /** Error message if success=false */
  error?: string;
}

/** Request to query revenue accumulated in a Story IP Royalty Vault */
export interface IPRevenueQueryIntent {
  type: "ip_revenue_query";
  /** Story Protocol IP Account address */
  ipId: string;
}

/** Response with revenue snapshot for a Story IP Royalty Vault */
export interface IPRevenueResultIntent {
  type: "ip_revenue_result";
  /** Story Protocol IP Account address */
  ipId: string;
  /** Total accumulated revenue (WIP/USDC token units) */
  totalRevenue: string;
  /** Revenue available to claim */
  unclaimedRevenue: string;
  /** Royalty Token holders with claimable amounts */
  tokenHolders: Array<{
    address: string;
    tokensHeld: number;
    claimable: string;
  }>;
}

/** Request to claim accumulated revenue from a Story IP Royalty Vault */
export interface IPClaimRevenueIntent {
  type: "ip_claim_revenue";
  /** Story Protocol IP Account address */
  ipId: string;
  /** Specific Royalty Token IDs to claim (omit to claim all) */
  tokenIds?: string[];
}

/** Response for a revenue claim transaction */
export interface IPClaimResultIntent {
  type: "ip_claim_result";
  /** Claim transaction hash */
  txHash: string;
  /** Amount claimed (token units) */
  claimed: string;
  /** Whether claim succeeded */
  success: boolean;
}

/** Revenue split entry in a proposed split scheme */
export interface IPRevenueSplitEntry {
  address: string;
  role: "designer" | "operator" | "verifier" | "assembler" | "curator";
  percentage: number;
  label: string;
}

/** Propose a revenue split scheme for an IP Asset (used in contract negotiation) */
export interface IPProposeSplitIntent {
  type: "ip_propose_split";
  /** Story Protocol IP Account address */
  ipId: string;
  /** Proposed split allocations (must sum to 100) */
  splits: IPRevenueSplitEntry[];
}

/** Accept or counter-propose a revenue split scheme */
export interface IPSplitResponseIntent {
  type: "ip_split_response";
  /** Whether the proposed split was accepted */
  accepted: boolean;
  /** The accepted or counter-proposed split (present when accepted=true or counterProposal=true) */
  splits?: IPRevenueSplitEntry[];
  /** Whether this is a counter-proposal (accepted=false but splits contains a counter-offer) */
  counterProposal?: boolean;
}

// ── Anomaly Detection Intents ────────────────────────────────────
// These enable agents to report, propagate, and respond to anomalies
// across the network. All three broadcast types (anomaly_detected,
// protocol_failure, system_alert) are fanned out to all anomaly listeners
// on the MessageBus in addition to normal point-to-point delivery.

export interface AnomalyDetectedIntent {
  type: "anomaly_detected";
  severity: "info" | "warning" | "critical";
  category: "protocol_failure" | "evidence_mismatch" | "consensus_failure" | "timeout" | "rate_anomaly" | "trust_violation";
  sourceAgentId: string;
  /** The agent or kernel being reported (optional — omit for self-reports) */
  targetAgentId?: string;
  description: string;
  evidence: {
    jobId?: string;
    bundleHash?: string;
    expectedValue?: string;
    actualValue?: string;
    timestamp: string;
  };
}

export interface ProtocolFailureIntent {
  type: "protocol_failure";
  /** Which protocol step failed, e.g. "evidence_submission", "escrow_release", "verification_consensus" */
  failedProtocol: string;
  errorCode: string;
  errorMessage: string;
  involvedAgents: string[];
  jobId?: string;
  recoveryAction?: "retry" | "escalate" | "rollback" | "ignore";
}

export interface TrustDowngradeIntent {
  type: "trust_downgrade";
  targetAgentId: string;
  previousTrustScore: number;
  newTrustScore: number;
  reason: string;
  /** List of anomaly IDs that triggered this downgrade */
  evidence: string[];
}

export interface SystemAlertIntent {
  type: "system_alert";
  alertType: "stuck_job" | "consensus_timeout" | "escrow_expiry" | "evidence_tampering" | "rate_spike" | "node_offline";
  severity: "info" | "warning" | "critical";
  message: string;
  metadata: Record<string, unknown>;
  autoResolves: boolean;
  resolveTimeoutMs?: number;
}

// ── General Intents ─────────────────────────────────────────────

export interface TextMessageIntent {
  type: "text_message";
  text: string;
}

// ── Sovereign Wealth Fund Intents ─────────────────────────────────

export interface SWFRegisterParticipantIntent {
  type: "swf_register_participant";
  did: string;
  walletAddress: string;
  role: string;
}

export interface SWFRegisterParticipantResultIntent {
  type: "swf_register_participant_result";
  participantId: string;
  status: "active" | "already_registered";
}

export interface SWFQueryDividendsIntent {
  type: "swf_query_dividends";
  participantId: string;
}

export interface SWFDividendsResultIntent {
  type: "swf_dividends_result";
  participantId: string;
  totalEarned: string;
  pendingDividends: string;
  epochCount: number;
}

export interface SWFClaimDividendsIntent {
  type: "swf_claim_dividends";
  claimId: string;
  chain?: string;
}

export interface SWFClaimResultIntent {
  type: "swf_claim_result";
  claimId: string;
  status: "pending" | "claimed" | "failed";
  txHash?: string;
}

export interface ErrorIntent {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
}

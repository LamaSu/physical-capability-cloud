/**
 * ACP ↔ A2A Protocol Bridge — maps between Virtuals Protocol's Agent Commerce
 * Protocol and PCC's A2A typed intents.
 *
 * Enables PCC capabilities to be discoverable and hireable by Virtuals agents,
 * and allows PCC agents to consume services from the Virtuals ecosystem.
 *
 * ACP uses a 5-phase Job lifecycle with Memos:
 *   Request → Negotiation → Transaction → Evaluation → Completed
 *
 * PCC uses typed intents on a MessageBus:
 *   discover → quote → negotiate → submit_workflow → job_completed
 */

import type {
  Intent,
  RequestQuoteIntent,
  QuoteResponseIntent,
  NegotiateIntent,
  NegotiationResponseIntent,
  SubmitWorkflowIntent,
  JobCompletedIntent,
  RequestEvaluationIntent,
  EvaluationResultIntent,
} from "@pcc/a2a";

// ---------------------------------------------------------------------------
// ACP Types (Virtuals Protocol)
// ---------------------------------------------------------------------------

export type AcpMemoType =
  | "JobRequest"
  | "Agreement"
  | "Transaction"
  | "Deliverable"
  | "General";

export type AcpPhase =
  | "REQUEST"
  | "NEGOTIATION"
  | "TRANSACTION"
  | "EVALUATION"
  | "COMPLETED";

export interface AcpMemo {
  content: string; // JSON payload
  type: AcpMemoType;
  nextPhase: AcpPhase;
  status: "pending" | "approved" | "rejected";
  payableDetails?: {
    amount: string;
    currency: string;
  };
}

export interface AcpJobOffering {
  name: string;
  description: string;
  price: string;
  slaMinutes: number;
  fundTransfer: boolean;
  requirements: string;
  deliverables: string;
}

// ---------------------------------------------------------------------------
// Intent → ACP Memo mapping
// ---------------------------------------------------------------------------

const INTENT_TO_MEMO: Record<string, AcpMemoType> = {
  discover_capabilities: "General",
  capabilities_response: "General",
  request_quote: "JobRequest",
  quote_response: "JobRequest",
  negotiate: "Agreement",
  negotiation_response: "Agreement",
  submit_workflow: "Transaction",
  workflow_accepted: "Transaction",
  request_evaluation: "Deliverable",
  evaluation_result: "Deliverable",
  job_completed: "Deliverable",
  text_message: "General",
};

const INTENT_TO_PHASE: Record<string, AcpPhase> = {
  discover_capabilities: "REQUEST",
  capabilities_response: "REQUEST",
  request_quote: "NEGOTIATION",
  quote_response: "NEGOTIATION",
  negotiate: "NEGOTIATION",
  negotiation_response: "NEGOTIATION",
  submit_workflow: "TRANSACTION",
  workflow_accepted: "TRANSACTION",
  request_evaluation: "EVALUATION",
  evaluation_result: "COMPLETED",
  job_completed: "COMPLETED",
};

// ---------------------------------------------------------------------------
// Bridge functions
// ---------------------------------------------------------------------------

/**
 * Convert a PCC A2A intent to an ACP Memo.
 */
export function intentToAcpMemo(intent: Intent): AcpMemo {
  const memoType = INTENT_TO_MEMO[intent.type] ?? "General";
  const nextPhase = INTENT_TO_PHASE[intent.type] ?? "REQUEST";

  const memo: AcpMemo = {
    content: JSON.stringify(intent),
    type: memoType,
    nextPhase,
    status: "pending",
  };

  // Add payment details for transaction intents
  if (intent.type === "submit_workflow") {
    const wf = intent as SubmitWorkflowIntent;
    // Total escrow amount would be calculated from accepted quotes
    memo.payableDetails = {
      amount: "0", // Calculated from quotes
      currency: "USDC",
    };
  }

  return memo;
}

/**
 * Convert an ACP Memo back to a PCC A2A intent.
 */
export function acpMemoToIntent(memo: AcpMemo): Intent | null {
  try {
    const parsed = JSON.parse(memo.content);
    if (parsed.type && typeof parsed.type === "string") {
      return parsed as Intent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert a PCC capability to an ACP Job Offering format.
 */
export function capabilityToJobOffering(capability: {
  name: string;
  description: string;
  basePrice: string;
  estimatedMinutes: number;
  parameters: Record<string, unknown>;
}): AcpJobOffering {
  return {
    name: capability.name,
    description: capability.description,
    price: capability.basePrice,
    slaMinutes: capability.estimatedMinutes,
    fundTransfer: false, // PCC uses milestone escrow, not fund transfer
    requirements: JSON.stringify(capability.parameters),
    deliverables: "Evidence bundle with cryptographic proof of work (IPFS CID + ZK proof)",
  };
}

/**
 * Convert an ACP Job Offering to a PCC quote request intent.
 */
export function jobOfferingToQuoteRequest(
  offering: AcpJobOffering,
  capabilityType: string,
): RequestQuoteIntent {
  return {
    type: "request_quote",
    capabilityType,
    params: JSON.parse(offering.requirements || "{}"),
    assuranceTier: 1, // Default to basic verification for ACP jobs
  };
}

/**
 * Get the ACP phase for a PCC intent type.
 */
export function getAcpPhase(intentType: string): AcpPhase {
  return INTENT_TO_PHASE[intentType] ?? "REQUEST";
}

/**
 * Check if a PCC intent maps to an ACP phase transition.
 */
export function isPhaseTransition(intentType: string): boolean {
  return intentType in INTENT_TO_PHASE;
}

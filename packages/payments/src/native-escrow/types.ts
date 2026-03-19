/**
 * Native Escrow types — demand/result attestation pattern.
 *
 * Replaces the Alkahest dependency with a self-contained escrow system
 * that follows the same demand -> fulfill -> collect lifecycle:
 *
 *   1. Buyer locks funds with a DemandSpec (evidence requirements)
 *   2. Seller fulfills by submitting a FulfillmentProof
 *   3. Service validates proof against demand
 *   4. Seller collects escrowed funds after successful fulfillment
 *   5. Buyer can reclaim if obligation expires unfulfilled
 *   6. Either party can dispute; resolution splits/returns funds
 *
 * In-memory for mock mode. Production path: Solidity contract interface
 * documented in comments (MilestoneEscrow v2 with attestation hooks).
 */

import type { Address, Amount, Id, Timestamp } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Demand & Fulfillment
// ---------------------------------------------------------------------------

/** Evidence requirements that a seller must satisfy to collect funds */
export interface DemandSpec {
  /** Minimum assurance tier (0-3) */
  minimumTier: number;
  /** Required number of verifiers (Bittensor miners) */
  minimumVerifiers: number;
  /** Minimum consensus score (0-1) */
  minimumConsensusScore: number;
  /** Whether a ZK proof is required */
  requireZKProof: boolean;
  /** Required evidence bundle hash (SHA-256). If set, proof must match exactly. */
  requiredBundleHash?: string;
  /** Arbitrary additional conditions (key-value for extensibility) */
  customConditions?: Record<string, unknown>;
}

/** Proof submitted by the seller to satisfy the demand */
export interface FulfillmentProof {
  /** Evidence bundle hash (SHA-256) */
  bundleHash: string;
  /** IPFS CID of the encrypted evidence */
  ipfsCid: string;
  /** Bittensor consensus score (0-1) */
  consensusScore: number;
  /** Number of verifiers that validated the evidence */
  verifierCount: number;
  /** ZK proof ID (required if demand.requireZKProof is true) */
  zkProofId?: string;
  /** Cryptographic signatures from verifiers */
  signatures: string[];
}

// ---------------------------------------------------------------------------
// Obligation
// ---------------------------------------------------------------------------

/** Status of an escrow obligation */
export type ObligationStatus =
  | "locked"
  | "fulfilled"
  | "collected"
  | "expired"
  | "disputed";

/** A single escrow obligation — one per milestone */
export interface EscrowObligation {
  /** Unique obligation ID */
  id: string;
  /** PCC milestone step ID this obligation maps to */
  milestoneStepId: Id;
  /** Parent PCC escrow ID */
  escrowId: Id;
  /** Buyer (requester) address */
  buyer: Address;
  /** Seller (operator) address */
  seller: Address;
  /** Token address (e.g. USDC on Base Sepolia) */
  token: Address;
  /** Amount locked (base amount + bond) */
  amount: Amount;
  /** Evidence demand that must be satisfied */
  demand: DemandSpec;
  /** Expiration timestamp (unix seconds) */
  expiration: number;
  /** Current status */
  status: ObligationStatus;
  /** Fulfillment evidence (set when seller fulfills) */
  fulfillmentEvidence?: FulfillmentProof;
  /** On-chain tx hash of the lock */
  lockTxHash?: string;
  /** On-chain tx hash of the settlement (collect/return/resolve) */
  settleTxHash?: string;
  /** When this obligation was created */
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

/** A dispute filed against an obligation */
export interface EscrowDispute {
  /** Dispute ID */
  id: string;
  /** Obligation this dispute targets */
  obligationId: string;
  /** Who filed the dispute */
  challenger: Address;
  /** Bond posted by the challenger */
  challengerBond: Amount;
  /** Reason for the dispute */
  reason: string;
  /** Resolution (set when resolved) */
  resolution?: {
    decision: "buyer" | "seller" | "split";
    splitPercent?: number;
    resolvedAt: Timestamp;
  };
  /** When the dispute was filed */
  filedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

/** A signed attestation record (replaces EAS) */
export interface Attestation {
  /** Unique attestation ID */
  id: string;
  /** Schema identifier (e.g. "pcc.demand.v1", "pcc.result.v1") */
  schema: string;
  /** Attestation data payload */
  data: Record<string, unknown>;
  /** Signer's public key (hex-encoded Ed25519) */
  signer: string;
  /** Ed25519 signature over (schema + canonical data + timestamp) */
  signature: string;
  /** Creation timestamp (ISO 8601) */
  timestamp: Timestamp;
  /** Whether this attestation has been revoked */
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the native escrow service */
export interface EscrowConfig {
  /** Default expiration in seconds (default: 7 days = 604800) */
  defaultExpirationSeconds?: number;
  /** Dispute window in seconds after fulfillment (default: 24 hours) */
  disputeWindowSeconds?: number;
  /** Minimum bond percentage (default: 5%) */
  minBondPercent?: number;
  /** USDC token address (default: Base Sepolia USDC) */
  usdcAddress?: string;
}

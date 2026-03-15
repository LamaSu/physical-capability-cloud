/**
 * Alkahest (Arkhai) escrow types — boolean-native escrow with EAS attestations.
 *
 * Alkahest escrow flow:
 *   1. Buyer locks ERC20 tokens with an arbiter + demand (the condition to fulfill)
 *   2. Seller does the work, creates a result attestation (EAS)
 *   3. Arbiter validates result against demand
 *   4. If valid: escrow releases to seller. If expired: returns to buyer.
 *
 * PCC maps each milestone to one Alkahest escrow obligation.
 * The arbiter is PCC's verification subnet (Bittensor) or a trusted party.
 * The demand is the evidence requirements for that assurance tier.
 */

import type { Address, Amount, Id } from "@pcc/spec";

/** Alkahest escrow obligation — one per PCC milestone */
export interface AlkahestObligation {
  /** Alkahest attestation UID (bytes32) */
  uid: string;
  /** PCC milestone step ID this obligation maps to */
  milestoneStepId: Id;
  /** PCC escrow ID */
  pccEscrowId: Id;
  /** Buyer (requester) address */
  buyer: Address;
  /** Seller (operator) address */
  seller: Address;
  /** ERC20 token address (USDC) */
  token: Address;
  /** Amount locked */
  amount: Amount;
  /** Arbiter contract address */
  arbiter: Address;
  /** ABI-encoded demand (evidence requirements) */
  demand: string;
  /** Expiration timestamp (unix seconds) */
  expiration: number;
  /** Current status */
  status: "locked" | "fulfilled" | "expired" | "collected";
  /** Fulfillment attestation UID (set when seller fulfills) */
  fulfillmentUid?: string;
  /** On-chain tx hash of the escrow creation */
  lockTxHash?: string;
  /** On-chain tx hash of the collection/return */
  settleTxHash?: string;
}

/** Demand encoding for PCC evidence requirements */
export interface PCCEvidenceDemand {
  /** Required evidence bundle hash (SHA-256) */
  requiredBundleHash?: string;
  /** Minimum assurance tier */
  minimumTier: number;
  /** Required verifier count (Bittensor miners) */
  minimumVerifiers: number;
  /** Minimum consensus score (0-1) */
  minimumConsensusScore: number;
  /** Whether ZK proof is required */
  requireZKProof: boolean;
}

/** Result attestation from the operator */
export interface PCCEvidenceResult {
  /** Evidence bundle hash */
  bundleHash: string;
  /** IPFS CID of the encrypted evidence */
  ipfsCid: string;
  /** Bittensor consensus score */
  consensusScore: number;
  /** Number of miners that verified */
  verifierCount: number;
  /** ZK proof ID (if applicable) */
  zkProofId?: string;
}

/** Configuration for the Alkahest escrow bridge */
export interface AlkahestBridgeConfig {
  /** Solana/EVM RPC URL (default: Base Sepolia) */
  rpcUrl?: string;
  /** USDC token address on Base Sepolia */
  usdcAddress?: string;
  /** Default arbiter contract (PCC's trusted verifier) */
  defaultArbiter?: string;
  /** Use mock mode (default: true) */
  mock?: boolean;
}

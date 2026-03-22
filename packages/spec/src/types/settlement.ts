/**
 * Settlement types — on-chain escrow, bonds, slashing, disputes.
 *
 * Control plane is off-chain; settlement + identity is on-chain.
 * Chain stores commitments (hashes), escrow state transitions,
 * slashing events, and identity/reputation registries.
 */

import type {
  Id,
  Address,
  Amount,
  Currency,
  SHA256,
  Timestamp,
  EscrowStatus,
  AssuranceTier,
} from "./common.js";
import type { TMPMode } from "./procurement.js";

/** A milestone in the escrow — corresponds to one CWM step */
export interface EscrowMilestone {
  stepId: Id;
  /** Amount locked for this milestone */
  amount: Amount;
  /** Current status */
  status: EscrowStatus;
  /** Evidence bundle hash (submitted by kernel) */
  evidenceBundleHash?: SHA256;
  /** Verifier attestation hash */
  verifierAttestationHash?: SHA256;
  /** When the challenge window opened */
  challengeWindowStart?: Timestamp;
  /** When the challenge window closes */
  challengeWindowEnd?: Timestamp;
  /** Operator bond amount for this milestone */
  bondAmount: Amount;
  /** Optional TMP procurement linkage for this milestone */
  procurement?: {
    mode: TMPMode;
    tmpTaskId?: string;
    tmpContractAddress?: Address;
  };
}

/** An escrow contract instance for a workflow */
export interface Escrow {
  id: Id;
  cwmId: Id;
  /** On-chain contract address */
  contractAddress: Address;
  /** Payer (user) */
  payer: Address;
  /** Total escrowed amount */
  totalAmount: Amount;
  currency: Currency;
  /** Per-step milestones */
  milestones: EscrowMilestone[];
  /** Overall status */
  status: "created" | "funded" | "active" | "completing" | "completed" | "disputed" | "refunded";
  /** Creation time */
  createdAt: Timestamp;
  /** Deadline for entire workflow */
  deadline: Timestamp;
}

/** A dispute filed against a milestone */
export interface Dispute {
  id: Id;
  escrowId: Id;
  milestoneStepId: Id;
  /** Who filed the dispute */
  challenger: Address;
  /** Bond staked by challenger */
  challengerBond: Amount;
  /** Reason for dispute */
  reason: string;
  /** Evidence submitted by challenger */
  challengerEvidenceHash?: SHA256;
  /** Current status */
  status: "filed" | "under_review" | "resolved_for_challenger" |
          "resolved_for_operator" | "dismissed";
  /** Arbitration panel (for Tier 2+) */
  arbiters?: Address[];
  /** Resolution details */
  resolution?: {
    decidedBy: Address;
    decision: "challenger_wins" | "operator_wins" | "split";
    reasoning: string;
    /** Amount returned to user */
    refundAmount?: Amount;
    /** Amount slashed from operator */
    slashedAmount?: Amount;
    /** Amount slashed from challenger (if frivolous) */
    challengerSlashed?: Amount;
    timestamp: Timestamp;
  };
  filedAt: Timestamp;
}

/** Bond configuration per assurance tier */
export interface BondConfig {
  tier: AssuranceTier;
  /** Operator bond as percentage of milestone amount */
  operatorBondPercent: number;
  /** Challenger bond as percentage of milestone amount */
  challengerBondPercent: number;
  /** Challenge window duration in seconds */
  challengeWindowSeconds: number;
  /** Slash percentage if fraud proven */
  slashPercent: number;
}

/** Default bond configurations */
export const DEFAULT_BOND_CONFIGS: BondConfig[] = [
  {
    tier: 0,
    operatorBondPercent: 0,
    challengerBondPercent: 10,
    challengeWindowSeconds: 3600,      // 1 hour
    slashPercent: 100,
  },
  {
    tier: 1,
    operatorBondPercent: 5,
    challengerBondPercent: 10,
    challengeWindowSeconds: 14400,     // 4 hours
    slashPercent: 100,
  },
  {
    tier: 2,
    operatorBondPercent: 15,
    challengerBondPercent: 15,
    challengeWindowSeconds: 86400,     // 24 hours
    slashPercent: 100,
  },
  {
    tier: 3,
    operatorBondPercent: 25,
    challengerBondPercent: 20,
    challengeWindowSeconds: 259200,    // 72 hours
    slashPercent: 100,
  },
];

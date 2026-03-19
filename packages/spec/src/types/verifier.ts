/**
 * Verifier types — the hybrid verification market.
 *
 * Tier 0/1: Open verification market (stake-weighted selection)
 * Tier 2/3: Curated guild allowlist (domain-expert verifiers)
 */

import type {
  Id,
  Address,
  Amount,
  SHA256,
  Timestamp,
  Signature,
  AssuranceTier,
} from "./common.js";

/** Verifier identity and capabilities */
export interface Verifier {
  id: Id;
  address: Address;
  /** Human-readable name */
  name: string;
  /** What this verifier can verify */
  supportedCapabilityTypes: string[];
  /** Maximum tier this verifier is qualified for */
  maxTier: AssuranceTier;
  /** Staked amount */
  stakedAmount: Amount;
  /** Reputation score (0-1000) */
  reputation: number;
  /** Total verifications completed */
  totalVerifications: number;
  /** Disputes lost (should be low relative to total) */
  disputesLost: number;
  /** Is this verifier in a curated guild? */
  guildMember: boolean;
  /** Guild ID if member */
  guildId?: Id;
  /** Registration time */
  registeredAt: Timestamp;
  /** Status */
  status: "active" | "inactive" | "suspended" | "slashed";
}

/** A verification request */
export interface VerificationRequest {
  id: Id;
  jobId: Id;
  stepId: Id;
  /** Evidence bundle to verify */
  evidenceBundleHash: SHA256;
  /** Required assurance tier */
  assuranceTier: AssuranceTier;
  /** Verification fee offered */
  fee: Amount;
  /** Deadline for verification */
  deadline: Timestamp;
  /** Status */
  status: "pending" | "assigned" | "in_progress" | "completed" | "expired";
  /** Assigned verifier(s) */
  assignedVerifiers?: Id[];
  createdAt: Timestamp;
}

/** A verification attestation */
export interface VerificationAttestation {
  id: Id;
  requestId: Id;
  verifierId: Id;
  /** Hash of the evidence bundle being attested */
  evidenceBundleHash: SHA256;
  /** Result */
  result: "valid" | "invalid" | "inconclusive";
  /** Confidence score (0-100) */
  confidence: number;
  /** Detailed findings */
  findings: VerificationFinding[];
  /** Hash of this attestation */
  attestationHash: SHA256;
  /** Verifier's signature */
  signature: Signature;
  createdAt: Timestamp;
  /** POAW-style audit receipt proving verification work was performed */
  auditReceipt?: {
    /** SHA-256 hash of the verification computation */
    scanHash: SHA256;
    /** Position in audit chain */
    chainPosition: number;
    /** Number of checks performed */
    checksPerformed: number;
    /** Timestamp */
    timestamp: Timestamp;
  };
}

/** A specific finding from verification */
export interface VerificationFinding {
  /** Which evidence event this finding relates to */
  evidenceEventId: Id;
  /** Check performed */
  check: string;
  /** Result of this check */
  passed: boolean;
  /** Details */
  details: string;
  /** Severity if failed */
  severity?: "info" | "warning" | "critical";
}

/** Verifier selection criteria */
export interface VerifierSelectionCriteria {
  /** Minimum reputation score */
  minReputation: number;
  /** Minimum stake */
  minStake: Amount;
  /** Number of verifiers needed */
  quorum: number;
  /** Must be guild member? */
  requireGuild: boolean;
  /** Specific guild required? */
  guildId?: Id;
}

/** Default selection criteria per tier */
export const DEFAULT_VERIFIER_CRITERIA: Record<AssuranceTier, VerifierSelectionCriteria> = {
  0: { minReputation: 0, minStake: "0", quorum: 1, requireGuild: false },
  1: { minReputation: 200, minStake: "100", quorum: 1, requireGuild: false },
  2: { minReputation: 500, minStake: "500", quorum: 2, requireGuild: false },
  3: { minReputation: 800, minStake: "1000", quorum: 3, requireGuild: true },
};

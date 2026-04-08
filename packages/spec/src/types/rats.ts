/**
 * RATS RFC 9334 Type Alignment Layer
 *
 * Maps PCC's evidence pipeline to formal RATS terminology.
 * These types are structural aliases — they wrap existing PCC types
 * using RATS role names so both the PCC internal API and the RATS
 * terminology are usable interchangeably.
 *
 * RFC 9334: https://datatracker.ietf.org/doc/rfc9334/
 *
 * Role mapping:
 *   Attester              = Shop Kernel (EvidenceEmitter)
 *   Verifier              = VerifierMarket + Bittensor subnet
 *   Relying Party         = Job Requester / Escrow
 *   Endorser              = Equipment Manufacturer
 *   Reference Value Provider (RVP) = CSD (Capability StructureDefinition)
 *
 * RATS two-stage appraisal flow in PCC:
 *
 *   [Endorser: Manufacturer] → Endorsements (CSD manufacturer field)
 *          │
 *          ▼
 *   [Attester: Shop Kernel / EvidenceEmitter]
 *     - Collects sensor readings → EvidenceEvents (RATS: Claims)
 *     - Assembles signed EvidenceBundle (RATS: Evidence)
 *          │
 *          │ Evidence (EvidenceBundle)
 *          ▼
 *   [Verifier: EvidenceVerifier + Bittensor Subnet]
 *     - Appraises Evidence against Reference Values (CSD / DEFAULT_TIER_REQUIREMENTS)
 *     - Produces VerificationAttestation (RATS: Attestation Result)
 *          │
 *          │ Attestation Result
 *          ▼
 *   [Relying Party: Job Requester / Escrow]
 *     - ComplianceFacade.aggregateAttestations() — settlement gates on result
 *
 *   [Reference Value Provider: CSD]
 *     - Provides required event types per tier, parameter ranges
 *     - Used by Verifier to appraise Evidence
 */

import type { EvidenceBundle, EvidenceEvent } from "./evidence.js";
import type { VerificationAttestation } from "./verifier.js";
import type { AssuranceTier } from "./common.js";

// ── RATS Core Concepts ────────────────────────────────────────────────────────

/**
 * RATS: Evidence
 * PCC: EvidenceBundle
 *
 * A collection of Claims (EvidenceEvents) about an Attester's (Shop Kernel's)
 * trustworthiness, produced by the Attester itself and conveyed to the Verifier.
 */
export type RATSEvidence = EvidenceBundle;

/**
 * RATS: Attestation Result
 * PCC: VerificationAttestation
 *
 * The appraisal output produced by the Verifier after evaluating Evidence
 * against Reference Values. Consumed by the Relying Party.
 */
export type RATSAttestationResult = VerificationAttestation;

/**
 * RATS: Claim
 * PCC: EvidenceEvent
 *
 * A single data item asserted by the Attester about itself or its
 * operational environment (sensor reading, hash, timestamp, etc.)
 */
export type RATSClaim = EvidenceEvent;

// ── RATS Role Interfaces ───────────────────────────────────────────────────────

/**
 * RATS: Attester
 * PCC: Shop Kernel / EvidenceEmitter
 *
 * An entity whose trustworthiness is being assessed. Produces Evidence
 * (EvidenceBundles) containing Claims about its own state and operations.
 *
 * Key RATS properties maintained by the Shop Kernel:
 *   - Each Claim (EvidenceEvent) is content-addressed (SHA-256)
 *   - Evidence (EvidenceBundle) is signed by the Attester's key
 *   - Evidence chain is tamper-evident (bundle hash over all event hashes)
 */
export interface RATSAttester {
  /** RATS: Attester identity. PCC: kernelId */
  readonly attesterId: string;
  /**
   * RATS: Produce Evidence.
   * PCC: EvidenceEmitter.finalizeBundle()
   */
  produceEvidence(jobId: string, stepId: string): Promise<RATSEvidence>;
}

/**
 * RATS: Verifier
 * PCC: EvidenceVerifier + VerifierMarket
 *
 * A trusted entity that appraises Evidence against Reference Values (from the
 * RVP) and Endorsements (from the Endorser), producing Attestation Results.
 *
 * Appraisal steps (RATS two-stage model):
 * 1. Verify Evidence integrity (hash chain) — did the Attester produce this?
 * 2. Appraise Evidence against Reference Values — does it meet tier requirements?
 * 3. Produce signed Attestation Result for Relying Party consumption
 */
export interface RATSVerifier {
  /** RATS: Verifier identity. PCC: verifierId */
  readonly verifierId: string;
  /**
   * RATS: Appraise Evidence → Attestation Result.
   * PCC: EvidenceVerifier.verify()
   */
  appraise(evidence: RATSEvidence): Promise<RATSAttestationResult>;
}

/**
 * RATS: Relying Party
 * PCC: Job Requester / Escrow Contract
 *
 * An entity that uses Attestation Results to make trust decisions.
 * In PCC, the escrow settlement gate is the primary Relying Party.
 *
 * Relying Party behavior:
 *   - Does NOT independently re-verify Evidence (that is the Verifier's job)
 *   - Applies policy (majority consensus, tier requirements) to Attestation Results
 *   - Settlement is blocked when Attestation Results do not pass policy
 */
export interface RATSRelyingParty {
  /**
   * RATS: Evaluate Attestation Result and make a trust decision.
   * PCC: ComplianceFacade.aggregateAttestations() → settlement gate
   * Returns true only when policy passes and settlement can proceed.
   */
  evaluateAttestation(result: RATSAttestationResult): Promise<boolean>;
}

/**
 * RATS: Endorsement
 * PCC: Device calibration certificate or manufacturer spec
 *
 * An authoritative statement from an Endorser about what the Attester
 * (physical equipment) is expected to produce as Evidence.
 */
export interface RATSEndorsement {
  /** Equipment or capability type this endorsement applies to */
  targetType: string;
  /** Version or model identifier */
  targetVersion?: string;
  /** Expected firmware hash, calibration values, equipment specs */
  expectedCharacteristics: Record<string, unknown>;
  /** ISO 8601 expiry for this endorsement */
  validUntil?: string;
  /** Endorser's signature over this endorsement */
  signature?: string;
}

/**
 * RATS: Endorser
 * PCC: Equipment Manufacturer
 *
 * Provides Endorsements — authoritative statements about the Attester's
 * (equipment's) expected characteristics (calibration, firmware, specs).
 * In PCC, the `manufacturer` field in the CSD is the primary Endorser identity.
 */
export interface RATSEndorser {
  /** RATS: Endorser identity. PCC: manufacturer name in CSD */
  readonly endorserId: string;
  /** RATS: Endorsement content. PCC: calibration cert + device spec */
  endorsements: RATSEndorsement[];
}

/**
 * RATS: Reference Values
 * PCC: Tier requirements from DEFAULT_TIER_REQUIREMENTS + CSD parameter ranges
 */
export interface RATSReferenceValues {
  /** Required evidence event types for this tier (from DEFAULT_TIER_REQUIREMENTS) */
  requiredEventTypes: string[][];
  /** Expected parameter ranges from CSD */
  parameterRanges?: Record<string, { min?: number; max?: number; unit?: string }>;
  /** The assurance tier these values apply to */
  assuranceTier: AssuranceTier;
  /** Source CSD URI */
  sourceCsdUri?: string;
}

/**
 * RATS: Reference Value Provider (RVP)
 * PCC: CSD (Capability StructureDefinition)
 *
 * Provides Reference Values that the Verifier uses to appraise Evidence.
 * In PCC, CSDs define expected parameter ranges, tolerances, and required
 * event types per assurance tier.
 */
export interface RATSReferenceValueProvider {
  /** RATS: RVP identity. PCC: CSD canonical URI */
  readonly rvpId: string;
  /**
   * RATS: Reference Values for a given assurance tier.
   * PCC: DEFAULT_TIER_REQUIREMENTS + CSD parameter definitions
   */
  getReferenceValues(assuranceTier: AssuranceTier): Promise<RATSReferenceValues>;
}

// ── RATS Topology ─────────────────────────────────────────────────────────────

/**
 * A complete RATS appraisal topology for a single PCC job.
 * Captures all five roles participating in a job's evidence appraisal.
 *
 * Use this to document and trace which entities played which RATS role
 * during a specific job's evidence lifecycle.
 */
export interface RATSTopology {
  /** The Shop Kernel producing evidence */
  attester: Pick<RATSAttester, "attesterId">;
  /** The verifier(s) appraising evidence */
  verifiers: Array<Pick<RATSVerifier, "verifierId">>;
  /** The requester consuming attestation results */
  relyingParty: { entityId: string; jobId: string };
  /** The manufacturer(s) endorsing the equipment */
  endorsers: Array<Pick<RATSEndorser, "endorserId">>;
  /** The CSD providing reference values */
  referenceValueProvider: { rvpId: string; csdUri: string };
}

// ── Mapping Functions ─────────────────────────────────────────────────────────

/**
 * Convert a PCC kernel identity to a RATS Attester identity record.
 *
 * Use this when bridging PCC kernel metadata to RATS-aware consumers
 * (compliance reports, audit trails, inter-system attestation protocols).
 */
export function kernelToAttester(kernelId: string): Pick<RATSAttester, "attesterId"> {
  return { attesterId: kernelId };
}

/**
 * Convert a PCC verifier identity to a RATS Verifier identity record.
 *
 * Use this when publishing verifier identities to RATS-aware consumers
 * or when constructing a RATSTopology for a job.
 */
export function verifierToRATSVerifier(verifierId: string): Pick<RATSVerifier, "verifierId"> {
  return { verifierId };
}

/**
 * Convert a PCC EvidenceBundle to a typed RATSEvidence alias.
 *
 * This is an identity cast — the types are structurally identical.
 * Use it to make RATS terminology explicit at call sites.
 */
export function bundleToRATSEvidence(bundle: EvidenceBundle): RATSEvidence {
  return bundle;
}

/**
 * Convert a PCC VerificationAttestation to a typed RATSAttestationResult alias.
 *
 * This is an identity cast — the types are structurally identical.
 * Use it to make RATS terminology explicit at call sites.
 */
export function attestationToRATSResult(
  attestation: VerificationAttestation,
): RATSAttestationResult {
  return attestation;
}

/**
 * Build a RATSTopology from PCC job participants.
 *
 * Convenience factory for constructing a topology record suitable for
 * compliance reports, audit logs, and inter-system protocol documentation.
 */
export function buildRATSTopology(params: {
  kernelId: string;
  verifierIds: string[];
  requesterId: string;
  jobId: string;
  manufacturerIds: string[];
  csdUri: string;
}): RATSTopology {
  return {
    attester: kernelToAttester(params.kernelId),
    verifiers: params.verifierIds.map((id) => verifierToRATSVerifier(id)),
    relyingParty: { entityId: params.requesterId, jobId: params.jobId },
    endorsers: params.manufacturerIds.map((id) => ({ endorserId: id })),
    referenceValueProvider: { rvpId: params.csdUri, csdUri: params.csdUri },
  };
}

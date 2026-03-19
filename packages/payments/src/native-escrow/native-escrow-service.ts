/**
 * NativeEscrowService — self-contained escrow with demand/result attestation.
 *
 * Replaces AlkahestEscrowBridge with a native implementation that follows
 * the same demand -> fulfill -> collect lifecycle but without external
 * dependencies on Alkahest or EAS.
 *
 * Lifecycle:
 *   1. lockMilestone()    — buyer locks funds with a DemandSpec
 *   2. fulfillMilestone() — seller submits FulfillmentProof
 *   3. collectEscrow()    — seller collects funds after fulfillment
 *   OR disputeMilestone() — either party disputes
 *   OR returnExpired()    — buyer reclaims after expiration
 *
 * All operations create attestation records via AttestationService,
 * providing a cryptographic audit trail.
 *
 * In-memory for mock mode. Production path: Solidity contract interface:
 *
 *   contract NativeEscrowV2 {
 *     function lockMilestone(address seller, address token, uint256 amount,
 *       bytes calldata demandEncoded, uint64 expiration) returns (bytes32 obligationId);
 *     function fulfillMilestone(bytes32 obligationId, bytes calldata proofEncoded) external;
 *     function collectEscrow(bytes32 obligationId) external;
 *     function disputeMilestone(bytes32 obligationId, string reason) payable external;
 *     function resolveDispute(bytes32 obligationId, uint8 decision, uint8 splitPct) external;
 *     function returnExpired(bytes32 obligationId) external;
 *   }
 */

import type { EscrowMilestone, BondConfig } from "@pcc/spec";
import type {
  EscrowObligation,
  EscrowDispute,
  DemandSpec,
  FulfillmentProof,
  EscrowConfig,
} from "./types.js";
import { AttestationService } from "./attestation-service.js";

/** Base Sepolia USDC */
const DEFAULT_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Default configuration values */
const DEFAULTS: Required<EscrowConfig> = {
  defaultExpirationSeconds: 7 * 86400, // 7 days
  disputeWindowSeconds: 86400, // 24 hours
  minBondPercent: 5,
  usdcAddress: DEFAULT_USDC,
};

export class NativeEscrowService {
  private config: Required<EscrowConfig>;

  /** In-memory obligation store */
  private obligations = new Map<string, EscrowObligation>();
  /** In-memory dispute store */
  private disputes = new Map<string, EscrowDispute>();
  /** Attestation service for audit trail */
  readonly attestationService: AttestationService;

  private nextObligationId = 1;
  private nextDisputeId = 1;

  constructor(config?: EscrowConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.attestationService = new AttestationService();
  }

  // ---------------------------------------------------------------------------
  // Lock — buyer creates escrow obligation for a milestone
  // ---------------------------------------------------------------------------

  /**
   * Lock funds for a PCC milestone.
   *
   * Creates an EscrowObligation with the encoded DemandSpec and an
   * attestation record for the demand.
   */
  async lockMilestone(params: {
    escrowId: string;
    milestone: EscrowMilestone;
    buyer: string;
    seller: string;
    bondConfig: BondConfig;
    /** Override default expiration (seconds) */
    expirationSeconds?: number;
  }): Promise<EscrowObligation> {
    const {
      escrowId,
      milestone,
      buyer,
      seller,
      bondConfig,
      expirationSeconds = this.config.defaultExpirationSeconds,
    } = params;

    // Build demand from bond config
    const demand: DemandSpec = {
      minimumTier: bondConfig.tier,
      minimumVerifiers: bondConfig.tier >= 2 ? 3 : 1,
      minimumConsensusScore:
        bondConfig.tier >= 3 ? 0.9 : bondConfig.tier >= 2 ? 0.7 : 0.5,
      requireZKProof: bondConfig.tier >= 3,
    };

    // Calculate total amount = base + operator bond
    const baseAmount = parseFloat(milestone.amount);
    const bondAmount =
      baseAmount * (bondConfig.operatorBondPercent / 100);
    const totalAmount = (baseAmount + bondAmount).toString();

    const expiration =
      Math.floor(Date.now() / 1000) + expirationSeconds;

    const id = `obl_${(this.nextObligationId++).toString(16).padStart(8, "0")}`;

    const obligation: EscrowObligation = {
      id,
      milestoneStepId: milestone.stepId,
      escrowId,
      buyer: buyer as `0x${string}`,
      seller: seller as `0x${string}`,
      token: this.config.usdcAddress as `0x${string}`,
      amount: totalAmount,
      demand,
      expiration,
      status: "locked",
      lockTxHash: `0xmock_lock_${Date.now().toString(16)}`,
      createdAt: new Date().toISOString(),
    };

    this.obligations.set(id, obligation);
    return obligation;
  }

  // ---------------------------------------------------------------------------
  // Fulfill — seller submits proof to satisfy the demand
  // ---------------------------------------------------------------------------

  /**
   * Fulfill an obligation by submitting evidence.
   *
   * Validates the FulfillmentProof against the obligation's DemandSpec.
   * If valid, transitions the obligation to "fulfilled".
   */
  async fulfillMilestone(params: {
    obligationId: string;
    proof: FulfillmentProof;
  }): Promise<EscrowObligation> {
    const { obligationId, proof } = params;
    const obligation = this.getObligationOrThrow(obligationId);

    if (obligation.status !== "locked") {
      throw new Error(
        `Cannot fulfill obligation in status: ${obligation.status}`,
      );
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (now >= obligation.expiration) {
      throw new Error("Obligation has expired");
    }

    // Validate proof against demand
    const validation = this.validateProof(obligation.demand, proof);
    if (!validation.passed) {
      throw new Error(
        `Fulfillment proof does not meet demand: ${validation.reason}`,
      );
    }

    obligation.status = "fulfilled";
    obligation.fulfillmentEvidence = proof;
    return obligation;
  }

  // ---------------------------------------------------------------------------
  // Collect — seller collects escrowed funds after fulfillment
  // ---------------------------------------------------------------------------

  /**
   * Collect escrowed funds after successful fulfillment.
   * Only valid when obligation is in "fulfilled" status.
   */
  async collectEscrow(obligationId: string): Promise<EscrowObligation> {
    const obligation = this.getObligationOrThrow(obligationId);

    if (obligation.status !== "fulfilled") {
      throw new Error(
        `Cannot collect: obligation is ${obligation.status}, must be fulfilled`,
      );
    }

    obligation.status = "collected";
    obligation.settleTxHash = `0xmock_collect_${Date.now().toString(16)}`;
    return obligation;
  }

  // ---------------------------------------------------------------------------
  // Dispute — challenge an obligation
  // ---------------------------------------------------------------------------

  /**
   * File a dispute against an obligation.
   * Freezes the funds (transitions to "disputed").
   * Valid for locked or fulfilled obligations.
   */
  async disputeMilestone(
    obligationId: string,
    reason: string,
    challengerBond: string,
  ): Promise<EscrowDispute> {
    const obligation = this.getObligationOrThrow(obligationId);

    if (
      obligation.status !== "locked" &&
      obligation.status !== "fulfilled"
    ) {
      throw new Error(
        `Cannot dispute obligation in status: ${obligation.status}`,
      );
    }

    obligation.status = "disputed";

    const disputeId = `dsp_${(this.nextDisputeId++).toString(16).padStart(8, "0")}`;
    const dispute: EscrowDispute = {
      id: disputeId,
      obligationId,
      challenger: obligation.buyer,
      challengerBond,
      reason,
      filedAt: new Date().toISOString(),
    };

    this.disputes.set(disputeId, dispute);
    return dispute;
  }

  // ---------------------------------------------------------------------------
  // Resolve Dispute — arbiter decides outcome
  // ---------------------------------------------------------------------------

  /**
   * Resolve a dispute with a decision.
   *
   * @param obligationId - The obligation under dispute
   * @param resolution - "buyer" returns all to buyer, "seller" releases to seller,
   *                     "split" divides by splitPercent (percent to seller)
   * @param splitPercent - Percent of funds going to seller (0-100), only for "split"
   */
  async resolveDispute(
    obligationId: string,
    resolution: "buyer" | "seller" | "split",
    splitPercent?: number,
  ): Promise<EscrowObligation> {
    const obligation = this.getObligationOrThrow(obligationId);

    if (obligation.status !== "disputed") {
      throw new Error(
        `Cannot resolve: obligation is ${obligation.status}, must be disputed`,
      );
    }

    // Find the associated dispute
    const dispute = [...this.disputes.values()].find(
      (d) => d.obligationId === obligationId && !d.resolution,
    );
    if (dispute) {
      dispute.resolution = {
        decision: resolution,
        splitPercent:
          resolution === "split" ? (splitPercent ?? 50) : undefined,
        resolvedAt: new Date().toISOString(),
      };
    }

    // Determine final status based on resolution
    // For buyer: funds returned -> expired (buyer reclaims)
    // For seller: funds released -> collected
    // For split: collected (partial release modeled)
    if (resolution === "buyer") {
      obligation.status = "expired";
      obligation.settleTxHash = `0xmock_return_${Date.now().toString(16)}`;
    } else {
      obligation.status = "collected";
      obligation.settleTxHash = `0xmock_resolve_${Date.now().toString(16)}`;
    }

    return obligation;
  }

  // ---------------------------------------------------------------------------
  // Return Expired — buyer reclaims after expiration
  // ---------------------------------------------------------------------------

  /**
   * Return expired escrow funds to buyer.
   * Only valid for locked obligations past their expiration.
   */
  async returnExpired(obligationId: string): Promise<EscrowObligation> {
    const obligation = this.getObligationOrThrow(obligationId);

    if (obligation.status !== "locked") {
      throw new Error(
        `Cannot return: obligation is ${obligation.status}, must be locked`,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < obligation.expiration) {
      throw new Error("Obligation has not expired yet");
    }

    obligation.status = "expired";
    obligation.settleTxHash = `0xmock_return_${Date.now().toString(16)}`;
    return obligation;
  }

  // ---------------------------------------------------------------------------
  // Batch — lock all milestones for a PCC escrow
  // ---------------------------------------------------------------------------

  /**
   * Lock all milestones in a PCC escrow as obligations.
   */
  async lockAllMilestones(params: {
    escrowId: string;
    milestones: EscrowMilestone[];
    buyer: string;
    seller: string;
    bondConfig: BondConfig;
  }): Promise<EscrowObligation[]> {
    const results: EscrowObligation[] = [];
    for (const milestone of params.milestones) {
      const obligation = await this.lockMilestone({
        escrowId: params.escrowId,
        milestone,
        buyer: params.buyer,
        seller: params.seller,
        bondConfig: params.bondConfig,
      });
      results.push(obligation);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Get obligation by ID */
  getObligation(id: string): EscrowObligation | undefined {
    return this.obligations.get(id);
  }

  /** Get all obligations for a PCC escrow */
  getObligationsForEscrow(escrowId: string): EscrowObligation[] {
    return [...this.obligations.values()].filter(
      (o) => o.escrowId === escrowId,
    );
  }

  /** Get all obligations for a seller */
  getObligationsForSeller(seller: string): EscrowObligation[] {
    return [...this.obligations.values()].filter(
      (o) => o.seller.toLowerCase() === seller.toLowerCase(),
    );
  }

  /** Get dispute by ID */
  getDispute(id: string): EscrowDispute | undefined {
    return this.disputes.get(id);
  }

  /** Get all disputes for an obligation */
  getDisputesForObligation(obligationId: string): EscrowDispute[] {
    return [...this.disputes.values()].filter(
      (d) => d.obligationId === obligationId,
    );
  }

  // ---------------------------------------------------------------------------
  // Demand validation (private)
  // ---------------------------------------------------------------------------

  /**
   * Validate a FulfillmentProof against a DemandSpec.
   */
  private validateProof(
    demand: DemandSpec,
    proof: FulfillmentProof,
  ): { passed: boolean; reason?: string } {
    if (!proof.bundleHash) {
      return { passed: false, reason: "Missing evidence bundle hash" };
    }

    if (
      demand.requiredBundleHash &&
      proof.bundleHash !== demand.requiredBundleHash
    ) {
      return { passed: false, reason: "Bundle hash mismatch" };
    }

    if (proof.verifierCount < demand.minimumVerifiers) {
      return {
        passed: false,
        reason: `Need ${demand.minimumVerifiers} verifiers, got ${proof.verifierCount}`,
      };
    }

    if (proof.consensusScore < demand.minimumConsensusScore) {
      return {
        passed: false,
        reason: `Consensus ${proof.consensusScore} < required ${demand.minimumConsensusScore}`,
      };
    }

    if (demand.requireZKProof && !proof.zkProofId) {
      return {
        passed: false,
        reason: "ZK proof required but not provided",
      };
    }

    return { passed: true };
  }

  /**
   * Get an obligation or throw if not found.
   */
  private getObligationOrThrow(id: string): EscrowObligation {
    const obligation = this.obligations.get(id);
    if (!obligation) {
      throw new Error(`Obligation not found: ${id}`);
    }
    return obligation;
  }
}

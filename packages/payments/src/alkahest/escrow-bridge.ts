/**
 * Alkahest Escrow Bridge — maps PCC milestones to Alkahest obligations.
 *
 * Each PCC milestone becomes one Alkahest escrow:
 *   - Buyer (requester) locks USDC with a demand (evidence requirements)
 *   - Seller (operator) fulfills by submitting evidence + attestation
 *   - Arbiter (Bittensor consensus or trusted party) validates
 *   - Escrow releases or returns based on validation result
 *
 * Uses EAS (Ethereum Attestation Service) for recording obligations
 * and fulfillments as on-chain attestations — creating a verifiable
 * audit trail for every milestone settlement.
 *
 * In production: calls alkahest-ts SDK against Base Sepolia.
 * In mock mode: simulates the full flow with in-memory state.
 */

import type { EscrowMilestone, BondConfig } from "@pcc/spec";
import type {
  AlkahestObligation,
  AlkahestBridgeConfig,
  PCCEvidenceDemand,
  PCCEvidenceResult,
} from "./types.js";

/** Base Sepolia USDC */
const DEFAULT_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Bridge between PCC milestone escrow and Alkahest's attestation-based escrow.
 *
 * In production, this wraps alkahest-ts SDK calls. In mock mode, it simulates
 * the Alkahest escrow lifecycle for testing.
 */
export class AlkahestEscrowBridge {
  private mock: boolean;
  private rpcUrl: string;
  private usdcAddress: string;
  private defaultArbiter: string;

  /** In-memory obligation store (mock mode) */
  private obligations = new Map<string, AlkahestObligation>();
  private nextUid = 1;

  constructor(config: AlkahestBridgeConfig = {}) {
    this.mock = config.mock ?? true;
    this.rpcUrl = config.rpcUrl ?? "https://sepolia.base.org";
    this.usdcAddress = config.usdcAddress ?? DEFAULT_USDC;
    this.defaultArbiter = config.defaultArbiter ?? "0x0000000000000000000000000000000000000000";
  }

  // ---------------------------------------------------------------------------
  // Lock — buyer creates escrow obligation for a milestone
  // ---------------------------------------------------------------------------

  /**
   * Lock funds for a PCC milestone via Alkahest escrow.
   *
   * Creates an EAS attestation with:
   * - Token: USDC on Base Sepolia
   * - Amount: milestone amount + bond
   * - Arbiter: PCC verifier (Bittensor bridge or trusted party)
   * - Demand: encoded evidence requirements for the assurance tier
   */
  async lockMilestone(params: {
    pccEscrowId: string;
    milestone: EscrowMilestone;
    buyer: string;
    seller: string;
    bondConfig: BondConfig;
    /** Seconds until expiration (default: 7 days) */
    expirationSeconds?: number;
  }): Promise<AlkahestObligation> {
    const {
      pccEscrowId,
      milestone,
      buyer,
      seller,
      bondConfig,
      expirationSeconds = 7 * 86400,
    } = params;

    // Encode the evidence demand based on assurance tier
    const demand = this.encodeDemand({
      minimumTier: bondConfig.tier,
      minimumVerifiers: bondConfig.tier >= 2 ? 3 : 1,
      minimumConsensusScore: bondConfig.tier >= 3 ? 0.9 : bondConfig.tier >= 2 ? 0.7 : 0.5,
      requireZKProof: bondConfig.tier >= 3,
    });

    const totalAmount = String(
      parseFloat(milestone.amount) * (1 + bondConfig.operatorBondPercent / 100),
    );

    const expiration = Math.floor(Date.now() / 1000) + expirationSeconds;

    if (this.mock) {
      const uid = `0x${(this.nextUid++).toString(16).padStart(64, "0")}`;
      const obligation: AlkahestObligation = {
        uid,
        milestoneStepId: milestone.stepId,
        pccEscrowId,
        buyer: buyer as `0x${string}`,
        seller: seller as `0x${string}`,
        token: this.usdcAddress as `0x${string}`,
        amount: totalAmount,
        arbiter: this.defaultArbiter as `0x${string}`,
        demand,
        expiration,
        status: "locked",
        lockTxHash: `0xmock_lock_${Date.now().toString(16)}`,
      };

      this.obligations.set(uid, obligation);
      return obligation;
    }

    // Production: use alkahest-ts SDK
    // const { buyWithErc20 } = await import("alkahest-ts");
    // const uid = await buyWithErc20(walletClient, {
    //   token: this.usdcAddress,
    //   amount: parseUnits(totalAmount, 6),
    //   arbiter: this.defaultArbiter,
    //   demand: demand,
    //   expiration: BigInt(expiration),
    // });
    throw new Error("Production Alkahest integration requires wallet client — use mock mode for now");
  }

  // ---------------------------------------------------------------------------
  // Fulfill — seller submits evidence result to satisfy the demand
  // ---------------------------------------------------------------------------

  /**
   * Fulfill an Alkahest obligation by submitting evidence.
   *
   * Creates a result attestation (EAS) with the evidence bundle hash,
   * IPFS CID, and Bittensor consensus score. The arbiter validates
   * that the result meets the encoded demand requirements.
   */
  async fulfillMilestone(params: {
    obligationUid: string;
    result: PCCEvidenceResult;
  }): Promise<AlkahestObligation> {
    const { obligationUid, result } = params;
    const obligation = this.obligations.get(obligationUid);
    if (!obligation) throw new Error(`Obligation not found: ${obligationUid}`);
    if (obligation.status !== "locked") throw new Error(`Obligation not locked: ${obligation.status}`);

    // Decode demand and validate result against it
    const demand = this.decodeDemand(obligation.demand);
    const valid = this.validateResult(demand, result);

    if (!valid.passed) {
      throw new Error(`Evidence does not meet demand: ${valid.reason}`);
    }

    if (this.mock) {
      obligation.status = "fulfilled";
      obligation.fulfillmentUid = `0x${(this.nextUid++).toString(16).padStart(64, "0")}`;
      return obligation;
    }

    // Production:
    // const fulfillmentUid = await createResultAttestation(walletClient, result);
    // await collectEscrow(walletClient, { escrowUid: obligationUid, fulfillmentUid });
    throw new Error("Production mode not yet available");
  }

  // ---------------------------------------------------------------------------
  // Collect — seller collects escrowed funds after fulfillment
  // ---------------------------------------------------------------------------

  /** Collect escrowed funds after successful fulfillment */
  async collectEscrow(obligationUid: string): Promise<AlkahestObligation> {
    const obligation = this.obligations.get(obligationUid);
    if (!obligation) throw new Error(`Obligation not found: ${obligationUid}`);
    if (obligation.status !== "fulfilled") throw new Error(`Not fulfilled: ${obligation.status}`);

    if (this.mock) {
      obligation.status = "collected";
      obligation.settleTxHash = `0xmock_collect_${Date.now().toString(16)}`;
      return obligation;
    }

    // Production: collectEscrow via alkahest-ts
    throw new Error("Production mode not yet available");
  }

  // ---------------------------------------------------------------------------
  // Return — buyer reclaims expired escrow
  // ---------------------------------------------------------------------------

  /** Return expired escrow funds to buyer */
  async returnExpired(obligationUid: string): Promise<AlkahestObligation> {
    const obligation = this.obligations.get(obligationUid);
    if (!obligation) throw new Error(`Obligation not found: ${obligationUid}`);

    const now = Math.floor(Date.now() / 1000);
    if (now < obligation.expiration) throw new Error("Obligation not yet expired");
    if (obligation.status !== "locked") throw new Error(`Cannot return: ${obligation.status}`);

    if (this.mock) {
      obligation.status = "expired";
      obligation.settleTxHash = `0xmock_return_${Date.now().toString(16)}`;
      return obligation;
    }

    throw new Error("Production mode not yet available");
  }

  // ---------------------------------------------------------------------------
  // Batch — lock all milestones for a PCC escrow
  // ---------------------------------------------------------------------------

  /** Lock all milestones in a PCC escrow as Alkahest obligations */
  async lockAllMilestones(params: {
    pccEscrowId: string;
    milestones: EscrowMilestone[];
    buyer: string;
    seller: string;
    bondConfig: BondConfig;
  }): Promise<AlkahestObligation[]> {
    const results: AlkahestObligation[] = [];
    for (const milestone of params.milestones) {
      const obligation = await this.lockMilestone({
        pccEscrowId: params.pccEscrowId,
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

  /** Get obligation by UID */
  getObligation(uid: string): AlkahestObligation | undefined {
    return this.obligations.get(uid);
  }

  /** Get all obligations for a PCC escrow */
  getObligationsForEscrow(pccEscrowId: string): AlkahestObligation[] {
    return [...this.obligations.values()].filter(
      (o) => o.pccEscrowId === pccEscrowId,
    );
  }

  /** Get all obligations for a seller */
  getObligationsForSeller(seller: string): AlkahestObligation[] {
    return [...this.obligations.values()].filter(
      (o) => o.seller.toLowerCase() === seller.toLowerCase(),
    );
  }

  // ---------------------------------------------------------------------------
  // Demand encoding/decoding
  // ---------------------------------------------------------------------------

  /** Encode evidence requirements as Alkahest demand bytes */
  private encodeDemand(demand: PCCEvidenceDemand): string {
    // In production: ABI-encode with ethers/viem
    // For now: JSON encode as hex
    const json = JSON.stringify(demand);
    const hex = Buffer.from(json, "utf-8").toString("hex");
    return `0x${hex}`;
  }

  /** Decode demand bytes back to requirements */
  private decodeDemand(demandHex: string): PCCEvidenceDemand {
    const hex = demandHex.startsWith("0x") ? demandHex.slice(2) : demandHex;
    const json = Buffer.from(hex, "hex").toString("utf-8");
    return JSON.parse(json);
  }

  /** Validate evidence result against demand requirements */
  private validateResult(
    demand: PCCEvidenceDemand,
    result: PCCEvidenceResult,
  ): { passed: boolean; reason?: string } {
    if (!result.bundleHash) {
      return { passed: false, reason: "Missing evidence bundle hash" };
    }
    if (demand.requiredBundleHash && result.bundleHash !== demand.requiredBundleHash) {
      return { passed: false, reason: "Bundle hash mismatch" };
    }
    if (result.verifierCount < demand.minimumVerifiers) {
      return { passed: false, reason: `Need ${demand.minimumVerifiers} verifiers, got ${result.verifierCount}` };
    }
    if (result.consensusScore < demand.minimumConsensusScore) {
      return { passed: false, reason: `Consensus ${result.consensusScore} < required ${demand.minimumConsensusScore}` };
    }
    if (demand.requireZKProof && !result.zkProofId) {
      return { passed: false, reason: "ZK proof required but not provided" };
    }
    return { passed: true };
  }
}

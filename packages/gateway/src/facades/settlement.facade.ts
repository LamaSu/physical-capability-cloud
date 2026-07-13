/**
 * Settlement Facade — escrow management, milestone release, and batch settlement.
 *
 * Maps to L1.5 (Settlement & Escrow) in the standards taxonomy.
 * Wraps the on-chain escrow-client and settlement-service pipeline behind
 * standardized Result<T> methods.
 *
 * Covers:
 *   - DB-backed escrow CRUD (listEscrows, getEscrow)
 *   - On-chain reads (getChainState, getChainEvents, token balance/allowance, dispute state)
 *   - On-chain writes (fundEscrow, approveToken, releaseMilestone, fileDispute, depositBond,
 *     submitEvidenceHash, submitAttestation)
 *   - Batch settlement (getBatchStatus, getEpochHistory, submitBatchIntent, flushBatch)
 *   - Job settlement (releaseMilestoneForJob, getJobSettlementStatus, getJobEvidence)
 */

import { type Result, ok, err, Errors } from "@pcc/spec";
import { isAddress, type Address, type Hex } from "viem";
import type { OracleAttestation } from "@pcc/contracts";
import { BaseFacade } from "./base.facade.js";
import type {
  EscrowSummaryDTO,
  SettlementResultDTO,
  PopulationContext,
  AgentRole,
} from "./types.js";
import {
  populateEscrowDTO,
  populateEscrowList,
} from "./populators/settlement.populator.js";
import { getSettlementService } from "../services/settlement-service.js";
import { pipelineTelemetry } from "../telemetry.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";
import {
  readEscrow,
  getEscrowEvents,
  readTokenBalance,
  readTokenAllowance,
  getActiveNetwork,
} from "../chain-client.js";
import {
  getEscrowState,
  getDispute,
  getEvents,
  fundEscrow as chainFundEscrow,
  // approveToken (chainApproveToken) intentionally NOT imported: the arbitrary
  // token-approve path is disabled (audit C-03). See approveToken() below.
  releaseMilestone as chainReleaseMilestone,
  fileDispute as chainFileDispute,
  depositBond as chainDepositBond,
  submitEvidence as chainSubmitEvidence,
  submitAttestation as chainSubmitAttestation,
  isWriteEnabled,
  getSignerAddress,
  // V2 (EAS-gated) reads + writes — used under useEasV2(). The V2 milestone tuple
  // and some V2 events carry extra fields the V1 ABI cannot decode, so a V2 escrow
  // MUST be read/written through the V2 ABI or the call decode-mismatches (→ 500).
  getEscrowStateV2,
  getDisputeV2,
  getEventsV2,
  fundEscrowV2 as chainFundEscrowV2,
  depositBondV2 as chainDepositBondV2,
  fileDisputeV2 as chainFileDisputeV2,
} from "../contracts/escrow-client.js";
import {
  isBatchEnabled,
  getSmartAccountAddress,
  submitSettlement,
  flushSettlements,
  getQueueStatus,
  getEpochHistory,
} from "../contracts/batch-settlement.js";
import { swfAccrue } from "../routes/swf.js";

/**
 * Whether on-chain escrow operations route through the EAS-gated
 * MilestoneEscrowV2 ABI. Mirrors paid-job-flow + escrow routes — default OFF so
 * V1 (attestation-struct) escrows are read/written unchanged. When a deployment
 * opts in (PCC_USE_EAS_V2=true), every escrow it creates is a V2 clone, so the
 * read/write helpers must dispatch against the V2 ABI.
 */
function useEasV2(): boolean {
  return process.env.PCC_USE_EAS_V2 === "true";
}

// ── Input interfaces ────────────────────────────────────────────────────────

export interface EscrowFilters {
  status?: string;
}

export interface DisputeInput {
  challengerBond: string;
  challengerEvidenceHash: string;
  reason: string;
}

export interface BatchIntentInput {
  intentId: string;
  agentId: string;
  escrowAddress: string;
  operation: {
    type: string;
    milestoneIndex?: number;
    evidenceHash?: string;
    /** Oracle attestation struct (required for submitAttestation + release) */
    attestation?: OracleAttestation;
    bond?: string;
    reason?: string;
  };
  usdcValue?: string;
}

// ── Facade ─────────────────────────────────────────────────────────────────

export class SettlementFacade extends BaseFacade {
  protected readonly allowedRoles: readonly AgentRole[] = [
    "escrow",
    "settlement",
    "operator",
    "admin",
  ];

  constructor() {
    super("settlement");
  }

  // ── DB-backed escrow reads ──────────────────────────────────────────────

  /**
   * List escrows from DB with milestone counts.
   * Replaces: GET /api/escrow
   */
  async listEscrows(
    filters?: EscrowFilters,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<EscrowSummaryDTO[]>> {
    return this.execute("listEscrows", async () => {
      const context = this.defaultContext(ctx);
      const escrows = filters?.status
        ? this.repos.escrows.findByStatus(filters.status)
        : this.repos.escrows.findAll();

      // Batch-load milestones (prevents N+1): one IN-list query for all
      // escrow ids, grouped in memory. Every escrow gets an entry (possibly
      // empty) so populators never see a missing key.
      const milestoneMap = new Map<string, any[]>();
      for (const escrow of escrows) milestoneMap.set(escrow.id, []);
      try {
        const allMilestones = this.repos.escrows.findMilestonesByEscrowIds(
          escrows.map((e) => e.id),
        );
        for (const ms of allMilestones) {
          milestoneMap.get(ms.escrowId)?.push(ms);
        }
      } catch {
        // Milestone enrichment is best-effort — counts default to 0
      }

      return populateEscrowList(escrows, milestoneMap, context);
    });
  }

  /**
   * Get a single escrow by ID — dual path: on-chain (if isAddress) or DB.
   * Replaces: GET /api/escrow/:escrowId
   */
  async getEscrow(
    escrowId: string,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<{ escrow: unknown; source: "on-chain" | "db" }>> {
    return this.execute("getEscrow", async () => {
      // On-chain path: if escrowId looks like an Ethereum address.
      // Under V2, read via the V2 ABI — readEscrow() uses the V1 ABI and would
      // decode-mismatch a MilestoneEscrowV2 once it has a milestone.
      if (isAddress(escrowId)) {
        const escrow = useEasV2()
          ? await getEscrowStateV2(escrowId as Address)
          : await readEscrow(escrowId as Address);
        return { escrow, source: "on-chain" as const };
      }

      // DB path
      const escrow = this.repos.escrows.findById(escrowId);
      if (!escrow) {
        throw new NotFoundError("escrow", escrowId);
      }
      const milestones = this.repos.escrows.findMilestonesByEscrow(escrowId);
      const disputes = this.repos.escrows.findDisputesByEscrow(escrowId);
      return {
        escrow: { ...escrow, milestones, disputes },
        source: "db" as const,
      };
    });
  }

  // ── On-chain reads ──────────────────────────────────────────────────────

  /**
   * Get on-chain event log for an escrow contract.
   * Replaces: GET /api/escrow/chain/:address/events
   */
  async getChainEvents(
    address: Address,
    fromBlock?: bigint,
  ): Promise<Result<unknown[]>> {
    return this.execute("getChainEvents", async () => {
      this.validateAddress(address);
      // V2 emits events (e.g. MilestoneAdded w/ token) the V1 ABI mis-decodes.
      return useEasV2()
        ? getEventsV2(address, fromBlock)
        : getEscrowEvents(address, fromBlock);
    });
  }

  /**
   * Read ERC-20 token balance for an account.
   * Replaces: GET /api/escrow/chain/token/:tokenAddress/balance/:account
   */
  async getTokenBalance(
    tokenAddress: Address,
    account: Address,
  ): Promise<Result<{ balance: string; token: string; account: string }>> {
    return this.execute("getTokenBalance", async () => {
      this.validateAddress(tokenAddress);
      this.validateAddress(account);
      const balance = await readTokenBalance(tokenAddress, account);
      return { balance, token: tokenAddress, account };
    });
  }

  /**
   * Read ERC-20 token allowance.
   * Replaces: GET /api/escrow/chain/token/:tokenAddress/allowance/:owner/:spender
   */
  async getTokenAllowance(
    tokenAddress: Address,
    owner: Address,
    spender: Address,
  ): Promise<Result<{ allowance: string; token: string; owner: string; spender: string }>> {
    return this.execute("getTokenAllowance", async () => {
      this.validateAddress(tokenAddress);
      this.validateAddress(owner);
      this.validateAddress(spender);
      const allowance = await readTokenAllowance(tokenAddress, owner, spender);
      return { allowance, token: tokenAddress, owner, spender };
    });
  }

  /**
   * Read dispute state for a specific milestone.
   * Replaces: GET /api/escrow/chain/:address/dispute/:milestoneIndex
   */
  async getDispute(
    address: Address,
    milestoneIndex: number,
  ): Promise<Result<{ dispute: unknown; milestoneIndex: number; source: "on-chain" }>> {
    return this.execute("getDispute", async () => {
      this.validateAddress(address);
      this.validateMilestoneIndex(milestoneIndex);
      const dispute = useEasV2()
        ? await getDisputeV2(milestoneIndex, address)
        : await getDispute(milestoneIndex, address);
      return { dispute, milestoneIndex, source: "on-chain" as const };
    });
  }

  /**
   * Get full on-chain escrow state with parallel milestone reads.
   * Replaces: GET /api/escrow/chain/:address/state
   */
  async getChainState(
    address: Address,
  ): Promise<Result<{ escrow: unknown; source: "on-chain" }>> {
    return this.execute("getChainState", async () => {
      this.validateAddress(address);
      // V2 escrows expose a wider milestone tuple (requiredTier/jobIdHash/
      // verifierAttestationUid). Reading them with the V1 ABI decode-mismatches.
      const state = useEasV2()
        ? await getEscrowStateV2(address)
        : await getEscrowState(address);
      return { escrow: state, source: "on-chain" as const };
    });
  }

  /**
   * Check whether write operations are available.
   * Replaces: GET /api/escrow/chain/write-status
   */
  async getWriteStatus(): Promise<Result<{
    writeEnabled: boolean;
    signerAddress: string | null;
    network: string;
  }>> {
    return this.execute("getWriteStatus", async () => ({
      writeEnabled: isWriteEnabled(),
      signerAddress: getSignerAddress() ?? null,
      network: getActiveNetwork(),
    }));
  }

  // ── On-chain writes ─────────────────────────────────────────────────────

  /**
   * Fund an escrow contract (payer must have approved token transfer).
   * Replaces: POST /api/escrow/chain/:address/fund
   */
  async fundEscrow(
    address: Address,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<unknown>> {
    return this.execute("fundEscrow", async () => {
      this.validateAddress(address);
      this.requireWriteEnabled();
      // V2 fund() lives on the V2 ABI and requires >=1 on-chain milestone.
      const result = useEasV2()
        ? await chainFundEscrowV2(address)
        : await chainFundEscrow(address);
      pipelineTelemetry.emit(address, "escrow_fund", "completed", { metadata: { escrow: address } });
      trackServerEvent("escrow_funded", { amount: result?.toString?.() ?? address }, actorId);
      auditService.log({
        eventType: "escrow.funded",
        actor: actorId,
        resourceType: "escrow",
        resourceId: address,
        action: "fund",
        ip,
        userAgent,
      });
      return { ...result, action: "fund", escrow: address };
    });
  }

  /**
   * DISABLED (audit C-03 containment). Backed the removed
   * POST /api/escrow/chain/:address/approve route (now 410 Gone).
   *
   * Previously issued an ERC-20 approval from the gateway signer to a
   * caller-supplied spender/token/amount with no provenance/ownership/allowlist
   * — a drain primitive. It is now fail-closed: it performs NO approval and
   * throws (mapped to 403 by BaseFacade.execute). The only legitimate funding
   * allowance is issued inline by the escrow-create path
   * (paid-job-flow.createJobFromSession) to a freshly factory-created escrow for
   * the exact fund amount.
   *
   * Kept (throwing) rather than deleted so any residual caller fails safely
   * instead of silently type-breaking.
   *
   * TODO(audit P0 follow-up, Wave 2): replace with a typed funding operation
   * (factory-proven escrow spender + token allowlist + caller-ownership +
   * zero-to-exact amount) + treasury/relayer signer separation + rotate signer.
   */
  async approveToken(
    _address: Address,
    _amount: string,
    _tokenAddress?: Address,
  ): Promise<Result<unknown>> {
    return this.execute("approveToken", async () => {
      throw Object.assign(
        new Error(
          "Arbitrary token approval is disabled (audit C-03). The gateway signer " +
            "does not approve caller-supplied spenders/tokens; funding allowances " +
            "are issued internally to protocol-created escrows only.",
        ),
        { name: "ForbiddenError" },
      );
    });
  }

  /**
   * Release a milestone (challenge window must have expired).
   * Replaces: POST /api/escrow/chain/:address/release/:milestoneIndex
   *
   * Requires the oracle-signed Attestation struct that was submitted via
   * submitAttestation — the contract rebinds release to the exact same
   * attestation and re-verifies it on-chain via
   * PCCProtocol.collectFeeWithAttestation.
   */
  async releaseMilestone(
    address: Address,
    milestoneIndex: number,
    attestation: OracleAttestation,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<unknown>> {
    return this.execute("releaseMilestone", async () => {
      this.validateAddress(address);
      this.validateMilestoneIndex(milestoneIndex);
      this.requireWriteEnabled();
      const result = await chainReleaseMilestone(milestoneIndex, attestation, address);
      pipelineTelemetry.emit(address, "settlement_complete", "completed", {
        metadata: { escrow: address, milestoneIndex, released: true },
      });
      auditService.log({
        eventType: "escrow.released",
        actor: actorId,
        resourceType: "escrow",
        resourceId: address,
        action: "release",
        metadata: { milestoneIndex, evidenceHash: attestation.evidenceHash },
        ip,
        userAgent,
      });
      return { ...result, action: "release", escrow: address, milestoneIndex };
    });
  }

  /**
   * File a dispute against a milestone.
   * Replaces: POST /api/escrow/chain/:address/dispute/:milestoneIndex
   */
  async fileDispute(
    address: Address,
    milestoneIndex: number,
    body: DisputeInput,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<unknown>> {
    return this.execute("fileDispute", async () => {
      this.validateAddress(address);
      this.validateMilestoneIndex(milestoneIndex);
      this.requireWriteEnabled();
      if (!body.challengerBond || !body.challengerEvidenceHash || !body.reason) {
        throw Object.assign(
          new Error("Missing required fields: challengerBond, challengerEvidenceHash, reason"),
          { name: "BadRequestError" },
        );
      }
      const result = useEasV2()
        ? await chainFileDisputeV2(
            milestoneIndex,
            body.challengerBond,
            body.challengerEvidenceHash as `0x${string}`,
            body.reason,
            address,
          )
        : await chainFileDispute(
            milestoneIndex,
            body.challengerBond,
            body.challengerEvidenceHash as `0x${string}`,
            body.reason,
            address,
          );
      pipelineTelemetry.emit(address, "verification_result", "completed", {
        metadata: { escrow: address, milestoneIndex, dispute: true, reason: body.reason },
      });
      auditService.log({
        eventType: "escrow.disputed",
        actor: actorId,
        resourceType: "escrow",
        resourceId: address,
        action: "dispute",
        metadata: { milestoneIndex, reason: body.reason },
        ip,
        userAgent,
      });
      return { ...result, action: "dispute", escrow: address, milestoneIndex };
    });
  }

  /**
   * Deposit operator bond for a milestone.
   * Replaces: POST /api/escrow/chain/:address/deposit-bond/:milestoneIndex
   */
  async depositBond(
    address: Address,
    milestoneIndex: number,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<unknown>> {
    return this.execute("depositBond", async () => {
      this.validateAddress(address);
      this.validateMilestoneIndex(milestoneIndex);
      this.requireWriteEnabled();
      const result = useEasV2()
        ? await chainDepositBondV2(milestoneIndex, address)
        : await chainDepositBond(milestoneIndex, address);
      pipelineTelemetry.emit(address, "escrow_fund", "completed", {
        metadata: { escrow: address, milestoneIndex, action: "depositBond" },
      });
      auditService.log({
        eventType: "escrow.bond_deposited",
        actor: actorId,
        resourceType: "escrow",
        resourceId: address,
        action: "deposit_bond",
        metadata: { milestoneIndex },
        ip,
        userAgent,
      });
      return { ...result, action: "depositBond", escrow: address, milestoneIndex };
    });
  }

  /**
   * Submit evidence bundle hash for a milestone.
   * Replaces: POST /api/escrow/chain/:address/evidence/:milestoneIndex
   */
  async submitEvidenceHash(
    address: Address,
    milestoneIndex: number,
    evidenceBundleHash: string,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<unknown>> {
    return this.execute("submitEvidenceHash", async () => {
      this.validateAddress(address);
      this.validateMilestoneIndex(milestoneIndex);
      this.requireWriteEnabled();
      if (!evidenceBundleHash) {
        throw Object.assign(new Error("evidenceBundleHash is required"), { name: "BadRequestError" });
      }
      const result = await chainSubmitEvidence(
        milestoneIndex,
        evidenceBundleHash as `0x${string}`,
        address,
      );
      pipelineTelemetry.emit(address, "verification_request", "completed", {
        metadata: { escrow: address, milestoneIndex, evidenceBundleHash },
      });
      auditService.log({
        eventType: "escrow.evidence_submitted",
        actor: actorId,
        resourceType: "escrow",
        resourceId: address,
        action: "submit_evidence",
        metadata: { milestoneIndex, evidenceBundleHash },
        ip,
        userAgent,
      });
      return { ...result, action: "submitEvidence", escrow: address, milestoneIndex };
    });
  }

  /**
   * Submit an oracle-signed attestation for a milestone.
   * Replaces: POST /api/escrow/chain/:address/attestation/:milestoneIndex
   *
   * The caller must supply the full IPCCOracle.Attestation struct
   * returned by the oracle client (see packages/verifier/src/oracle).
   * The on-chain contract re-verifies the attestation via the protocol
   * oracle verifier before the challenge window opens.
   */
  async submitAttestation(
    address: Address,
    milestoneIndex: number,
    attestation: OracleAttestation,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<unknown>> {
    return this.execute("submitAttestation", async () => {
      this.validateAddress(address);
      this.validateMilestoneIndex(milestoneIndex);
      this.requireWriteEnabled();
      if (!attestation || !attestation.escrowAddress) {
        throw Object.assign(new Error("attestation struct is required"), { name: "BadRequestError" });
      }
      const result = await chainSubmitAttestation(
        milestoneIndex,
        attestation,
        address,
      );
      pipelineTelemetry.emit(address, "verification_result", "completed", {
        metadata: {
          escrow: address,
          milestoneIndex,
          evidenceHash: attestation.evidenceHash,
          tier: attestation.tier,
        },
      });
      auditService.log({
        eventType: "escrow.attestation_submitted",
        actor: actorId,
        resourceType: "escrow",
        resourceId: address,
        action: "submit_attestation",
        metadata: {
          milestoneIndex,
          evidenceHash: attestation.evidenceHash,
          tier: attestation.tier,
          jobId: attestation.jobId,
        },
        ip,
        userAgent,
      });
      return { ...result, action: "submitAttestation", escrow: address, milestoneIndex };
    });
  }

  // ── Batch settlement ────────────────────────────────────────────────────

  /**
   * Get ERC-4337 batch queue status.
   * Replaces: GET /api/settlement/status
   */
  async getBatchStatus(): Promise<Result<{
    pending: number;
    totalValue: string;
    smartAccountAddress: string | null;
    [key: string]: unknown;
  }>> {
    return this.execute("getBatchStatus", async () => {
      const status = getQueueStatus();
      return {
        ...status,
        totalValue: status.totalValue.toString(),
        smartAccountAddress: getSmartAccountAddress() ?? null,
      };
    });
  }

  /**
   * Get epoch history.
   * Replaces: GET /api/settlement/epochs
   */
  async getEpochHistory(): Promise<Result<{ epochs: unknown[] }>> {
    return this.execute("getEpochHistory", async () => {
      return { epochs: getEpochHistory() as unknown as unknown[] };
    });
  }

  /**
   * Submit a settlement intent to the batch queue.
   * Replaces: POST /api/settlement/submit
   */
  async submitBatchIntent(intent: BatchIntentInput): Promise<Result<unknown>> {
    return this.execute("submitBatchIntent", async () => {
      if (!isBatchEnabled()) {
        throw Object.assign(
          new Error("Batch settlement is not configured. Set PCC_BUNDLER_URL to enable."),
          { name: "BatchDisabledError" },
        );
      }

      const { intentId, agentId, escrowAddress, operation, usdcValue } = intent;

      if (!intentId || !agentId || !escrowAddress || !operation?.type) {
        throw Object.assign(
          new Error("Missing required fields: intentId, agentId, escrowAddress, operation.type"),
          { name: "BadRequestError" },
        );
      }

      if (!isAddress(escrowAddress)) {
        throw Object.assign(new Error("Invalid escrowAddress"), { name: "BadRequestError" });
      }

      const parsedOp = parseOperation(operation);
      const opId = submitSettlement({
        intentId,
        agentId,
        escrowAddress: escrowAddress as Address,
        operation: parsedOp,
        usdcValue: usdcValue ? BigInt(usdcValue) : undefined,
      });

      const status = getQueueStatus();
      return {
        operationId: opId,
        intentId,
        queued: true,
        queueStatus: {
          pending: status.pending,
          totalValue: status.totalValue.toString(),
        },
      };
    });
  }

  /**
   * Manually release a milestone for a job via the SettlementService.
   * Replaces: POST /api/settlement/release
   *
   * Requires the oracle-signed Attestation struct previously submitted
   * via submitAttestation. See SettlementService.releaseMilestone.
   */
  async releaseMilestoneForJob(
    jobId: string,
    milestoneIndex: number | undefined,
    attestation: OracleAttestation,
    contractAddress?: string,
  ): Promise<Result<SettlementResultDTO>> {
    return this.execute("releaseMilestoneForJob", async () => {
      if (!jobId) {
        throw Object.assign(new Error("jobId is required"), { name: "BadRequestError" });
      }
      if (!attestation || !attestation.escrowAddress) {
        throw Object.assign(new Error("attestation struct is required"), { name: "BadRequestError" });
      }

      const idx = milestoneIndex ?? 0;
      const service = getSettlementService();
      const result = await service.releaseMilestone(jobId, idx, attestation, contractAddress);

      if (result.status === "failed") {
        throw new Error(result.error ?? "Release failed");
      }

      // SWF accrual: 2% of released milestone value
      if (result.status === "released") {
        swfAccrue("settlement", result.jobId, 1000, "USDC", "base");
      }

      return {
        jobId: result.jobId,
        escrowId: contractAddress ?? "",
        status: result.status as SettlementResultDTO["status"],
        releasedAmount: "0",
        protocolFee: "0",
        txHash: result.txHash,
        chain: "base",
      };
    });
  }

  /**
   * Get settlement status for a completed job.
   * Replaces: GET /api/settlement/:jobId
   */
  async getJobSettlementStatus(jobId: string): Promise<Result<unknown>> {
    return this.execute("getJobSettlementStatus", async () => {
      const job = this.repos.jobs.findById(jobId);
      if (!job) {
        throw new NotFoundError("job", jobId);
      }

      const bundles = this.repos.evidence.findByJob(jobId);
      const latestBundle = bundles[bundles.length - 1] ?? null;
      const settled = job.status === "settled" || job.status === "completed";

      return {
        jobId: job.id,
        status: job.status,
        evidenceBundleId: latestBundle?.id ?? job.evidenceBundleId ?? null,
        evidenceHash: latestBundle?.bundleHash ?? null,
        assuranceTier: latestBundle?.assuranceTier ?? null,
        settled,
        settledAt: job.completedAt ?? null,
      };
    });
  }

  /**
   * Get evidence bundle details for a job.
   * Replaces: GET /api/evidence/:jobId
   */
  async getJobEvidence(jobId: string): Promise<Result<unknown>> {
    return this.execute("getJobEvidence", async () => {
      const bundles = this.repos.evidence.findByJob(jobId);
      if (bundles.length === 0) {
        throw new NotFoundError("evidence", jobId);
      }

      const enriched = bundles.map((bundle: any) => {
        const events = this.repos.evidence.findEventsByBundle(bundle.id);
        return {
          bundleId: bundle.id,
          jobId: bundle.jobId,
          stepId: bundle.stepId,
          kernelId: bundle.kernelId,
          hash: bundle.bundleHash,
          assuranceTier: bundle.assuranceTier,
          eventCount: events.length,
          events,
          storedAt: bundle.createdAt,
        };
      });

      return { jobId, bundles: enriched, count: enriched.length };
    });
  }

  /**
   * Manually flush all pending batch settlement intents (epoch settlement).
   * Replaces: POST /api/settlement/flush
   */
  async flushBatch(): Promise<Result<unknown>> {
    return this.execute("flushBatch", async () => {
      if (!isBatchEnabled()) {
        throw Object.assign(
          new Error("Batch settlement is not configured. Set PCC_BUNDLER_URL to enable."),
          { name: "BatchDisabledError" },
        );
      }

      const summary = await flushSettlements();
      pipelineTelemetry.emit(
        `epoch-${summary.epochId}`,
        "settlement_claim",
        "completed",
        { metadata: { epochId: summary.epochId, totalIntents: summary.totalIntents } },
      );

      return {
        epoch: summary.epochId,
        totalIntents: summary.totalIntents,
        batches: summary.batches.length,
        batchDetails: summary.batches.map((b: any) => ({
          userOpHash: b.userOpHash,
          operationCount: b.operationCount,
          trigger: b.trigger,
        })),
        byAgent: summary.byAgent,
        byOperation: summary.byOperation,
        duration: summary.completedAt - summary.startedAt,
      };
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private validateAddress(address: string): void {
    if (!isAddress(address)) {
      throw Object.assign(new Error("Invalid Ethereum address"), { name: "BadRequestError" });
    }
  }

  private validateMilestoneIndex(index: number): void {
    if (isNaN(index) || index < 0) {
      throw Object.assign(new Error("Invalid milestone index"), { name: "BadRequestError" });
    }
  }

  private requireWriteEnabled(): void {
    if (!isWriteEnabled()) {
      throw Object.assign(
        new Error("Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured."),
        { name: "WriteDisabledError" },
      );
    }
  }
}

/** Internal error for flow control — caught by BaseFacade.execute() */
class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' not found`);
    this.name = "NotFoundError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseOperation(op: Record<string, unknown>) {
  switch (op.type) {
    case "release":
      if (op.milestoneIndex == null) throw new Error("milestoneIndex required for release");
      if (!op.attestation) throw new Error("attestation required for release");
      return {
        type: "release" as const,
        milestoneIndex: Number(op.milestoneIndex),
        attestation: op.attestation as OracleAttestation,
      };

    case "submitEvidence":
      if (op.milestoneIndex == null || !op.evidenceHash)
        throw new Error("milestoneIndex and evidenceHash required for submitEvidence");
      return {
        type: "submitEvidence" as const,
        milestoneIndex: Number(op.milestoneIndex),
        evidenceHash: op.evidenceHash as Hex,
      };

    case "submitAttestation":
      if (op.milestoneIndex == null || !op.attestation)
        throw new Error("milestoneIndex and attestation struct required for submitAttestation");
      return {
        type: "submitAttestation" as const,
        milestoneIndex: Number(op.milestoneIndex),
        attestation: op.attestation as OracleAttestation,
      };

    case "depositBond":
      if (op.milestoneIndex == null) throw new Error("milestoneIndex required for depositBond");
      return { type: "depositBond" as const, milestoneIndex: Number(op.milestoneIndex) };

    case "fund":
      return { type: "fund" as const };

    case "fileDispute":
      if (op.milestoneIndex == null || !op.bond || !op.evidenceHash || !op.reason)
        throw new Error("milestoneIndex, bond, evidenceHash, reason required for fileDispute");
      return {
        type: "fileDispute" as const,
        milestoneIndex: Number(op.milestoneIndex),
        bond: BigInt(op.bond as string),
        evidenceHash: op.evidenceHash as Hex,
        reason: op.reason as string,
      };

    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}

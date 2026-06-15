import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { isAddress, type Address } from "viem";
import type { OracleAttestation } from "@pcc/contracts";
import { getSettlementFacade } from "../facades/index.js";
import type { DisputeInput } from "../facades/index.js";
import {
  fundEscrowActivity,
  releaseMilestoneActivity,
  fileDisputeActivity,
  depositBondActivity,
  submitEvidenceActivity,
  FacadeError,
} from "../activities/escrow.js";
import {
  submitEvidenceV2,
  submitAttestationV2,
  releaseMilestoneV2,
  isWriteEnabled as escrowWriteEnabled,
} from "../contracts/escrow-client.js";

/**
 * Whether to route the direct escrow chain routes through the EAS-gated
 * MilestoneEscrowV2 path. Mirrors paid-job-flow's flag — default OFF so the V1
 * (attestation-struct) routes are unchanged for existing callers.
 */
function useEasV2(): boolean {
  return process.env.PCC_USE_EAS_V2 === "true";
}

// ── Result→HTTP helper ────────────────────────────────────────────────────────

function sendActivityError(reply: FastifyReply, error: Error): unknown {
  if (error instanceof FacadeError) {
    return reply.status(error.httpStatus).send({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return reply.status(502).send({ error: error.message });
}

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function escrowRoutes(app: FastifyInstance) {
  const facade = getSettlementFacade();

  // ── DB-backed escrow reads ────────────────────────────────────────────

  /**
   * List escrows from DB with milestone counts.
   * Supports optional ?status= filter.
   * Returns { escrows: EscrowSummaryDTO[] }.
   */
  app.get<{ Querystring: { status?: string } }>(
    "/api/escrow",
    async (req, reply) => {
      const result = await facade.listEscrows({ status: req.query.status });
      if (result.success) return { escrows: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Get escrow by ID or on-chain address.
   * If escrowId looks like an Ethereum address: reads from chain.
   * Otherwise: reads from DB with milestones and disputes.
   * Returns { escrow, source: "on-chain"|"db" }.
   */
  app.get<{ Params: { escrowId: string } }>("/api/escrow/:escrowId", async (req, reply) => {
    const result = await facade.getEscrow(req.params.escrowId);
    return sendResult(reply, result);
  });

  // ── On-chain reads ────────────────────────────────────────────────────

  /**
   * Get on-chain event log for an escrow contract.
   * Returns { events }.
   */
  app.get<{ Params: { address: string }; Querystring: { fromBlock?: string } }>(
    "/api/escrow/chain/:address/events",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const fromBlock = req.query.fromBlock ? BigInt(req.query.fromBlock) : undefined;
      const result = await facade.getChainEvents(address as Address, fromBlock);
      if (result.success) return { events: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Read ERC-20 token balance for an account.
   */
  app.get<{ Params: { tokenAddress: string; account: string } }>(
    "/api/escrow/chain/token/:tokenAddress/balance/:account",
    async (req, reply) => {
      const { tokenAddress, account } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(account)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const result = await facade.getTokenBalance(
        tokenAddress as Address,
        account as Address,
      );
      return sendResult(reply, result);
    },
  );

  /**
   * Read ERC-20 token allowance.
   */
  app.get<{ Params: { tokenAddress: string; owner: string; spender: string } }>(
    "/api/escrow/chain/token/:tokenAddress/allowance/:owner/:spender",
    async (req, reply) => {
      const { tokenAddress, owner, spender } = req.params;
      if (!isAddress(tokenAddress) || !isAddress(owner) || !isAddress(spender)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const result = await facade.getTokenAllowance(
        tokenAddress as Address,
        owner as Address,
        spender as Address,
      );
      return sendResult(reply, result);
    },
  );

  /**
   * Read dispute state for a specific milestone.
   */
  app.get<{ Params: { address: string; milestoneIndex: string } }>(
    "/api/escrow/chain/:address/dispute/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const result = await facade.getDispute(address as Address, idx);
      return sendResult(reply, result);
    },
  );

  /**
   * Get full on-chain escrow state with parallel milestone reads.
   */
  app.get<{ Params: { address: string } }>(
    "/api/escrow/chain/:address/state",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const result = await facade.getChainState(address as Address);
      return sendResult(reply, result);
    },
  );

  /**
   * Check whether write operations are available.
   * Returns { writeEnabled, signerAddress, network }.
   */
  app.get("/api/escrow/chain/write-status", async (req, reply) => {
    const result = await facade.getWriteStatus();
    return sendResult(reply, result);
  });

  // ── On-chain writes ───────────────────────────────────────────────────

  /**
   * Fund an escrow contract (payer must have approved token transfer).
   * Returns 503 if PCC_GATEWAY_PRIVATE_KEY is not configured.
   */
  app.post<{ Params: { address: string } }>(
    "/api/escrow/chain/:address/fund",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await fundEscrowActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `fund:${address}`,
        input: [address as Address, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/fund`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * Approve token spending for an escrow contract.
   * Returns 503 if write is disabled.
   */
  app.post<{
    Params: { address: string };
    Body: { amount: string; tokenAddress?: string };
  }>(
    "/api/escrow/chain/:address/approve",
    async (req, reply) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid escrow address" });
      }
      const body = req.body as { amount?: string; tokenAddress?: string } | undefined;
      if (!body?.amount) {
        return reply.status(400).send({ error: "amount is required" });
      }

      // Bound approval to MAX_ESCROW_AMOUNT (default 1M USDC, 6 decimals)
      const maxEscrowAmount = BigInt(
        Math.floor(parseFloat(process.env.MAX_ESCROW_AMOUNT ?? "1000000") * 1_000_000),
      );
      let amountUnits: bigint;
      try {
        amountUnits = BigInt(Math.floor(parseFloat(body.amount) * 1_000_000));
      } catch {
        return reply.status(400).send({ error: "invalid_amount", message: "amount must be numeric" });
      }
      if (amountUnits <= 0n || amountUnits > maxEscrowAmount) {
        return reply.status(400).send({
          error: "amount_out_of_bounds",
          message: `Amount must be between 0 and ${process.env.MAX_ESCROW_AMOUNT ?? "1000000"} USDC`,
        });
      }

      const tokenAddr =
        body.tokenAddress && isAddress(body.tokenAddress)
          ? (body.tokenAddress as Address)
          : undefined;
      const result = await facade.approveToken(address as Address, body.amount, tokenAddr);
      return sendResult(reply, result);
    },
  );

  /**
   * Release a milestone (challenge window must have expired).
   * Requires the same oracle-signed attestation struct used in
   * submitAttestation. Returns 503 if write is disabled.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { attestation: OracleAttestation };
  }>(
    "/api/escrow/chain/:address/release/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      // V2 (EAS) path: release takes ONLY the milestone index — the binding
      // attestation was supplied at submitAttestation time (by UID), so no
      // attestation struct is re-passed here (unlike V1). Challenge window must
      // have expired (the contract enforces this and reverts otherwise).
      if (useEasV2()) {
        if (!escrowWriteEnabled()) {
          return reply.status(503).send({ error: "write_disabled", message: "Chain write not enabled (no gateway private key)." });
        }
        try {
          const result = await releaseMilestoneV2(idx, address as Address);
          return { ...result, action: "release", escrow: address, milestoneIndex: idx, path: "eas-v2" };
        } catch (err) {
          return reply.status(502).send({ error: "chain_write_failed", message: err instanceof Error ? err.message : String(err) });
        }
      }
      const body = req.body as { attestation?: OracleAttestation } | undefined;
      if (!body?.attestation || !body.attestation.escrowAddress) {
        return reply.status(400).send({
          error: "attestation_required",
          message:
            "An oracle-signed attestation struct is required in the request body.",
        });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await releaseMilestoneActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `release:${address}:${idx}`,
        input: [
          address as Address,
          idx,
          body.attestation,
          actorId,
          req.ip,
          req.headers["user-agent"],
        ] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/release/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * File a dispute against a milestone.
   * Requires: challengerBond, challengerEvidenceHash, reason.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: DisputeInput;
  }>(
    "/api/escrow/chain/:address/dispute/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await fileDisputeActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `dispute:${address}:${idx}`,
        input: [address as Address, idx, req.body, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/dispute/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * Deposit operator bond for a milestone.
   * Returns 503 if write is disabled.
   */
  app.post<{ Params: { address: string; milestoneIndex: string } }>(
    "/api/escrow/chain/:address/deposit-bond/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await depositBondActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `depositBond:${address}:${idx}`,
        input: [address as Address, idx, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/deposit-bond/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * Submit evidence bundle hash for a milestone.
   * Returns 503 if write is disabled.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { evidenceBundleHash: string };
  }>(
    "/api/escrow/chain/:address/evidence/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      const body = req.body as { evidenceBundleHash?: string } | undefined;
      if (!body?.evidenceBundleHash) {
        return reply.status(400).send({ error: "evidenceBundleHash is required" });
      }
      // V2 (EAS) path: submitEvidence has the SAME wire signature in V2, but must
      // be sent through the V2 ABI against a MilestoneEscrowV2 address.
      if (useEasV2()) {
        if (!escrowWriteEnabled()) {
          return reply.status(503).send({ error: "write_disabled", message: "Chain write not enabled (no gateway private key)." });
        }
        try {
          const result = await submitEvidenceV2(idx, body.evidenceBundleHash as `0x${string}`, address as Address);
          return { ...result, action: "submitEvidence", escrow: address, milestoneIndex: idx, path: "eas-v2" };
        } catch (err) {
          return reply.status(502).send({ error: "chain_write_failed", message: err instanceof Error ? err.message : String(err) });
        }
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId ?? "system";
      const activityResult = await submitEvidenceActivity.invoke({
        workflowRunId: `escrow:${address}`,
        activityId: `submitEvidence:${address}:${idx}`,
        input: [address as Address, idx, body.evidenceBundleHash, actorId, req.ip, req.headers["user-agent"]] as const,
        actorId,
        clientKey: req.headers["idempotency-key"] as string | undefined,
        httpMethod: "POST",
        httpPath: `/api/escrow/chain/${address}/evidence/${idx}`,
      });
      if (!activityResult.ok) {
        return sendActivityError(reply, activityResult.error);
      }
      return activityResult.value;
    },
  );

  /**
   * Submit an oracle-signed attestation for a milestone.
   * Body: { attestation: IPCCOracle.Attestation } — the full struct from
   * the oracle client. The on-chain contract re-verifies the signature
   * against the protocol oracle verifier before opening the challenge window.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { attestation: OracleAttestation };
  }>(
    "/api/escrow/chain/:address/attestation/:milestoneIndex",
    async (req, reply) => {
      const { address, milestoneIndex } = req.params;
      if (!isAddress(address)) {
        return reply.status(400).send({ error: "Invalid address" });
      }
      const idx = parseInt(milestoneIndex, 10);
      if (isNaN(idx) || idx < 0) {
        return reply.status(400).send({ error: "Invalid milestone index" });
      }
      // V2 (EAS) path: the body carries an EAS UID (bytes32) instead of the full
      // oracle attestation struct. The contract validates the UID against EAS
      // on-chain. Accept `easUid` (preferred) or legacy `attestationHash`.
      if (useEasV2()) {
        const v2body = req.body as { easUid?: string; attestationHash?: string } | undefined;
        const easUid = v2body?.easUid ?? v2body?.attestationHash;
        if (!easUid || !easUid.startsWith("0x")) {
          return reply.status(400).send({
            error: "eas_uid_required",
            message: "V2 attestation requires an EAS UID (bytes32) in `easUid` (or `attestationHash`).",
          });
        }
        if (!escrowWriteEnabled()) {
          return reply.status(503).send({ error: "write_disabled", message: "Chain write not enabled (no gateway private key)." });
        }
        try {
          const result = await submitAttestationV2(idx, easUid as `0x${string}`, address as Address);
          return { ...result, action: "submitAttestation", escrow: address, milestoneIndex: idx, easUid, path: "eas-v2" };
        } catch (err) {
          return reply.status(502).send({ error: "chain_write_failed", message: err instanceof Error ? err.message : String(err) });
        }
      }
      const body = req.body as { attestation?: OracleAttestation } | undefined;
      if (!body?.attestation || !body.attestation.escrowAddress) {
        return reply.status(400).send({
          error: "attestation_required",
          message:
            "An oracle-signed attestation struct is required in the request body.",
        });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.submitAttestation(
        address as Address,
        idx,
        body.attestation,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
    },
  );
}

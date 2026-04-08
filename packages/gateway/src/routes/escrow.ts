import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import { isAddress, type Address } from "viem";
import { getSettlementFacade } from "../facades/index.js";
import type { DisputeInput } from "../facades/index.js";

// ── Result→HTTP helper ────────────────────────────────────────────────────────

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
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.fundEscrow(
        address as Address,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
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
   * Returns 503 if write is disabled.
   */
  app.post<{ Params: { address: string; milestoneIndex: string } }>(
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
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.releaseMilestone(
        address as Address,
        idx,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
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
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.fileDispute(
        address as Address,
        idx,
        req.body,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
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
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.depositBond(
        address as Address,
        idx,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
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
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.submitEvidenceHash(
        address as Address,
        idx,
        body.evidenceBundleHash,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
    },
  );

  /**
   * Submit verifier attestation for a milestone.
   * Returns 503 if write is disabled.
   */
  app.post<{
    Params: { address: string; milestoneIndex: string };
    Body: { attestationHash: string };
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
      const body = req.body as { attestationHash?: string } | undefined;
      if (!body?.attestationHash) {
        return reply.status(400).send({ error: "attestationHash is required" });
      }
      const actorId = (req as any).operatorId ?? (req as any).apiKeyId;
      const result = await facade.submitAttestation(
        address as Address,
        idx,
        body.attestationHash,
        actorId,
        req.ip,
        req.headers["user-agent"],
      );
      return sendResult(reply, result);
    },
  );
}

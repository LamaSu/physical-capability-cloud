/**
 * PCCProtocol REST routes — root protocol contract stats and factory.
 *
 * GET  /api/protocol/state          — Protocol state (fee rate, total fees, escrow count)
 * GET  /api/protocol/fee/:amount    — Calculate fee for a given amount
 * GET  /api/protocol/escrow/:addr/fees — Fees collected from a specific escrow
 * GET  /api/protocol/token/:addr/fees  — Total fees for a token across all escrows
 * POST /api/protocol/create-escrow  — Create an escrow via the protocol factory
 */

import type { FastifyInstance } from "fastify";
import { isAddress, type Address } from "viem";
import {
  getProtocolState,
  calculateProtocolFee,
  getTotalFeesForToken,
  getFeesFromEscrow,
  isProtocolEscrow,
  createEscrowViaProtocol,
  isWriteEnabled,
  getProtocolAddress,
} from "../contracts/protocol-client.js";

export async function pccProtocolRoutes(app: FastifyInstance) {
  // ── Read routes ────────────────────────────────────────────────────

  // Protocol state: fee rate, total fees, escrow count, registry addresses
  app.get("/api/protocol/state", async (_req, reply) => {
    const address = getProtocolAddress();
    if (!address) {
      return reply.status(503).send({
        error: "protocol_not_configured",
        message: "PCCProtocol address not configured. Set PCC_PROTOCOL_ADDRESS env var.",
      });
    }

    try {
      const state = await getProtocolState(address);
      return { protocol: state, source: "on-chain" };
    } catch (err) {
      return reply.status(502).send({
        error: "protocol_read_failed",
        message: err instanceof Error ? err.message : "Failed to read protocol state",
      });
    }
  });

  // Calculate protocol fee for a given amount (in USDC units with 6 decimals)
  app.get<{ Params: { amount: string } }>(
    "/api/protocol/fee/:amount",
    async (req, reply) => {
      const rawAmount = req.params.amount;
      let amount: bigint;

      try {
        amount = BigInt(rawAmount);
      } catch {
        return reply.status(400).send({ error: "Invalid amount — must be a BigInt string (e.g. 1000000000)" });
      }

      const address = getProtocolAddress();
      if (!address) {
        return reply.status(503).send({
          error: "protocol_not_configured",
          message: "PCCProtocol address not configured.",
        });
      }

      try {
        const result = await calculateProtocolFee(amount, address);
        return {
          amount: rawAmount,
          fee: result.fee.toString(),
          feeFormatted: result.feeFormatted,
          netAmount: result.netAmount.toString(),
          netFormatted: result.netFormatted,
        };
      } catch (err) {
        return reply.status(502).send({
          error: "fee_calculation_failed",
          message: err instanceof Error ? err.message : "Failed to calculate fee",
        });
      }
    },
  );

  // Total fees collected for a token address
  app.get<{ Params: { tokenAddress: string } }>(
    "/api/protocol/token/:tokenAddress/fees",
    async (req, reply) => {
      const { tokenAddress } = req.params;
      if (!isAddress(tokenAddress)) {
        return reply.status(400).send({ error: "Invalid token address" });
      }

      const address = getProtocolAddress();
      if (!address) {
        return reply.status(503).send({ error: "protocol_not_configured" });
      }

      try {
        const fees = await getTotalFeesForToken(tokenAddress as Address, address);
        return { token: tokenAddress, totalFees: fees.raw.toString(), totalFeesFormatted: fees.formatted };
      } catch (err) {
        return reply.status(502).send({
          error: "fees_read_failed",
          message: err instanceof Error ? err.message : "Failed to read token fees",
        });
      }
    },
  );

  // Fees collected from a specific escrow contract
  app.get<{ Params: { escrowAddress: string } }>(
    "/api/protocol/escrow/:escrowAddress/fees",
    async (req, reply) => {
      const { escrowAddress } = req.params;
      if (!isAddress(escrowAddress)) {
        return reply.status(400).send({ error: "Invalid escrow address" });
      }

      const address = getProtocolAddress();
      if (!address) {
        return reply.status(503).send({ error: "protocol_not_configured" });
      }

      try {
        const [fees, isFactory] = await Promise.all([
          getFeesFromEscrow(escrowAddress as Address, address),
          isProtocolEscrow(escrowAddress as Address, address),
        ]);
        return {
          escrow: escrowAddress,
          fees: fees.raw.toString(),
          feesFormatted: fees.formatted,
          isProtocolEscrow: isFactory,
        };
      } catch (err) {
        return reply.status(502).send({
          error: "escrow_fees_read_failed",
          message: err instanceof Error ? err.message : "Failed to read escrow fees",
        });
      }
    },
  );

  // ── Write routes ────────────────────────────────────────────────────

  // Create an escrow via the protocol factory
  app.post<{
    Body: {
      payer: string;
      arbiter: string;
      token: string;
      cwmId: string;
    };
  }>(
    "/api/protocol/create-escrow",
    async (req, reply) => {
      const body = req.body as {
        payer?: string;
        arbiter?: string;
        token?: string;
        cwmId?: string;
      } | undefined;

      if (!body?.payer || !body?.arbiter || !body?.token || !body?.cwmId) {
        return reply.status(400).send({
          error: "Missing required fields: payer, arbiter, token, cwmId",
        });
      }

      if (!isAddress(body.payer) || !isAddress(body.arbiter) || !isAddress(body.token)) {
        return reply.status(400).send({ error: "payer, arbiter, and token must be valid addresses" });
      }

      if (!body.cwmId.startsWith("0x") || body.cwmId.length !== 66) {
        return reply.status(400).send({ error: "cwmId must be a 32-byte hex string (0x + 64 chars)" });
      }

      if (!isWriteEnabled()) {
        return reply.status(503).send({
          error: "write_disabled",
          message: "Write operations are not available — PCC_GATEWAY_PRIVATE_KEY is not configured.",
        });
      }

      const address = getProtocolAddress();
      if (!address) {
        return reply.status(503).send({
          error: "protocol_not_configured",
          message: "PCCProtocol address not configured. Set PCC_PROTOCOL_ADDRESS env var.",
        });
      }

      try {
        const result = await createEscrowViaProtocol(
          body.payer as Address,
          body.arbiter as Address,
          body.token as Address,
          body.cwmId as `0x${string}`,
          address,
        );
        return {
          ...result,
          action: "createEscrow",
          payer: body.payer,
          arbiter: body.arbiter,
          token: body.token,
          cwmId: body.cwmId,
        };
      } catch (err) {
        return reply.status(502).send({
          error: "create_escrow_failed",
          message: err instanceof Error ? err.message : "Failed to create escrow",
        });
      }
    },
  );
}

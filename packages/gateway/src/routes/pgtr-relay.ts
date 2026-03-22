/**
 * PGTR Relay routes -- Payment-Gated Transaction Relay (ERC-8194).
 *
 * POST /api/pgtr/relay   -- Relay a payment-gated transaction through PCCForwarder
 * GET  /api/pgtr/status   -- Check PGTR relay availability and config
 *
 * The relay endpoint accepts an EIP-3009 signed payment authorization bundled
 * with target contract call data. It verifies the request, then calls
 * PCCForwarder.relay() on-chain via the configured relayer wallet.
 */

import type { FastifyInstance } from "fastify";
import { isAddress, type Address, type Hex } from "viem";

export async function pgtrRelayRoutes(app: FastifyInstance) {
  // ── Status ──────────────────────────────────────────────────────────

  app.get("/api/pgtr/status", async () => {
    const forwarderAddress = process.env.PCC_PGTR_FORWARDER_ADDRESS;
    const relayerConfigured = !!process.env.PCC_PGTR_RELAYER_KEY;

    return {
      enabled: !!forwarderAddress && relayerConfigured,
      forwarderAddress: forwarderAddress ?? null,
      relayerConfigured,
    };
  });

  // ── Relay ───────────────────────────────────────────────────────────

  app.post<{
    Body: {
      payer: string;
      amount: string;
      nonce: string;
      expiry: number;
      target: string;
      selector: string;
      callData: string;
      v: number;
      r: string;
      s: string;
    };
  }>("/api/pgtr/relay", async (req, reply) => {
    // Check configuration
    const forwarderAddress = process.env.PCC_PGTR_FORWARDER_ADDRESS;
    const relayerKey = process.env.PCC_PGTR_RELAYER_KEY;

    if (!forwarderAddress || !relayerKey) {
      return reply.status(503).send({
        error: "pgtr_not_configured",
        message:
          "PGTR relay is not configured. Set PCC_PGTR_FORWARDER_ADDRESS and PCC_PGTR_RELAYER_KEY.",
      });
    }

    // Parse request body
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const { payer, amount, nonce, expiry, target, selector, callData, v, r, s } =
      body as {
        payer?: string;
        amount?: string;
        nonce?: string;
        expiry?: number;
        target?: string;
        selector?: string;
        callData?: string;
        v?: number;
        r?: string;
        s?: string;
      };

    // Validate required fields
    if (!payer || !amount || !nonce || !expiry || !target || !callData) {
      return reply.status(400).send({
        error: "missing_fields",
        message:
          "Required fields: payer, amount, nonce, expiry, target, callData",
      });
    }

    if (!isAddress(payer)) {
      return reply
        .status(400)
        .send({ error: "invalid_payer", message: "Invalid payer address" });
    }

    if (!isAddress(target)) {
      return reply
        .status(400)
        .send({ error: "invalid_target", message: "Invalid target address" });
    }

    if (typeof v !== "number" || !r || !s) {
      return reply.status(400).send({
        error: "invalid_signature",
        message: "Signature components v, r, s are required",
      });
    }

    if (expiry < Math.floor(Date.now() / 1000)) {
      return reply
        .status(400)
        .send({ error: "expired", message: "Relay request has expired" });
    }

    try {
      // Import viem dynamically to build and send the relay transaction.
      // In a production deployment this would use a pre-configured wallet client.
      const { createWalletClient, createPublicClient, http, encodeFunctionData } =
        await import("viem");
      const { privateKeyToAccount } = await import("viem/accounts");
      const { baseSepolia } = await import("viem/chains");

      const { PCCForwarderABI } = await import("@pcc/contracts/abi");

      // Determine chain from env or default to base-sepolia
      const rpcUrl = process.env.PCC_RPC_URL;
      const chain = baseSepolia; // TODO: support chain switching via env

      const relayerAccount = privateKeyToAccount(relayerKey as Hex);

      const walletClient = createWalletClient({
        account: relayerAccount,
        chain,
        transport: http(rpcUrl),
      });

      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
      });

      // Call PCCForwarder.relay() on-chain
      const txHash = await walletClient.writeContract({
        address: forwarderAddress as Address,
        abi: PCCForwarderABI,
        functionName: "relay",
        args: [
          payer as Address,
          target as Address,
          callData as Hex,
          BigInt(amount),
          nonce as Hex,
          BigInt(expiry),
          v,
          r as Hex,
          s as Hex,
        ],
      });

      app.log.info(
        { txHash, payer, target, amount },
        "PGTR relay transaction submitted",
      );

      return {
        txHash,
        payer,
        target,
        amount,
      };
    } catch (err) {
      app.log.error({ err, payer, target }, "PGTR relay failed");

      const message =
        err instanceof Error ? err.message : "Unknown relay error";

      // Check for common on-chain revert reasons
      if (message.includes("revert")) {
        return reply.status(422).send({
          error: "relay_reverted",
          message: `On-chain relay reverted: ${message}`,
        });
      }

      return reply.status(502).send({
        error: "relay_failed",
        message,
      });
    }
  });
}

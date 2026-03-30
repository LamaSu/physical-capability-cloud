/**
 * NEAR Protocol Integration — Cross-Chain Payment Intents
 *
 * Uses NEAR's 1Click chain abstraction API (chaindefuser.com) for
 * solver-routed cross-chain settlement. PCC agents can request
 * cross-chain payment quotes and submit intents to fund escrow
 * contracts on any chain via NEAR's solver network.
 *
 * Routes:
 *   GET  /api/near/status         — NEAR integration status + capabilities
 *   POST /api/near/quote          — Get a cross-chain payment quote
 *   POST /api/near/intent         — Submit a cross-chain payment intent
 *   GET  /api/near/intent/:id     — Check intent status
 */

import type { FastifyInstance } from "fastify";
import {
  fetchOneClickQuote,
  submitOneClickIntent,
  getOneClickIntentStatus,
  NEAR_NETWORK,
  NEAR_TESTNET_RPC,
  type OneClickQuoteRequest,
  type OneClickIntentRequest,
} from "../contracts/near-client.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { auditService } from "../services/audit-service.js";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function nearRoutes(app: FastifyInstance) {
  // ── GET /api/near/status ────────────────────────────────────────────
  //
  // Returns current NEAR integration status, network, and capabilities.
  // This is the entry-point agents use to discover whether NEAR
  // chain-abstraction is available and what chains/assets are supported.

  app.get("/api/near/status", async () => {
    const mock = process.env.NEAR_MOCK === "true" || process.env.NODE_ENV === "test";
    return {
      integration: "near-chain-abstraction",
      network: NEAR_NETWORK,
      rpc: NEAR_TESTNET_RPC,
      mock,
      capabilities: {
        crossChainQuote: true,
        crossChainIntent: true,
        intentStatusPolling: true,
        solver: "1click-chaindefuser",
      },
      supportedChains: ["near", "eth", "base", "arbitrum", "optimism", "polygon"],
      supportedAssets: ["USDC", "USDT", "NEAR", "ETH", "WBTC"],
      apiBase: "https://1click.chaindefuser.com/v0/",
      description:
        "NEAR chain abstraction enables PCC agents to fund escrow contracts " +
        "on any supported chain using any source asset. The 1Click solver " +
        "network routes cross-chain payments atomically without bridges.",
    };
  });

  // ── POST /api/near/quote ────────────────────────────────────────────
  //
  // Get a cross-chain payment quote from the 1Click solver network.
  //
  // Body: { fromChain, fromAsset, toChain, toAsset, amount, recipient? }
  // Returns: solver quote with estimated output, fee, route, validity window

  app.post<{
    Body: {
      fromChain?: string;
      fromAsset?: string;
      toChain?: string;
      toAsset?: string;
      amount?: string;
      recipient?: string;
    };
  }>("/api/near/quote", async (req, reply) => {
    const body = req.body as OneClickQuoteRequest & { recipient?: string } | undefined;

    if (!body?.fromChain) {
      return reply.status(400).send({ error: "fromChain is required" });
    }
    if (!body.fromAsset) {
      return reply.status(400).send({ error: "fromAsset is required" });
    }
    if (!body.toChain) {
      return reply.status(400).send({ error: "toChain is required" });
    }
    if (!body.toAsset) {
      return reply.status(400).send({ error: "toAsset is required" });
    }
    if (!body.amount) {
      return reply.status(400).send({ error: "amount is required" });
    }

    // Validate amount is a positive integer string
    const amountNum = BigInt(body.amount.replace(/[^0-9]/g, "") || "0");
    if (amountNum <= 0n) {
      return reply.status(400).send({ error: "amount must be a positive integer" });
    }

    try {
      const quote = await fetchOneClickQuote({
        fromChain: body.fromChain,
        fromAsset: body.fromAsset,
        toChain: body.toChain,
        toAsset: body.toAsset,
        amount: body.amount,
        recipient: body.recipient,
      });

      trackServerEvent("near_quote_requested", {
        fromChain: body.fromChain,
        toChain: body.toChain,
        fromAsset: body.fromAsset,
        toAsset: body.toAsset,
      }, (req as any).operatorId);
      return {
        quote,
        _meta: {
          integration: "near-1click",
          network: NEAR_NETWORK,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (err) {
      return reply.status(502).send({
        error: "quote_failed",
        message: err instanceof Error ? err.message : "Failed to fetch quote from 1Click",
      });
    }
  });

  // ── POST /api/near/intent ───────────────────────────────────────────
  //
  // Submit a cross-chain payment intent. Call /quote first to get a quoteId.
  // This creates a signed intent in the 1Click solver network that routes
  // the payment atomically across chains.
  //
  // Body: { quoteId, workflowId, recipient? }
  // Returns: intentId, status, txHash (when available), explorerUrl

  app.post<{
    Body: {
      quoteId?: string;
      workflowId?: string;
      recipient?: string;
    };
  }>("/api/near/intent", async (req, reply) => {
    const body = req.body as OneClickIntentRequest | undefined;

    if (!body?.quoteId) {
      return reply.status(400).send({ error: "quoteId is required" });
    }
    if (!body.workflowId) {
      return reply.status(400).send({ error: "workflowId is required" });
    }

    try {
      const intent = await submitOneClickIntent({
        quoteId: body.quoteId,
        workflowId: body.workflowId,
        recipient: body.recipient,
      });

      trackServerEvent("near_intent_submitted", {
        quoteId: body.quoteId,
        workflowId: body.workflowId,
        intentId: intent.intentId,
      }, (req as any).operatorId);
      auditService.log({
        eventType: "near.intent_submitted",
        actor: (req as any).operatorId ?? (req as any).apiKeyId,
        resourceType: "near_intent",
        resourceId: intent.intentId,
        action: "create",
        metadata: { quoteId: body.quoteId, workflowId: body.workflowId },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      return {
        intent,
        _meta: {
          integration: "near-1click",
          network: NEAR_NETWORK,
          timestamp: new Date().toISOString(),
          note:
            "Poll GET /api/near/intent/:intentId to track settlement status. " +
            "Intents are typically settled within 30-60 seconds.",
        },
      };
    } catch (err) {
      return reply.status(502).send({
        error: "intent_failed",
        message: err instanceof Error ? err.message : "Failed to submit intent to 1Click",
      });
    }
  });

  // ── GET /api/near/intent/:intentId ─────────────────────────────────
  //
  // Check the current status of a submitted intent.
  // Statuses: pending → submitted → settled | failed
  //
  // Returns: intentId, status, txHash, settlementTxHash, chain info

  app.get<{ Params: { intentId: string } }>(
    "/api/near/intent/:intentId",
    async (req, reply) => {
      const { intentId } = req.params;

      if (!intentId || intentId.trim() === "") {
        return reply.status(400).send({ error: "intentId is required" });
      }

      try {
        const status = await getOneClickIntentStatus(intentId);
        return {
          status,
          _meta: {
            integration: "near-1click",
            network: NEAR_NETWORK,
            timestamp: new Date().toISOString(),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          return reply.status(404).send({ error: "intent_not_found", intentId });
        }
        return reply.status(502).send({
          error: "status_failed",
          message: msg,
        });
      }
    },
  );
}

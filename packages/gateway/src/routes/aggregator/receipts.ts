/**
 * GET /api/aggregator/receipts/:cid — fetch a persisted InvocationReceipt by CID.
 *
 * Public (any caller can verify a receipt they were given). Returns the full
 * receipt body + a fresh evaluation. If the receipt is not found, returns 404.
 *
 * Auxiliary route:
 *   GET /api/aggregator/receipts/by-tool/:toolId — recent receipts for a tool
 *   GET /api/aggregator/receipts/by-caller/:agentId — recent receipts for caller
 */

import type { FastifyInstance } from "fastify";
import type { InvocationReceipt } from "@pcc/spec";
import { evaluateReceipt } from "@pcc/verifier";
import { getRepos } from "../../db.js";
import { getAggregatorRegistry } from "./index.js";

interface ReceiptResponse {
  receipt: InvocationReceipt;
  evaluation: {
    finalScore: number;
    verdict: "valid" | "invalid" | "inconclusive";
    confidence: number;
  };
}

interface ReceiptListResponse {
  receipts: InvocationReceipt[];
}

export async function receiptsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { cid: string };
    Reply: ReceiptResponse | { error: string };
  }>("/api/aggregator/receipts/:cid", async (req, reply) => {
    try {
      const repos = getRepos();
      const row = repos.invocationReceipts.findByCid(req.params.cid);
      if (!row) return reply.status(404).send({ error: "receipt_not_found" });
      const receipt = row.body as unknown as InvocationReceipt;
      const tool = getAggregatorRegistry().get(receipt.indexedToolId);
      const evaluation = await evaluateReceipt(receipt, tool);
      return reply.send({
        receipt,
        evaluation: {
          finalScore: evaluation.finalScore,
          verdict: evaluation.verdict,
          confidence: evaluation.confidence,
        },
      });
    } catch (err) {
      return reply.status(500).send({
        error: "internal_error",
      });
    }
  });

  app.get<{
    Params: { toolId: string };
    Querystring: { limit?: string };
    Reply: ReceiptListResponse | { error: string };
  }>("/api/aggregator/receipts/by-tool/:toolId", async (req, reply) => {
    try {
      const repos = getRepos();
      const limit = parseLimit(req.query.limit);
      const rows = repos.invocationReceipts.findByTool(
        req.params.toolId,
        limit,
      );
      const receipts = rows.map(
        (r) => r.body as unknown as InvocationReceipt,
      );
      return reply.send({ receipts });
    } catch {
      return reply.status(500).send({ error: "internal_error" });
    }
  });

  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string };
    Reply: ReceiptListResponse | { error: string };
  }>("/api/aggregator/receipts/by-caller/:agentId", async (req, reply) => {
    try {
      const repos = getRepos();
      const limit = parseLimit(req.query.limit);
      const rows = repos.invocationReceipts.findByCaller(
        req.params.agentId,
        limit,
      );
      const receipts = rows.map(
        (r) => r.body as unknown as InvocationReceipt,
      );
      return reply.send({ receipts });
    } catch {
      return reply.status(500).send({ error: "internal_error" });
    }
  });
}

function parseLimit(s: string | undefined): number {
  const n = Number.parseInt(s ?? "50", 10);
  if (Number.isNaN(n)) return 50;
  return Math.min(500, Math.max(1, n));
}

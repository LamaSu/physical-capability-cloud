/**
 * Settlement routes — batch settlement via ERC-4337.
 *
 * POST /api/settlement/submit   — Submit a settlement intent to the batch queue
 * POST /api/settlement/flush    — Manually flush all pending intents (epoch settlement)
 * GET  /api/settlement/status   — Queue status (pending ops, total value, age)
 * GET  /api/settlement/epochs   — Epoch history (past settlements)
 */

import type { FastifyInstance } from "fastify";
import { isAddress, type Address, type Hex } from "viem";
import {
  isBatchEnabled,
  getSmartAccountAddress,
  submitSettlement,
  flushSettlements,
  getQueueStatus,
  getEpochHistory,
} from "../contracts/batch-settlement.js";

export async function settlementRoutes(app: FastifyInstance) {
  // ── Status ────────────────────────────────────────────────────────

  app.get("/api/settlement/status", async () => {
    const status = getQueueStatus();
    return {
      ...status,
      // bigint → string for JSON serialization
      totalValue: status.totalValue.toString(),
      smartAccountAddress: getSmartAccountAddress() ?? null,
    };
  });

  // ── Epoch history ─────────────────────────────────────────────────

  app.get("/api/settlement/epochs", async () => {
    const epochs = getEpochHistory();
    return { epochs };
  });

  // ── Submit intent ─────────────────────────────────────────────────

  app.post<{
    Body: {
      intentId: string;
      agentId: string;
      escrowAddress: string;
      operation: {
        type: string;
        milestoneIndex?: number;
        evidenceHash?: string;
        attestationHash?: string;
        bond?: string;
        reason?: string;
      };
      usdcValue?: string;
    };
  }>("/api/settlement/submit", async (req, reply) => {
    if (!isBatchEnabled()) {
      return reply.status(503).send({
        error: "batch_disabled",
        message: "Batch settlement is not configured. Set PCC_BUNDLER_URL to enable.",
      });
    }

    const body = req.body as Record<string, unknown> | undefined;
    if (!body) {
      return reply.status(400).send({ error: "Request body is required" });
    }

    const { intentId, agentId, escrowAddress, operation, usdcValue } = body as any;

    if (!intentId || !agentId || !escrowAddress || !operation?.type) {
      return reply.status(400).send({
        error: "Missing required fields: intentId, agentId, escrowAddress, operation.type",
      });
    }

    if (!isAddress(escrowAddress)) {
      return reply.status(400).send({ error: "Invalid escrowAddress" });
    }

    try {
      // Parse the operation into the correct typed shape
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
    } catch (err) {
      return reply.status(400).send({
        error: "invalid_operation",
        message: err instanceof Error ? err.message : "Failed to parse operation",
      });
    }
  });

  // ── Flush (manual epoch settlement) ───────────────────────────────

  app.post("/api/settlement/flush", async (req, reply) => {
    if (!isBatchEnabled()) {
      return reply.status(503).send({
        error: "batch_disabled",
        message: "Batch settlement is not configured. Set PCC_BUNDLER_URL to enable.",
      });
    }

    try {
      const summary = await flushSettlements();
      return {
        epoch: summary.epochId,
        totalIntents: summary.totalIntents,
        batches: summary.batches.length,
        batchDetails: summary.batches.map((b) => ({
          userOpHash: b.userOpHash,
          operationCount: b.operationCount,
          trigger: b.trigger,
        })),
        byAgent: summary.byAgent,
        byOperation: summary.byOperation,
        duration: summary.completedAt - summary.startedAt,
      };
    } catch (err) {
      return reply.status(502).send({
        error: "flush_failed",
        message: err instanceof Error ? err.message : "Failed to flush settlements",
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOperation(op: Record<string, unknown>) {
  switch (op.type) {
    case "release":
      if (op.milestoneIndex == null) throw new Error("milestoneIndex required for release");
      return { type: "release" as const, milestoneIndex: Number(op.milestoneIndex) };

    case "submitEvidence":
      if (op.milestoneIndex == null || !op.evidenceHash)
        throw new Error("milestoneIndex and evidenceHash required for submitEvidence");
      return {
        type: "submitEvidence" as const,
        milestoneIndex: Number(op.milestoneIndex),
        evidenceHash: op.evidenceHash as Hex,
      };

    case "submitAttestation":
      if (op.milestoneIndex == null || !op.attestationHash)
        throw new Error("milestoneIndex and attestationHash required for submitAttestation");
      return {
        type: "submitAttestation" as const,
        milestoneIndex: Number(op.milestoneIndex),
        attestationHash: op.attestationHash as Hex,
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

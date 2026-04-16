/**
 * Settlement routes — batch settlement via ERC-4337 + evidence-to-settlement flow.
 *
 * POST /api/settlement/submit        — Submit a settlement intent to the batch queue
 * POST /api/settlement/flush         — Manually flush all pending intents (epoch settlement)
 * GET  /api/settlement/status        — Queue status (pending ops, total value, age)
 * GET  /api/settlement/epochs        — Epoch history (past settlements)
 * POST /api/settlement/release       — Manually release a milestone escrow for a job
 * GET  /api/settlement/:jobId        — Settlement status for a completed job
 * GET  /api/evidence/:jobId          — Evidence bundle details for a job
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { isAddress, type Address, type Hex } from "viem";
import type { Result } from "@pcc/spec";
import { pipelineTelemetry } from "../telemetry.js";
import { getSettlementService } from "../services/settlement-service.js";
import { getSettlementFacade } from "../facades/index.js";
import { swfAccrue } from "./swf.js";
import { releaseMilestoneByJobActivity } from "../activities/escrow.js";
import {
  isBatchEnabled,
  getSmartAccountAddress,
  submitSettlement,
  flushSettlements,
  getQueueStatus,
  getEpochHistory,
} from "../contracts/batch-settlement.js";

function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

export async function settlementRoutes(app: FastifyInstance) {
  const settlementFacade = getSettlementFacade();
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
      // Validate usdcValue before BigInt conversion
      if (usdcValue !== undefined && usdcValue !== null) {
        const raw = String(usdcValue);
        if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
          return reply.status(400).send({ error: "Invalid usdcValue — must be a numeric or hex string" });
        }
      }

      // Parse the operation into the correct typed shape
      const parsedOp = parseOperation(operation);

      const opId = submitSettlement({
        intentId,
        agentId,
        escrowAddress: escrowAddress as Address,
        operation: parsedOp,
        usdcValue: usdcValue ? (() => { try { return BigInt(usdcValue); } catch { return undefined; } })() : undefined,
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

  // ── Release milestone (evidence-to-settlement) ────────────────────

  app.post<{
    Body: { jobId: string; milestoneIndex?: number; contractAddress?: string };
  }>("/api/settlement/release", async (req, reply) => {
    const body = req.body as {
      jobId?: string;
      milestoneIndex?: number;
      contractAddress?: string;
    } | undefined;

    if (!body?.jobId) {
      return reply.status(400).send({ error: "jobId is required" });
    }

    const milestoneIndex = body.milestoneIndex ?? 0;

    const activityResult = await releaseMilestoneByJobActivity.invoke({
      workflowRunId: `settlement:${body.jobId}`,
      activityId: `release:${body.jobId}:${milestoneIndex}`,
      input: [body.jobId, milestoneIndex, body.contractAddress] as const,
      actorId: "system",
    });

    if (!activityResult.ok) {
      return reply.status(502).send({
        error: "release_failed",
        message: activityResult.error.message,
        jobId: body.jobId,
      });
    }

    const result = activityResult.value;

    if (result.status === "failed") {
      return reply.status(502).send({
        error: "release_failed",
        message: result.error,
        jobId: result.jobId,
      });
    }

    // SWF accrual: 2% of released milestone value flows into the fund
    if (result.status === "released") {
      swfAccrue("settlement", result.jobId, 1000, "USDC", "base");
    }

    return {
      txHash: result.txHash,
      status: result.status,
      jobId: result.jobId,
      milestoneIndex,
    };
  });

  // ── Settlement status for a job ───────────────────────────────────

  app.get<{ Params: { jobId: string } }>("/api/settlement/:jobId", async (req, reply) => {
    // Guard against routes that look like ":jobId" matching "status", "epochs", "submit", etc.
    const { jobId } = req.params;
    if (["status", "epochs", "submit", "flush", "release"].includes(jobId)) {
      return reply.status(404).send({ error: "not_found" });
    }

    const result = await settlementFacade.getJobSettlementStatus(jobId);
    return sendResult(reply, result);
  });

  // ── Evidence bundle details for a job ─────────────────────────────

  app.get<{ Params: { jobId: string } }>("/api/evidence/:jobId", async (req, reply) => {
    const result = await settlementFacade.getJobEvidence(req.params.jobId);
    return sendResult(reply, result);
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
      pipelineTelemetry.emit("epoch-" + summary.epochId, "settlement_claim", "completed", { metadata: { epochId: summary.epochId, totalIntents: summary.totalIntents } });
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
      {
        const bondStr = String(op.bond);
        if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(bondStr)) {
          throw new Error("bond must be a numeric or hex string");
        }
        return {
          type: "fileDispute" as const,
          milestoneIndex: Number(op.milestoneIndex),
          bond: BigInt(bondStr),
          evidenceHash: op.evidenceHash as Hex,
          reason: op.reason as string,
        };
      }

    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}

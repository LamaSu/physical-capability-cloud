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

import type { FastifyInstance } from "fastify";
import { isAddress, type Address, type Hex } from "viem";
import { getRepos } from "../db.js";
import { pipelineTelemetry } from "../telemetry.js";
import { getSettlementService } from "../services/settlement-service.js";
import { swfAccrue } from "./swf.js";
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
    const service = getSettlementService();

    try {
      const result = await service.releaseMilestone(
        body.jobId,
        milestoneIndex,
        body.contractAddress,
      );

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
    } catch (err) {
      return reply.status(500).send({
        error: "release_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // ── Settlement status for a job ───────────────────────────────────

  app.get<{ Params: { jobId: string } }>("/api/settlement/:jobId", async (req, reply) => {
    // Guard against routes that look like ":jobId" matching "status", "epochs", "submit", etc.
    const { jobId } = req.params;
    if (["status", "epochs", "submit", "flush", "release"].includes(jobId)) {
      return reply.status(404).send({ error: "not_found" });
    }

    try {
      const repos = getRepos();
      const job = repos.jobs.findById(jobId);
      if (!job) {
        return reply.status(404).send({ error: "not_found" });
      }

      const bundles = repos.evidence.findByJob(jobId);
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
    } catch (err) {
      return reply.status(500).send({
        error: "query_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // ── Evidence bundle details for a job ─────────────────────────────

  app.get<{ Params: { jobId: string } }>("/api/evidence/:jobId", async (req, reply) => {
    try {
      const repos = getRepos();
      const bundles = repos.evidence.findByJob(req.params.jobId);

      if (bundles.length === 0) {
        return reply.status(404).send({ error: "not_found" });
      }

      const enriched = bundles.map((bundle) => {
        const events = repos.evidence.findEventsByBundle(bundle.id);
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

      return {
        jobId: req.params.jobId,
        bundles: enriched,
        count: enriched.length,
      };
    } catch (err) {
      return reply.status(500).send({
        error: "query_failed",
        message: err instanceof Error ? err.message : "Unknown error",
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

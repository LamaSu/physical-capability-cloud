/**
 * TMP Task Routes -- REST API for TMP procurement mode operations.
 *
 * Bridges PCC milestones to ERC-8195 Task Management Protocol:
 * - Create TMP tasks for milestones
 * - Submit bids, pitches, claims
 * - Auto-select procurement modes
 * - Validate benchmark proofs
 */

import type { FastifyInstance } from "fastify";
import type {
  TMPMode,
  MilestoneProcurement,
  ModeConfig,
  Address,
} from "@pcc/spec";
import { selectMode, getAvailableModes } from "@pcc/scheduler";
import {
  TMPValidatorBridge,
  EvidenceVerifier,
  CommitmentService,
  ZKProofService,
  BittensorSubnetBridge,
} from "@pcc/verifier";
import type { BenchmarkProofEnvelope } from "@pcc/verifier";

// ── In-Memory Store (dev mode) ───────────────────────────────────────

const tmpTasks: Map<string, MilestoneProcurement> = new Map();

// ── Singleton Validator Bridge ───────────────────────────────────────

const validatorBridge = new TMPValidatorBridge(
  new EvidenceVerifier("tmp-validator", "0x0000000000000000000000000000000000000001"),
  new CommitmentService(),
  new ZKProofService(),
  new BittensorSubnetBridge({ numMinersToQuery: 5, minScoreThreshold: 0.6 }),
);

// ── Routes ───────────────────────────────────────────────────────────

export async function tmpTaskRoutes(app: FastifyInstance) {
  // ── List available TMP modes ───────────────────────────────────────

  app.get("/api/tmp/modes", async () => {
    const modes = getAvailableModes();
    return { modes, count: modes.length };
  });

  // ── Auto-select mode for a capability type ─────────────────────────

  app.post<{
    Body: {
      capabilityType?: string;
      assuranceTier?: number;
      workerPreAssigned?: boolean;
      requiresProposal?: boolean;
      priceCompetitive?: boolean;
      automatedVerification?: boolean;
    };
  }>("/api/tmp/select-mode", async (req, reply) => {
    const body = (req.body ?? {}) as {
      capabilityType?: string;
      assuranceTier?: number;
      workerPreAssigned?: boolean;
      requiresProposal?: boolean;
      priceCompetitive?: boolean;
      automatedVerification?: boolean;
    };

    if (!body.capabilityType) {
      return reply.code(400).send({
        error: "bad_request",
        message: "capabilityType is required",
      });
    }

    const result = selectMode(
      body.capabilityType,
      (body.assuranceTier ?? 1) as 0 | 1 | 2 | 3,
      {
        workerPreAssigned: body.workerPreAssigned,
        requiresProposal: body.requiresProposal,
        priceCompetitive: body.priceCompetitive,
        automatedVerification: body.automatedVerification,
      },
    );

    return { selection: result };
  });

  // ── Create TMP task for a milestone ────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-task",
    async (req, reply) => {
      const milestoneId = req.params.id;
      const body = (req.body ?? {}) as {
        mode?: TMPMode;
        modeConfig?: ModeConfig;
      };

      if (!body.mode || !body.modeConfig) {
        return reply.code(400).send({
          error: "bad_request",
          message: "mode and modeConfig are required",
        });
      }

      // Validate mode matches config
      if (body.mode !== body.modeConfig.mode) {
        return reply.code(400).send({
          error: "bad_request",
          message: `mode '${body.mode}' does not match modeConfig.mode '${body.modeConfig.mode}'`,
        });
      }

      const task: MilestoneProcurement = {
        milestoneId,
        mode: body.mode,
        modeConfig: body.modeConfig,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      tmpTasks.set(milestoneId, task);

      return reply.code(201).send({ task });
    },
  );

  // ── Get TMP task for a milestone ───────────────────────────────────

  app.get<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-task",
    async (req, reply) => {
      const task = tmpTasks.get(req.params.id);
      if (!task) {
        return reply.code(404).send({
          error: "not_found",
          message: `No TMP task for milestone ${req.params.id}`,
        });
      }
      return { task };
    },
  );

  // ── Submit bid (auction mode) ──────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-bid",
    async (req, reply) => {
      const task = tmpTasks.get(req.params.id);
      if (!task) {
        return reply.code(404).send({
          error: "not_found",
          message: `No TMP task for milestone ${req.params.id}`,
        });
      }

      if (task.mode !== "auction") {
        return reply.code(400).send({
          error: "invalid_mode",
          message: `Milestone ${req.params.id} uses '${task.mode}' mode, not auction`,
        });
      }

      const body = (req.body ?? {}) as {
        bidder?: string;
        amount?: string;
      };

      if (!body.bidder || !body.amount) {
        return reply.code(400).send({
          error: "bad_request",
          message: "bidder and amount are required",
        });
      }

      // In production, this would interact with the on-chain auction contract
      return {
        milestoneId: req.params.id,
        bidder: body.bidder,
        amount: body.amount,
        status: "bid_accepted",
        timestamp: new Date().toISOString(),
      };
    },
  );

  // ── Submit pitch ───────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-pitch",
    async (req, reply) => {
      const task = tmpTasks.get(req.params.id);
      if (!task) {
        return reply.code(404).send({
          error: "not_found",
          message: `No TMP task for milestone ${req.params.id}`,
        });
      }

      if (task.mode !== "pitch") {
        return reply.code(400).send({
          error: "invalid_mode",
          message: `Milestone ${req.params.id} uses '${task.mode}' mode, not pitch`,
        });
      }

      const body = (req.body ?? {}) as {
        pitcher?: string;
        proposal?: string;
        estimatedCost?: string;
        estimatedDuration?: number;
      };

      if (!body.pitcher || !body.proposal) {
        return reply.code(400).send({
          error: "bad_request",
          message: "pitcher and proposal are required",
        });
      }

      return {
        milestoneId: req.params.id,
        pitcher: body.pitcher,
        proposal: body.proposal,
        estimatedCost: body.estimatedCost,
        estimatedDuration: body.estimatedDuration,
        status: "pitch_received",
        timestamp: new Date().toISOString(),
      };
    },
  );

  // ── Claim task with stake ──────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-claim",
    async (req, reply) => {
      const task = tmpTasks.get(req.params.id);
      if (!task) {
        return reply.code(404).send({
          error: "not_found",
          message: `No TMP task for milestone ${req.params.id}`,
        });
      }

      if (task.mode !== "claim") {
        return reply.code(400).send({
          error: "invalid_mode",
          message: `Milestone ${req.params.id} uses '${task.mode}' mode, not claim`,
        });
      }

      const body = (req.body ?? {}) as {
        worker?: string;
        stakeAmount?: string;
      };

      if (!body.worker) {
        return reply.code(400).send({
          error: "bad_request",
          message: "worker address is required",
        });
      }

      // Mark task as active
      task.status = "active";

      return {
        milestoneId: req.params.id,
        worker: body.worker,
        stakeAmount: body.stakeAmount,
        status: "claimed",
        timestamp: new Date().toISOString(),
      };
    },
  );

  // ── Validate benchmark proof ───────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-validate",
    async (req, reply) => {
      const task = tmpTasks.get(req.params.id);
      if (!task) {
        return reply.code(404).send({
          error: "not_found",
          message: `No TMP task for milestone ${req.params.id}`,
        });
      }

      if (task.mode !== "benchmark") {
        return reply.code(400).send({
          error: "invalid_mode",
          message: `Milestone ${req.params.id} uses '${task.mode}' mode, not benchmark`,
        });
      }

      const body = (req.body ?? {}) as Partial<BenchmarkProofEnvelope>;

      if (!body.proofType || !body.proof || !body.worker) {
        return reply.code(400).send({
          error: "bad_request",
          message: "proofType, proof, and worker are required",
        });
      }

      const envelope: BenchmarkProofEnvelope = {
        taskId: task.tmpTaskId ?? req.params.id,
        contractAddress: task.tmpContractAddress ?? ("0x0000000000000000000000000000000000000000" as Address),
        chainId: body.chainId ?? 84532,
        worker: body.worker as Address,
        deliverable: body.deliverable ?? "",
        metricTarget: (task.modeConfig as { metricTarget?: string }).metricTarget ?? "",
        proofType: body.proofType,
        proof: body.proof,
        submittedAt: new Date().toISOString(),
      };

      const result = await validatorBridge.validate(envelope);
      const acceptance = validatorBridge.formatAcceptance(envelope, result);

      // Update task status if validation passed
      if (acceptance.accepted) {
        task.status = "completed";
        task.completedAt = new Date().toISOString();
      }

      return { result, acceptance };
    },
  );
}

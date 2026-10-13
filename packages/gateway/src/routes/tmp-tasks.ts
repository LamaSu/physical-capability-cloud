/**
 * TMP Task Routes -- REST API for TMP procurement mode operations.
 *
 * Bridges PCC milestones to ERC-8195 Task Management Protocol:
 * - Create TMP tasks for milestones
 * - Submit bids, pitches, claims
 * - Auto-select procurement modes
 * - Validate benchmark proofs
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  TMPMode,
  MilestoneProcurement,
  ModeConfig,
  BenchmarkConfig,
  Address,
} from "@pcc/spec";
import { selectMode, getAvailableModes } from "@pcc/scheduler";
import {
  TMPValidatorBridge,
  EvidenceVerifier,
  CommitmentService,
  ZKProofService,
  OracleVerificationBridge,
  configFromEnv,
  TIER_ENFORCING_PIPELINES,
} from "@pcc/verifier";
import type { BenchmarkProofEnvelope } from "@pcc/verifier";
import type { TmpTaskRecord, TmpTaskStore } from "../services/tmp-task-store.js";

// ── Authoritative task state (E11e) ──────────────────────────────────

/**
 * What decides a TMP proof's verdict (the tier and the pipeline) comes from the TASK, and the task comes
 * only from the milestone's owner (its poster), never from a worker's submission or another caller
 * (N118, restated end to end in bus #6161).
 */
export interface TmpTaskRouteOptions {
  /**
   * The principal that owns a milestone (its poster), from authoritative state outside this route, or
   * null when unknown. With a resolver, only that owner creates the milestone's task. Wire it only with a
   * PROVEN caller principal: today an API key's operatorId is whatever its self-service sign-up typed
   * (routes/provision.ts), which proves nothing until WP-A proves an operator's wallet.
   */
  milestoneOwner?: (milestoneId: string) => Promise<string | null> | string | null;
  /**
   * The admin exception while no resolver is wired (the steward's ruling on #6182, the N55 precedent):
   * only a caller this answers exactly `true` for creates a task, and everyone else is refused. In the
   * gateway it is an API key holding the literal "admin" scope (hasAdminScope). Absent, throwing, or any
   * other answer: no admin. With a resolver wired, the owner path alone applies.
   */
  isAdmin?: (req: FastifyRequest) => boolean | Promise<boolean>;
  /**
   * Where tasks live: durable and write-once, because a task's tier and pipeline decide its verdicts
   * (E11f). The gateway wires FsTmpTaskStore on its volume (server.ts); tests pass MemoryTmpTaskStore.
   * Without a store, no task is created and none is read: the routes fail closed.
   */
  store?: TmpTaskStore;
}

/** The caller's authenticated principal: the operator behind the API key, else the key, else the session user. */
function callerPrincipal(req: FastifyRequest): string | null {
  const r = req as unknown as { operatorId?: unknown; apiKeyId?: unknown; userId?: unknown };
  for (const v of [r.operatorId, r.apiKeyId, r.userId]) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

const ASSURANCE_TIERS: readonly unknown[] = [0, 1, 2, 3];

// ── Singleton Validator Bridge ───────────────────────────────────────
// Config driven by env vars — set ORACLE_MOCK=false for live verification.

const validatorBridge = new TMPValidatorBridge(
  new EvidenceVerifier("tmp-validator", "0x0000000000000000000000000000000000000001"),
  new CommitmentService(),
  new ZKProofService(),
  new OracleVerificationBridge(configFromEnv()),
);

// ── Routes ───────────────────────────────────────────────────────────

export async function tmpTaskRoutes(app: FastifyInstance, opts: TmpTaskRouteOptions = {}) {
  // A task's terms live in the durable store, created once (E11f). Its lifecycle status (claimed,
  // completed) is this process's view only: it decides no verdict, and a restart resets it to pending.
  const lifecycle = new Map<string, { status: MilestoneProcurement["status"]; completedAt?: string }>();

  /** The milestone's task from the store, or null once the reply is sent (404; 503 when unreadable). */
  async function taskFor(milestoneId: string, reply: FastifyReply): Promise<TmpTaskRecord | null> {
    let task: TmpTaskRecord | undefined;
    try {
      task = await opts.store?.get(milestoneId);
    } catch {
      await reply.code(503).send({ error: "task_store_unreadable", message: "the TMP task store could not be read" });
      return null;
    }
    if (!task) {
      await reply.code(404).send({ error: "not_found", message: `No TMP task for milestone ${milestoneId}` });
      return null;
    }
    return task;
  }

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
        /** The tier the milestone's evidence must meet (N118: recorded here, never taken from a proof). */
        assuranceTier?: unknown;
      };

      // Owner-bound (E11e): only the milestone's poster creates its task, once. Until this gateway can
      // resolve a milestone's poster, only an admin creates it, and everyone else is refused (#6182).
      const principal = callerPrincipal(req);
      if (principal === null) {
        return reply.code(401).send({ error: "unauthenticated", message: "creating a TMP task needs an authenticated caller" });
      }
      const store = opts.store;
      if (!store) {
        return reply.code(503).send({
          error: "task_store_unavailable",
          message: "a TMP task is durable, write-once state, and this gateway has no durable task store, so none can be created",
        });
      }
      if (opts.milestoneOwner) {
        let owner: string | null;
        try {
          owner = await opts.milestoneOwner(milestoneId);
        } catch {
          owner = null;
        }
        if (owner === null || owner !== principal) {
          return reply.code(403).send({ error: "not_milestone_owner", message: "only the milestone's poster creates its TMP task" });
        }
      } else {
        let admin = false;
        try {
          admin = opts.isAdmin !== undefined && (await opts.isAdmin(req)) === true;
        } catch {
          admin = false;
        }
        if (!admin) {
          return reply.code(403).send({
            error: "admin_only",
            message: "TMP tasks are owner-bound, and this gateway cannot resolve a milestone's poster yet, so only an admin creates them",
          });
        }
      }

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

      // A benchmark task's pipeline must be one that can enforce its tier: validation refuses the others,
      // so a task on one could never be fulfilled (E11f).
      if (body.mode === "benchmark" && !TIER_ENFORCING_PIPELINES.includes((body.modeConfig as BenchmarkConfig).proofType)) {
        return reply.code(400).send({
          error: "pipeline_unenforceable",
          message: `a benchmark task's proofType must enforce its tier: one of ${TIER_ENFORCING_PIPELINES.join(", ")}`,
        });
      }

      if (!ASSURANCE_TIERS.includes(body.assuranceTier)) {
        return reply.code(400).send({
          error: "bad_request",
          message: "assuranceTier is required: one of 0, 1, 2, 3",
        });
      }

      const task: TmpTaskRecord = {
        milestoneId,
        mode: body.mode,
        modeConfig: body.modeConfig,
        acceptedTier: body.assuranceTier as 0 | 1 | 2 | 3,
        owner: principal,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      let created: boolean;
      try {
        created = await store.createOnce(task);
      } catch {
        return reply.code(503).send({ error: "task_store_unavailable", message: "the TMP task store could not be written" });
      }
      if (!created) {
        return reply.code(409).send({ error: "task_exists", message: "a milestone's TMP task is created once" });
      }

      return reply.code(201).send({ task });
    },
  );

  // ── Get TMP task for a milestone ───────────────────────────────────

  app.get<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-task",
    async (req, reply) => {
      const task = await taskFor(req.params.id, reply);
      if (!task) return reply;
      return { task: { ...task, ...lifecycle.get(req.params.id) } };
    },
  );

  // ── Submit bid (auction mode) ──────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-bid",
    async (req, reply) => {
      const task = await taskFor(req.params.id, reply);
      if (!task) return reply;

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
      const task = await taskFor(req.params.id, reply);
      if (!task) return reply;

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
      const task = await taskFor(req.params.id, reply);
      if (!task) return reply;

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

      // Mark the task active, in this process's view (it decides no verdict).
      lifecycle.set(req.params.id, { status: "active" });

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
  // A verdict here proves the bundle's INTEGRITY (its events are the ones its hash commits), not its ORIGIN:
  // no kernel or device signature is checked yet (row N124). Nothing in this repo moves money or writes
  // reputation on a TMP verdict, and any consumer that would must wait for N124.

  app.post<{ Params: { id: string } }>(
    "/api/milestones/:id/tmp-validate",
    async (req, reply) => {
      const task = await taskFor(req.params.id, reply);
      if (!task) return reply;

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

      // The tier and the pipeline are the task's own durable record, set once at creation by an admin (or,
      // with a resolver, the milestone's owner), never the worker's envelope (N118, E11e, E11f).
      const result = await validatorBridge.validate(envelope, {
        acceptedTier: task.acceptedTier,
        proofType: (task.modeConfig as BenchmarkConfig).proofType,
      });
      const acceptance = validatorBridge.formatAcceptance(envelope, result);

      // Update the task's status, in this process's view, if validation passed.
      if (acceptance.accepted) {
        lifecycle.set(req.params.id, { status: "completed", completedAt: new Date().toISOString() });
      }

      return { result, acceptance };
    },
  );
}

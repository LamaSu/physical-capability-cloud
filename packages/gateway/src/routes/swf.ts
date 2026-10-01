import type { FastifyInstance } from "fastify";
import { SWFService } from "@pcc/payments";
import type { SWFParticipantRole, SWFAllocationStrategy, SWFDemandForecast, SWFOperatorCostModel, SWFEquityTier } from "@pcc/spec";
import { isDemoRoutesOn, markDemo } from "../config/demo-routes.js";

// ---------------------------------------------------------------------------
// The SWF is a design, not a running fund (board N34; astra round 1 on #421, r1a HIGH)
// ---------------------------------------------------------------------------
//
// SWFService keeps everything in process-local maps: nothing persists or funds it, and its
// summary reports a "last distribution" of now and a Base USDC balance that no chain read
// produced. So every route here answers only in demo mode (PCC_DEMO_ROUTES=true, never
// under NODE_ENV=production), and every demo answer says so: the x-pcc-demo: true header,
// plus mock: true, demo: true on object bodies. Outside demo mode each route answers 501
// not_available before its body is parsed, and nothing is read or written. Epoch
// distribution answers 501 in every mode (the steward's ruling, operator item 69: the SWF's
// money routes stay disabled). Nothing outside this module writes to the simulation.

/** The in-memory simulation that demo answers come from. Exported for tests. */
const swfService = new SWFService();
export { swfService };

const DEMO_HEADER = "x-pcc-demo";

const SWF_NOT_RECORDED = {
  error: "not_available",
  message:
    "The SWF (sovereign wealth fund) is not recorded on this gateway: nothing persists or funds its epochs, " +
    "participants, accruals, dividend claims, proposals, equity positions or term sheets, so nothing is " +
    "returned and nothing was written.",
  see: [] as string[],
};

// Distributing an epoch divides its dividend pool by each participant's contribution
// score, and nothing computes a participant's per-epoch contribution (its jobs, reputation,
// activity and votes in the epoch; jobs and votes are recorded, the per-epoch score is not).
// This route drew those inputs from Math.random() and then DISTRIBUTED the epoch on them: a
// write that shared the fund out by chance. Boards N34 and N46 (money floor): it answers 501
// not_available before anything is parsed, read, scored or written, in every mode.
const DISTRIBUTE_PATH = "/api/swf/epochs/:epochId/distribute";
const DISTRIBUTE_REFUSAL = {
  error: "not_available",
  message:
    "Per-epoch contribution scores (each participant's jobs, reputation, activity and votes in this epoch) " +
    "are not computed on this gateway, " +
    "so the epoch was not scored or distributed: without them, every participant's share would come " +
    "from random numbers.",
  see: [] as string[],
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function swfRoutes(app: FastifyInstance) {
  // The one gate for every route in this plugin (see above). It is encapsulated: this plugin
  // is a plain async function (not wrapped with fastify-plugin), so the hooks run only for
  // the routes declared here. It runs after the root API-key gate and before the body is
  // parsed, so a refused POST parses, creates and records nothing.
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url === DISTRIBUTE_PATH) return reply.code(501).send(DISTRIBUTE_REFUSAL);
    if (!isDemoRoutesOn()) return reply.code(501).send(SWF_NOT_RECORDED);
    reply.header(DEMO_HEADER, "true");
    // The simulation opens with one active epoch, on the first demo request (never at import).
    if (swfService.listEpochs().length === 0) swfService.createEpoch();
  });
  // A demo response's object body says so too; the header above covers any other shape.
  app.addHook("preSerialization", async (_req, reply, payload: unknown) =>
    reply.getHeader(DEMO_HEADER) === "true" && isPlainObject(payload) ? markDemo("demo", payload) : payload,
  );

  // ── Fund Summary ──────────────────────────────────────────────

  app.get("/api/swf/summary", async () => {
    return { summary: swfService.getSummary() };
  });

  // ── Participants ──────────────────────────────────────────────

  app.post("/api/swf/participants", async (req, reply) => {
    const body = (req.body ?? {}) as {
      did?: string;
      walletAddress?: string;
      role?: string;
    };

    if (!body.did || !body.walletAddress || !body.role) {
      return reply.code(400).send({
        error: "bad_request",
        message: "did, walletAddress, and role are required",
      });
    }

    const participant = swfService.registerParticipant({
      did: body.did,
      walletAddress: body.walletAddress,
      role: body.role as SWFParticipantRole,
    });

    return reply.code(201).send({ participant });
  });

  app.get<{ Querystring: { role?: string; status?: string } }>(
    "/api/swf/participants",
    async (req) => {
      const participants = swfService.listParticipants({
        role: req.query.role as SWFParticipantRole | undefined,
        status: req.query.status as "active" | "suspended" | "withdrawn" | undefined,
      });
      return { participants, total: participants.length };
    },
  );

  app.get<{ Params: { participantId: string } }>(
    "/api/swf/participants/:participantId",
    async (req, reply) => {
      try {
        const dashboard = swfService.getParticipantDashboard(
          req.params.participantId,
        );
        return { dashboard };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: "not_found", message });
      }
    },
  );

  // ── Epochs ────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string } }>(
    "/api/swf/epochs",
    async (req) => {
      const epochs = swfService.listEpochs({
        status: req.query.status as any,
      });
      return { epochs, total: epochs.length };
    },
  );

  app.get<{ Params: { epochId: string } }>(
    "/api/swf/epochs/:epochId",
    async (req, reply) => {
      const epoch = swfService.getEpoch(req.params.epochId);
      if (!epoch) {
        return reply.code(404).send({
          error: "not_found",
          message: `Epoch ${req.params.epochId} not found`,
        });
      }
      return { epoch };
    },
  );

  app.post("/api/swf/epochs", async (_req, reply) => {
    const epoch = swfService.createEpoch();
    return reply.code(201).send({ epoch });
  });

  // Epoch distribution: the gate above always refuses it (DISTRIBUTE_REFUSAL). The handler
  // answers the same, so the route cannot distribute even if the hook were bypassed.
  app.post<{ Params: { epochId: string } }>(DISTRIBUTE_PATH, async (_req, reply) =>
    reply.code(501).send(DISTRIBUTE_REFUSAL),
  );

  // ── Accruals ──────────────────────────────────────────────────

  app.get<{ Querystring: { epochId?: string } }>(
    "/api/swf/accruals",
    async (req) => {
      if (req.query.epochId) {
        const accruals = swfService.getAccrualsForEpoch(req.query.epochId);
        return { accruals, total: accruals.length };
      }
      // Return current epoch accruals by default
      const active = swfService.getActiveEpoch();
      if (!active) return { accruals: [], total: 0 };
      const accruals = swfService.getAccrualsForEpoch(active.id);
      return { accruals, total: accruals.length };
    },
  );

  // ── Claims ────────────────────────────────────────────────────

  app.post("/api/swf/claims", async (req, reply) => {
    const body = (req.body ?? {}) as {
      claimId?: string;
      chain?: string;
    };

    if (!body.claimId) {
      return reply.code(400).send({
        error: "bad_request",
        message: "claimId is required",
      });
    }

    try {
      const claim = swfService.submitClaim(body.claimId, body.chain);
      return reply.code(201).send({ claim });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  app.get<{ Params: { claimId: string } }>(
    "/api/swf/claims/:claimId",
    async (req, reply) => {
      // Find the claim through participant claims
      const participants = swfService.listParticipants();
      for (const p of participants) {
        const claims = swfService.getClaimsForParticipant(p.id);
        const found = claims.find((c) => c.id === req.params.claimId);
        if (found) return { claim: found };
      }
      return reply.code(404).send({
        error: "not_found",
        message: `Claim ${req.params.claimId} not found`,
      });
    },
  );

  // ── Governance: Proposals ─────────────────────────────────────

  app.get<{ Querystring: { status?: string } }>(
    "/api/swf/proposals",
    async (req) => {
      const proposals = swfService.listProposals({
        status: req.query.status as any,
      });
      return { proposals, total: proposals.length };
    },
  );

  app.post("/api/swf/proposals", async (req, reply) => {
    const body = (req.body ?? {}) as {
      proposer?: string;
      title?: string;
      description?: string;
      proposedStrategy?: SWFAllocationStrategy;
    };

    if (!body.proposer || !body.title || !body.description || !body.proposedStrategy) {
      return reply.code(400).send({
        error: "bad_request",
        message: "proposer, title, description, and proposedStrategy are required",
      });
    }

    try {
      const proposal = swfService.createProposal({
        proposer: body.proposer,
        title: body.title,
        description: body.description,
        proposedStrategy: body.proposedStrategy,
      });
      return reply.code(201).send({ proposal });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  app.get<{ Params: { proposalId: string } }>(
    "/api/swf/proposals/:proposalId",
    async (req, reply) => {
      const proposal = swfService.getProposal(req.params.proposalId);
      if (!proposal) {
        return reply.code(404).send({
          error: "not_found",
          message: `Proposal ${req.params.proposalId} not found`,
        });
      }
      const votes = swfService.getVotesForProposal(req.params.proposalId);
      return { proposal, votes, voteCount: votes.length };
    },
  );

  // ── Governance: Voting ────────────────────────────────────────

  app.post<{ Params: { proposalId: string } }>(
    "/api/swf/proposals/:proposalId/vote",
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        participantId?: string;
        vote?: string;
        weight?: number;
      };

      if (!body.participantId || !body.vote) {
        return reply.code(400).send({
          error: "bad_request",
          message: "participantId and vote are required",
        });
      }

      try {
        const vote = swfService.castVote({
          proposalId: req.params.proposalId,
          participantId: body.participantId,
          vote: body.vote as "yes" | "no" | "abstain",
          weight: body.weight,
        });
        return reply.code(201).send({ vote });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  app.post<{ Params: { proposalId: string } }>(
    "/api/swf/proposals/:proposalId/execute",
    async (req, reply) => {
      try {
        // Tally first, then execute if passed
        const tallied = swfService.tallyProposal(req.params.proposalId);
        if (tallied.status === "passed") {
          const executed = swfService.executeProposal(req.params.proposalId);
          return { proposal: executed, action: "executed" };
        }
        return { proposal: tallied, action: "rejected" };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  // ── Forecast-Driven Allocation ──────────────────────────────────

  app.post<{ Params: { epochId: string } }>(
    "/api/swf/epochs/:epochId/forecast-allocate",
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        demands?: SWFDemandForecast[];
      };

      if (!body.demands || !Array.isArray(body.demands) || body.demands.length === 0) {
        return reply.code(400).send({
          error: "bad_request",
          message: "demands array is required (from BountyService.getTopDemand or manual input)",
        });
      }

      try {
        const result = swfService.computeForecastAllocation(
          req.params.epochId,
          body.demands,
        );
        return { forecastAllocation: result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  // ── Equity Portfolio ──────────────────────────────────────────

  app.get("/api/swf/equity/portfolio", async () => {
    return { portfolio: swfService.getEquityPortfolio() };
  });

  app.get<{ Params: { positionId: string } }>(
    "/api/swf/equity/:positionId",
    async (req, reply) => {
      const positions = swfService.getEquityPortfolio().positions;
      const position = positions.find((p) => p.id === req.params.positionId);
      if (!position) {
        return reply.code(404).send({
          error: "not_found",
          message: `Equity position ${req.params.positionId} not found`,
        });
      }
      const revenues = swfService.getEquityRevenues(req.params.positionId);
      return { position, revenues, revenueCount: revenues.length };
    },
  );

  app.post<{ Params: { positionId: string } }>(
    "/api/swf/equity/:positionId/activate",
    async (req, reply) => {
      try {
        const position = swfService.activateEquityPosition(req.params.positionId);
        return { position };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  app.post("/api/swf/equity/record-revenue", async (req, reply) => {
    const body = (req.body ?? {}) as {
      equityPositionId?: string;
      jobId?: string;
      protocolFee?: number;
    };

    if (!body.equityPositionId || !body.jobId || body.protocolFee === undefined) {
      return reply.code(400).send({
        error: "bad_request",
        message: "equityPositionId, jobId, and protocolFee are required",
      });
    }

    try {
      const revenue = swfService.recordEquityRevenue({
        equityPositionId: body.equityPositionId,
        jobId: body.jobId,
        protocolFee: body.protocolFee,
      });
      const position = swfService.getEquityPortfolio().positions.find(
        (p) => p.id === body.equityPositionId,
      );
      return { revenue, position };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  // ── Term Sheet Negotiation ──────────────────────────────────────

  app.post("/api/swf/terms/propose", async (req, reply) => {
    const body = (req.body ?? {}) as {
      capabilityType?: string;
      operatorId?: string;
      equityTier?: string;
      seedAmount?: number;
      costModel?: SWFOperatorCostModel;
    };

    // The PROPOSER (caller) and the OPERATOR (target) are distinct.
    // Term sheets are proposed BY a sponsor/investor TO an operator.
    // We require auth, validate types, rate limit, and audit-log both parties.
    const proposerId = (req as any).operatorId ?? (req as any).userId;
    if (!proposerId) {
      return reply.code(401).send({ error: "authentication_required" });
    }

    // Rate limit: 5 term sheets per proposer per 10 minutes (anti-spam)
    const { checkCallerRate } = await import("../middleware/security-hardening.js");
    if (!checkCallerRate(proposerId, "swf_propose", 5, 600_000)) {
      return reply.code(429).send({
        error: "rate_limited",
        message: "Too many term sheet proposals. Try again in 10 minutes.",
      });
    }

    // Type guards on all body fields (prevents NoSQL-style object injection)
    if (typeof body.capabilityType !== "string") {
      return reply.code(400).send({ error: "invalid_type", message: "capabilityType must be a string" });
    }
    if (typeof body.operatorId !== "string") {
      return reply.code(400).send({ error: "invalid_type", message: "operatorId must be a string" });
    }
    if (typeof body.seedAmount !== "number" || body.seedAmount <= 0 || body.seedAmount > 10_000_000) {
      return reply.code(400).send({
        error: "invalid_seed_amount",
        message: "seedAmount must be a positive number under 10,000,000",
      });
    }

    if (!body.equityTier || !body.costModel) {
      return reply.code(400).send({
        error: "bad_request",
        message: "capabilityType, operatorId, equityTier, seedAmount, and costModel are required",
      });
    }

    try {
      const termSheet = swfService.proposeTermSheet({
        capabilityType: body.capabilityType,
        operatorId: body.operatorId,
        equityTier: body.equityTier as SWFEquityTier,
        seedAmount: body.seedAmount,
        costModel: body.costModel,
      });

      // Audit log records both parties for forensics
      try {
        const { auditService } = await import("../services/audit-service.js");
        auditService.log({
          eventType: "swf.term_sheet.proposed",
          actor: proposerId,
          resourceType: "swf_term_sheet",
          resourceId: termSheet.id,
          action: "propose",
          metadata: {
            targetOperator: body.operatorId,
            capabilityType: body.capabilityType,
            seedAmount: body.seedAmount,
            equityTier: body.equityTier,
          },
          ip: req.ip,
        });
      } catch { /* non-fatal */ }
      return reply.code(201).send({ termSheet });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  app.post<{ Params: { termSheetId: string } }>(
    "/api/swf/terms/:termSheetId/counter",
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        counterRevenueShareBps?: number;
        counterMaturityMultiplier?: number;
        reason?: string;
      };

      if (!body.counterRevenueShareBps || !body.counterMaturityMultiplier || !body.reason) {
        return reply.code(400).send({
          error: "bad_request",
          message: "counterRevenueShareBps, counterMaturityMultiplier, and reason are required",
        });
      }

      try {
        const termSheet = swfService.counterTermSheet({
          termSheetId: req.params.termSheetId,
          counterRevenueShareBps: body.counterRevenueShareBps,
          counterMaturityMultiplier: body.counterMaturityMultiplier,
          reason: body.reason,
        });
        return { termSheet };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  app.post<{ Params: { termSheetId: string } }>(
    "/api/swf/terms/:termSheetId/accept",
    async (req, reply) => {
      const body = (req.body ?? {}) as { epochId?: string };
      const epochId = body.epochId ?? swfService.getActiveEpoch()?.id;
      if (!epochId) {
        return reply.code(400).send({ error: "bad_request", message: "No active epoch" });
      }

      try {
        const result = swfService.acceptTermSheet(req.params.termSheetId, epochId);
        return { termSheet: result.termSheet, equityPosition: result.equityPosition };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  app.post<{ Params: { termSheetId: string } }>(
    "/api/swf/terms/:termSheetId/reject",
    async (req, reply) => {
      const body = (req.body ?? {}) as { reason?: string };
      try {
        const termSheet = swfService.rejectTermSheet(req.params.termSheetId, body.reason);
        return { termSheet };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  app.get<{ Querystring: { status?: string; operatorId?: string; capabilityType?: string } }>(
    "/api/swf/terms",
    async (req) => {
      const terms = swfService.listTermSheets({
        status: req.query.status as any,
        operatorId: req.query.operatorId,
        capabilityType: req.query.capabilityType,
      });
      return { termSheets: terms, total: terms.length };
    },
  );

  app.get<{ Params: { termSheetId: string } }>(
    "/api/swf/terms/:termSheetId",
    async (req, reply) => {
      const sheet = swfService.getTermSheet(req.params.termSheetId);
      if (!sheet) {
        return reply.code(404).send({
          error: "not_found",
          message: `Term sheet ${req.params.termSheetId} not found`,
        });
      }
      return { termSheet: sheet };
    },
  );
}

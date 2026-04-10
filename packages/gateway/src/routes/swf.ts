import type { FastifyInstance } from "fastify";
import { SWFService } from "@pcc/payments";
import type { SWFParticipantRole, SWFAccrualSource, SWFAllocationStrategy, SWFDemandForecast, SWFOperatorCostModel, SWFEquityTier } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Shared service instance (in-memory mock)
// ---------------------------------------------------------------------------

const swfService = new SWFService();

// Seed an initial epoch so the fund is immediately active
const initialEpoch = swfService.createEpoch();

/** Exported for integration hooks from other route modules */
export { swfService };

/**
 * Convenience: accrue to the SWF from any service.
 * Call this after escrow collection, bounty payout, pool distribution, etc.
 * Silently no-ops if no active epoch exists (fund not yet initialized).
 */
export function swfAccrue(
  sourceType: SWFAccrualSource,
  sourceId: string,
  grossAmount: number,
  currency?: "USDC" | "CREDITS",
  chain?: string,
): void {
  const epoch = swfService.getActiveEpoch();
  if (!epoch) return;
  try {
    swfService.accrue({ sourceType, sourceId, grossAmount, currency, chain, epochId: epoch.id });
  } catch {
    // Non-fatal — fund accrual should never break the primary transaction
  }
}

/**
 * Convenience: auto-register a participant in the SWF.
 * Call when a kernel registers, a user submits a job, or a verifier completes work.
 * Idempotent by DID.
 */
export function swfAutoRegister(
  did: string,
  walletAddress: string,
  role: SWFParticipantRole,
): void {
  try {
    swfService.registerParticipant({ did, walletAddress, role });
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function swfRoutes(app: FastifyInstance) {
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

  app.post<{ Params: { epochId: string } }>(
    "/api/swf/epochs/:epochId/distribute",
    async (req, reply) => {
      try {
        // For mock purposes, generate scores from all active participants
        const participants = swfService.listParticipants({ status: "active" });
        if (participants.length > 0) {
          swfService.calculateContributionScores(
            req.params.epochId,
            participants.map((p) => ({
              participantId: p.id,
              jobCount: Math.floor(Math.random() * 50),
              reputation: Math.floor(Math.random() * 1000),
              uptimeOrActivity: Math.floor(Math.random() * 100),
              tenureDays: Math.floor(
                (Date.now() - new Date(p.registeredAt).getTime()) / 86_400_000,
              ),
              votedThisEpoch: Math.random() > 0.5,
            })),
          );
        }

        const epoch = swfService.distributeEpoch(req.params.epochId);
        return { epoch };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
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

    // IDOR fix: derive operatorId from session, not body (red team #10)
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }

    if (!body.capabilityType || !body.equityTier || !body.seedAmount || !body.costModel) {
      return reply.code(400).send({
        error: "bad_request",
        message: "capabilityType, equityTier, seedAmount, and costModel are required",
      });
    }

    try {
      const termSheet = swfService.proposeTermSheet({
        capabilityType: body.capabilityType,
        operatorId,
        equityTier: body.equityTier as SWFEquityTier,
        seedAmount: body.seedAmount,
        costModel: body.costModel,
      });
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

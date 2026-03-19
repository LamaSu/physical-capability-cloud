import type { FastifyInstance } from "fastify";
import { BountyService } from "@pcc/payments";

// ---------------------------------------------------------------------------
// Shared service instance (in-memory mock)
// ---------------------------------------------------------------------------

const bountyService = new BountyService();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function bountyRoutes(app: FastifyInstance) {
  // ── Demand Signals ──────────────────────────────────────────────

  app.post("/api/bounty/demand", async (req, reply) => {
    const body = (req.body ?? {}) as {
      requesterId?: string;
      capabilityType?: string;
      description?: string;
      estimatedJobValue?: number;
      estimatedFrequency?: string;
      location?: string;
      assuranceTier?: number;
    };

    if (!body.requesterId || !body.capabilityType || !body.description) {
      return reply.code(400).send({
        error: "bad_request",
        message: "requesterId, capabilityType, and description are required",
      });
    }

    const signal = bountyService.submitDemand({
      requesterId: body.requesterId,
      capabilityType: body.capabilityType,
      description: body.description,
      estimatedJobValue: body.estimatedJobValue ?? 0,
      estimatedFrequency:
        (body.estimatedFrequency as "one-time" | "weekly" | "monthly" | "daily") ?? "one-time",
      location: body.location,
      assuranceTier: body.assuranceTier ?? 1,
    });

    // Auto-check if this demand triggers a new bounty
    const autoBounties = bountyService.checkAndCreateBounties();

    return reply.code(201).send({
      signal,
      autoBountiesCreated: autoBounties.length,
      autoBounties,
    });
  });

  app.get<{ Querystring: { capabilityType?: string } }>(
    "/api/bounty/demand",
    async (req) => {
      const signals = bountyService.getDemandSignals(req.query.capabilityType);
      return { signals, total: signals.length };
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/bounty/demand/top",
    async (req) => {
      const limit = parseInt(req.query.limit ?? "10", 10);
      const top = bountyService.getTopDemand(limit);
      return { demand: top };
    },
  );

  // ── Bounties ────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string; capabilityType?: string } }>(
    "/api/bounty/list",
    async (req) => {
      const bounties = bountyService.listBounties({
        status: req.query.status as "open" | "claimed" | "verified" | "paid" | "expired" | undefined,
        capabilityType: req.query.capabilityType,
      });
      return { bounties, total: bounties.length };
    },
  );

  app.post("/api/bounty/claim", async (req, reply) => {
    const body = (req.body ?? {}) as {
      bountyId?: string;
      operatorId?: string;
    };

    if (!body.bountyId || !body.operatorId) {
      return reply.code(400).send({
        error: "bad_request",
        message: "bountyId and operatorId are required",
      });
    }

    try {
      const bounty = bountyService.claimBounty(body.bountyId, body.operatorId);
      return { bounty };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  app.post("/api/bounty/verify", async (req, reply) => {
    const body = (req.body ?? {}) as {
      bountyId?: string;
      jobId?: string;
      score?: number;
    };

    if (!body.bountyId || !body.jobId || body.score === undefined) {
      return reply.code(400).send({
        error: "bad_request",
        message: "bountyId, jobId, and score are required",
      });
    }

    try {
      const bounty = bountyService.verifyBounty(
        body.bountyId,
        body.jobId,
        body.score,
      );
      return { bounty };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  // ── Leaderboard ─────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>(
    "/api/bounty/leaderboard",
    async (req) => {
      const limit = parseInt(req.query.limit ?? "10", 10);
      const leaderboard = bountyService.getLeaderboard(limit);
      return { leaderboard, total: leaderboard.length };
    },
  );
}

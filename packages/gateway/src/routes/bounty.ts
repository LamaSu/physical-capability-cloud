import type { FastifyInstance } from "fastify";
import { BountyService, type DemandSignal } from "@pcc/payments";

// ---------------------------------------------------------------------------
// Shared service instance (in-memory mock)
//
// Nothing behind these routes is funded or durable. Treasury auto-bounties
// stay off (the service default), every bounty reports fundingStatus
// "unfunded", and no route can move a bounty to "paid". The durable,
// escrow-backed replacement is the kit-build offer (ledger R7/R45).
// ---------------------------------------------------------------------------

const bountyService = new BountyService();

/** Test helper: the shared service, so tests can seed state no route can create. */
export function _bountyServiceForTests(): BountyService {
  return bountyService;
}

/**
 * The only demand-signal fields any caller may read back. Requester identity,
 * free-text descriptions, locations and self-declared budgets are private.
 */
function redactSignal(s: DemandSignal) {
  return {
    id: s.id,
    capabilityType: s.capabilityType,
    estimatedFrequency: s.estimatedFrequency,
    assuranceTier: s.assuranceTier,
    createdAt: s.createdAt,
    status: s.status,
  };
}

/**
 * Demand aggregates stay unpublished until requester identity is bound to a
 * proven credential (gateway R29/N2): today one caller with a few free keys can
 * fabricate "broad" demand, and a single-requester row exposes that requester's
 * self-declared annual spend.
 */
const DEMAND_AGGREGATES_SUPPRESSED_REASON =
  "demand aggregates are not published until requester identity is bound to a proven credential (ledger R29/N2)";

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
      const signals = bountyService
        .getDemandSignals(req.query.capabilityType)
        .map(redactSignal);
      return { signals, total: signals.length };
    },
  );

  app.get("/api/bounty/demand/top", async () => {
    return {
      demand: [],
      suppressed: true,
      reason: DEMAND_AGGREGATES_SUPPRESSED_REASON,
    };
  });

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
    };

    // IDOR fix: derive operatorId from authenticated session, not body (red team #10)
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }

    if (!body.bountyId) {
      return reply.code(400).send({
        error: "bad_request",
        message: "bountyId is required",
      });
    }

    try {
      const bounty = bountyService.claimBounty(body.bountyId, operatorId);
      return { bounty };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  // Retired: this route let any caller mark any bounty "verified" with a score
  // of its own choosing. Verification must come from the server's own evidence
  // (ledger R45), so the route refuses and changes no state.
  app.post("/api/bounty/verify", async (_req, reply) => {
    return reply.code(410).send({
      error: "gone",
      message:
        "Caller-supplied bounty verification is no longer accepted. Verification must be derived by the server from real job evidence (ledger R45); this route changes no state.",
    });
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

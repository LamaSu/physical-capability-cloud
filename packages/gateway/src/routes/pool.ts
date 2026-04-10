import type { FastifyInstance } from "fastify";
import { PoolService, BountyService } from "@pcc/payments";

// ---------------------------------------------------------------------------
// Shared service instances (in-memory mock)
// ---------------------------------------------------------------------------

const bountyService = new BountyService();
const poolService = new PoolService({}, bountyService);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function poolRoutes(app: FastifyInstance) {
  // ── Create Pool ───────────────────────────────────────────────

  app.post("/api/pool/create", async (req, reply) => {
    const body = (req.body ?? {}) as {
      capabilityType?: string;
      description?: string;
      targetAmount?: number;
      currency?: string;
      revenueShareBps?: number;
      sunsetMultiplier?: number;
    };

    if (!body.capabilityType || !body.description) {
      return reply.code(400).send({
        error: "bad_request",
        message: "capabilityType and description are required",
      });
    }

    const pool = poolService.createPool({
      capabilityType: body.capabilityType,
      description: body.description,
      targetAmount: body.targetAmount,
      currency: body.currency as "USDC" | "CREDITS" | undefined,
      revenueShareBps: body.revenueShareBps,
      sunsetMultiplier: body.sunsetMultiplier,
    });

    return reply.code(201).send({ pool });
  });

  // ── Stake ─────────────────────────────────────────────────────

  app.post("/api/pool/stake", async (req, reply) => {
    const body = (req.body ?? {}) as {
      poolId?: string;
      staker?: string;
      amount?: number;
    };

    if (!body.poolId || !body.staker || body.amount === undefined) {
      return reply.code(400).send({
        error: "bad_request",
        message: "poolId, staker, and amount are required",
      });
    }

    try {
      const stake = poolService.stake(body.poolId, body.staker, body.amount);
      return reply.code(201).send({ stake });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: "conflict", message });
    }
  });

  // ── Close Pool ────────────────────────────────────────────────

  app.post<{ Params: { poolId: string } }>(
    "/api/pool/close/:poolId",
    async (req, reply) => {
      try {
        const pool = poolService.closePool(req.params.poolId);
        return { pool };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  // ── Claim Pool ────────────────────────────────────────────────

  app.post<{ Params: { poolId: string } }>(
    "/api/pool/claim/:poolId",
    async (req, reply) => {
      // IDOR fix: derive operatorId from session, not body (red team #10)
      const operatorId = (req as any).operatorId ?? (req as any).userId;
      if (!operatorId) {
        return reply.code(401).send({ error: "authentication_required" });
      }

      try {
        const pool = poolService.claimPool(req.params.poolId, operatorId);
        return { pool };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );

  // ── Get Pool ──────────────────────────────────────────────────

  app.get<{ Params: { poolId: string } }>(
    "/api/pool/:poolId",
    async (req, reply) => {
      const pool = poolService.getPool(req.params.poolId);
      if (!pool) {
        return reply.code(404).send({
          error: "not_found",
          message: `Pool ${req.params.poolId} not found`,
        });
      }
      return { pool };
    },
  );

  // ── List Pools ────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string; capabilityType?: string } }>(
    "/api/pool/list",
    async (req) => {
      const pools = poolService.listPools({
        status: req.query.status as
          | "open"
          | "funded"
          | "active"
          | "sunset"
          | "cancelled"
          | undefined,
        capabilityType: req.query.capabilityType,
      });
      return { pools, total: pools.length };
    },
  );

  // ── Staker Earnings ───────────────────────────────────────────

  app.get<{ Params: { staker: string } }>(
    "/api/pool/earnings/:staker",
    async (req) => {
      const earnings = poolService.getStakerEarnings(req.params.staker);
      return { earnings };
    },
  );

  // ── Convert Bounty to Pool ────────────────────────────────────

  app.post<{ Params: { bountyId: string } }>(
    "/api/pool/from-bounty/:bountyId",
    async (req, reply) => {
      try {
        const pool = poolService.createPoolFromBounty(req.params.bountyId);
        return reply.code(201).send({ pool });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: "conflict", message });
      }
    },
  );
}

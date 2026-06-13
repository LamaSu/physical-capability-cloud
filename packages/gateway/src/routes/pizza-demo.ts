/**
 * POST /api/demo/pizza-* — agentic-composition pizza demo for the vibecodenights
 * x402 session, now with the pre-commit → escrow → user-confirms-delivery flow.
 *
 * Lifecycle (nothing ships until every party pre-commits):
 *   1. POST /api/demo/pizza-order              → propose composition (status: proposed)
 *   2. POST /api/demo/orders/:id/confirm       → user accepts the quote (status: confirmed)
 *   3. POST /api/demo/orders/:id/pre-commit    → commitment templates (pizza-oracle.ts; status: staking)
 *   4. POST /api/demo/jobs/:jobId/stake  ×3    → shop + driver + user stake
 *      → on the 3rd stake, escrow locks (status: escrow_locked) and make-pizza dispatches
 *   5. POST /api/demo/jobs/:jobId/evidence     → shop bundle (photo+GPS+ts); oracle verifies
 *      → delivery dispatched (status: awaiting_driver)
 *   6. driver evidence: pickup photo → in_transit; delivery photo → awaiting_user_confirmation
 *   7. POST /api/demo/orders/:id/confirm-delivery → settle + reveal (status: delivered)
 *      OR the confirmation window lapses → user_confirmation_timeout + penalty
 *
 * State lives in pizza-store.ts (shared with pizza-oracle.ts). The route still
 * delegates planning to compose.planComposition() — exercising the real
 * substrate, not faking it.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { planComposition } from "./compose.js";
import type { ComposeRequest } from "@pcc/spec";
import {
  confirmDelivery,
  deriveSlug,
  dispatchDelivery,
  emitter,
  getCommitments,
  getEvidence,
  jobs,
  jobsByAssignee,
  nowIso,
  orders,
  sweepConfirmationWindow,
  sweepStakeWindow,
  updateOrder,
  _clearPizzaForTests,
  type DemoJob,
  type DemoOrder,
} from "./pizza-store.js";

// ── SSE handler ────────────────────────────────────────────────────────────

function setupSse(reply: FastifyReply, topics: string[]): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(`data: ${JSON.stringify({ type: "connected", topics })}\n\n`);

  const listeners = topics.map((topic) => {
    const listener = (event: unknown): void => {
      try {
        reply.raw.write(
          `data: ${JSON.stringify({ topic, event, ts: nowIso() })}\n\n`,
        );
      } catch {
        /* socket closed */
      }
    };
    emitter.on(topic, listener);
    return { topic, listener };
  });

  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(`: heartbeat\n\n`);
    } catch {
      /* socket closed */
    }
  }, 15_000);

  reply.raw.on("close", () => {
    clearInterval(heartbeat);
    listeners.forEach(({ topic, listener }) => emitter.off(topic, listener));
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function pizzaDemoRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/demo/pizza-order — propose a composition for a pizza order.
  app.post("/api/demo/pizza-order", async (req, reply) => {
    const body = req.body as Partial<{
      userId: string;
      description: string;
      deliveryAddress: string;
      deliveryLocation: { lat: number; lng: number };
      maxPriceUSD: number;
      maxTimeMin: number;
    }>;

    if (!body || !body.userId || !body.description || !body.deliveryAddress) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "userId, description, deliveryAddress required",
      });
    }

    const loc = body.deliveryLocation ?? { lat: 37.77, lng: -122.42 };
    const maxPrice = body.maxPriceUSD ?? 30;

    // Plan a 2-step composition: make-pizza → deliver-pizza via graph-search.
    const composeReq: ComposeRequest = {
      requester: { agentId: body.userId },
      outcomeType: "delivered-pizza",
      outcomeChain: ["make-pizza", "delivered-pizza"],
      budgetUSD: maxPrice,
      minAssuranceTier: 1,
      optimizeFor: "price",
      location: { lat: loc.lat, lng: loc.lng, radiusKm: 25 },
    };

    const planned = planComposition(composeReq);
    if (planned.status !== "proposed" || planned.steps.length < 2) {
      return reply.status(planned.status === "over_budget" ? 402 : 404).send({
        error: planned.status,
        message:
          planned.rejectionReason ??
          `compose engine returned ${planned.status} for this order`,
      });
    }

    const shopStep = planned.steps[0]!;
    const driverStep = planned.steps[1]!;

    const orderId = `order_${randomUUID().slice(0, 8)}`;
    const order: DemoOrder = {
      orderId,
      userId: body.userId,
      description: body.description,
      deliveryAddress: body.deliveryAddress,
      deliveryLocation: loc,
      maxPriceUSD: maxPrice,
      maxTimeMin: body.maxTimeMin ?? 30,
      status: "proposed",
      composition: {
        compositionId: planned.compositionId,
        shop: {
          capabilityId: shopStep.capabilityId,
          kernelId: shopStep.kernelId,
          name: deriveSlug(shopStep.capabilityId),
          priceUSD: shopStep.estimatedPriceUSD,
          etaSec: Math.round((shopStep.estimatedDurationMs ?? 600_000) / 1000),
        },
        driver: {
          capabilityId: driverStep.capabilityId,
          kernelId: driverStep.kernelId,
          name: deriveSlug(driverStep.capabilityId),
          priceUSD: driverStep.estimatedPriceUSD,
          etaSec: Math.round((driverStep.estimatedDurationMs ?? 1_800_000) / 1000),
        },
        totalPriceUSD: planned.totalPriceUSD,
        etaSec: Math.round((planned.totalDurationMs ?? 2_400_000) / 1000),
      },
      jobs: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    orders.set(orderId, order);
    return reply.status(201).send({ order });
  });

  // POST /api/demo/orders/:id/confirm — user accepts the quote.
  // Does NOT dispatch work — the pre-commit + stake + escrow phases run first.
  // Call POST /api/demo/orders/:id/pre-commit next.
  app.post<{ Params: { id: string } }>(
    "/api/demo/orders/:id/confirm",
    async (req, reply) => {
      const order = orders.get(req.params.id);
      if (!order) return reply.status(404).send({ error: "not_found" });
      if (order.status !== "proposed")
        return reply.status(409).send({
          error: "wrong_state",
          message: `expected proposed, got ${order.status}`,
        });
      updateOrder(order, "confirmed");
      return reply.status(200).send({
        order,
        next: {
          step: "pre-commit",
          endpoint: `/api/demo/orders/${order.orderId}/pre-commit`,
        },
      });
    },
  );

  // POST /api/demo/orders/:id/cancel — user cancels (before escrow locks).
  app.post<{ Params: { id: string } }>(
    "/api/demo/orders/:id/cancel",
    async (req, reply) => {
      const order = orders.get(req.params.id);
      if (!order) return reply.status(404).send({ error: "not_found" });
      const cancellable: DemoOrder["status"][] = ["proposed", "confirmed", "staking"];
      if (!cancellable.includes(order.status))
        return reply
          .status(409)
          .send({ error: "wrong_state", message: order.status });
      order.rejectionReason = "cancelled by user";
      if (order.escrow) order.escrow.returned = true;
      updateOrder(order, "cancelled");
      return reply.status(200).send({ order });
    },
  );

  // POST /api/demo/orders/:id/confirm-delivery — user confirms receipt.
  // Settlement releases, stakes return, all parties are told to reveal.
  app.post<{ Params: { id: string } }>(
    "/api/demo/orders/:id/confirm-delivery",
    async (req, reply) => {
      const res = confirmDelivery(req.params.id);
      if (!res.ok)
        return reply.status(res.status).send({ error: res.error, message: res.message });
      return reply.status(200).send({
        order: res.data!.order,
        settlement: res.data!.settlement,
      });
    },
  );

  // GET /api/demo/orders/:id — read order state (runs window sweeps lazily).
  app.get<{ Params: { id: string } }>(
    "/api/demo/orders/:id",
    async (req, reply) => {
      const order = orders.get(req.params.id);
      if (!order) return reply.status(404).send({ error: "not_found" });
      // Lazy timers: a poll after a deadline transitions the order.
      sweepStakeWindow(order);
      sweepConfirmationWindow(order);
      return reply.status(200).send({
        order,
        jobs: {
          makePizza: order.jobs.makePizza ? jobs.get(order.jobs.makePizza) : null,
          delivery: order.jobs.delivery ? jobs.get(order.jobs.delivery) : null,
        },
        commitments: order.jobId ? getCommitments(order.jobId) : [],
        evidence: order.jobId ? getEvidence(order.jobId) : [],
      });
    },
  );

  // GET /api/demo/jobs/:assignee/queue — queued+active tickets for an operator/driver.
  app.get<{ Params: { assignee: string } }>(
    "/api/demo/jobs/:assignee/queue",
    async (req, reply) => {
      const ids = jobsByAssignee.get(req.params.assignee) ?? [];
      const active = ids
        .map((id) => jobs.get(id))
        .filter(
          (j): j is DemoJob =>
            !!j &&
            j.status !== "complete" &&
            j.status !== "rejected" &&
            j.status !== "expired",
        );
      const completed = ids
        .map((id) => jobs.get(id))
        .filter((j): j is DemoJob => !!j && j.status === "complete")
        .slice(-10);
      return reply.status(200).send({ active, completed });
    },
  );

  // POST /api/demo/jobs/:jobId/accept — operator/driver acknowledges a ticket.
  app.post<{ Params: { jobId: string } }>(
    "/api/demo/jobs/:jobId/accept",
    async (req, reply) => {
      const job = jobs.get(req.params.jobId);
      if (!job) return reply.status(404).send({ error: "not_found" });
      if (job.status !== "queued")
        return reply
          .status(409)
          .send({ error: "wrong_state", message: job.status });
      job.status = "accepted";
      job.acceptedAt = nowIso();
      const order = orders.get(job.orderId);
      if (order) {
        // Cosmetic order state — compatible with the evidence-driven transitions.
        if (job.type === "make-pizza" && order.status === "awaiting_shop")
          updateOrder(order, "making");
        else if (job.type === "deliver-pizza" && order.status === "awaiting_driver")
          updateOrder(order, "ready_for_pickup");
        emitter.emit(`order:${job.orderId}`, { type: "job_accepted", job });
      }
      return reply.status(200).send({
        job,
        oracleJobId: order?.jobId ?? null,
        hint: "submit evidence to POST /api/demo/jobs/<oracleJobId>/evidence",
      });
    },
  );

  // POST /api/demo/jobs/:jobId/pickup — driver marks pickup on the ticket.
  // (The order moves to in_transit when the driver submits a pickup evidence bundle.)
  app.post<{ Params: { jobId: string } }>(
    "/api/demo/jobs/:jobId/pickup",
    async (req, reply) => {
      const job = jobs.get(req.params.jobId);
      if (!job || job.type !== "deliver-pizza")
        return reply.status(404).send({ error: "not_found" });
      if (job.status !== "accepted")
        return reply
          .status(409)
          .send({ error: "wrong_state", message: job.status });
      job.status = "picked_up";
      const order = orders.get(job.orderId);
      // Legacy (no oracle pre-commit) orders advance here; oracle orders advance on evidence.
      if (order && !order.jobId && order.status === "ready_for_pickup")
        updateOrder(order, "in_transit");
      emitter.emit(`order:${job.orderId}`, { type: "job_pickup", job });
      return reply.status(200).send({ job });
    },
  );

  // POST /api/demo/jobs/:jobId/complete — operator/driver marks a ticket done.
  // For oracle orders the order lifecycle is driven by evidence submission, not
  // this endpoint; this just marks the work ticket + nudges for evidence.
  app.post<{ Params: { jobId: string }; Body: { evidenceHash?: string } }>(
    "/api/demo/jobs/:jobId/complete",
    async (req, reply) => {
      const job = jobs.get(req.params.jobId);
      if (!job) return reply.status(404).send({ error: "not_found" });
      if (job.status !== "accepted" && job.status !== "picked_up")
        return reply
          .status(409)
          .send({ error: "wrong_state", message: job.status });
      job.status = "complete";
      job.evidenceHash =
        req.body?.evidenceHash ?? `sha256:${randomUUID().replace(/-/g, "")}`;
      job.completedAt = nowIso();

      const order = orders.get(job.orderId);
      if (!order) return reply.status(200).send({ job, order: null });

      // Legacy fallback for orders that never went through pre-commit.
      if (!order.jobId) {
        if (job.type === "make-pizza") {
          updateOrder(order, "awaiting_driver");
          dispatchDelivery(order);
        } else if (job.type === "deliver-pizza") {
          updateOrder(order, "delivered");
        }
        return reply.status(200).send({ job, order });
      }

      return reply.status(200).send({
        job,
        oracleJobId: order.jobId,
        hint: "order advances when you POST the evidence bundle to /api/demo/jobs/<oracleJobId>/evidence",
      });
    },
  );

  // POST /api/demo/jobs/:jobId/reject — operator/driver rejects a ticket.
  app.post<{
    Params: { jobId: string };
    Body: { reason?: string };
  }>("/api/demo/jobs/:jobId/reject", async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return reply.status(404).send({ error: "not_found" });
    if (job.status !== "queued" && job.status !== "accepted")
      return reply
        .status(409)
        .send({ error: "wrong_state", message: job.status });
    job.status = "rejected";
    const order = orders.get(job.orderId);
    if (order) {
      order.rejectionReason = req.body?.reason ?? "rejected by assignee";
      updateOrder(order, "rejected");
    }
    return reply.status(200).send({ job });
  });

  // GET /sse/demo/order/:id — user watches order status + oracle events.
  app.get<{ Params: { id: string } }>(
    "/sse/demo/order/:id",
    async (req, reply) => {
      setupSse(reply, [`order:${req.params.id}`]);
    },
  );

  // GET /sse/demo/operator/:slug — shop watches jobs + its pre_commit_required.
  app.get<{ Params: { slug: string } }>(
    "/sse/demo/operator/:slug",
    async (req, reply) => {
      setupSse(reply, [`operator:${req.params.slug}`]);
    },
  );

  // GET /sse/demo/driver/:slug — driver watches jobs + its pre_commit_required.
  app.get<{ Params: { slug: string } }>(
    "/sse/demo/driver/:slug",
    async (req, reply) => {
      setupSse(reply, [`driver:${req.params.slug}`]);
    },
  );

  // GET /api/demo/orders — list recent orders (for demo dashboard).
  app.get("/api/demo/orders", async (_req, reply) => {
    const all = Array.from(orders.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return reply
      .status(200)
      .send({ orders: all.slice(0, 50), total: all.length });
  });

  // POST /api/demo/_reset — wipe state (demo bootstrap).
  app.post("/api/demo/_reset", async (_req, reply) => {
    _clearPizzaForTests();
    return reply.status(200).send({ ok: true });
  });
}

/** Test helper — clear in-memory state (delegates to the shared store). */
export function _clearPizzaDemoForTests(): void {
  _clearPizzaForTests();
}

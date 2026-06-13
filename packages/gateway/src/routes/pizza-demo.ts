/**
 * POST /api/demo/pizza-* — agentic-composition pizza demo for vibecodenights x402 session.
 *
 * Demo flow:
 *   1. User's agent: POST /api/demo/pizza-order  → returns proposed composition (shop + driver)
 *   2. User confirms:   POST /api/demo/orders/:id/confirm → dispatch make-pizza job to shop
 *   3. Shop's UI: GET /sse/demo/operator/:shopSlug receives the job
 *   4. Shop accepts/completes: POST /api/demo/jobs/:jobId/accept, /complete
 *   5. On make-pizza complete: dispatch deliver-pizza job to driver
 *   6. Driver's UI: GET /sse/demo/driver/:driverSlug receives the job
 *   7. Driver accepts/picks-up/completes
 *   8. On deliver-pizza complete: order DELIVERED → settlement + reputation
 *
 * Storage: in-memory (matches substrate scaffold). Production swaps to facades.
 * The route delegates planning to compose.planComposition() — exercising the
 * real substrate (#88 + #95 graph-search wire), not faking it.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { planComposition } from "./compose.js";
import type { ComposeRequest } from "@pcc/spec";

// ── State ──────────────────────────────────────────────────────────────────

interface DemoOrder {
  orderId: string;
  userId: string;
  description: string;
  deliveryAddress: string;
  deliveryLocation: { lat: number; lng: number };
  maxPriceUSD: number;
  maxTimeMin: number;
  status:
    | "proposed"
    | "confirmed"
    | "awaiting_shop"
    | "making"
    | "ready_for_pickup"
    | "awaiting_driver"
    | "in_transit"
    | "delivered"
    | "rejected"
    | "failed";
  composition?: {
    compositionId: string;
    shop: ProviderRef;
    driver: ProviderRef;
    totalPriceUSD: number;
    etaSec: number;
  };
  jobs: {
    makePizza?: string; // jobId
    delivery?: string; // jobId
  };
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProviderRef {
  capabilityId: string;
  kernelId: string;
  name: string;
  priceUSD: number;
  etaSec: number;
}

interface DemoJob {
  jobId: string;
  orderId: string;
  type: "make-pizza" | "deliver-pizza";
  assigneeSlug: string;
  status:
    | "queued"
    | "accepted"
    | "picked_up"
    | "complete"
    | "rejected"
    | "expired";
  details: {
    description: string;
    priceUSD: number;
    deliveryAddress?: string;
    pickupAddress?: string;
    deadlineSec: number;
  };
  evidenceHash?: string;
  acceptedAt?: string;
  completedAt?: string;
  createdAt: string;
}

const orders = new Map<string, DemoOrder>();
const jobs = new Map<string, DemoJob>();
const jobsByAssignee = new Map<string, string[]>(); // assigneeSlug → jobId[]

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function emit(topic: string, event: unknown): void {
  emitter.emit(topic, event);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function deriveSlug(refId: string): string {
  // capability-id format: "cap_shop-roma" → "shop-roma"
  return refId.replace(/^cap_/, "").replace(/^skill_/, "");
}

function pushJobToAssignee(jobId: string, slug: string): void {
  const list = jobsByAssignee.get(slug) ?? [];
  list.push(jobId);
  jobsByAssignee.set(slug, list);
}

function dispatchMakePizza(order: DemoOrder): DemoJob {
  if (!order.composition) throw new Error("no composition");
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const job: DemoJob = {
    jobId,
    orderId: order.orderId,
    type: "make-pizza",
    assigneeSlug: deriveSlug(order.composition.shop.capabilityId),
    status: "queued",
    details: {
      description: order.description,
      priceUSD: order.composition.shop.priceUSD,
      deadlineSec: order.composition.shop.etaSec,
    },
    createdAt: nowIso(),
  };
  jobs.set(jobId, job);
  pushJobToAssignee(jobId, job.assigneeSlug);
  order.jobs.makePizza = jobId;
  emit(`operator:${job.assigneeSlug}`, { type: "job_assigned", job });
  return job;
}

function dispatchDelivery(order: DemoOrder): DemoJob {
  if (!order.composition) throw new Error("no composition");
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const job: DemoJob = {
    jobId,
    orderId: order.orderId,
    type: "deliver-pizza",
    assigneeSlug: deriveSlug(order.composition.driver.capabilityId),
    status: "queued",
    details: {
      description: `Deliver ${order.description}`,
      priceUSD: order.composition.driver.priceUSD,
      pickupAddress: order.composition.shop.name,
      deliveryAddress: order.deliveryAddress,
      deadlineSec: order.composition.driver.etaSec,
    },
    createdAt: nowIso(),
  };
  jobs.set(jobId, job);
  pushJobToAssignee(jobId, job.assigneeSlug);
  order.jobs.delivery = jobId;
  emit(`driver:${job.assigneeSlug}`, { type: "job_assigned", job });
  return job;
}

function updateOrder(order: DemoOrder, status: DemoOrder["status"]): void {
  order.status = status;
  order.updatedAt = nowIso();
  emit(`order:${order.orderId}`, { type: "status", order });
}

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
      requesterAgentId: body.userId,
      outcomeType: "delivered-pizza",
      outcomeChain: ["make-pizza", "delivered-pizza"],
      budgetUSD: maxPrice,
      minAssuranceTier: 1,
      optimizeFor: "price",
      location: { lat: loc.lat, lng: loc.lng, radiusKm: 25 },
    };

    const planned = planComposition(composeReq);
    if (planned.status !== "proposed" || !planned.candidate) {
      return reply.status(planned.status === "over_budget" ? 402 : 404).send({
        error: planned.status,
        message:
          planned.rejectionReason ??
          `compose engine returned ${planned.status} for this order`,
      });
    }

    const cand = planned.candidate;
    const shopStep = cand.steps[0]!;
    const driverStep = cand.steps[1]!;

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
        totalPriceUSD: cand.totalPriceUSD,
        etaSec: Math.round((cand.totalDurationMs ?? 2_400_000) / 1000),
      },
      jobs: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    orders.set(orderId, order);
    return reply.status(201).send({ order });
  });

  // POST /api/demo/orders/:id/confirm — user confirms; dispatch make-pizza.
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
      updateOrder(order, "awaiting_shop");
      const job = dispatchMakePizza(order);
      return reply.status(200).send({ order, job });
    },
  );

  // POST /api/demo/orders/:id/cancel — user cancels (only before shop accepts).
  app.post<{ Params: { id: string } }>(
    "/api/demo/orders/:id/cancel",
    async (req, reply) => {
      const order = orders.get(req.params.id);
      if (!order) return reply.status(404).send({ error: "not_found" });
      if (order.status !== "proposed" && order.status !== "awaiting_shop")
        return reply
          .status(409)
          .send({ error: "wrong_state", message: order.status });
      updateOrder(order, "rejected");
      order.rejectionReason = "cancelled by user";
      return reply.status(200).send({ order });
    },
  );

  // GET /api/demo/orders/:id — read order state.
  app.get<{ Params: { id: string } }>(
    "/api/demo/orders/:id",
    async (req, reply) => {
      const order = orders.get(req.params.id);
      if (!order) return reply.status(404).send({ error: "not_found" });
      return reply.status(200).send({
        order,
        jobs: {
          makePizza: order.jobs.makePizza
            ? jobs.get(order.jobs.makePizza)
            : null,
          delivery: order.jobs.delivery ? jobs.get(order.jobs.delivery) : null,
        },
      });
    },
  );

  // GET /api/demo/jobs/:assignee/queue — list queued+active jobs for an operator/driver.
  app.get<{ Params: { assignee: string } }>(
    "/api/demo/jobs/:assignee/queue",
    async (req, reply) => {
      const ids = jobsByAssignee.get(req.params.assignee) ?? [];
      const active = ids
        .map((id) => jobs.get(id))
        .filter(
          (j): j is DemoJob =>
            !!j && j.status !== "complete" && j.status !== "rejected" && j.status !== "expired",
        );
      const completed = ids
        .map((id) => jobs.get(id))
        .filter((j): j is DemoJob => !!j && j.status === "complete")
        .slice(-10);
      return reply.status(200).send({ active, completed });
    },
  );

  // POST /api/demo/jobs/:jobId/accept — operator/driver accepts.
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
        if (job.type === "make-pizza") updateOrder(order, "making");
        else if (job.type === "deliver-pizza")
          updateOrder(order, "ready_for_pickup");
      }
      emit(`order:${job.orderId}`, { type: "job_accepted", job });
      return reply.status(200).send({ job });
    },
  );

  // POST /api/demo/jobs/:jobId/pickup — driver marks pickup.
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
      if (order) updateOrder(order, "in_transit");
      emit(`order:${job.orderId}`, { type: "job_pickup", job });
      return reply.status(200).send({ job });
    },
  );

  // POST /api/demo/jobs/:jobId/complete — operator/driver completes with evidence.
  app.post<{ Params: { jobId: string }; Body: { evidenceHash?: string } }>(
    "/api/demo/jobs/:jobId/complete",
    async (req, reply) => {
      const job = jobs.get(req.params.jobId);
      if (!job) return reply.status(404).send({ error: "not_found" });
      if (
        job.status !== "accepted" &&
        job.status !== "picked_up"
      )
        return reply
          .status(409)
          .send({ error: "wrong_state", message: job.status });
      job.status = "complete";
      job.evidenceHash =
        req.body?.evidenceHash ?? `sha256:${randomUUID().replace(/-/g, "")}`;
      job.completedAt = nowIso();

      const order = orders.get(job.orderId);
      if (!order)
        return reply.status(200).send({ job, order: null });

      if (job.type === "make-pizza") {
        updateOrder(order, "awaiting_driver");
        dispatchDelivery(order);
      } else if (job.type === "deliver-pizza") {
        updateOrder(order, "delivered");
        emit(`order:${order.orderId}`, {
          type: "delivered",
          order,
          settlement: {
            // Mocked settlement event; real impl wires to EAS V2 (#83/#94)
            shopPayoutUSD: order.composition!.shop.priceUSD,
            driverPayoutUSD: order.composition!.driver.priceUSD,
            pccFeeUSD: +(order.composition!.totalPriceUSD * 0.0235).toFixed(2),
          },
          reputation: {
            // Mocked deltas; real wire is via PR #91 + #96 executeComposition
            shopDelta: 15, // +10 step + 5 bonus
            driverDelta: 15,
          },
        });
      }
      return reply.status(200).send({ job, order });
    },
  );

  // POST /api/demo/jobs/:jobId/reject — operator/driver rejects.
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
      updateOrder(order, "rejected");
      order.rejectionReason = req.body?.reason ?? "rejected by assignee";
    }
    return reply.status(200).send({ job });
  });

  // GET /sse/demo/order/:id — user watches order status.
  app.get<{ Params: { id: string } }>(
    "/sse/demo/order/:id",
    async (req, reply) => {
      setupSse(reply, [`order:${req.params.id}`]);
    },
  );

  // GET /sse/demo/operator/:slug — shop watches incoming jobs.
  app.get<{ Params: { slug: string } }>(
    "/sse/demo/operator/:slug",
    async (req, reply) => {
      setupSse(reply, [`operator:${req.params.slug}`]);
    },
  );

  // GET /sse/demo/driver/:slug — driver watches incoming jobs.
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
    return reply.status(200).send({ orders: all.slice(0, 50), total: all.length });
  });

  // POST /api/demo/_reset — wipe state (demo bootstrap).
  app.post("/api/demo/_reset", async (_req, reply) => {
    orders.clear();
    jobs.clear();
    jobsByAssignee.clear();
    return reply.status(200).send({ ok: true });
  });
}

/** Test helper — clear in-memory state. */
export function _clearPizzaDemoForTests(): void {
  orders.clear();
  jobs.clear();
  jobsByAssignee.clear();
  emitter.removeAllListeners();
}

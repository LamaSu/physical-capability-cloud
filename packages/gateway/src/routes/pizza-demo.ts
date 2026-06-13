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
import { searchGraph } from "./graph-search.js";
import {
  decideOnOffer,
  getPolicyForAssignee,
  COUNTER_OFFER_WINDOW_SEC,
} from "./operator-policy.js";
import type {
  ComposeRequest,
  DemoJobOffer,
  DemoPolicyMode,
  GraphSearchRequest,
  GraphPathStep,
} from "@pcc/spec";

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
    | "negotiating"
    | "making"
    | "ready_for_pickup"
    | "awaiting_driver"
    | "in_transit"
    | "delivered"
    | "rejected"
    | "failed";
  /** capabilityIds of shops that auto-declined — excluded from re-routing. */
  declinedShops?: string[];
  /** capabilityIds of drivers that auto-declined — excluded from re-routing. */
  declinedDrivers?: string[];
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
    | "negotiating"
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
  // ── Policy-driven fields ──────────────────────────────────────────────────
  /** Which policy mode the assignee's agent applied to this offer. */
  policyMode?: DemoPolicyMode;
  /** True when the agent (not a human) accepted/declined this job. */
  autoHandled?: boolean;
  /** Why the job was rejected/declined (policy reason or human reason). */
  rejectionReason?: string;
  /** Counter-offer: the price the operator's agent is asking for. */
  counterPriceUSD?: number;
  /** Counter-offer: the original offered price, before the counter. */
  originalPriceUSD?: number;
  /** How many counter-offers the agent has issued on this assignment. */
  counterOffersSoFar?: number;
  /** Counter-offer expiry (ISO); the user agent must respond before this. */
  counterExpiresAt?: string;
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

/** Counter-offer response window, in ms (derived from the policy module). */
const COUNTER_WINDOW_MS = COUNTER_OFFER_WINDOW_SEC * 1000;
/** jobId → pending counter-offer expiry timer (so it can be cleared on resolve). */
const counterTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Round to 2 decimals (cents). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "operator:<slug>" for shops, "driver:<slug>" for drivers. */
function topicFor(role: "shop" | "driver", slug: string): string {
  return role === "shop" ? `operator:${slug}` : `driver:${slug}`;
}

/** Count jobs an assignee already has actively running (accepted / picked_up). */
function countRunning(slug: string, excludeJobId?: string): number {
  const ids = jobsByAssignee.get(slug) ?? [];
  let n = 0;
  for (const id of ids) {
    if (id === excludeJobId) continue;
    const j = jobs.get(id);
    if (j && (j.status === "accepted" || j.status === "picked_up")) n++;
  }
  return n;
}

// ── Dispatch (policy-aware) ──────────────────────────────────────────────────

function buildMakePizzaJob(order: DemoOrder): DemoJob {
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
  return job;
}

function buildDeliveryJob(order: DemoOrder): DemoJob {
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
  return job;
}

function dispatchMakePizza(order: DemoOrder): DemoJob {
  return applyPolicy(order, buildMakePizzaJob(order), "shop");
}

function dispatchDelivery(order: DemoOrder): DemoJob {
  return applyPolicy(order, buildDeliveryJob(order), "driver");
}

/**
 * Consult the assignee's policy for a freshly-built (queued) job and act on the
 * decision. This is where shops/drivers stop being reflexive accept-bots:
 *   - prompt-human  → leave queued, notify the operator UI (original behaviour)
 *   - auto-accept   → straight to "accepted", skip the queue
 *   - auto-decline  → mark rejected, re-route to the next-cheapest provider
 *   - counter-offer → "negotiating"; the user agent has 30s to approve/reject
 */
function applyPolicy(
  order: DemoOrder,
  job: DemoJob,
  role: "shop" | "driver",
): DemoJob {
  const policy = getPolicyForAssignee(job.assigneeSlug, job.type);
  job.policyMode = policy.mode;

  const offer: DemoJobOffer = {
    capabilityType: job.type,
    priceUSD: job.details.priceUSD,
    deadlineSec: job.details.deadlineSec,
    currentConcurrent: countRunning(job.assigneeSlug, job.jobId),
    counterOffersSoFar: job.counterOffersSoFar ?? 0,
  };
  const decision = decideOnOffer(policy, offer);
  const topic = topicFor(role, job.assigneeSlug);

  switch (decision.kind) {
    case "prompt-human": {
      job.status = "queued";
      emit(topic, { type: "job_assigned", job });
      emit(`order:${order.orderId}`, { type: "job_queued", job });
      return job;
    }
    case "auto-accept": {
      job.status = "accepted";
      job.acceptedAt = nowIso();
      job.autoHandled = true;
      emit(topic, { type: "job_auto_accepted", job });
      // Also emit job_assigned so the unmodified operator/driver dashboards
      // render it (as in-progress, with the Mark-done action).
      emit(topic, { type: "job_assigned", job });
      updateOrder(order, role === "shop" ? "making" : "ready_for_pickup");
      emit(`order:${order.orderId}`, { type: "job_auto_accepted", job });
      return job;
    }
    case "auto-decline": {
      job.status = "rejected";
      job.autoHandled = true;
      job.rejectionReason = decision.reason;
      emit(topic, { type: "job_auto_declined", job, reason: decision.reason });
      emit(`order:${order.orderId}`, {
        type: "job_auto_declined",
        job,
        reason: decision.reason,
      });
      return tryNextProvider(order, role, job);
    }
    case "counter-offer": {
      job.status = "negotiating";
      job.originalPriceUSD = job.details.priceUSD;
      job.counterPriceUSD = decision.newPriceUSD;
      job.counterOffersSoFar = (job.counterOffersSoFar ?? 0) + 1;
      job.counterExpiresAt = new Date(Date.now() + COUNTER_WINDOW_MS).toISOString();
      scheduleCounterExpiry(order, job, role);
      emit(topic, {
        type: "job_counter_offered",
        job,
        newPriceUSD: decision.newPriceUSD,
      });
      emit(`order:${order.orderId}`, {
        type: "job_counter_offered",
        job,
        newPriceUSD: decision.newPriceUSD,
      });
      updateOrder(order, "negotiating");
      return job;
    }
  }
}

/**
 * After an auto-decline (or a rejected/expired counter), pick the next-cheapest
 * provider for the role via the compose engine's graph search, excluding any
 * that already declined, then re-dispatch (which re-consults that provider's
 * policy). If no provider remains, the order fails.
 */
function tryNextProvider(
  order: DemoOrder,
  role: "shop" | "driver",
  declinedJob: DemoJob,
): DemoJob {
  if (!order.composition) return declinedJob;

  const declinedCapId =
    role === "shop"
      ? order.composition.shop.capabilityId
      : order.composition.driver.capabilityId;
  const excluded =
    role === "shop"
      ? (order.declinedShops ??= [])
      : (order.declinedDrivers ??= []);
  if (!excluded.includes(declinedCapId)) excluded.push(declinedCapId);

  const alt = cheapestAlternativeProvider(order, role, new Set(excluded));
  if (!alt) {
    order.rejectionReason = `no ${role} accepted the order (all ${excluded.length} declined)`;
    updateOrder(order, "failed");
    emit(`order:${order.orderId}`, {
      type: "composition_failed",
      role,
      reason: order.rejectionReason,
    });
    return declinedJob;
  }

  if (role === "shop") order.composition.shop = alt;
  else order.composition.driver = alt;
  order.composition.totalPriceUSD = round2(
    order.composition.shop.priceUSD + order.composition.driver.priceUSD,
  );
  emit(`order:${order.orderId}`, { type: "rerouting", role, to: alt });

  return role === "shop" ? dispatchMakePizza(order) : dispatchDelivery(order);
}

/**
 * Cheapest provider for the role, via the graph-search engine, excluding any
 * capabilityIds in `excluded`. Returns null when nothing is left (or the graph
 * is unseeded). Uses a generous topN so every distinct provider surfaces.
 */
function cheapestAlternativeProvider(
  order: DemoOrder,
  role: "shop" | "driver",
  excluded: Set<string>,
): ProviderRef | null {
  const loc = order.deliveryLocation;
  const gsReq: GraphSearchRequest = {
    outcomeType: "delivered-pizza",
    budgetUSD: order.maxPriceUSD,
    minAssuranceTier: 1,
    location: { lat: loc.lat, lng: loc.lng, radiusKm: 25 },
    optimizeFor: "price",
    topN: 50,
  };

  let options;
  try {
    options = searchGraph(gsReq).options;
  } catch {
    return null;
  }

  const stepIndex = role === "shop" ? 0 : 1;
  const byId = new Map<string, GraphPathStep>();
  for (const opt of options) {
    const step = opt.steps[stepIndex];
    if (!step || excluded.has(step.capabilityId)) continue;
    const seen = byId.get(step.capabilityId);
    if (!seen || step.estimatedPriceUSD < seen.estimatedPriceUSD) {
      byId.set(step.capabilityId, step);
    }
  }

  const pick = [...byId.values()].sort(
    (a, b) => a.estimatedPriceUSD - b.estimatedPriceUSD,
  )[0];
  if (!pick) return null;

  const fallbackMs = role === "shop" ? 600_000 : 1_800_000;
  return {
    capabilityId: pick.capabilityId,
    kernelId: pick.kernelId,
    name: deriveSlug(pick.capabilityId),
    priceUSD: pick.estimatedPriceUSD,
    etaSec: Math.round((pick.estimatedDurationMs ?? fallbackMs) / 1000),
  };
}

/** Auto-expire an unanswered counter-offer after the window, then re-route. */
function scheduleCounterExpiry(
  order: DemoOrder,
  job: DemoJob,
  role: "shop" | "driver",
): void {
  clearCounterTimer(job.jobId);
  const t = setTimeout(() => {
    counterTimers.delete(job.jobId);
    const live = jobs.get(job.jobId);
    if (!live || live.status !== "negotiating") return; // already resolved
    live.status = "rejected";
    live.rejectionReason = "counter-offer expired (no response in 30s)";
    emit(`order:${order.orderId}`, { type: "counter_expired", job: live });
    tryNextProvider(order, role, live);
  }, COUNTER_WINDOW_MS);
  // Don't keep the event loop (or test runner) alive on this timer.
  if (typeof t.unref === "function") t.unref();
  counterTimers.set(job.jobId, t);
}

function clearCounterTimer(jobId: string): void {
  const t = counterTimers.get(jobId);
  if (t) {
    clearTimeout(t);
    counterTimers.delete(jobId);
  }
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
      requester: { agentId: body.userId },
      outcomeType: "delivered-pizza",
      outcomeChain: ["make-pizza", "delivered-pizza"],
      budgetUSD: maxPrice,
      minAssuranceTier: 1,
      optimizeFor: "price",
      location: { lat: loc.lat, lng: loc.lng, radiusKm: 25 },
    };

    // planComposition returns a ComposeResponse whose steps/totals live at the
    // top level (there is no `.candidate` wrapper). A delivered-pizza order
    // needs both a make-pizza and a delivered-pizza step.
    const planned = planComposition(composeReq);
    if (planned.status !== "proposed" || planned.steps.length < 2) {
      return reply.status(planned.status === "over_budget" ? 402 : 404).send({
        error: planned.status === "proposed" ? "no_path_found" : planned.status,
        message:
          planned.rejectionReason ??
          `compose engine returned ${planned.status} for this order`,
      });
    }

    const cand = planned;
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

  // POST /api/demo/jobs/:jobId/approve-counter — user agent accepts a counter
  // offer; the job is accepted at the countered price.
  app.post<{ Params: { jobId: string } }>(
    "/api/demo/jobs/:jobId/approve-counter",
    async (req, reply) => {
      const job = jobs.get(req.params.jobId);
      if (!job) return reply.status(404).send({ error: "not_found" });
      if (job.status !== "negotiating")
        return reply
          .status(409)
          .send({ error: "wrong_state", message: job.status });
      if (
        job.counterExpiresAt &&
        new Date(job.counterExpiresAt).getTime() < Date.now()
      )
        return reply.status(410).send({
          error: "counter_expired",
          message: "counter-offer window elapsed",
        });

      clearCounterTimer(job.jobId);
      if (typeof job.counterPriceUSD === "number")
        job.details.priceUSD = job.counterPriceUSD;
      job.status = "accepted";
      job.acceptedAt = nowIso();

      const order = orders.get(job.orderId);
      if (order) {
        if (order.composition) {
          if (job.type === "make-pizza")
            order.composition.shop.priceUSD = job.details.priceUSD;
          else order.composition.driver.priceUSD = job.details.priceUSD;
          order.composition.totalPriceUSD = round2(
            order.composition.shop.priceUSD +
              order.composition.driver.priceUSD,
          );
        }
        updateOrder(
          order,
          job.type === "make-pizza" ? "making" : "ready_for_pickup",
        );
      }
      const role = job.type === "make-pizza" ? "shop" : "driver";
      emit(topicFor(role, job.assigneeSlug), { type: "counter_accepted", job });
      emit(`order:${job.orderId}`, { type: "counter_accepted", job });
      return reply.status(200).send({ job, order: order ?? null });
    },
  );

  // POST /api/demo/jobs/:jobId/reject-counter — user rejects the counter; try
  // the next-cheapest provider.
  app.post<{ Params: { jobId: string } }>(
    "/api/demo/jobs/:jobId/reject-counter",
    async (req, reply) => {
      const job = jobs.get(req.params.jobId);
      if (!job) return reply.status(404).send({ error: "not_found" });
      if (job.status !== "negotiating")
        return reply
          .status(409)
          .send({ error: "wrong_state", message: job.status });

      clearCounterTimer(job.jobId);
      job.status = "rejected";
      job.rejectionReason = "counter-offer rejected by user";
      emit(`order:${job.orderId}`, { type: "counter_rejected", job });

      const order = orders.get(job.orderId);
      if (!order) return reply.status(200).send({ job, order: null });
      const role = job.type === "make-pizza" ? "shop" : "driver";
      const nextJob = tryNextProvider(order, role, job);
      return reply.status(200).send({ job, order, nextJob });
    },
  );

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
    for (const t of counterTimers.values()) clearTimeout(t);
    counterTimers.clear();
    orders.clear();
    jobs.clear();
    jobsByAssignee.clear();
    return reply.status(200).send({ ok: true });
  });
}

/** Test helper — clear in-memory state. */
export function _clearPizzaDemoForTests(): void {
  for (const t of counterTimers.values()) clearTimeout(t);
  counterTimers.clear();
  orders.clear();
  jobs.clear();
  jobsByAssignee.clear();
  emitter.removeAllListeners();
}

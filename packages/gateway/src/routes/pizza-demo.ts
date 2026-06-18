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
import { geocode } from "../services/geocode.js";
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
  /** Ordered log of real lifecycle events — drives the observability timeline. */
  timeline: TimelineEntry[];
  /** Mocked-but-realistic on-chain event surface for this order. */
  chainEvents: ChainEvent[];
  createdAt: string;
  updatedAt: string;
}

/** One recorded step in an order's lifecycle (a fact that already happened). */
interface TimelineEntry {
  step: string; // canonical step id — matches the dashboard's STEPS list
  label: string;
  role: "user" | "compose" | "shop" | "driver" | "chain";
  at: string; // ISO timestamp of when it actually happened
  detail?: Record<string, unknown>;
}

/** A mocked on-chain event shaped like a real Base Sepolia log. */
interface ChainEvent {
  id: string;
  orderId: string;
  type:
    | "escrow_locked"
    | "escrow_released"
    | "usdc_transfer"
    | "eas_attestation"
    | "reputation_delta";
  contract: string; // "MilestoneEscrowV2" | "EASV2" | "USDC"
  txHash: string; // 0x + 64 hex
  blockNumber: number;
  amountUSDC?: string;
  from?: string;
  to?: string;
  schema?: string; // EAS schema label
  data?: Record<string, unknown>;
  explorerUrl: string;
  mock: boolean;
  at: string;
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
emitter.setMaxListeners(1000);

/** Meta-topic every event is mirrored onto so /sse/demo/firehose sees everything. */
const FIREHOSE_TOPIC = "__firehose__";

function emit(topic: string, event: unknown): void {
  emitter.emit(topic, event);
  // Fan every event out to the cross-order firehose stream too.
  emitter.emit(FIREHOSE_TOPIC, { topic, event, ts: nowIso() });
}

// ── Observability helpers: timeline recording + mocked on-chain surface ───────

// Plausible Base Sepolia block height; advances a few blocks per event.
let blockCursor = 28_400_000 + Math.floor(Math.random() * 50_000);
function nextBlock(): number {
  blockCursor += 1 + Math.floor(Math.random() * 4);
  return blockCursor;
}

function mockTxHash(): string {
  return "0x" + (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64);
}

function usdc(n: number): string {
  return n.toFixed(2);
}

/** Record a real lifecycle step on the order and push it to subscribers. */
function recordStep(
  order: DemoOrder,
  step: string,
  label: string,
  role: TimelineEntry["role"],
  detail?: Record<string, unknown>,
): TimelineEntry {
  const entry: TimelineEntry = { step, label, role, at: nowIso(), detail };
  order.timeline.push(entry);
  emit(`order:${order.orderId}`, { type: "timeline", entry });
  return entry;
}

/** Mint a mocked on-chain event, attach it to the order, and broadcast it. */
function emitChainEvent(
  order: DemoOrder,
  type: ChainEvent["type"],
  contract: string,
  fields: Partial<ChainEvent> = {},
): ChainEvent {
  const txHash = mockTxHash();
  const ce: ChainEvent = {
    ...fields,
    id: `ce_${randomUUID().slice(0, 8)}`,
    orderId: order.orderId,
    type,
    contract,
    txHash,
    blockNumber: nextBlock(),
    explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
    mock: true,
    at: nowIso(),
  };
  order.chainEvents.push(ce);
  emit(`order:${order.orderId}`, { type: "chain_event", chainEvent: ce });
  return ce;
}

/** Interpolate a short geo breadcrumb trail (origin → destination). */
function geoBreadcrumbs(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  n = 5,
): Array<{ lat: number; lng: number; seq: number }> {
  const pts: Array<{ lat: number; lng: number; seq: number }> = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push({
      lat: +(from.lat + (to.lat - from.lat) * f).toFixed(5),
      lng: +(from.lng + (to.lng - from.lng) * f).toFixed(5),
      seq: i,
    });
  }
  return pts;
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
  recordStep(order, "make_dispatched", "Make-pizza dispatched", "shop", {
    jobId,
    assignee: job.assigneeSlug,
    priceUSD: job.details.priceUSD,
    deadlineSec: job.details.deadlineSec,
  });
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
  recordStep(order, "delivery_dispatched", "Delivery dispatched", "driver", {
    jobId,
    assignee: job.assigneeSlug,
    priceUSD: job.details.priceUSD,
    pickup: job.details.pickupAddress,
    dropoff: job.details.deliveryAddress,
  });
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

    // Resolve the drop point: prefer explicit coords, else geocode the address
    // the buyer typed, else fall back to the demo's default SF drop point. The
    // resolved point flows into the compose location filter (radiusKm below), so
    // shop/driver matching is anchored to the real delivery address rather than
    // a hardcoded constant when only an address string is supplied.
    let loc = body.deliveryLocation;
    if (!loc && body.deliveryAddress) {
      loc = (await geocode(body.deliveryAddress)) ?? undefined;
    }
    loc = loc ?? { lat: 37.77, lng: -122.42 };
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
      timeline: [],
      chainEvents: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    orders.set(orderId, order);
    recordStep(order, "order_placed", "Order placed", "user", {
      description: order.description,
      deliveryAddress: order.deliveryAddress,
      maxPriceUSD: order.maxPriceUSD,
      maxTimeMin: order.maxTimeMin,
    });
    recordStep(order, "composition_planned", "Composition planned", "compose", {
      compositionId: order.composition!.compositionId,
      shop: order.composition!.shop.name,
      driver: order.composition!.driver.name,
      shopPriceUSD: order.composition!.shop.priceUSD,
      driverPriceUSD: order.composition!.driver.priceUSD,
      totalPriceUSD: order.composition!.totalPriceUSD,
      etaSec: order.composition!.etaSec,
      optimizeFor: "price",
      engine: "compose.planComposition · graph-search",
    });
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
      recordStep(order, "user_confirmed", "User confirmed", "user", {
        compositionId: order.composition?.compositionId,
      });
      updateOrder(order, "awaiting_shop");
      // Escrow lock — funds committed to the on-chain milestone contract.
      const lock = emitChainEvent(order, "escrow_locked", "MilestoneEscrowV2", {
        amountUSDC: usdc(order.composition!.totalPriceUSD),
        from: order.userId,
        to: "MilestoneEscrowV2",
        data: { milestones: 2, token: "USDC", network: "base-sepolia" },
      });
      recordStep(order, "escrow_locked", "Escrow locked", "chain", {
        txHash: lock.txHash,
        blockNumber: lock.blockNumber,
        amountUSDC: lock.amountUSDC,
        contract: "MilestoneEscrowV2",
        explorerUrl: lock.explorerUrl,
      });
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
        if (job.type === "make-pizza") {
          updateOrder(order, "making");
          recordStep(order, "shop_accepted", "Shop accepted", "shop", {
            jobId: job.jobId,
            assignee: job.assigneeSlug,
          });
        } else if (job.type === "deliver-pizza") {
          updateOrder(order, "ready_for_pickup");
          recordStep(order, "driver_accepted", "Driver accepted", "driver", {
            jobId: job.jobId,
            assignee: job.assigneeSlug,
          });
        }
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
      if (order) {
        updateOrder(order, "in_transit");
        // Geo breadcrumb trail begins at pickup (shop) → destination (user).
        const origin = {
          lat: order.deliveryLocation.lat + 0.012,
          lng: order.deliveryLocation.lng - 0.01,
        };
        const crumbs = geoBreadcrumbs(origin, order.deliveryLocation, 5);
        recordStep(order, "driver_pickup", "Driver picked up", "driver", {
          jobId: job.jobId,
          breadcrumbStart: crumbs[0],
          breadcrumbs: crumbs,
          evidenceHash: `sha256:${randomUUID().replace(/-/g, "")}`,
        });
      }
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
        // Pizza ready — evidence bundle (photo + GPS + time) attested on EAS.
        recordStep(order, "pizza_ready", "Pizza ready", "shop", {
          jobId: job.jobId,
          evidenceHash: job.evidenceHash,
          photo: `ipfs://Qm${randomUUID().replace(/-/g, "").slice(0, 44)}`,
          gps: order.deliveryLocation,
          capturedAt: nowIso(),
          assuranceTier: 2,
        });
        emitChainEvent(order, "eas_attestation", "EASV2", {
          schema: "pcc.evidence.bundle",
          to: order.composition!.shop.name,
          data: {
            jobId: job.jobId,
            evidenceHash: job.evidenceHash,
            kind: "pizza-ready",
            assuranceTier: 2,
          },
        });
        updateOrder(order, "awaiting_driver");
        dispatchDelivery(order);
      } else if (job.type === "deliver-pizza") {
        // Delivery proof — evidence bundle at the dropoff, attested on EAS.
        recordStep(order, "pizza_delivered", "Driver delivered", "driver", {
          jobId: job.jobId,
          evidenceHash: job.evidenceHash,
          photo: `ipfs://Qm${randomUUID().replace(/-/g, "").slice(0, 44)}`,
          gps: order.deliveryLocation,
          capturedAt: nowIso(),
          assuranceTier: 2,
        });
        emitChainEvent(order, "eas_attestation", "EASV2", {
          schema: "pcc.evidence.bundle",
          to: order.composition!.driver.name,
          data: {
            jobId: job.jobId,
            evidenceHash: job.evidenceHash,
            kind: "pizza-delivered",
            assuranceTier: 2,
          },
        });
        updateOrder(order, "delivered");

        const shopPayoutUSD = order.composition!.shop.priceUSD;
        const driverPayoutUSD = order.composition!.driver.priceUSD;
        const pccFeeUSD = +(order.composition!.totalPriceUSD * 0.0235).toFixed(2);

        emit(`order:${order.orderId}`, {
          type: "delivered",
          order,
          settlement: {
            // Mocked settlement event; real impl wires to EAS V2 (#83/#94)
            shopPayoutUSD,
            driverPayoutUSD,
            pccFeeUSD,
          },
          reputation: {
            // Mocked deltas; real wire is via PR #91 + #96 executeComposition
            shopDelta: 15, // +10 step + 5 bonus
            driverDelta: 15,
          },
        });

        // ── Mocked on-chain settlement surface (Base Sepolia-shaped) ──────────
        const release = emitChainEvent(
          order,
          "escrow_released",
          "MilestoneEscrowV2",
          {
            amountUSDC: usdc(order.composition!.totalPriceUSD),
            from: "MilestoneEscrowV2",
            data: { milestone: 2, reason: "evidence-verified" },
          },
        );
        emitChainEvent(order, "usdc_transfer", "USDC", {
          amountUSDC: usdc(shopPayoutUSD),
          from: "MilestoneEscrowV2",
          to: order.composition!.shop.name,
          data: { leg: "shop-payout" },
        });
        emitChainEvent(order, "usdc_transfer", "USDC", {
          amountUSDC: usdc(driverPayoutUSD),
          from: "MilestoneEscrowV2",
          to: order.composition!.driver.name,
          data: { leg: "driver-payout" },
        });
        emitChainEvent(order, "usdc_transfer", "USDC", {
          amountUSDC: usdc(pccFeeUSD),
          from: "MilestoneEscrowV2",
          to: "pcc-treasury",
          data: { leg: "pcc-protocol-fee", feeBps: 235 },
        });
        recordStep(order, "settlement_released", "Settlement released", "chain", {
          txHash: release.txHash,
          blockNumber: release.blockNumber,
          explorerUrl: release.explorerUrl,
          shopPayoutUSD,
          driverPayoutUSD,
          pccFeeUSD,
          contract: "MilestoneEscrowV2",
        });

        // Reputation deltas — written as EAS attestations.
        const rep = emitChainEvent(order, "reputation_delta", "EASV2", {
          schema: "pcc.reputation.delta",
          data: {
            shop: { slug: order.composition!.shop.name, delta: 15 },
            driver: { slug: order.composition!.driver.name, delta: 15 },
          },
        });
        recordStep(
          order,
          "reputation_applied",
          "Reputation deltas applied",
          "chain",
          {
            txHash: rep.txHash,
            blockNumber: rep.blockNumber,
            explorerUrl: rep.explorerUrl,
            shopDelta: 15,
            driverDelta: 15,
            contract: "EASV2",
          },
        );
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
      recordStep(order, "order_rejected", "Order rejected", "chain", {
        reason: order.rejectionReason,
        jobId: job.jobId,
        by: job.assigneeSlug,
      });
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

  // GET /api/demo/orders/observability — every order with full timeline +
  // chain-event surface + aggregate stats. Hydrates the observability dashboard
  // on first load. (Static path wins over /api/demo/orders/:id in find-my-way.)
  app.get("/api/demo/orders/observability", async (_req, reply) => {
    const all = Array.from(orders.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    const today = nowIso().slice(0, 10);
    const ACTIVE = new Set<DemoOrder["status"]>([
      "proposed",
      "confirmed",
      "awaiting_shop",
      "making",
      "ready_for_pickup",
      "awaiting_driver",
      "in_transit",
    ]);

    let totalVolumeUSD = 0;
    let pccFeeUSDToday = 0;
    let completedToday = 0;
    const deliverTimes: number[] = [];

    for (const o of all) {
      if (o.status !== "delivered") continue;
      const vol = o.composition?.totalPriceUSD ?? 0;
      if (o.updatedAt.slice(0, 10) === today) {
        totalVolumeUSD += vol;
        pccFeeUSDToday += +(vol * 0.0235).toFixed(2);
        completedToday++;
      }
      const placedAt = o.timeline.find((t) => t.step === "order_placed")?.at ?? o.createdAt;
      const deliveredAt =
        o.timeline.find((t) => t.step === "pizza_delivered")?.at ?? o.updatedAt;
      const dt = (new Date(deliveredAt).getTime() - new Date(placedAt).getTime()) / 1000;
      if (Number.isFinite(dt) && dt >= 0) deliverTimes.push(dt);
    }

    const activeOrders = all.filter((o) => ACTIVE.has(o.status)).length;
    const avgTimeToDeliverSec = deliverTimes.length
      ? Math.round(deliverTimes.reduce((a, b) => a + b, 0) / deliverTimes.length)
      : 0;

    const out = all.slice(0, 50).map((o) => ({
      orderId: o.orderId,
      userId: o.userId,
      description: o.description,
      deliveryAddress: o.deliveryAddress,
      deliveryLocation: o.deliveryLocation,
      status: o.status,
      composition: o.composition,
      rejectionReason: o.rejectionReason,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      timeline: o.timeline,
      chainEvents: o.chainEvents,
      jobs: {
        makePizza: o.jobs.makePizza ? jobs.get(o.jobs.makePizza) ?? null : null,
        delivery: o.jobs.delivery ? jobs.get(o.jobs.delivery) ?? null : null,
      },
    }));

    return reply.status(200).send({
      orders: out,
      stats: {
        activeOrders,
        completedToday,
        totalVolumeUSD: +totalVolumeUSD.toFixed(2),
        pccFeeUSDToday: +pccFeeUSDToday.toFixed(2),
        avgTimeToDeliverSec,
        totalOrders: orders.size,
      },
      serverTime: nowIso(),
    });
  });

  // GET /sse/demo/firehose — single cross-order stream of EVERY pizza-demo
  // event. The audience subscribes once and sees the whole substrate at work.
  app.get("/sse/demo/firehose", async (_req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(
      `data: ${JSON.stringify({ type: "connected", stream: "firehose" })}\n\n`,
    );

    const listener = (payload: unknown): void => {
      try {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* socket closed */
      }
    };
    emitter.on(FIREHOSE_TOPIC, listener);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch {
        /* socket closed */
      }
    }, 15_000);

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      emitter.off(FIREHOSE_TOPIC, listener);
    });
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

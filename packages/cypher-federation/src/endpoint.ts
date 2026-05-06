/**
 * Express router that PCC mounts at `/cypher/federation` to receive
 * inbound traffic from Cypher Bio's federation runtime.
 *
 * Routes:
 *   GET  /services            — list published PCC services (read-only, public)
 *   POST /orders              — accept an inbound order from Cypher
 *   GET  /status              — federation health snapshot
 *   POST /orders/:id/status   — Cypher pushes status updates (no-op log)
 *
 * All inbound bodies are validated with Zod. The router does not
 * make outbound HTTP calls itself — it delegates to a `gatewayClient`
 * for PCC-side calls and to the `peer`/`translator` for Cypher-side
 * data shaping. This keeps the router test-friendly.
 */

import express, { type Express, type Request, type Response, type Router } from "express";
import { z } from "zod";

import type { FederationPeer } from "./peer.js";
import type { OrderTranslator } from "./translator.js";
import type {
  CypherFederationService,
  CypherOrder,
  PccA2aIntent,
} from "./types.js";

// ── Inbound payload schemas ─────────────────────────────────────

const orderDataSchema = z.record(z.unknown());

const cypherOrderSchema = z.object({
  _id: z.string().min(1),
  orderNumber: z.string().min(1),
  federatedServiceId: z.string().min(1),
  orderData: orderDataSchema.optional().default({}),
  priority: z.enum(["standard", "rush", "express", "scheduled"]).optional(),
  quoteRequest: orderDataSchema.optional(),
  requester: z
    .object({
      userId: z.string().optional(),
      email: z.string().optional(),
      orgId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string().optional(),
  status: z
    .enum(["pending", "accepted", "in_progress", "completed", "failed", "cancelled"])
    .optional(),
});

const orderStatusUpdateSchema = z.object({
  status: z.enum(["accepted", "in_progress", "completed", "failed", "cancelled"]),
  message: z.string().optional(),
  /** Free-form payload passed through. */
  data: z.record(z.unknown()).optional(),
});

// ── Gateway client interface ────────────────────────────────────

/**
 * Surface the router needs from the PCC gateway. In production this
 * is a small `fetch`-based wrapper; in tests we mock it.
 */
export interface GatewayClient {
  /** POST `/api/jobs/submit` and return `{ jobId, status }`. */
  submitJob(intent: PccA2aIntent): Promise<{ jobId: string; status: string }>;
  /**
   * Optional: list currently-published services. The router uses
   * this to back `GET /services`. If absent, the router serves a
   * cached list set via `setPublishedServices`.
   */
  listPublishedServices?(): Promise<CypherFederationService[]>;
}

export interface CreatePeerEndpointOptions {
  peer: FederationPeer;
  translator: OrderTranslator;
  gatewayClient: GatewayClient;
  /**
   * Optional logger. Defaults to console.* — pass a noop logger in
   * tests to silence output.
   */
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  /** Pre-loaded cache for `GET /services` when the gateway client doesn't support live listing. */
  initialPublishedServices?: CypherFederationService[];
}

export interface PeerEndpoint {
  router: Router;
  /** Update the cached service list (useful when no live gateway listing is available). */
  setPublishedServices(services: CypherFederationService[]): void;
  /** Snapshot used by GET /status. */
  getOpenOrderCount(): number;
}

/**
 * Create the Express router.
 */
export function createPeerEndpoint(opts: CreatePeerEndpointOptions): PeerEndpoint {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  const log =
    opts.logger ?? {
      info: (...a: unknown[]) => console.log("[cypher-federation]", ...a),
      warn: (...a: unknown[]) => console.warn("[cypher-federation]", ...a),
      error: (...a: unknown[]) => console.error("[cypher-federation]", ...a),
    };

  let publishedServices: CypherFederationService[] = opts.initialPublishedServices ?? [];
  let openOrders = 0;
  let lastSyncAt: string | undefined;

  // GET /services — list published PCC services
  router.get("/services", async (_req: Request, res: Response) => {
    try {
      let services = publishedServices;
      if (opts.gatewayClient.listPublishedServices) {
        services = await opts.gatewayClient.listPublishedServices();
        publishedServices = services;
      }
      res.json({ services });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("services_list_failed", msg);
      res.status(500).json({ error: "services_list_failed", message: msg });
    }
  });

  // POST /orders — accept inbound order
  router.post("/orders", async (req: Request, res: Response) => {
    const parsed = cypherOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_order", details: parsed.error.flatten() });
      return;
    }
    const order: CypherOrder = parsed.data;
    log.info("order_received", { orderNumber: order.orderNumber, _id: order._id });

    let intent: PccA2aIntent;
    try {
      intent = opts.translator.cypherOrderToPccA2aIntent(order);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("translate_failed", msg);
      res.status(400).json({ error: "translate_failed", message: msg });
      return;
    }

    try {
      const submission = await opts.gatewayClient.submitJob(intent);
      openOrders += 1;
      lastSyncAt = new Date().toISOString();
      log.info("order_submitted", {
        orderNumber: order.orderNumber,
        jobId: submission.jobId,
      });
      res.status(200).json({
        orderNumber: order.orderNumber,
        orderId: order._id,
        status: "accepted",
        pccJobId: submission.jobId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("submit_failed", { orderNumber: order.orderNumber, error: msg });
      res.status(502).json({
        error: "submit_failed",
        message: msg,
        orderNumber: order.orderNumber,
        orderId: order._id,
      });
    }
  });

  // GET /status — federation health
  router.get("/status", async (_req: Request, res: Response) => {
    try {
      const upstream = await opts.peer.status().catch(() => undefined);
      res.json({
        registered: upstream?.registered ?? false,
        lastSyncAt: lastSyncAt ?? upstream?.lastSyncAt,
        openOrders,
        publishedServices: publishedServices.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: "status_failed", message: msg });
    }
  });

  // POST /orders/:id/status — Cypher pushes status update (no-op log for now)
  router.post("/orders/:id/status", (req: Request, res: Response) => {
    const id = req.params.id;
    const parsed = orderStatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_status_update", details: parsed.error.flatten() });
      return;
    }
    log.info("order_status_update", { orderId: id, status: parsed.data.status });
    res.status(200).json({ ok: true, orderId: id, status: parsed.data.status });
  });

  return {
    router,
    setPublishedServices(services: CypherFederationService[]) {
      publishedServices = services;
    },
    getOpenOrderCount() {
      return openOrders;
    },
  };
}

/**
 * Convenience helper: mount the router on a brand-new Express app.
 * Used by the standalone server example and by tests.
 */
export function mountStandalone(opts: CreatePeerEndpointOptions): { app: Express; endpoint: PeerEndpoint } {
  const endpoint = createPeerEndpoint(opts);
  const app = express();
  app.use("/cypher/federation", endpoint.router);
  return { app, endpoint };
}

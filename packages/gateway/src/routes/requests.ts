/**
 * Capability Request Routes
 *
 * High-level request decomposition system. Users submit natural language
 * requests that are automatically decomposed into a capability DAG with
 * dependencies, timelines, and budget allocation.
 *
 * POST /api/requests                          — submit + auto-decompose
 * GET  /api/requests                          — list (with status filter)
 * GET  /api/requests/:id                      — get with full DAG
 * POST /api/requests/:id/decompose            — re-trigger decomposition
 * POST /api/requests/:id/publish              — publish nodes as bounties
 * PUT  /api/requests/:id                      — update (title, budget, etc.)
 * DELETE /api/requests/:id                    — cancel request
 * GET  /api/requests/:id/dag                  — get the DAG only
 * GET  /api/requests/:id/critical-path        — get critical path
 * POST /api/requests/:id/nodes/:nodeId/assign — assign operator to node
 * PUT  /api/requests/:id/nodes/:nodeId/status — update node status
 */

import type { FastifyInstance } from "fastify";
import type {
  CapabilityRequest,
  CapabilityNode,
  RequestStatus,
  CapabilityNodeStatus,
} from "@pcc/spec";
import { decomposeRequest } from "../services/request-decomposer.js";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const requestsStore = new Map<string, CapabilityRequest>();

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Seed data — the moltpod example
// ---------------------------------------------------------------------------

function seedRequests() {
  const now = new Date().toISOString();

  const seedReq: CapabilityRequest = {
    id: "req-moltpod-001",
    title: "Cute Animatronic Plush Desk Robot",
    description:
      "Design and build a friendly animatronic plush desk robot for moltpod (team@moltpod.com). Cute, interactive, head movement + arm wave + idle breathing animations. Needs to be a plush/soft exterior with internal servo mechanism. Rush: needed by end of day.",
    requesterEmail: "team@moltpod.com",
    budget: 2500,
    currency: "USDC",
    deadline: "2026-03-31T23:59:59Z",
    urgency: "emergency",
    status: "decomposing",
    capabilityDag: [],
    totalEstimatedCost: 0,
    totalEstimatedHours: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Run decomposition on seed
  const result = decomposeRequest(seedReq);
  seedReq.capabilityDag = result.nodes;
  seedReq.totalEstimatedCost = result.totalEstimatedCost;
  seedReq.totalEstimatedHours = result.totalEstimatedHours;
  seedReq.status = "published";

  requestsStore.set(seedReq.id, seedReq);
}

seedRequests();

// ---------------------------------------------------------------------------
// Exported store reset (for tests)
// ---------------------------------------------------------------------------

export function resetRequestsStore() {
  requestsStore.clear();
  seedRequests();
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function requestRoutes(app: FastifyInstance) {
  // ── POST /api/requests ────────────────────────────────────────────
  // Submit a new request and auto-decompose it
  app.post("/api/requests", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CapabilityRequest>;

    if (!body.title || !body.description) {
      return reply.status(400).send({
        error: "bad_request",
        message: "title and description are required",
      });
    }

    if (body.budget !== undefined && body.budget <= 0) {
      return reply.status(400).send({
        error: "bad_request",
        message: "budget must be a positive number",
      });
    }

    const now = new Date().toISOString();
    const request: CapabilityRequest = {
      id: newId("req"),
      title: body.title,
      description: body.description,
      requesterEmail: body.requesterEmail,
      requesterWallet: body.requesterWallet,
      budget: body.budget ?? 1000,
      currency: body.currency ?? "USDC",
      deadline: body.deadline ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      urgency: body.urgency ?? "standard",
      status: "decomposing",
      capabilityDag: [],
      totalEstimatedCost: 0,
      totalEstimatedHours: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Auto-decompose immediately
    const result = decomposeRequest(request);
    request.capabilityDag = result.nodes;
    request.totalEstimatedCost = result.totalEstimatedCost;
    request.totalEstimatedHours = result.totalEstimatedHours;
    request.status = "published";

    requestsStore.set(request.id, request);

    return reply.status(201).send({ request, decomposition: result });
  });

  // ── GET /api/requests ─────────────────────────────────────────────
  app.get("/api/requests", async (req) => {
    const q = req.query as Record<string, string>;
    let results = [...requestsStore.values()];

    if (q.status) {
      results = results.filter((r) => r.status === q.status);
    }
    if (q.urgency) {
      results = results.filter((r) => r.urgency === q.urgency);
    }
    if (q.requesterEmail) {
      results = results.filter((r) => r.requesterEmail === q.requesterEmail);
    }

    return { requests: results, count: results.length };
  });

  // ── GET /api/requests/:id ─────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
    const request = requestsStore.get(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    return { request };
  });

  // ── POST /api/requests/:id/decompose ──────────────────────────────
  // Re-trigger decomposition (overwrites existing DAG)
  app.post<{ Params: { id: string } }>("/api/requests/:id/decompose", async (req, reply) => {
    const request = requestsStore.get(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "request_not_found" });
    }

    if (request.status === "cancelled") {
      return reply.status(409).send({ error: "conflict", message: "Cannot decompose a cancelled request" });
    }

    request.status = "decomposing";
    request.updatedAt = new Date().toISOString();
    requestsStore.set(request.id, request);

    const result = decomposeRequest(request);
    request.capabilityDag = result.nodes;
    request.totalEstimatedCost = result.totalEstimatedCost;
    request.totalEstimatedHours = result.totalEstimatedHours;
    request.status = "published";
    request.updatedAt = new Date().toISOString();
    requestsStore.set(request.id, request);

    return { request, decomposition: result };
  });

  // ── POST /api/requests/:id/publish ───────────────────────────────
  // Publish all pending capability nodes as bounties
  app.post<{ Params: { id: string } }>("/api/requests/:id/publish", async (req, reply) => {
    const request = requestsStore.get(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "request_not_found" });
    }

    if (request.status === "cancelled") {
      return reply.status(409).send({ error: "conflict", message: "Cannot publish a cancelled request" });
    }

    if (request.capabilityDag.length === 0) {
      return reply.status(409).send({
        error: "conflict",
        message: "Request has no decomposed nodes. Run /decompose first.",
      });
    }

    const now = new Date().toISOString();
    const publishedBounties: Array<{ nodeId: string; bountyId: string }> = [];

    for (const node of request.capabilityDag) {
      if (node.status === "pending") {
        const bountyId = newId("bounty");
        node.bountyId = bountyId;
        node.status = "bidding";
        publishedBounties.push({ nodeId: node.id, bountyId });
      }
    }

    request.status = "in_progress";
    request.updatedAt = now;
    requestsStore.set(request.id, request);

    return { request, publishedBounties, publishedCount: publishedBounties.length };
  });

  // ── PUT /api/requests/:id ─────────────────────────────────────────
  app.put<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
    const request = requestsStore.get(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "request_not_found" });
    }

    if (request.status === "cancelled") {
      return reply.status(409).send({ error: "conflict", message: "Cannot update a cancelled request" });
    }

    const body = (req.body ?? {}) as Partial<CapabilityRequest>;
    const allowed: Array<keyof CapabilityRequest> = [
      "title", "description", "budget", "deadline", "urgency",
      "requesterEmail", "requesterWallet", "currency",
    ];

    const mutable = request as unknown as Record<string, unknown>;
    for (const key of allowed) {
      if (body[key] !== undefined) {
        mutable[key] = body[key];
      }
    }

    request.updatedAt = new Date().toISOString();
    requestsStore.set(request.id, request);

    return { request };
  });

  // ── DELETE /api/requests/:id ──────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
    const request = requestsStore.get(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "request_not_found" });
    }

    request.status = "cancelled";
    request.updatedAt = new Date().toISOString();
    requestsStore.set(request.id, request);

    return { deleted: true, id: req.params.id };
  });

  // ── GET /api/requests/:id/dag ─────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/requests/:id/dag", async (req, reply) => {
    const request = requestsStore.get(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "request_not_found" });
    }

    // Build adjacency info for the DAG
    const nodes = request.capabilityDag;
    const edges = nodes.flatMap((n) =>
      n.dependencies.map((dep) => ({ from: dep, to: n.id })),
    );

    return {
      requestId: request.id,
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    };
  });

  // ── GET /api/requests/:id/critical-path ──────────────────────────
  app.get<{ Params: { id: string } }>("/api/requests/:id/critical-path", async (req, reply) => {
    const request = requestsStore.get(req.params.id);
    if (!request) {
      return reply.status(404).send({ error: "request_not_found" });
    }

    if (request.capabilityDag.length === 0) {
      return { requestId: request.id, criticalPath: [], totalHours: 0 };
    }

    const result = decomposeRequest(request);
    const criticalNodes = result.criticalPath
      .map((id) => request.capabilityDag.find((n) => n.id === id))
      .filter(Boolean) as CapabilityNode[];

    const totalHours = criticalNodes.reduce((sum, n) => sum + n.estimatedHours, 0);

    return {
      requestId: request.id,
      criticalPath: result.criticalPath,
      criticalNodes,
      totalHours,
    };
  });

  // ── POST /api/requests/:id/nodes/:nodeId/assign ───────────────────
  app.post<{ Params: { id: string; nodeId: string } }>(
    "/api/requests/:id/nodes/:nodeId/assign",
    async (req, reply) => {
      const request = requestsStore.get(req.params.id);
      if (!request) {
        return reply.status(404).send({ error: "request_not_found" });
      }

      const node = request.capabilityDag.find((n) => n.id === req.params.nodeId);
      if (!node) {
        return reply.status(404).send({ error: "node_not_found" });
      }

      // Caller must be authenticated. By default they can only assign nodes
      // to themselves; brokers/dispatchers (BROKER_OPERATORS env allowlist)
      // can assign to any operator.
      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!callerId) {
        return reply.status(401).send({ error: "authentication_required" });
      }

      // Rate limit: 30 assignments per caller per minute
      const { checkCallerRate, isBrokerOperator } = await import("../middleware/security-hardening.js");
      if (!checkCallerRate(callerId, "request_assign", 30, 60_000)) {
        return reply.status(429).send({ error: "rate_limited", message: "Too many node assignments" });
      }

      const body = (req.body ?? {}) as { operatorId?: string };
      let targetOperator: string;

      if (body.operatorId && body.operatorId !== callerId) {
        // Cross-operator assignment requires broker role
        if (!isBrokerOperator(callerId)) {
          return reply.status(403).send({
            error: "forbidden",
            message: "Only broker operators can assign nodes to other operators. " +
                     "Set BROKER_OPERATORS env var to allowlist callers.",
          });
        }
        if (typeof body.operatorId !== "string") {
          return reply.status(400).send({ error: "invalid_type", message: "operatorId must be a string" });
        }
        targetOperator = body.operatorId;
      } else {
        // Self-assign
        targetOperator = callerId;
      }

      node.assignedOperator = targetOperator;
      node.status = "assigned";

      // Audit trail records both the caller (broker) and the target operator
      try {
        const { auditService } = await import("../services/audit-service.js");
        auditService.log({
          eventType: "request.node.assigned",
          actor: callerId,
          resourceType: "request_node",
          resourceId: node.id,
          action: "assign",
          metadata: { requestId: request.id, targetOperator, broker: callerId !== targetOperator },
          ip: req.ip,
        });
      } catch { /* non-fatal */ }
      request.updatedAt = new Date().toISOString();
      requestsStore.set(request.id, request);

      return { node, requestId: request.id };
    },
  );

  // ── PUT /api/requests/:id/nodes/:nodeId/status ────────────────────
  app.put<{ Params: { id: string; nodeId: string } }>(
    "/api/requests/:id/nodes/:nodeId/status",
    async (req, reply) => {
      // Ownership check: only the assigned operator can update their node's status.
      // Without this, any authenticated user can mark any node "completed" and
      // trigger request settlement. (Red team round 5 NEW-01 CRITICAL)
      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!callerId) {
        return reply.status(401).send({ error: "authentication_required" });
      }

      const request = requestsStore.get(req.params.id);
      if (!request) {
        return reply.status(404).send({ error: "request_not_found" });
      }

      const node = request.capabilityDag.find((n) => n.id === req.params.nodeId);
      if (!node) {
        return reply.status(404).send({ error: "node_not_found" });
      }

      // Only the assigned operator (or a broker) can update status
      const { isBrokerOperator } = await import("../middleware/security-hardening.js");
      if (node.assignedOperator && node.assignedOperator !== callerId && !isBrokerOperator(callerId)) {
        return reply.status(403).send({
          error: "forbidden",
          message: "Only the assigned operator can update this node's status",
        });
      }

      const body = (req.body ?? {}) as { status?: CapabilityNodeStatus };
      const validStatuses: CapabilityNodeStatus[] = [
        "pending", "bidding", "assigned", "in_progress", "completed", "failed",
      ];

      if (!body.status || !validStatuses.includes(body.status)) {
        return reply.status(400).send({
          error: "bad_request",
          message: `status must be one of: ${validStatuses.join(", ")}`,
        });
      }

      node.status = body.status;
      request.updatedAt = new Date().toISOString();

      // Check if all nodes completed — update request status
      if (request.capabilityDag.every((n) => n.status === "completed")) {
        request.status = "completed";
      }

      requestsStore.set(request.id, request);

      return { node, requestId: request.id };
    },
  );
}

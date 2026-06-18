/**
 * Capability Request Routes — SQLite-backed
 *
 * High-level request decomposition system. Users submit natural language
 * requests that are automatically decomposed into a capability DAG with
 * dependencies, timelines, and budget allocation.
 *
 * POST /api/requests                          - submit + auto-decompose
 * GET  /api/requests                          - list (with status filter)
 * GET  /api/requests/:id                      - get with full DAG
 * POST /api/requests/:id/decompose            - re-trigger decomposition
 * POST /api/requests/:id/publish              - publish nodes as bounties
 * PUT  /api/requests/:id                      - update (title, budget, etc.)
 * DELETE /api/requests/:id                    - cancel request (soft-delete)
 * GET  /api/requests/:id/dag                  - get the DAG only
 * GET  /api/requests/:id/critical-path        - get critical path
 * POST /api/requests/:id/nodes/:nodeId/assign - assign operator to node
 * PUT  /api/requests/:id/nodes/:nodeId/status - update node status
 *
 * Persistence: backed by `capabilityRequests` table in @pcc/store. The
 * `compositionSignature` column is indexed so the demand-intel aggregator
 * can fold many envelopes that share the same composition shape efficiently.
 *
 * Demand capture: on each successful POST /api/requests, emits an
 * `intent.composite_request` analytics event for internal demand-intel
 * aggregation. Requester PII (email/wallet) is hashed before payload write.
 */

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type {
  CapabilityRequest,
  CapabilityNode,
  RequestStatus,
  CapabilityNodeStatus,
  DemandEnvelope,
  IntentSource,
  DecompositionResult,
} from "@pcc/spec";
import { computeCompositionSignature, budgetToBand } from "@pcc/spec";
import { decomposeRequest, decomposeDirectMatch } from "../services/request-decomposer.js";
import { matchListings } from "../services/request-matcher.js";
import { getRepos, getStore } from "../db.js";
import { getEventBus } from "../services/event-bus.js";
import { schema } from "@pcc/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot the live capability-registry `type` column. Used by
 * decomposeRequest() to bias template selection toward kernels that are
 * actually registered RIGHT NOW (the B1 fix from 2026-06-17). Returns
 * an empty array if the repo is unavailable -- decomposeRequest() then
 * falls back to its hardcoded vocabulary safely.
 */
function liveCapabilityTypes(): string[] {
  try {
    const repos = getRepos();
    const all = repos.capabilities.findAll();
    return [...new Set(all.map((c) => c.type))];
  } catch {
    return [];
  }
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Row -> CapabilityRequest. The DB row's numeric fields come back as numbers
 * already (better-sqlite3); JSON columns are deserialized by drizzle.
 */
function rowToRequest(row: Record<string, unknown>): CapabilityRequest {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string,
    requesterEmail: (row.requesterEmail as string | null) ?? undefined,
    requesterWallet: (row.requesterWallet as string | null) ?? undefined,
    budget: row.budget as number,
    currency: row.currency as string,
    deadline: row.deadline as string,
    urgency: row.urgency as CapabilityRequest["urgency"],
    status: row.status as RequestStatus,
    capabilityDag: (row.capabilityDag as CapabilityNode[]) ?? [],
    totalEstimatedCost: row.totalEstimatedCost as number,
    totalEstimatedHours: row.totalEstimatedHours as number,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

/** Compute composition signature from a request's DAG */
function signatureFromDag(dag: CapabilityNode[]): string {
  const capabilityTypes = dag.map((n) => n.capabilityType);
  const edges: Array<{ from: string; to: string }> = [];
  for (const node of dag) {
    for (const dep of node.dependencies) {
      edges.push({ from: dep, to: node.id });
    }
  }
  return computeCompositionSignature(capabilityTypes, edges);
}

/** Build a DemandEnvelope from a fully-decomposed CapabilityRequest */
function buildEnvelopeFromRequest(
  request: CapabilityRequest,
  source: IntentSource,
): DemandEnvelope {
  const capabilityTypes = request.capabilityDag.map((n) => n.capabilityType);
  const edges: Array<{ from: string; to: string }> = [];
  for (const node of request.capabilityDag) {
    for (const dep of node.dependencies) {
      edges.push({ from: dep, to: node.id });
    }
  }
  const signature = computeCompositionSignature(capabilityTypes, edges);

  const requesterRaw = request.requesterEmail ?? request.requesterWallet;
  const requesterIdHash = requesterRaw ? sha256Hex(requesterRaw) : undefined;

  // Summary: title + 1st line of description, trim to 200 chars
  const summary = `${request.title}: ${request.description}`
    .replace(/\s+/g, " ")
    .slice(0, 200);

  return {
    id: `intent-${request.id}`,
    source,
    compositionSignature: signature,
    capabilityTypes,
    summary,
    budgetBand: budgetToBand(request.budget),
    urgencyBand: request.urgency,
    requesterIdHash,
    createdAt: request.createdAt,
  };
}

function emitIntent(envelope: DemandEnvelope, actor: string, actorType: "requestor" | "agent") {
  try {
    getEventBus().publish({
      eventType:
        envelope.source === "requests_api"
          ? "intent.composite_request"
          : envelope.source === "negotiate_api"
          ? "intent.atomic_session"
          : "intent.synthetic_query",
      category: "intent",
      actorId: actor,
      actorType,
      resourceType: "intent",
      resourceId: envelope.id,
      payload: envelope as unknown as Record<string, unknown>,
    });
  } catch {
    // Event-bus failures must NEVER break the original request. Telemetry is
    // best-effort; demand-intel can replay from analytics_events as needed.
  }
}

// ---------------------------------------------------------------------------
// Seed — moltpod example, persisted via the repo
// ---------------------------------------------------------------------------

const SEED_ID = "req-moltpod-001";

function seedRequests(): void {
  const repos = getRepos();
  if (repos.requests.findById(SEED_ID)) return;

  const now = new Date().toISOString();
  const seed: CapabilityRequest = {
    id: SEED_ID,
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

  const result = decomposeRequest(seed);
  seed.capabilityDag = result.nodes;
  seed.totalEstimatedCost = result.totalEstimatedCost;
  seed.totalEstimatedHours = result.totalEstimatedHours;
  seed.status = "published";

  const signature = signatureFromDag(seed.capabilityDag);

  repos.requests.insert({
    id: seed.id,
    title: seed.title,
    description: seed.description,
    requesterEmail: seed.requesterEmail ?? null,
    requesterWallet: seed.requesterWallet ?? null,
    budget: seed.budget,
    currency: seed.currency,
    deadline: seed.deadline,
    urgency: seed.urgency,
    status: seed.status,
    capabilityDag: seed.capabilityDag,
    totalEstimatedCost: seed.totalEstimatedCost,
    totalEstimatedHours: seed.totalEstimatedHours,
    compositionSignature: signature,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
  });
}

/**
 * Reset the requests store for tests. Wipes all rows and re-seeds the
 * moltpod example. Idempotent.
 */
export function resetRequestsStore(): void {
  const store = getStore();
  (store.db as any).delete(schema.capabilityRequests).run();
  seedRequests();
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function requestRoutes(app: FastifyInstance) {
  // Ensure seed on registration (idempotent; safe if called repeatedly)
  try {
    seedRequests();
  } catch (err) {
    // If repos aren't initialized yet in some test paths, skip silently.
    // The route handlers will fail loudly if the DB is truly missing.
    app.log?.warn?.({ err }, "[requests] seed deferred");
  }

  // ── POST /api/requests ────────────────────────────────────────────
  // Submit a new request and auto-decompose it
  app.post("/api/requests", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CapabilityRequest> & {
      /** When set, route the request directly to a registered listing of this
       *  capability type (ad-hoc or built-in) instead of NL template decomposition. */
      capabilityType?: string;
      /** Pin the direct match to a specific capability row. */
      capabilityId?: string;
      /** Constrain the direct match to a specific kernel. */
      kernelId?: string;
      /** Units to order (direct-match pricing = basePrice * quantity). */
      quantity?: number;
    };

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

    // Routing decision: if the buyer named a capability type, route the request
    // straight to a matching registered listing (keyed off the capability's own
    // type + pricing model — ad-hoc types match exactly like built-in ones).
    // Otherwise fall back to natural-language composite decomposition with
    // live-vocab-aware DAG construction (B1 fix from 2026-06-17 — see romeo's
    // food_delivery template).
    let result: DecompositionResult;
    if (body.capabilityType) {
      const match = matchListings(body.capabilityType, {
        capabilityId: body.capabilityId,
        kernelId: body.kernelId,
      });
      if (match.matches.length === 0) {
        return reply.status(404).send({
          error: "no_matching_listing",
          message:
            match.reason ??
            `No registered listing offers capability type "${body.capabilityType}"`,
        });
      }
      result = decomposeDirectMatch(request, match.matches[0], body.quantity);
    } else {
      result = decomposeRequest(request, { availableTypes: liveCapabilityTypes() });
    }


    request.capabilityDag = result.nodes;
    request.totalEstimatedCost = result.totalEstimatedCost;
    request.totalEstimatedHours = result.totalEstimatedHours;
    request.status = "published";

    const signature = signatureFromDag(request.capabilityDag);

    const repos = getRepos();
    repos.requests.insert({
      id: request.id,
      title: request.title,
      description: request.description,
      requesterEmail: request.requesterEmail ?? null,
      requesterWallet: request.requesterWallet ?? null,
      budget: request.budget,
      currency: request.currency,
      deadline: request.deadline,
      urgency: request.urgency,
      status: request.status,
      capabilityDag: request.capabilityDag,
      totalEstimatedCost: request.totalEstimatedCost,
      totalEstimatedHours: request.totalEstimatedHours,
      compositionSignature: signature,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });

    // ── Demand-intel capture point A — composite request ───────────
    const envelope = buildEnvelopeFromRequest(request, "requests_api");
    const actor = request.requesterEmail ?? request.requesterWallet ?? "anonymous";
    emitIntent(envelope, actor, "requestor");

    return reply.status(201).send({ request, decomposition: result });
  });

  // ── POST /api/requests/match ──────────────────────────────────────
  // Resolve a buyer's capability-type request to the operator listings that can
  // fulfil it — WITHOUT creating a request. This is the routing primitive behind
  // POST /api/requests's direct-match path: it keys off the capability's own type
  // + pricing model, so ad-hoc types (rideshare-driver, wood-fired-pizza) resolve
  // to their listing exactly like built-in ones. Lets an agent confirm an operator
  // is reachable (and at what price) before committing to an order.
  app.post("/api/requests/match", async (req, reply) => {
    const body = (req.body ?? {}) as {
      capabilityType?: string;
      capabilityId?: string;
      kernelId?: string;
    };

    if (!body.capabilityType) {
      return reply.status(400).send({
        error: "bad_request",
        message: "capabilityType is required",
      });
    }

    const match = matchListings(body.capabilityType, {
      capabilityId: body.capabilityId,
      kernelId: body.kernelId,
    });

    if (match.matches.length === 0) {
      return reply.status(404).send({
        error: "no_matching_listing",
        message: match.reason,
        matches: [],
        count: 0,
      });
    }

    return { matches: match.matches, count: match.matches.length };
  });

  // ── GET /api/requests ─────────────────────────────────────────────
  app.get("/api/requests", async (req) => {
    const q = req.query as Record<string, string>;
    const repos = getRepos();
    const rows = repos.requests.findAll({
      status: q.status,
      urgency: q.urgency,
      requesterEmail: q.requesterEmail,
    });
    const results = rows.map(rowToRequest);
    return { requests: results, count: results.length };
  });

  // ── GET /api/requests/:id ─────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
    const repos = getRepos();
    const row = repos.requests.findById(req.params.id);
    if (!row) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    return { request: rowToRequest(row) };
  });

  // ── POST /api/requests/:id/decompose ──────────────────────────────
  app.post<{ Params: { id: string } }>("/api/requests/:id/decompose", async (req, reply) => {
    const repos = getRepos();
    const row = repos.requests.findById(req.params.id);
    if (!row) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    const request = rowToRequest(row);

    if (request.status === "cancelled") {
      return reply.status(409).send({ error: "conflict", message: "Cannot decompose a cancelled request" });
    }

    request.status = "decomposing";
    request.updatedAt = new Date().toISOString();

    const result = decomposeRequest(request, { availableTypes: liveCapabilityTypes() });
    request.capabilityDag = result.nodes;
    request.totalEstimatedCost = result.totalEstimatedCost;
    request.totalEstimatedHours = result.totalEstimatedHours;
    request.status = "published";
    request.updatedAt = new Date().toISOString();

    const signature = signatureFromDag(request.capabilityDag);
    repos.requests.update(request.id, {
      status: request.status,
      capabilityDag: request.capabilityDag,
      totalEstimatedCost: request.totalEstimatedCost,
      totalEstimatedHours: request.totalEstimatedHours,
      compositionSignature: signature,
      updatedAt: request.updatedAt,
    });

    return { request, decomposition: result };
  });

  // ── POST /api/requests/:id/publish ───────────────────────────────
  app.post<{ Params: { id: string } }>("/api/requests/:id/publish", async (req, reply) => {
    const repos = getRepos();
    const row = repos.requests.findById(req.params.id);
    if (!row) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    const request = rowToRequest(row);

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

    repos.requests.update(request.id, {
      status: request.status,
      capabilityDag: request.capabilityDag,
      updatedAt: now,
    });

    return { request, publishedBounties, publishedCount: publishedBounties.length };
  });

  // ── PUT /api/requests/:id ─────────────────────────────────────────
  app.put<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
    const repos = getRepos();
    const row = repos.requests.findById(req.params.id);
    if (!row) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    const request = rowToRequest(row);

    if (request.status === "cancelled") {
      return reply.status(409).send({ error: "conflict", message: "Cannot update a cancelled request" });
    }

    const body = (req.body ?? {}) as Partial<CapabilityRequest>;
    const updates: Record<string, unknown> = {};
    const allowed: Array<keyof CapabilityRequest> = [
      "title", "description", "budget", "deadline", "urgency",
      "requesterEmail", "requesterWallet", "currency",
    ];
    for (const key of allowed) {
      if (body[key] !== undefined) {
        // drizzle column names match camelCase via $type, so direct map works
        updates[key] = body[key];
      }
    }

    const updatedAt = new Date().toISOString();
    updates.updatedAt = updatedAt;
    repos.requests.update(request.id, updates);

    const refreshed = repos.requests.findById(request.id);
    return { request: refreshed ? rowToRequest(refreshed) : request };
  });

  // ── DELETE /api/requests/:id ──────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
    const repos = getRepos();
    const row = repos.requests.findById(req.params.id);
    if (!row) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    repos.requests.softDelete(req.params.id);
    return { deleted: true, id: req.params.id };
  });

  // ── GET /api/requests/:id/dag ─────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/requests/:id/dag", async (req, reply) => {
    const repos = getRepos();
    const row = repos.requests.findById(req.params.id);
    if (!row) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    const request = rowToRequest(row);
    const nodes = request.capabilityDag;
    const edges = nodes.flatMap((n) => n.dependencies.map((dep) => ({ from: dep, to: n.id })));
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
    const repos = getRepos();
    const row = repos.requests.findById(req.params.id);
    if (!row) {
      return reply.status(404).send({ error: "request_not_found" });
    }
    const request = rowToRequest(row);

    if (request.capabilityDag.length === 0) {
      return { requestId: request.id, criticalPath: [], totalHours: 0 };
    }

    const result = decomposeRequest(request, { availableTypes: liveCapabilityTypes() });
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
      const repos = getRepos();
      const row = repos.requests.findById(req.params.id);
      if (!row) {
        return reply.status(404).send({ error: "request_not_found" });
      }
      const request = rowToRequest(row);

      const node = request.capabilityDag.find((n) => n.id === req.params.nodeId);
      if (!node) {
        return reply.status(404).send({ error: "node_not_found" });
      }

      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!callerId) {
        return reply.status(401).send({ error: "authentication_required" });
      }

      const { checkCallerRate, isBrokerOperator } = await import("../middleware/security-hardening.js");
      if (!checkCallerRate(callerId, "request_assign", 30, 60_000)) {
        return reply.status(429).send({ error: "rate_limited", message: "Too many node assignments" });
      }

      const body = (req.body ?? {}) as { operatorId?: string };
      let targetOperator: string;

      if (body.operatorId && body.operatorId !== callerId) {
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
        targetOperator = callerId;
      }

      node.assignedOperator = targetOperator;
      node.status = "assigned";

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

      const updatedAt = new Date().toISOString();
      repos.requests.update(request.id, {
        capabilityDag: request.capabilityDag,
        updatedAt,
      });

      return { node, requestId: request.id };
    },
  );

  // ── PUT /api/requests/:id/nodes/:nodeId/status ────────────────────
  app.put<{ Params: { id: string; nodeId: string } }>(
    "/api/requests/:id/nodes/:nodeId/status",
    async (req, reply) => {
      const callerId = (req as any).operatorId ?? (req as any).userId;
      if (!callerId) {
        return reply.status(401).send({ error: "authentication_required" });
      }

      const repos = getRepos();
      const row = repos.requests.findById(req.params.id);
      if (!row) {
        return reply.status(404).send({ error: "request_not_found" });
      }
      const request = rowToRequest(row);

      const node = request.capabilityDag.find((n) => n.id === req.params.nodeId);
      if (!node) {
        return reply.status(404).send({ error: "node_not_found" });
      }

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

      // Cascade: if all nodes completed, mark request completed
      let newStatus: RequestStatus = request.status;
      if (request.capabilityDag.every((n) => n.status === "completed")) {
        newStatus = "completed";
      }

      const updatedAt = new Date().toISOString();
      repos.requests.update(request.id, {
        status: newStatus,
        capabilityDag: request.capabilityDag,
        updatedAt,
      });

      return { node, requestId: request.id };
    },
  );
}

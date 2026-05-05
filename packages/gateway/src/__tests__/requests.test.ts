/**
 * Tests for the Capability Request Decomposition system.
 *
 * Covers:
 *   - POST /api/requests — creates and auto-decomposes
 *   - GET /api/requests — list with status filter
 *   - GET /api/requests/:id — returns full request with DAG
 *   - POST /api/requests/:id/decompose — re-triggers decomposition
 *   - POST /api/requests/:id/publish — publishes nodes as bounties
 *   - PUT /api/requests/:id — updates request fields
 *   - DELETE /api/requests/:id — cancels request
 *   - GET /api/requests/:id/dag — returns adjacency data
 *   - GET /api/requests/:id/critical-path — returns critical path
 *   - POST /api/requests/:id/nodes/:nodeId/assign — assigns operator
 *   - PUT /api/requests/:id/nodes/:nodeId/status — updates node status
 *   - Decomposition template matching (robot, lab, etc.)
 *   - Critical path calculation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { requestRoutes, resetRequestsStore } from "../routes/requests.js";
import { detectTemplateName } from "../services/request-decomposer.js";

// ---------------------------------------------------------------------------
// App builder (no DB needed — in-memory store)
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(requestRoutes);
  await app.ready();
  return app;
}

/**
 * Build an app with an injected authenticated operator. The node-assign
 * route requires auth (401 without) — this helper lets the per-test caller
 * simulate a signed-in operator without running the full apiGate middleware.
 */
async function buildAuthedApp(operatorId: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.addHook("onRequest", async (req) => {
    (req as unknown as { operatorId: string }).operatorId = operatorId;
  });
  await app.register(requestRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ROBOT_REQUEST = {
  title: "Cute Animatronic Plush Desk Robot",
  description:
    "Build a cute animatronic plush desk robot with servo-driven head movement, arm wave, and idle breathing animations. Soft plush exterior with internal servo mechanism.",
  budget: 2500,
  currency: "USDC",
  deadline: "2026-03-31T23:59:59Z",
  urgency: "emergency",
  requesterEmail: "team@moltpod.com",
};

const LAB_REQUEST = {
  title: "HPLC Purity Analysis",
  description: "HPLC analysis and characterization of compound X. Need purity assay with quantification against reference standard.",
  budget: 500,
  currency: "USDC",
  deadline: "2026-04-15T23:59:59Z",
  urgency: "standard",
  requesterEmail: "lab@example.com",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/requests", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates a request and auto-decomposes it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.request).toBeDefined();
    expect(body.decomposition).toBeDefined();
    expect(body.request.id).toBeTruthy();
    expect(body.request.title).toBe(ROBOT_REQUEST.title);
    expect(body.request.status).toBe("published");
    expect(body.request.capabilityDag).toBeInstanceOf(Array);
    expect(body.request.capabilityDag.length).toBeGreaterThan(0);
    expect(body.request.totalEstimatedCost).toBeGreaterThan(0);
    expect(body.request.totalEstimatedHours).toBeGreaterThan(0);
  });

  it("returns 400 when title is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { description: "some request" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when description is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { title: "Some title" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for negative budget", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { ...ROBOT_REQUEST, budget: -100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("uses default budget when not provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: { title: "Test", description: "Build something" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().request.budget).toBe(1000);
  });

  it("auto-decomposes into robotics template for robot request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    expect(res.statusCode).toBe(201);
    const { request } = res.json();
    const nodeNames = request.capabilityDag.map((n: { name: string }) => n.name);
    // robotics_build template has assembly and testing nodes
    const hasAssembly = nodeNames.some((n: string) => n.toLowerCase().includes("assembl"));
    const hasTesting = nodeNames.some((n: string) => n.toLowerCase().includes("test"));
    expect(hasAssembly).toBe(true);
    expect(hasTesting).toBe(true);
  });

  it("auto-decomposes into lab template for HPLC request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: LAB_REQUEST,
    });
    expect(res.statusCode).toBe(201);
    const { request } = res.json();
    const nodeNames = request.capabilityDag.map((n: { name: string }) => n.name);
    // lab_analysis template has sample prep and report nodes
    const hasSamplePrep = nodeNames.some((n: string) => n.toLowerCase().includes("sample"));
    const hasReport = nodeNames.some((n: string) => n.toLowerCase().includes("report"));
    expect(hasSamplePrep).toBe(true);
    expect(hasReport).toBe(true);
  });

  it("each decomposed node has required fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    const { request } = res.json();
    for (const node of request.capabilityDag) {
      expect(node.id).toBeTruthy();
      expect(node.requestId).toBe(request.id);
      expect(node.name).toBeTruthy();
      expect(node.capabilityType).toBeTruthy();
      expect(node.category).toBeTruthy();
      expect(typeof node.estimatedCost).toBe("number");
      expect(typeof node.estimatedHours).toBe("number");
      expect(Array.isArray(node.dependencies)).toBe(true);
      expect(typeof node.parallel).toBe("boolean");
      expect(node.status).toBe("pending");
    }
  });

  it("decomposition returns critical path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    const { decomposition } = res.json();
    expect(Array.isArray(decomposition.criticalPath)).toBe(true);
    expect(decomposition.criticalPath.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/requests
// ---------------------------------------------------------------------------

describe("GET /api/requests", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the seeded moltpod request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/requests" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requests).toBeInstanceOf(Array);
    expect(body.count).toBeGreaterThan(0);
    const moltpod = body.requests.find((r: { id: string }) => r.id === "req-moltpod-001");
    expect(moltpod).toBeDefined();
  });

  it("filters by status", async () => {
    // Cancel the seeded request first
    await app.inject({ method: "DELETE", url: "/api/requests/req-moltpod-001" });

    const res = await app.inject({ method: "GET", url: "/api/requests?status=cancelled" });
    const body = res.json();
    expect(body.requests.every((r: { status: string }) => r.status === "cancelled")).toBe(true);
  });

  it("returns empty array when no match", async () => {
    const res = await app.inject({ method: "GET", url: "/api/requests?status=draft" });
    const body = res.json();
    expect(body.requests).toHaveLength(0);
    expect(body.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/requests/:id
// ---------------------------------------------------------------------------

describe("GET /api/requests/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the seeded moltpod request with full DAG", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/requests/req-moltpod-001",
    });
    expect(res.statusCode).toBe(200);
    const { request } = res.json();
    expect(request.id).toBe("req-moltpod-001");
    expect(request.capabilityDag).toBeInstanceOf(Array);
    expect(request.capabilityDag.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown ID", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/requests/req-does-not-exist",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/requests/:id/decompose
// ---------------------------------------------------------------------------

describe("POST /api/requests/:id/decompose", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("re-decomposes and returns updated request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests/req-moltpod-001/decompose",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.request.status).toBe("published");
    expect(body.decomposition).toBeDefined();
    expect(body.decomposition.nodes.length).toBeGreaterThan(0);
  });

  it("returns 404 for unknown request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests/req-fake/decompose",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when request is cancelled", async () => {
    await app.inject({ method: "DELETE", url: "/api/requests/req-moltpod-001" });
    const res = await app.inject({
      method: "POST",
      url: "/api/requests/req-moltpod-001/decompose",
    });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /api/requests/:id/publish
// ---------------------------------------------------------------------------

describe("POST /api/requests/:id/publish", () => {
  let app: FastifyInstance;
  let requestId: string;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();

    // Create a fresh request to publish
    const create = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    requestId = create.json().request.id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("publishes all pending nodes as bounties", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/publish`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.publishedCount).toBeGreaterThan(0);
    expect(body.publishedBounties).toBeInstanceOf(Array);
    expect(body.request.status).toBe("in_progress");

    // Verify nodes now have bountyIds and bidding status
    for (const entry of body.publishedBounties) {
      expect(entry.nodeId).toBeTruthy();
      expect(entry.bountyId).toBeTruthy();
    }
  });

  it("returns 404 for unknown request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests/req-fake/publish",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 for cancelled request", async () => {
    await app.inject({ method: "DELETE", url: `/api/requests/${requestId}` });
    const res = await app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/publish`,
    });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/requests/:id
// ---------------------------------------------------------------------------

describe("PUT /api/requests/:id", () => {
  let app: FastifyInstance;
  let requestId: string;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    requestId = create.json().request.id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("updates title and budget", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/requests/${requestId}`,
      payload: { title: "Updated Robot", budget: 3000 },
    });
    expect(res.statusCode).toBe(200);
    const { request } = res.json();
    expect(request.title).toBe("Updated Robot");
    expect(request.budget).toBe(3000);
  });

  it("returns 404 for unknown request", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/requests/req-fake",
      payload: { title: "New title" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 for cancelled request", async () => {
    await app.inject({ method: "DELETE", url: `/api/requests/${requestId}` });
    const res = await app.inject({
      method: "PUT",
      url: `/api/requests/${requestId}`,
      payload: { title: "New title" },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/requests/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/requests/:id", () => {
  let app: FastifyInstance;
  let requestId: string;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    requestId = create.json().request.id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("cancels the request", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/requests/${requestId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);

    // Verify it's cancelled
    const get = await app.inject({ method: "GET", url: `/api/requests/${requestId}` });
    expect(get.json().request.status).toBe("cancelled");
  });

  it("returns 404 for unknown request", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/requests/req-fake" });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/requests/:id/dag
// ---------------------------------------------------------------------------

describe("GET /api/requests/:id/dag", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns nodes and edges for the moltpod request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/requests/req-moltpod-001/dag",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toBeInstanceOf(Array);
    expect(body.edges).toBeInstanceOf(Array);
    expect(body.nodeCount).toBeGreaterThan(0);
    expect(typeof body.edgeCount).toBe("number");

    // Every edge should reference real node IDs
    const nodeIds = new Set(body.nodes.map((n: { id: string }) => n.id));
    for (const edge of body.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  it("returns 404 for unknown request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/requests/req-fake/dag" });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/requests/:id/critical-path
// ---------------------------------------------------------------------------

describe("GET /api/requests/:id/critical-path", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns a non-empty critical path for moltpod request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/requests/req-moltpod-001/critical-path",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.criticalPath).toBeInstanceOf(Array);
    expect(body.criticalPath.length).toBeGreaterThan(0);
    expect(body.totalHours).toBeGreaterThan(0);
    expect(body.criticalNodes).toBeInstanceOf(Array);
  });

  it("returns 404 for unknown request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/requests/req-fake/critical-path",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/requests/:id/nodes/:nodeId/assign
// ---------------------------------------------------------------------------

describe("POST /api/requests/:id/nodes/:nodeId/assign", () => {
  // The node-assign route now enforces caller auth (401 without) and
  // restricts cross-operator assignment to BROKER_OPERATORS. Each test builds
  // an app authed as the operator whose point-of-view it needs to simulate.
  const OPERATOR_ID = "op-biopunk-lab";
  let app: FastifyInstance;
  let requestId: string;
  let firstNodeId: string;

  beforeEach(async () => {
    resetRequestsStore();
    // Use an unauthenticated app for POST /api/requests (public) to seed the
    // store. The requestsStore is module-global, so any subsequent app sees
    // the same data.
    const bootstrap = await buildApp();
    const create = await bootstrap.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    const reqJson = create.json().request;
    requestId = reqJson.id;
    firstNodeId = reqJson.capabilityDag[0].id;
    await bootstrap.close();

    app = await buildAuthedApp(OPERATOR_ID);
  });

  afterEach(async () => {
    await app.close();
  });

  it("assigns an operator to a node (self-assign)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/nodes/${firstNodeId}/assign`,
      payload: { operatorId: OPERATOR_ID },
    });
    expect(res.statusCode).toBe(200);
    const { node } = res.json();
    expect(node.assignedOperator).toBe(OPERATOR_ID);
    expect(node.status).toBe("assigned");
  });

  it("self-assigns to the caller when operatorId is missing", async () => {
    // R3 security hardening: an empty body no longer returns 400 — the route
    // now self-assigns the node to the authenticated caller. Non-broker
    // callers can only act on their own behalf anyway.
    const res = await app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/nodes/${firstNodeId}/assign`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { node } = res.json();
    expect(node.assignedOperator).toBe(OPERATOR_ID);
    expect(node.status).toBe("assigned");
  });

  it("returns 404 for unknown node", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/requests/${requestId}/nodes/node-fake/assign`,
      payload: { operatorId: OPERATOR_ID },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/requests/:id/nodes/:nodeId/status
// ---------------------------------------------------------------------------

describe("PUT /api/requests/:id/nodes/:nodeId/status", () => {
  // Red team round 5 hardened the status route to require caller auth (401
  // without) and restrict cross-operator status updates. Mirror the
  // /assign block above: bootstrap the request unauthed, then build an
  // authed app for the actual status updates.
  const OPERATOR_ID = "op-biopunk-lab";
  let app: FastifyInstance;
  let requestId: string;
  let firstNodeId: string;

  beforeEach(async () => {
    resetRequestsStore();
    const bootstrap = await buildApp();
    const create = await bootstrap.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    const req = create.json().request;
    requestId = req.id;
    firstNodeId = req.capabilityDag[0].id;
    await bootstrap.close();

    app = await buildAuthedApp(OPERATOR_ID);
  });

  afterEach(async () => {
    await app.close();
  });

  it("updates node status to in_progress", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/requests/${requestId}/nodes/${firstNodeId}/status`,
      payload: { status: "in_progress" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().node.status).toBe("in_progress");
  });

  it("returns 400 for invalid status value", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/requests/${requestId}/nodes/${firstNodeId}/status`,
      payload: { status: "flying" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when status is missing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/requests/${requestId}/nodes/${firstNodeId}/status`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown node", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/requests/${requestId}/nodes/node-fake/status`,
      payload: { status: "completed" },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Template detection (unit tests)
// ---------------------------------------------------------------------------

describe("Template detection — keyword matching", () => {
  it("detects robotics_build for robot/servo/plush keywords", () => {
    expect(detectTemplateName("Build a cute animatronic plush desk robot with servos")).toBe("robotics_build");
    expect(detectTemplateName("Create an interactive robot with servo motors")).toBe("robotics_build");
    expect(detectTemplateName("animatronic puppet with MCU firmware")).toBe("robotics_build");
  });

  it("detects lab_analysis for HPLC/assay keywords", () => {
    expect(detectTemplateName("HPLC analysis of compound purity and quantification")).toBe("lab_analysis");
    expect(detectTemplateName("run an assay on my sample for concentration")).toBe("lab_analysis");
    expect(detectTemplateName("PCR characterization of DNA sample")).toBe("lab_analysis");
  });

  it("detects synthesis for synthesis/reagent keywords", () => {
    expect(detectTemplateName("synthesize a small molecule compound from reagents")).toBe("synthesis");
    expect(detectTemplateName("organic synthesis reaction and purification")).toBe("synthesis");
  });

  it("detects print_deliver for print/deliver keywords", () => {
    expect(detectTemplateName("print and deliver this document to the office")).toBe("print_deliver");
    expect(detectTemplateName("courier delivery of printed invoice")).toBe("print_deliver");
  });

  it("defaults to custom_product for unmatched descriptions", () => {
    expect(detectTemplateName("fabricate a custom metal part")).toBe("custom_product");
    expect(detectTemplateName("manufacture a unique widget")).toBe("custom_product");
  });

  it("defaults to custom_product for completely generic input", () => {
    expect(detectTemplateName("I need something made")).toBe("custom_product");
  });
});

// ---------------------------------------------------------------------------
// Critical path calculation
// ---------------------------------------------------------------------------

describe("Critical path calculation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetRequestsStore();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("critical path ends at a leaf node (no dependents)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: ROBOT_REQUEST,
    });
    const requestId = create.json().request.id;

    const cpRes = await app.inject({
      method: "GET",
      url: `/api/requests/${requestId}/critical-path`,
    });
    const { criticalPath, criticalNodes } = cpRes.json();

    // The last node on the critical path should have no dependents
    const lastId = criticalPath[criticalPath.length - 1];
    const dagRes = await app.inject({
      method: "GET",
      url: `/api/requests/${requestId}/dag`,
    });
    const { edges } = dagRes.json();
    const lastHasDependents = edges.some((e: { from: string }) => e.from === lastId);
    expect(lastHasDependents).toBe(false);
    expect(criticalNodes.length).toBe(criticalPath.length);
  });

  it("critical path for a linear chain is the whole chain", async () => {
    // print_deliver is roughly linear
    const create = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "Print and deliver",
        description: "print and deliver this document via courier",
        budget: 100,
        urgency: "standard",
      },
    });
    const requestId = create.json().request.id;

    const cpRes = await app.inject({
      method: "GET",
      url: `/api/requests/${requestId}/critical-path`,
    });
    const { criticalPath } = cpRes.json();
    expect(criticalPath.length).toBeGreaterThanOrEqual(2);
  });
});

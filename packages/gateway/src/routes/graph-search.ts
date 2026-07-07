/**
 * Capability Graph Search — gateway routes.
 *
 * The composition engine (PR #88) finds capability INSTANCES for a known step
 * sequence. This engine finds the SEQUENCE: given a target outcome type, a
 * budget, and constraints, it runs a Dijkstra-style shortest-path over the
 * capability graph and returns the top-N cheapest-verified composition paths.
 *
 * Endpoints (all under /api/capabilities/*):
 *   POST /api/capabilities/graph-search             — run a search, return top-N paths (201)
 *   GET  /api/capabilities/graph-search/:searchId   — retrieve a prior search (200 / 404 / 410)
 *   GET  /api/capabilities/graph-stats              — node/edge/type counts + freshness
 *   POST /api/capabilities/graph/_dev/register-node — scaffold candidate injection (201)
 *   POST /api/capabilities/graph/_dev/register-edge — scaffold candidate injection (201)
 *
 * Storage: SQLite via @pcc/store (graph_search_nodes + graph_search_edges +
 * graph_search_proposals), following the marketplace / requests persistence
 * pattern. The graph + search proposals survive gateway redeploys. A search
 * loads the node/edge snapshot from SQLite and runs the traversal in memory; in
 * production the `_dev/register-*` endpoints are replaced by a CapabilityFacade-
 * backed graph rebuild. The HTTP shape stays identical.
 *
 * Algorithm: for each (start, end) capability pair we run a bounded best-path
 * search (Dijkstra-style — explores in composite-score order, prunes on a
 * visited-on-path set so cycles can't loop forever). Edge weight depends on
 * `optimizeFor`:
 *   price       → node.estimatedPriceUSD + edge.estimatedHandoffPriceUSD
 *   speed       → node.estimatedDurationMs + edge.estimatedHandoffDurationMs
 *   quality     → (4 - assuranceTier) * 1000 + (1000 - reputation)   (edges free)
 *   reputation  → 1000 - reputation                                  (edges free)
 * Filters: minAssuranceTier, minReputation, location radius (haversine),
 * availability. Caps: budgetUSD (running total of node + handoff prices),
 * maxDepth (path node count, default 5), topN (default 5).
 *
 * Companion to PR #88. When that lands, returned paths feed straight into a
 * @pcc/workflow run for execution.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  GraphSearchRequestSchema,
  RegisterGraphNodeSchema,
  RegisterGraphEdgeSchema,
} from "@pcc/spec";
import type {
  CapabilityGraphNode,
  CapabilityGraphEdge,
  GraphSearchRequest,
  GraphSearchResponse,
  GraphPathStep,
  GraphPathOption,
  GraphStatsResponse,
  GraphSearchOptimization,
  RegisterGraphNodeInput,
  RegisterGraphEdgeInput,
} from "@pcc/spec";
import { schema, eq, sql } from "@pcc/store";
import { getStore, initStore } from "../db.js";

// ---------------------------------------------------------------------------
// Store access — see compose.ts for the lazy-init rationale.
// ---------------------------------------------------------------------------

function db() {
  try {
    return getStore().db;
  } catch {
    if (
      (process.env.VITEST || process.env.NODE_ENV === "test") &&
      !process.env.PCC_DB_PATH &&
      !process.env.DATABASE_URL
    ) {
      process.env.PCC_DB_PATH = ":memory:";
    }
    return initStore({ seed: false }).db;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_TOP_N = 5;
/** Default proximity radius when a location filter omits radiusKm. */
const DEFAULT_RADIUS_KM = 50;
/** Search proposals live 30 minutes (matches the negotiation session TTL). */
const SEARCH_TTL_MS = 30 * 60 * 1000;

function nowISO(): string {
  return new Date().toISOString();
}

function edgeKey(fromCapabilityId: string, toCapabilityId: string): string {
  return `${fromCapabilityId}->${toCapabilityId}`;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Snapshot of every graph node, for an in-memory traversal. */
function loadNodes(): CapabilityGraphNode[] {
  const rows = db().select().from(schema.graphSearchNodes).all();
  return rows.map((r) => r.data as CapabilityGraphNode);
}

/** Snapshot of every graph edge. */
function loadEdges(): CapabilityGraphEdge[] {
  const rows = db().select().from(schema.graphSearchEdges).all();
  return rows.map((r) => r.data as CapabilityGraphEdge);
}

/**
 * Upsert a node by capabilityId — re-registering replaces it. `created_at`
 * is bumped on every write so graph-stats' `lastRebuiltAt` (MAX(created_at))
 * reflects the most recent rebuild.
 */
function persistNode(node: CapabilityGraphNode): void {
  const cols = {
    capabilityType: node.capabilityType,
    kernelId: node.kernelId,
    estimatedPriceUsd: node.estimatedPriceUSD,
    estimatedDurationMs: node.estimatedDurationMs,
    assuranceTier: node.assuranceTier,
    reputation: node.reputation,
    available: node.available,
    createdAt: nowISO(),
    data: node,
  };
  db()
    .insert(schema.graphSearchNodes)
    .values({ capabilityId: node.capabilityId, ...cols })
    .onConflictDoUpdate({ target: schema.graphSearchNodes.capabilityId, set: cols })
    .run();
}

/** Upsert an edge by `${from}->${to}` — re-registering replaces it. */
function persistEdge(edge: CapabilityGraphEdge): void {
  const cols = {
    fromCapabilityId: edge.fromCapabilityId,
    toCapabilityId: edge.toCapabilityId,
    capabilityTypeFlow: edge.capabilityTypeFlow,
    createdAt: nowISO(),
    data: edge,
  };
  db()
    .insert(schema.graphSearchEdges)
    .values({ id: edgeKey(edge.fromCapabilityId, edge.toCapabilityId), ...cols })
    .onConflictDoUpdate({ target: schema.graphSearchEdges.id, set: cols })
    .run();
}

/** Persist a search proposal so it can be retrieved by id within its TTL. */
function saveProposal(response: GraphSearchResponse, req: GraphSearchRequest): void {
  db()
    .insert(schema.graphSearchProposals)
    .values({
      id: response.searchId,
      requestJson: req,
      optionsJson: response.options,
      searchStatsJson: {
        searchStats: response.searchStats,
        outcomeType: response.outcomeType,
        optimizedFor: response.optimizedFor,
        proposedAt: response.proposedAt,
      },
      expiresAt: response.expiresAt,
      createdAt: response.proposedAt,
    })
    .run();
}

/** Reconstruct a stored GraphSearchResponse, or undefined when absent. */
function loadProposal(searchId: string): GraphSearchResponse | undefined {
  const row = db()
    .select()
    .from(schema.graphSearchProposals)
    .where(eq(schema.graphSearchProposals.id, searchId))
    .get();
  if (!row) return undefined;
  const meta = row.searchStatsJson as {
    searchStats: GraphSearchResponse["searchStats"];
    outcomeType: string;
    optimizedFor: GraphSearchOptimization;
    proposedAt: string;
  };
  return {
    searchId: row.id,
    outcomeType: meta.outcomeType,
    optimizedFor: meta.optimizedFor,
    options: row.optionsJson as GraphPathOption[],
    searchStats: meta.searchStats,
    proposedAt: meta.proposedAt,
    expiresAt: row.expiresAt,
  };
}

function deleteProposal(searchId: string): void {
  db()
    .delete(schema.graphSearchProposals)
    .where(eq(schema.graphSearchProposals.id, searchId))
    .run();
}

/** Drop search proposals whose TTL has elapsed so the table doesn't grow. */
function pruneExpiredSearches(): void {
  db()
    .delete(schema.graphSearchProposals)
    .where(sql`${schema.graphSearchProposals.expiresAt} <= ${nowISO()}`)
    .run();
}

/** Most recent node/edge write time, or null when the graph is empty. */
function lastRebuiltAt(): string | null {
  const n = db()
    .select({ m: sql<string | null>`max(${schema.graphSearchNodes.createdAt})` })
    .from(schema.graphSearchNodes)
    .get();
  const e = db()
    .select({ m: sql<string | null>`max(${schema.graphSearchEdges.createdAt})` })
    .from(schema.graphSearchEdges)
    .get();
  const candidates = [n?.m, e?.m].filter((x): x is string => typeof x === "string");
  if (candidates.length === 0) return null;
  return candidates.sort().at(-1)!;
}

// ---------------------------------------------------------------------------
// Geo helper — copied from @pcc/dht's query.ts (haversine great-circle km)
// ---------------------------------------------------------------------------

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in kilometres. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ---------------------------------------------------------------------------
// Scoring — composite weight depends on optimizeFor (LOWER is always better)
// ---------------------------------------------------------------------------

type Scorable = Pick<
  CapabilityGraphNode,
  "estimatedPriceUSD" | "estimatedDurationMs" | "assuranceTier" | "reputation"
>;

/** Per-node contribution to the composite path score. */
function scoreNode(n: Scorable, optimizeFor: GraphSearchOptimization): number {
  switch (optimizeFor) {
    case "price":
      return n.estimatedPriceUSD;
    case "speed":
      return n.estimatedDurationMs;
    case "quality":
      // Lower assurance / lower reputation = higher (worse) cost.
      return (4 - n.assuranceTier) * 1000 + (1000 - n.reputation);
    case "reputation":
      return 1000 - n.reputation;
  }
}

/** Per-edge contribution to the composite path score. */
function edgeWeight(
  edge: CapabilityGraphEdge,
  optimizeFor: GraphSearchOptimization,
): number {
  switch (optimizeFor) {
    case "price":
      return edge.estimatedHandoffPriceUSD;
    case "speed":
      return edge.estimatedHandoffDurationMs;
    case "quality":
    case "reputation":
      return 0;
  }
}

/**
 * Composite score for a complete path. Equals the accumulated Dijkstra
 * distance: sum of per-node scores plus per-edge weights along the sequence.
 */
function compositeScoreForPath(
  steps: GraphPathStep[],
  optimizeFor: GraphSearchOptimization,
  edgesByKey: Map<string, CapabilityGraphEdge>,
): number {
  let score = 0;
  for (let i = 0; i < steps.length; i++) {
    score += scoreNode(steps[i], optimizeFor);
    if (i > 0) {
      const edge = edgesByKey.get(edgeKey(steps[i - 1].capabilityId, steps[i].capabilityId));
      if (edge) score += edgeWeight(edge, optimizeFor);
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Filters + candidate selection
// ---------------------------------------------------------------------------

function nodePassesFilters(node: CapabilityGraphNode, req: GraphSearchRequest): boolean {
  if (!node.available) return false;
  if (node.assuranceTier < req.minAssuranceTier) return false;
  if (req.minReputation !== undefined && node.reputation < req.minReputation) {
    return false;
  }
  if (req.location) {
    if (!node.location) return false; // can't verify proximity without coordinates
    const radiusKm = req.location.radiusKm ?? DEFAULT_RADIUS_KM;
    if (haversineKm(node.location, req.location) > radiusKm) return false;
  }
  return true;
}

/**
 * Candidate START nodes: those that consume `startInputType` if it was
 * supplied, otherwise pure sources (empty inputTypes).
 */
function findStartNodes(
  startInputType: string | undefined,
  all: CapabilityGraphNode[],
): CapabilityGraphNode[] {
  if (startInputType) {
    return all.filter((n) => n.inputTypes.includes(startInputType));
  }
  return all.filter((n) => n.inputTypes.length === 0);
}

/** Candidate END nodes: those that produce the requested outcome type. */
function findEndNodes(
  outcomeType: string,
  all: CapabilityGraphNode[],
): CapabilityGraphNode[] {
  return all.filter((n) => n.outputTypes.includes(outcomeType));
}

function toStep(node: CapabilityGraphNode): GraphPathStep {
  return {
    capabilityId: node.capabilityId,
    capabilityType: node.capabilityType,
    kernelId: node.kernelId,
    estimatedPriceUSD: node.estimatedPriceUSD,
    estimatedDurationMs: node.estimatedDurationMs,
    assuranceTier: node.assuranceTier,
    reputation: node.reputation,
    ...(node.resourceRequirements
      ? { resourceRequirements: node.resourceRequirements }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Dijkstra-style bounded shortest-path
// ---------------------------------------------------------------------------

interface MutableStats {
  nodesExplored: number;
  edgesExplored: number;
  durationMs: number;
  cappedAtMaxDepth: boolean;
  cappedAtBudget: boolean;
}

interface SearchContext {
  adjacency: Map<string, Array<{ edge: CapabilityGraphEdge; to: CapabilityGraphNode }>>;
  optimizeFor: GraphSearchOptimization;
  budgetUSD: number;
  maxDepth: number;
  req: GraphSearchRequest;
  stats: MutableStats;
}

/**
 * Find the minimum-composite-score simple path from `start` to `end`, or null
 * if none exists within the depth + budget + filter constraints. Dijkstra-
 * style: explores edges in score order via recursion, prunes with a
 * visited-on-path set (cycles can never loop forever), and never expands past
 * the depth or budget caps.
 */
function dijkstra(
  start: CapabilityGraphNode,
  end: CapabilityGraphNode,
  ctx: SearchContext,
): GraphPathStep[] | null {
  let best: { score: number; steps: GraphPathStep[] } | null = null;
  const onPath = new Set<string>();
  const stack: GraphPathStep[] = [];

  function visit(node: CapabilityGraphNode, accScore: number, accPrice: number): void {
    const nextScore = accScore + scoreNode(node, ctx.optimizeFor);
    const nextPrice = accPrice + node.estimatedPriceUSD;

    stack.push(toStep(node));
    ctx.stats.nodesExplored++;

    // Depth cap — count of nodes on the path.
    if (stack.length > ctx.maxDepth) {
      ctx.stats.cappedAtMaxDepth = true;
      stack.pop();
      return;
    }
    // Budget cap — running total of node + handoff prices.
    if (nextPrice > ctx.budgetUSD) {
      ctx.stats.cappedAtBudget = true;
      stack.pop();
      return;
    }
    // Reached the target — record if this is the cheapest route so far.
    if (node.capabilityId === end.capabilityId) {
      const current = best; // const capture → clean strict-mode narrowing
      if (current === null || nextScore < current.score) {
        best = { score: nextScore, steps: stack.map((s) => ({ ...s })) };
      }
      stack.pop();
      return;
    }

    onPath.add(node.capabilityId);
    for (const { edge, to } of ctx.adjacency.get(node.capabilityId) ?? []) {
      if (onPath.has(to.capabilityId)) continue; // cycle guard
      if (!nodePassesFilters(to, ctx.req)) continue; // filtered out
      ctx.stats.edgesExplored++;
      visit(
        to,
        nextScore + edgeWeight(edge, ctx.optimizeFor),
        nextPrice + edge.estimatedHandoffPriceUSD,
      );
    }
    onPath.delete(node.capabilityId);
    stack.pop();
  }

  visit(start, 0, 0);
  if (best === null) return null;
  return (best as { score: number; steps: GraphPathStep[] }).steps;
}

// ---------------------------------------------------------------------------
// Path assembly + search orchestration
// ---------------------------------------------------------------------------

function buildPathOption(
  steps: GraphPathStep[],
  optimizeFor: GraphSearchOptimization,
  edgesByKey: Map<string, CapabilityGraphEdge>,
): GraphPathOption {
  let totalPriceUSD = 0;
  let totalDurationMs = 0;
  let repSum = 0;
  let minAssuranceTier: 0 | 1 | 2 | 3 = steps[0]?.assuranceTier ?? 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    totalPriceUSD += s.estimatedPriceUSD;
    totalDurationMs += s.estimatedDurationMs;
    repSum += s.reputation;
    if (s.assuranceTier < minAssuranceTier) minAssuranceTier = s.assuranceTier;
    if (i > 0) {
      const edge = edgesByKey.get(edgeKey(steps[i - 1].capabilityId, s.capabilityId));
      if (edge) {
        totalPriceUSD += edge.estimatedHandoffPriceUSD;
        totalDurationMs += edge.estimatedHandoffDurationMs;
      }
    }
  }

  return {
    pathId: crypto.randomUUID(),
    steps,
    totalPriceUSD,
    totalDurationMs,
    minAssuranceTier,
    avgReputation: steps.length ? repSum / steps.length : 0,
    compositeScore: compositeScoreForPath(steps, optimizeFor, edgesByKey),
  };
}

function runGraphSearch(req: GraphSearchRequest): GraphSearchResponse {
  const startedMs = Date.now();
  const optimizeFor: GraphSearchOptimization = req.optimizeFor ?? "price";
  const maxDepth = req.maxDepth ?? DEFAULT_MAX_DEPTH;
  const topN = req.topN ?? DEFAULT_TOP_N;
  const stats: MutableStats = {
    nodesExplored: 0,
    edgesExplored: 0,
    durationMs: 0,
    cappedAtMaxDepth: false,
    cappedAtBudget: false,
  };

  // Load the graph snapshot from SQLite for this traversal.
  const all = loadNodes();
  const edgeList = loadEdges();
  const edgesByKey = new Map(
    edgeList.map((e) => [edgeKey(e.fromCapabilityId, e.toCapabilityId), e] as const),
  );

  const startCandidates = findStartNodes(req.startInputType, all).filter((n) =>
    nodePassesFilters(n, req),
  );
  const endCandidates = findEndNodes(req.outcomeType, all).filter((n) =>
    nodePassesFilters(n, req),
  );

  // Build adjacency from edges whose endpoints both exist as nodes.
  const nodesById = new Map(all.map((n) => [n.capabilityId, n] as const));
  const adjacency = new Map<
    string,
    Array<{ edge: CapabilityGraphEdge; to: CapabilityGraphNode }>
  >();
  for (const edge of edgeList) {
    const to = nodesById.get(edge.toCapabilityId);
    if (!to || !nodesById.has(edge.fromCapabilityId)) continue; // dangling edge
    const list = adjacency.get(edge.fromCapabilityId) ?? [];
    list.push({ edge, to });
    adjacency.set(edge.fromCapabilityId, list);
  }

  const ctx: SearchContext = {
    adjacency,
    optimizeFor,
    budgetUSD: req.budgetUSD,
    maxDepth,
    req,
    stats,
  };

  const seen = new Set<string>();
  const collected: GraphPathOption[] = [];
  for (const s of startCandidates) {
    for (const e of endCandidates) {
      const steps = dijkstra(s, e, ctx);
      if (!steps) continue;
      const key = steps.map((st) => st.capabilityId).join("->");
      if (seen.has(key)) continue; // distinct sequences only
      seen.add(key);
      collected.push(buildPathOption(steps, optimizeFor, edgesByKey));
    }
  }

  collected.sort(
    (a, b) =>
      a.compositeScore - b.compositeScore ||
      a.totalPriceUSD - b.totalPriceUSD ||
      a.steps.length - b.steps.length,
  );
  const options = collected.slice(0, topN);

  stats.durationMs = Date.now() - startedMs;
  const searchId = crypto.randomUUID();
  const response: GraphSearchResponse = {
    searchId,
    outcomeType: req.outcomeType,
    optimizedFor: optimizeFor,
    options,
    searchStats: stats,
    proposedAt: new Date(startedMs).toISOString(),
    expiresAt: new Date(startedMs + SEARCH_TTL_MS).toISOString(),
  };
  saveProposal(response, req);
  return response;
}

// ---------------------------------------------------------------------------
// Public search entrypoint — in-process graph search without an HTTP round-trip
// ---------------------------------------------------------------------------

/**
 * Run a capability-graph search and return the proposal — the exact logic
 * `POST /api/capabilities/graph-search` runs (prune expired proposals, then a
 * Dijkstra traversal over the graph), exposed for in-process callers that need
 * the result directly without an HTTP round-trip (e.g. the composition
 * planner's multi-step fallback in compose.ts).
 *
 * The returned proposal is persisted in the same store as the HTTP route, so
 * its `searchId` stays retrievable via `GET /api/capabilities/graph-search/:id`.
 */
export function searchGraph(req: GraphSearchRequest): GraphSearchResponse {
  pruneExpiredSearches();
  return runGraphSearch(req);
}

// ---------------------------------------------------------------------------
// Registration (scaffold candidate injection — idempotent upsert)
// ---------------------------------------------------------------------------

function upsertNode(input: RegisterGraphNodeInput): CapabilityGraphNode {
  const node: CapabilityGraphNode = {
    capabilityId: input.capabilityId,
    capabilityType: input.capabilityType,
    kernelId: input.kernelId,
    operatorAddress: input.operatorAddress,
    estimatedPriceUSD: input.estimatedPriceUSD,
    estimatedDurationMs: input.estimatedDurationMs,
    assuranceTier: input.assuranceTier,
    reputation: input.reputation ?? 0,
    location: input.location,
    available: input.available ?? true,
    inputTypes: input.inputTypes ?? [],
    outputTypes: input.outputTypes ?? [],
    ...(input.resourceRequirements
      ? { resourceRequirements: input.resourceRequirements }
      : {}),
  };
  persistNode(node); // upsert — re-registering replaces, never dupes
  return node;
}

function upsertEdge(input: RegisterGraphEdgeInput): CapabilityGraphEdge {
  const edge: CapabilityGraphEdge = {
    fromCapabilityId: input.fromCapabilityId,
    toCapabilityId: input.toCapabilityId,
    capabilityTypeFlow: input.capabilityTypeFlow,
    estimatedHandoffPriceUSD: input.estimatedHandoffPriceUSD ?? 0,
    estimatedHandoffDurationMs: input.estimatedHandoffDurationMs ?? 0,
  };
  persistEdge(edge); // upsert
  return edge;
}

function buildStats(): GraphStatsResponse {
  const nodes = loadNodes();
  const edges = loadEdges();
  const typeSet = new Set<string>();
  for (const n of nodes) typeSet.add(n.capabilityType);
  const capabilityTypes = [...typeSet].sort();
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    capabilityTypeCount: capabilityTypes.length,
    capabilityTypes,
    lastRebuiltAt: lastRebuiltAt(),
  };
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function graphSearchRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/capabilities/graph-search ──────────────────────────────────
  app.post("/api/capabilities/graph-search", async (req, reply) => {
    const parsed = GraphSearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Invalid graph search request",
        details: parsed.error.flatten(),
      });
    }
    const response = searchGraph(parsed.data);
    return reply.status(201).send(response);
  });

  // ── GET /api/capabilities/graph-search/:searchId ─────────────────────────
  app.get<{ Params: { searchId: string } }>(
    "/api/capabilities/graph-search/:searchId",
    async (req, reply) => {
      const { searchId } = req.params;
      const s = loadProposal(searchId);
      if (!s) {
        return reply.status(404).send({
          error: "search_not_found",
          message: `No search with id=${searchId}`,
        });
      }
      if (Date.parse(s.expiresAt) <= Date.now()) {
        deleteProposal(searchId);
        return reply.status(410).send({
          error: "search_expired",
          message: `Search ${searchId} has expired`,
          searchId,
        });
      }
      return s;
    },
  );

  // ── GET /api/capabilities/graph-stats ────────────────────────────────────
  app.get("/api/capabilities/graph-stats", async () => buildStats());

  // ── POST /api/capabilities/graph/_dev/register-node ──────────────────────
  // Scaffold-only injection. Production replaces this with a CapabilityFacade-
  // backed graph rebuild. Gated behind the gateway apiGate in production.
  app.post("/api/capabilities/graph/_dev/register-node", async (req, reply) => {
    const parsed = RegisterGraphNodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Invalid node registration",
        details: parsed.error.flatten(),
      });
    }
    const node = upsertNode(parsed.data);
    return reply.status(201).send({ ok: true, node });
  });

  // ── POST /api/capabilities/graph/_dev/register-edge ──────────────────────
  app.post("/api/capabilities/graph/_dev/register-edge", async (req, reply) => {
    const parsed = RegisterGraphEdgeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        message: "Invalid edge registration",
        details: parsed.error.flatten(),
      });
    }
    const edge = upsertEdge(parsed.data);
    return reply.status(201).send({ ok: true, edge });
  });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Clear every store. Call in beforeEach. */
export function _clearGraphSearchForTests(): void {
  const d = db();
  d.delete(schema.graphSearchNodes).run();
  d.delete(schema.graphSearchEdges).run();
  d.delete(schema.graphSearchProposals).run();
}

/** Bulk-inject nodes/edges directly (bypasses HTTP) for test setup. */
export function _seedGraphSearchForTests(seed: {
  nodes?: RegisterGraphNodeInput[];
  edges?: RegisterGraphEdgeInput[];
}): void {
  for (const n of seed.nodes ?? []) upsertNode(n);
  for (const e of seed.edges ?? []) upsertEdge(e);
}

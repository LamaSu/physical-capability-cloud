/**
 * Composition engine routes.
 *
 * The keystone for PCC's agentic-composition layer. Takes an outcome spec +
 * budget + assurance tier, returns a sequenced DAG of capability instances
 * ready for execution.
 *
 * Storage: in-memory Map for the scaffold (compositions + candidates).
 * Production wiring will swap the candidate provider to CapabilityFacade and
 * persist compositions via the same SQLite layer as marketplace + bounty.
 *
 * The execute endpoint is currently a stub — it returns a synthetic workflow
 * id without actually queueing jobs. Follow-on PR wires this into
 * @pcc/workflow + /api/jobs/submit + /api/escrow/fund.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ComposeRequestSchema,
  ExecuteCompositionRequestSchema,
  RegisterCandidateRequestSchema,
  type ComposeRequest,
  type ComposeResponse,
  type CompositionCandidate,
  type CompositionOptimization,
  type CompositionStep,
  type CompositionStatus,
  type ExecuteCompositionResponse,
  type LocationConstraint,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// In-memory store (scaffold-only; production swaps to facades + SQLite)
// ---------------------------------------------------------------------------

const candidates = new Map<string, CompositionCandidate>();
const compositions = new Map<string, ComposeResponse>();

const COMPOSITION_TTL_MS = 30 * 60 * 1000; // 30 min

function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Candidate provider interface — production wiring point
// ---------------------------------------------------------------------------

/**
 * Pluggable provider that returns capability candidates matching a step's
 * constraints. The scaffold uses an in-memory implementation; production
 * wires this to CapabilityFacade.list({ capabilityType, ... }).
 */
export interface CapabilityProvider {
  findByType(
    capabilityType: string,
    constraints: {
      minAssuranceTier: number;
      location?: LocationConstraint;
    },
  ): CompositionCandidate[];
}

const inMemoryProvider: CapabilityProvider = {
  findByType: (capabilityType, constraints) => {
    const all = Array.from(candidates.values());
    return all.filter((c) => {
      if (c.capabilityType !== capabilityType) return false;
      if (!c.available) return false;
      if (c.assuranceTier < constraints.minAssuranceTier) return false;
      if (constraints.location && c.location) {
        const km = haversineKm(constraints.location, c.location);
        const radius = constraints.location.radiusKm ?? 50;
        if (km > radius) return false;
      }
      return true;
    });
  },
};

/** Haversine great-circle distance in km. */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const aHav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(aHav));
}

// ---------------------------------------------------------------------------
// Planner — picks one candidate per step under the chosen optimization
// ---------------------------------------------------------------------------

function scoreCandidate(
  c: CompositionCandidate,
  optimization: CompositionOptimization,
): number {
  switch (optimization) {
    case "price":
      return c.estimatedPriceUSD;
    case "speed":
      return c.estimatedDurationMs;
    case "quality":
      // Higher tier + higher reputation = better; invert so lower score = better.
      return -1 * (c.assuranceTier * 1000 + (c.reputation ?? 0));
  }
}

function plan(
  req: ComposeRequest,
  provider: CapabilityProvider,
): { steps: CompositionStep[]; status: CompositionStatus; rejection?: string } {
  const stepTypes = req.steps ?? [req.outcomeType];
  const optimization = req.optimizeFor ?? "price";

  const chosen: CompositionStep[] = [];
  for (let i = 0; i < stepTypes.length; i++) {
    const capType = stepTypes[i]!;
    const matches = provider.findByType(capType, {
      minAssuranceTier: req.minAssuranceTier,
      location: req.location,
    });

    if (matches.length === 0) {
      return {
        steps: [],
        status: "no_path_found",
        rejection: `No candidate found for step ${i} (capabilityType="${capType}") at minAssuranceTier=${req.minAssuranceTier}`,
      };
    }

    matches.sort(
      (a, b) => scoreCandidate(a, optimization) - scoreCandidate(b, optimization),
    );
    const pick = matches[0]!;

    chosen.push({
      index: i,
      capabilityType: capType,
      capabilityId: pick.capabilityId,
      kernelId: pick.kernelId,
      operatorAddress: pick.operatorAddress,
      estimatedPriceUSD: pick.estimatedPriceUSD,
      estimatedDurationMs: pick.estimatedDurationMs,
      assuranceTier: pick.assuranceTier,
      dependsOn: i === 0 ? [] : [i - 1],
      reputation: pick.reputation,
    });
  }

  const total = chosen.reduce((s, x) => s + x.estimatedPriceUSD, 0);
  if (total > req.budgetUSD) {
    return {
      steps: chosen,
      status: "over_budget",
      rejection: `Plan total $${total.toFixed(2)} exceeds budget $${req.budgetUSD.toFixed(2)}`,
    };
  }

  return { steps: chosen, status: "proposed" };
}

function summarize(
  req: ComposeRequest,
  steps: CompositionStep[],
  status: CompositionStatus,
  rejectionReason: string | undefined,
): ComposeResponse {
  const totalPriceUSD = steps.reduce((s, x) => s + x.estimatedPriceUSD, 0);
  const totalDurationMs = steps.reduce((s, x) => s + x.estimatedDurationMs, 0);
  const effectiveTier =
    steps.length === 0
      ? req.minAssuranceTier
      : (Math.min(...steps.map((s) => s.assuranceTier)) as 0 | 1 | 2 | 3);
  const budgetRemainingUSD = Math.max(0, req.budgetUSD - totalPriceUSD);

  return {
    compositionId: `cmp_${randomUUID()}`,
    status,
    steps,
    totalPriceUSD,
    totalDurationMs,
    effectiveAssuranceTier: effectiveTier,
    budgetUSD: req.budgetUSD,
    budgetRemainingUSD,
    optimizedFor: req.optimizeFor ?? "price",
    proposedAt: nowISO(),
    expiresAt: new Date(Date.now() + COMPOSITION_TTL_MS).toISOString(),
    rejectionReason,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/compose — propose a composition
  app.post("/api/compose", async (req, reply) => {
    const parsed = ComposeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_failed",
        message: "Invalid compose request",
        details: parsed.error.format(),
      });
    }

    const result = plan(parsed.data, inMemoryProvider);
    const response = summarize(
      parsed.data,
      result.steps,
      result.status,
      result.rejection,
    );
    compositions.set(response.compositionId, response);

    return reply.code(result.status === "proposed" ? 201 : 200).send(response);
  });

  // GET /api/compose/:id — retrieve a previously-proposed composition
  app.get<{ Params: { id: string } }>(
    "/api/compose/:id",
    async (req, reply) => {
      const c = compositions.get(req.params.id);
      if (!c) {
        return reply.code(404).send({
          error: "not_found",
          message: `No composition with id ${req.params.id}`,
        });
      }
      // Expire on the fly
      if (new Date(c.expiresAt).getTime() < Date.now()) {
        return reply.code(410).send({
          error: "expired",
          message: `Composition ${req.params.id} expired at ${c.expiresAt}`,
        });
      }
      return reply.send(c);
    },
  );

  // POST /api/compose/:id/execute — commit composition → workflow run
  //
  // SCAFFOLD: returns a synthetic workflow id without queueing actual jobs.
  // Follow-on PR wires this to @pcc/workflow + /api/jobs/submit + /api/escrow/fund.
  app.post<{ Params: { id: string } }>(
    "/api/compose/:id/execute",
    async (req, reply) => {
      const parsed = ExecuteCompositionRequestSchema.safeParse({
        ...(req.body as object),
        compositionId: req.params.id,
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          message: "Invalid execute payload",
          details: parsed.error.format(),
        });
      }

      const c = compositions.get(req.params.id);
      if (!c) {
        return reply.code(404).send({
          error: "not_found",
          message: `No composition with id ${req.params.id}`,
        });
      }
      if (c.status !== "proposed") {
        return reply.code(409).send({
          error: "not_executable",
          message: `Composition is in status "${c.status}" and cannot be executed`,
        });
      }
      if (new Date(c.expiresAt).getTime() < Date.now()) {
        return reply.code(410).send({
          error: "expired",
          message: `Composition expired at ${c.expiresAt}`,
        });
      }

      const response: ExecuteCompositionResponse = {
        compositionId: c.compositionId,
        workflowId: `wf_${randomUUID()}`,
        status: "queued",
        startedAt: nowISO(),
      };
      return reply.code(202).send(response);
    },
  );

  // POST /api/compose/_dev/register-candidate — scaffold-only candidate injection
  //
  // Production replaces the in-memory provider with CapabilityFacade and
  // this endpoint goes away. Keep it gated for dev/test only.
  app.post(
    "/api/compose/_dev/register-candidate",
    async (req, reply) => {
      const parsed = RegisterCandidateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          message: "Invalid candidate",
          details: parsed.error.format(),
        });
      }
      const cap = parsed.data;
      candidates.set(cap.capabilityId, cap);
      return reply.code(201).send({ ok: true, capabilityId: cap.capabilityId });
    },
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Clear in-memory stores between test cases */
export function _clearComposeForTests(): void {
  candidates.clear();
  compositions.clear();
}

/** Direct candidate injection for tests (bypass the dev endpoint) */
export function _registerCandidateForTests(c: CompositionCandidate): void {
  candidates.set(c.capabilityId, c);
}

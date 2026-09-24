/**
 * Agent plans over HTTP (reconciliation R9): an arbitrary external agent submits the plan it composed,
 * and the SERVER decides what it costs, who is paid, and what is sealed.
 *
 *   POST /api/agent-plans/validate            read-only R10 pre-check: each node's claim against the
 *                                             live row, with the re-quote when it is stale. Moves nothing.
 *   POST /api/settlement/agent-plans/accept   the accept seam (R10 -> R11 -> R12), then escrow's unit ids
 *                                             and VCR's deal binding, then ONE atomic R13 consume that
 *                                             seals `acceptedDealDigest`.
 *
 * Authority. The principal is the gate's authenticated identity (`authenticatedPrincipal`), never a
 * body field. The tenant for R10 visibility is the gate's `req.tenantId`. Everything else (live terms,
 * programs, evidence requirements, payer, fee, reclaim time, plan id, unit ids) is the server's.
 *
 * Gating. `/api/settlement/` is a money-path prefix: the scope checker DEFAULT-DENIES its writes. After
 * gateway WP-A (R28, #326) a caller needs an explicit `settlement` (or `admin`) scope, and a wildcard key
 * no longer counts. On top of that, accept answers 503 and consumes nothing until EVERY production
 * piece exists:
 *   - the R13 reservation store (its table is operator decision #2240);
 *   - evidence's program resolver and gate (#349);
 *   - evidence's CSD-tier -> requirement map;
 *   - the server fee policy;
 *   - escrow's encoder (#367), plus oracle's termsHash and acceptedPolicyDigest.
 * Validate is wired today: live capability and kernel rows, and the CSD registry.
 *
 * Order on accept: seam, then deal binding (VCR's 64-unit limit, then escrow's unit ids), then consume.
 * A plan that cannot be bound never consumes its reservation. The consume re-checks and RECOMPUTES the
 * digest atomically (the #351 consumer contract); a lost race is 409.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CompiledAcceptedPlan } from "@pcc/spec";
import { getRepos } from "../db.js";
import { getCsdRegistry } from "./csd.js";
import {
  acceptExternalPlan,
  snapshotSubmission,
  submissionDigest,
  type ExternalPlanSubmission,
  type SeamDeps,
  type SeamResult,
} from "../services/external-plan-seam.js";
import { csdSlugFromUrl, revalidatePlanSnapshots, type RevalidationDeps, type SnapshotClaim } from "../services/plan-snapshot-revalidation.js";
import { bindDeal, type DealEncoder } from "../services/agent-plan-deal.js";
import { presentPlan } from "../services/plan-presentation.js";

/** R13's consume: ONE atomic step that re-checks the reservation, recomputes the digest, consumes once and seals. */
export type ConsumeReservation = (
  reservationId: string,
  principal: string,
  plan: CompiledAcceptedPlan,
  now: number,
) => { ok: true } | { ok: false; reason: string };

/** Everything accept needs. */
export interface AgentPlanAcceptWiring {
  seam: SeamDeps;
  encodeDeal: DealEncoder;
  consumeReservation: ConsumeReservation;
}

export interface AgentPlanRouteDeps {
  /** R10's live reads. Wired in production today. */
  revalidation: RevalidationDeps;
  /** Accept's wiring, or the pieces that do not exist yet (accept then answers 503 and consumes nothing). */
  accept: AgentPlanAcceptWiring | { missing: string[] };
}

export interface AgentPlanRouteOptions {
  /** Test injection. Production: `productionAgentPlanDeps`. */
  deps?: () => AgentPlanRouteDeps;
}

/**
 * The authenticated principal: the API key's operator identity, else the SIWE session's wallet, as the
 * gate set them. Never a body field. Lowercased, because neither an address nor an email means anything
 * by its case. R13's reservation-issue route must use this same function, so an issued reservation's
 * `principal` and an accepting caller's principal compare equal.
 */
export function authenticatedPrincipal(req: FastifyRequest): string | null {
  const id: unknown = req.operatorId ?? req.userId ?? null;
  if (typeof id !== "string") return null;
  const p = id.trim().toLowerCase();
  return p === "" ? null : p;
}

/** The production wiring: live rows and the CSD registry for R10. Accept's pieces are listed as missing. */
export function productionAgentPlanDeps(): AgentPlanRouteDeps {
  return {
    revalidation: {
      loadCapabilities: (ids) =>
        getRepos()
          .capabilities.findByIds(ids)
          .map((r) => ({ id: r.id, type: r.type, kernelId: r.kernelId, pricing: r.pricing, assuranceTiers: r.assuranceTiers, tenantId: r.tenantId })),
      loadKernels: (ids) =>
        getRepos()
          .kernels.findByIds(ids)
          .map((k) => ({ id: k.id, operatorAddress: k.operatorAddress, status: k.status })),
      csdForType: (type) => csdSlugFromUrl(getCsdRegistry().findUrlByType(type)),
    },
    accept: {
      missing: [
        "reservation-store (R13; operator decision #2240)",
        "program-resolver-and-gate (R11; evidence #349)",
        "evidence-requirement-map (evidence)",
        "fee-policy",
        "deal-encoder (escrow #367 + oracle termsHash/acceptedPolicyDigest)",
      ],
    },
  };
}

/** Bigints as decimal strings: the response is plain JSON, and money never becomes a float. */
function jsonSafe<T>(x: T): unknown {
  return JSON.parse(JSON.stringify(x, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * A reservation that belongs to another principal is answered exactly like a missing one, so accept is
 * not an oracle for which reservation ids exist.
 */
function withoutExistenceOracle(result: Extract<SeamResult, { ok: false }>): Extract<SeamResult, { ok: false }> {
  const r = result.refusal;
  return r.stage === "reservation" && r.reason === "wrong-principal" ? { ...result, refusal: { stage: "reservation", reason: "not-found" } } : result;
}

function refusalStatus(result: Extract<SeamResult, { ok: false }>): number {
  const r = result.refusal;
  if (r.stage === "submission") return 400;
  if (r.stage === "reservation") {
    if (r.reason === "not-found" || r.reason === "wrong-principal") return 404;
    if (r.reason === "not-issued" || r.reason === "expired") return 409;
    if (r.reason === "malformed-reservation") return 500;
    return 422; // wrong-request: the plan names another request than its reservation
  }
  return 422;
}

export async function agentPlanRoutes(app: FastifyInstance, opts: AgentPlanRouteOptions = {}): Promise<void> {
  const depsOf = opts.deps ?? productionAgentPlanDeps;

  app.post("/api/agent-plans/validate", async (req: FastifyRequest, reply: FastifyReply) => {
    if (authenticatedPrincipal(req) === null) return reply.status(401).send({ error: "authentication-required" });
    const body: unknown = req.body;
    const nodes = typeof body === "object" && body !== null ? (body as { nodes?: unknown }).nodes : undefined;
    if (!Array.isArray(nodes)) return reply.status(400).send({ error: "malformed-body", message: "Expected { nodes: SnapshotClaim[] }." });
    try {
      const { revalidation } = depsOf();
      const result = revalidatePlanSnapshots(nodes as SnapshotClaim[], revalidation, { tenantId: req.tenantId ?? null });
      return reply.status(200).send(jsonSafe({ ok: result.ok, verdicts: result.verdicts, asOf: new Date().toISOString() }));
    } catch (err) {
      req.log.error({ err }, "agent-plans validate: server fault");
      return reply.status(500).send({ error: "internal-error" });
    }
  });

  app.post("/api/settlement/agent-plans/accept", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticatedPrincipal(req);
    if (principal === null) return reply.status(401).send({ error: "authentication-required" });
    try {
      const { accept } = depsOf();
      if ("missing" in accept) return reply.status(503).send({ error: "accept-not-wired", missing: [...accept.missing] });
      // The wiring, read once. Its functions are called with the wiring as receiver.
      const wiring = accept;
      const seam: unknown = wiring.seam;
      const encodeFn: unknown = wiring.encodeDeal;
      const consumeFn: unknown = wiring.consumeReservation;
      if (typeof seam !== "object" || seam === null || typeof encodeFn !== "function" || typeof consumeFn !== "function") {
        throw new TypeError("agent-plans accept: malformed wiring");
      }
      // ONE clock reading per request. The seam, the consume and the presentation all use it; a clock
      // that cannot give a finite time fails closed.
      const nowFn: unknown = (seam as SeamDeps).now;
      const clock: unknown = typeof nowFn === "function" ? Reflect.apply(nowFn, seam, []) : undefined;
      if (typeof clock !== "number" || !Number.isFinite(clock) || clock < 0) return reply.status(500).send({ error: "clock-unavailable" });
      const now = Math.floor(clock);
      const asOf = new Date(now * 1000).toISOString();
      // The seam's own deps, with the clock pinned. Every other member resolves through the prototype,
      // so method-style dependencies keep their receiver.
      const seamAt = Object.create(seam, { now: { value: () => now } }) as SeamDeps;

      const submission = req.body as ExternalPlanSubmission;
      const result = acceptExternalPlan(submission, { principal, tenantId: req.tenantId ?? null }, seamAt);
      if (!result.ok) {
        const shown = withoutExistenceOracle(result);
        return reply.status(refusalStatus(result)).send(
          jsonSafe({
            refusal: shown.refusal,
            verdicts: shown.verdicts,
            submissionDigest: shown.submissionDigest,
            presentation: presentPlan({ submission, outcome: shown, asOf }),
          }),
        );
      }

      // The edges exactly as the seam evaluated them: re-snapshot the body and match the seam's digest.
      const snap = snapshotSubmission(submission);
      if (snap === null || submissionDigest(snap) !== result.submissionDigest) return reply.status(500).send({ error: "submission-changed" });
      const deal = bindDeal(result.plan, snap.edges, (plan) => Reflect.apply(encodeFn, wiring, [plan]) as ReturnType<DealEncoder>);
      if (!deal.ok) {
        if (deal.reason === "too-many-units-for-deal") {
          return reply.status(422).send({ refusal: { stage: "deal", reason: deal.reason, units: deal.units }, submissionDigest: result.submissionDigest });
        }
        return reply.status(500).send({ error: "deal-binding-failed", reason: deal.reason, detail: deal.detail });
      }

      // R13: the acceptance itself. Only an explicit { ok: true } counts as consumed.
      const consumed: unknown = Reflect.apply(consumeFn, wiring, [result.plan.reservationId, principal, result.plan, now]);
      const c = (typeof consumed === "object" && consumed !== null ? consumed : {}) as { ok?: unknown; reason?: unknown };
      const ok = c.ok;
      if (ok !== true) {
        const why = c.reason;
        const reason = typeof why === "string" ? why : "unknown";
        const hidden = reason === "wrong-principal" || reason === "not-found";
        return reply.status(hidden ? 404 : 409).send({ error: "reservation-conflict", reason: hidden ? "not-found" : reason });
      }
      const sealed = { reservationId: result.plan.reservationId, acceptedDealDigest: result.plan.acceptedDealDigest };
      return reply.status(200).send(
        jsonSafe({
          plan: result.plan,
          dealBindings: deal.bindings,
          submissionDigest: result.submissionDigest,
          sealed,
          presentation: presentPlan({ submission, outcome: result, sealed, asOf }),
        }),
      );
    } catch (err) {
      req.log.error({ err }, "agent-plans accept: server fault");
      return reply.status(500).send({ error: "internal-error" });
    }
  });
}

/**
 * pizza-oracle — pre-commit / hash-commit-reveal / evidence endpoints for the
 * vibecodenights pizza demo. Thin HTTP layer over pizza-store.ts (shared with
 * pizza-demo.ts so both sides operate on the same in-memory state).
 *
 * Endpoints (all under /api/demo):
 *   POST /orders/:id/pre-commit          → generate commitment templates, → staking
 *   POST /jobs/:jobId/stake              → a party stakes (hash + funds)
 *   POST /jobs/:jobId/evidence           → a party submits an evidence bundle
 *   GET  /jobs/:jobId/evidence           → list evidence bundles
 *   POST /jobs/:jobId/reveal             → a party reveals its secret (fraud check)
 *   GET  /jobs/:jobId/commitments        → list commitments + their states
 *
 * The oracle being "notified of all the things that are supposed to happen" =
 * the commitment templates' evidenceRequirements. Verification (geofence,
 * required photo/timestamp) happens in the store on evidence submission.
 */

import type { FastifyInstance } from "fastify";
import {
  beginPreCommit,
  getCommitments,
  getEvidence,
  orderByJobId,
  orders,
  revealSecret,
  stakeCommitment,
  submitEvidence,
  type EvidenceBody,
  type PreCommitOptions,
  type RevealBody,
  type StakeBody,
} from "./pizza-store.js";

export async function pizzaOracleRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/demo/orders/:id/pre-commit — kick off the pre-commit phase.
  // Returns the commitment templates each party must stake. Idempotent.
  app.post<{
    Params: { id: string };
    Body: PreCommitOptions;
  }>("/api/demo/orders/:id/pre-commit", async (req, reply) => {
    const order = orders.get(req.params.id);
    if (!order) return reply.status(404).send({ error: "not_found" });
    if (
      order.status !== "confirmed" &&
      !(order.status === "staking" && order.jobId) // allow idempotent re-fetch
    ) {
      return reply.status(409).send({
        error: "wrong_state",
        message: `expected confirmed, got ${order.status}`,
      });
    }
    const res = beginPreCommit(order, req.body ?? {});
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    return reply.status(res.status).send({
      jobId: res.data!.jobId,
      orderId: order.orderId,
      stakeDeadline: order.stakeDeadline,
      commitments: res.data!.commitments,
    });
  });

  // POST /api/demo/jobs/:jobId/stake — party stakes commitment + secret hash + funds.
  app.post<{
    Params: { jobId: string };
    Body: StakeBody;
  }>("/api/demo/jobs/:jobId/stake", async (req, reply) => {
    const res = stakeCommitment(req.params.jobId, req.body ?? {});
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    return reply.status(200).send({
      commitment: res.data!.commitment,
      allStaked: res.data!.allStaked,
      escrow: res.data!.order.escrow ?? null,
      orderStatus: res.data!.order.status,
    });
  });

  // POST /api/demo/jobs/:jobId/evidence — party submits an evidence bundle.
  app.post<{
    Params: { jobId: string };
    Body: EvidenceBody;
  }>("/api/demo/jobs/:jobId/evidence", async (req, reply) => {
    const res = submitEvidence(req.params.jobId, req.body ?? {});
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    return reply.status(201).send({
      bundle: res.data!.bundle,
      phase: res.data!.phase,
      orderStatus: res.data!.order.status,
    });
  });

  // GET /api/demo/jobs/:jobId/evidence — list evidence bundles for a job.
  app.get<{ Params: { jobId: string } }>(
    "/api/demo/jobs/:jobId/evidence",
    async (req, reply) => {
      if (!orderByJobId.has(req.params.jobId)) {
        return reply.status(404).send({ error: "not_found" });
      }
      const bundles = getEvidence(req.params.jobId);
      return reply.status(200).send({ jobId: req.params.jobId, bundles, total: bundles.length });
    },
  );

  // POST /api/demo/jobs/:jobId/reveal — party reveals its secret (fraud check).
  app.post<{
    Params: { jobId: string };
    Body: RevealBody;
  }>("/api/demo/jobs/:jobId/reveal", async (req, reply) => {
    const res = revealSecret(req.params.jobId, req.body ?? {});
    if (!res.ok) return reply.status(res.status).send({ error: res.error, message: res.message });
    return reply.status(200).send({
      commitment: res.data!.commitment,
      fraud: res.data!.fraud,
      verdict: res.data!.fraud ? "slashed" : "revealed",
    });
  });

  // GET /api/demo/jobs/:jobId/commitments — list commitments + their states.
  app.get<{ Params: { jobId: string } }>(
    "/api/demo/jobs/:jobId/commitments",
    async (req, reply) => {
      if (!orderByJobId.has(req.params.jobId)) {
        return reply.status(404).send({ error: "not_found" });
      }
      const all = getCommitments(req.params.jobId);
      return reply.status(200).send({
        jobId: req.params.jobId,
        commitments: all,
        total: all.length,
        allStaked: all.length > 0 && all.every((c) => c.status !== "pending"),
      });
    },
  );
}

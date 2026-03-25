/**
 * Bittensor Subnet Task Routes — API surface for the 3 PCC task subnets.
 *
 * POST /api/subnet/route      — Capability routing (best operator for job)
 * POST /api/subnet/quality    — Evidence quality scoring
 * POST /api/subnet/similarity — CSD similarity detection
 * GET  /api/subnet/metrics    — Aggregated subnet metrics
 *
 * Currently runs mock miners in-process. When a real Bittensor subnet is
 * registered, the BittensorTaskRouter would send synapses via dendrite
 * instead of in-process simulation.
 */

import type { FastifyInstance } from "fastify";
import {
  BittensorTaskRouter,
  type CapabilityRoutingSynapse,
  type QualityScoringSynapse,
  type SimilarityScoringSynapse,
} from "@pcc/verifier";

const router = new BittensorTaskRouter({ minersPerSubnet: 8 });

export async function subnetRoutes(app: FastifyInstance) {
  // ── Capability Routing ────────────────────────────────────────────────

  app.post<{ Body: CapabilityRoutingSynapse }>("/api/subnet/route", async (req) => {
    const synapse = req.body as CapabilityRoutingSynapse;

    if (!synapse.jobRequest || !synapse.operators) {
      return { error: "Missing jobRequest or operators in body" };
    }

    const result = await router.routeCapability(synapse);
    return {
      subnet: "capability_routing",
      mode: "mock",
      result,
    };
  });

  // ── Quality Scoring ───────────────────────────────────────────────────

  app.post<{ Body: QualityScoringSynapse }>("/api/subnet/quality", async (req) => {
    const synapse = req.body as QualityScoringSynapse;

    if (!synapse.bundleHash || !synapse.bundleData) {
      return { error: "Missing bundleHash or bundleData in body" };
    }

    const result = await router.scoreQuality(synapse);
    return {
      subnet: "quality_scoring",
      mode: "mock",
      result,
    };
  });

  // ── Similarity Detection ──────────────────────────────────────────────

  app.post<{ Body: SimilarityScoringSynapse }>("/api/subnet/similarity", async (req) => {
    const synapse = req.body as SimilarityScoringSynapse;

    if (!synapse.candidateCsd || !synapse.registeredCsds) {
      return { error: "Missing candidateCsd or registeredCsds in body" };
    }

    const result = await router.detectSimilarity(synapse);
    return {
      subnet: "similarity_detection",
      mode: "mock",
      result,
    };
  });

  // ── Metrics ───────────────────────────────────────────────────────────

  app.get("/api/subnet/metrics", async () => {
    const metrics = router.getSubnetMetrics();
    return {
      mode: "mock",
      note: "In-process mock miners. Real Bittensor subnet not yet registered.",
      ...metrics,
    };
  });
}

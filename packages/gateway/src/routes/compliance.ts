// packages/gateway/src/routes/compliance.ts
//
// HTTP routes that surface ComplianceFacade data for the dashboard.
//
// PRIMARY (dashboard hooks already wired):
//   GET  /api/capabilities/:capabilityId/compliance  → useComplianceReport
//   GET  /api/jobs/:jobId/drift-alerts               → useDriftAlerts
//
// SECONDARY (complete the compliance surface area):
//   GET  /api/jobs/:jobId/evidence
//   GET  /api/evidence/:bundleId
//   GET  /api/evidence/:bundleId/tier-compliance
//   POST /api/jobs/:jobId/attestations/aggregate
//
// Public endpoints — compliance data is transparency.
// No auth gate — the apiGate middleware handles global auth; these are read-only.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import type { VerificationAttestation } from "@pcc/spec";
import { getComplianceFacade } from "../facades/index.js";
import { getRepos } from "../db.js";

// ── Result→HTTP helper ────────────────────────────────────────────────────────
//
// Maps a Result<T> returned by any facade method to a Fastify HTTP response.
// Success → 200 with data as body (Fastify serialises automatically).
// Failure → reply.code(httpStatus).send({ error, message[, details] }).
//
function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

export async function complianceRoutes(app: FastifyInstance) {
  // Acquire singleton once per plugin registration — safe because the DB is
  // initialised before route plugins are registered in server.ts.
  const facade = getComplianceFacade();

  // ── PRIMARY: Compliance report ────────────────────────────────────────────
  // Dashboard hook: useComplianceReport(capabilityId)
  // Client call: GET /api/capabilities/:capabilityId/compliance
  app.get<{ Params: { capabilityId: string } }>(
    "/api/capabilities/:capabilityId/compliance",
    async (req, reply) => {
      const result = await facade.generateComplianceReport(req.params.capabilityId);
      return sendResult(reply, result);
    },
  );

  // ── PRIMARY: Drift alerts ─────────────────────────────────────────────────
  // Dashboard hook: useDriftAlerts(jobId)
  // Client call: GET /api/jobs/:jobId/drift-alerts
  app.get<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/drift-alerts",
    async (req, reply) => {
      const result = await facade.detectDrift(req.params.jobId);
      return sendResult(reply, result);
    },
  );

  // ── SECONDARY: Evidence list for a job ───────────────────────────────────
  // GET /api/jobs/:jobId/evidence → EvidenceSummaryDTO[]
  // Registered AFTER jobRoutes in server.ts so Fastify's specificity rules
  // let the more-specific path win over any wildcard in jobs.ts.
  app.get<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/evidence",
    async (req, reply) => {
      const result = await facade.getEvidenceForJob(req.params.jobId);
      return sendResult(reply, result);
    },
  );

  // ── SECONDARY: Single evidence bundle (via compliance facade) ─────────────
  // Moved to /api/compliance/evidence/ to avoid collision with evidence-encrypted.ts
  // which owns GET /api/evidence/:bundleId
  app.get<{ Params: { bundleId: string } }>(
    "/api/compliance/evidence/:bundleId",
    async (req, reply) => {
      const result = await facade.getBundle(req.params.bundleId);
      return sendResult(reply, result);
    },
  );

  // ── SECONDARY: Tier compliance check for a bundle ────────────────────────
  app.get<{ Params: { bundleId: string } }>(
    "/api/compliance/evidence/:bundleId/tier-compliance",
    async (req, reply) => {
      const result = await facade.checkTierCompliance(req.params.bundleId);
      return sendResult(reply, result);
    },
  );

  // ── SECONDARY: Aggregate attestations ────────────────────────────────────
  // POST /api/jobs/:jobId/attestations/aggregate
  // Body: { attestations: VerificationAttestation[] }
  // Returns: AggregatedAttestationDTO
  //
  // Security: requires auth + ownership (kernel operator or job submitter only).
  // Previously unauthenticated — allowed fabricated attestations against any job.
  app.post<{
    Params: { jobId: string };
    Body: { attestations: VerificationAttestation[] };
  }>(
    "/api/jobs/:jobId/attestations/aggregate",
    async (req, reply) => {
      // Require authentication (apiGate runs before this route)
      const operatorId = (req as any).operatorId ?? (req as any).userId;
      if (!operatorId) {
        return reply.code(401).send({ error: "Authentication required" });
      }

      // Verify caller is the kernel operator or job submitter
      const repos = getRepos();
      const job = repos.jobs.findById(req.params.jobId);
      if (!job) return reply.code(404).send({ error: "not_found" });

      let isAuthorized = false;
      if ((job as any).submittedBy === operatorId) isAuthorized = true;
      if (!isAuthorized && (job as any).kernelId) {
        const kernel = repos.kernels.findById((job as any).kernelId);
        if (kernel && (kernel as any).operatorId === operatorId) isAuthorized = true;
      }
      if (!isAuthorized) {
        return reply.code(403).send({
          error: "forbidden",
          message: "You can only aggregate attestations for your own jobs",
        });
      }

      const attestations = req.body?.attestations ?? [];
      const result = await facade.aggregateAttestations(req.params.jobId, attestations);
      return sendResult(reply, result);
    },
  );
}

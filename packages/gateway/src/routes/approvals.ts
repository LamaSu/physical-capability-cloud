/**
 * Approval-as-evidence intake routes (D8, settlement-decisions.md).
 *
 * Three endpoints, all BENIGN:
 *   POST /api/jobs/:jobId/approval-challenge — issue a single-use nonce
 *   POST /api/jobs/:jobId/approvals          — submit a signed approval
 *   GET  /api/jobs/:jobId/approvals           — list approvals for a job
 *
 * These routes carry + structurally pre-check approvals; they NEVER decide
 * settlement and NEVER re-drive the settlement pipeline themselves. The
 * (not-yet-built) PUT /api/jobs/:jobId/complete gating — reading these rows
 * and handing them to the oracle's /verify call — is the oracle lane's
 * responsibility (see approval-as-evidence-build-spec.md §2 Lane B, the
 * paid-job-flow.ts row, tagged security-heavy + settlement-coordinated).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Result } from "@pcc/spec";
import {
  issueChallenge,
  submitApproval,
  listApprovals,
  getPolicyForJob,
} from "../services/approval-service.js";

// ── Result→HTTP helper (matches routes/capabilities.ts convention) ────────
function sendResult<T>(reply: FastifyReply, result: Result<T>, successStatus = 200): unknown {
  if (result.success) return reply.code(successStatus).send(result.data);
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.hint ? { hint: result.error.hint } : {}),
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

export async function approvalRoutes(app: FastifyInstance) {
  /**
   * POST /api/jobs/:jobId/approval-challenge — issue a single-use nonce +
   * a best-effort digest preview, and the policy's claims for UX rendering
   * (the Approve card shows the acceptance criteria before the user signs).
   */
  app.post<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/approval-challenge",
    async (req, reply) => {
      const { jobId } = req.params;
      if (!jobId) return reply.status(400).send({ error: "jobId is required" });
      const result = issueChallenge(jobId);
      return sendResult(reply, result, 200);
    },
  );

  /**
   * POST /api/jobs/:jobId/approvals — submit a signed ApprovalEvidenceV1.
   * 202 on successful intake: the approval is durably recorded, not yet
   * acted upon (settlement re-drive is the oracle lane's wiring).
   */
  app.post<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/approvals",
    async (req, reply) => {
      const { jobId } = req.params;
      if (!jobId) return reply.status(400).send({ error: "jobId is required" });
      const result = submitApproval(jobId, req.body);
      return sendResult(reply, result, 202);
    },
  );

  /** GET /api/jobs/:jobId/approvals — list approvals submitted for a job. */
  app.get<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/approvals",
    async (req, reply) => {
      const { jobId } = req.params;
      if (!jobId) return reply.status(400).send({ error: "jobId is required" });
      const approvals = listApprovals(jobId);
      const policy = getPolicyForJob(jobId);
      return reply.status(200).send({
        jobId,
        policyId: policy?.policyId ?? null,
        approvals,
      });
    },
  );
}

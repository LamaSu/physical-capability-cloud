import type { FastifyInstance } from "fastify";
import { gateJobRead, refuseJobRead } from "../readmodels/job-read-gate.js";
import { jobFundingOf } from "../readmodels/job-funding.js";

const schema = {
  tags: ["jobs"],
  summary: "Read a job's paid-scope funding status",
  description: "The recorded buyer's, kernel operator's or admin's funding view of a job. Reads stored records without a chain call, so funded_verified means the funding was verified at block verification.blockNumber, never that it is held now. Funding whose deployment.chainClass is not mainnet is never money. Responses are not cached.",
  params: {
    type: "object",
    required: ["jobId"],
    properties: { jobId: { type: "string" } },
  },
  response: {
    200: {
      type: "object",
      additionalProperties: true,
      properties: {
        jobId: { type: "string" },
        scopes: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    },
    401: { type: "object", additionalProperties: true, description: "Authentication required." },
    403: { type: "object", additionalProperties: true, description: "A proven wallet identity is required." },
    404: { type: "object", additionalProperties: true, description: "The job is unavailable to this caller." },
    503: { type: "object", additionalProperties: true, description: "The job or funding record could not be read." },
  },
};

export async function jobFundingRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/funding", { schema }, async (req, reply) => {
    const gate = gateJobRead(req, req.params.jobId);
    if (!gate.ok) return refuseJobRead(reply, gate, { error: "job_not_found" });
    const funding = jobFundingOf(gate.job.id, gate.job.kernelId, new Date().toISOString());
    if (funding.read === "failed") return refuseJobRead(reply, { ok: false, kind: "unavailable" });
    return { jobId: gate.job.id, scopes: funding.scopes };
  });
}

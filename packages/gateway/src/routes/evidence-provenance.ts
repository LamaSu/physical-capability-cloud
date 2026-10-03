/**
 * GET /api/jobs/:jobId/evidence/provenance: EvidenceProvenanceDTO (PX-7). Behind the job read
 * family's gate (#403): the admin, the job's kernel operator or its buyer. Anyone else gets the
 * same 404 as a missing job; an anonymous caller gets 401. cache-control: no-store.
 */
import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { gateJobRead, refuseJobRead } from "../readmodels/job-read-gate.js";
import {
  buildEvidenceProvenanceDTO,
  loadEvidenceProvenance,
  type EvidenceProvenanceRepos,
} from "../readmodels/evidence-provenance.js";

export async function evidenceProvenanceRoutes(app: FastifyInstance) {
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/evidence/provenance", async (req, reply) => {
    const asOf = new Date().toISOString();
    const gate = gateJobRead(req, req.params.jobId);
    if (!gate.ok) {
      return refuseJobRead(reply, gate, { error: "not_found", message: `job '${req.params.jobId}' not found` });
    }
    const read = loadEvidenceProvenance(gate.job.id, getStore().repos as unknown as EvidenceProvenanceRepos);
    if (!read.ok) req.log.warn({ jobId: gate.job.id }, "evidence provenance: evidence store read failed");
    reply.header("cache-control", "no-store");
    return buildEvidenceProvenanceDTO(gate.job.id, read, asOf);
  });
}

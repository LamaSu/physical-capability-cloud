import type { FastifyInstance } from "fastify";
import type { SampleSlot } from "@pcc/spec";
import { batchTracker } from "../services.js";

export async function batchRoutes(app: FastifyInstance) {
  // List batch manifests — from in-memory BatchTracker (live lifecycle state)
  app.get<{ Querystring: { kernelId?: string; status?: string } }>(
    "/api/batches",
    async (req) => {
      const batches = batchTracker.getAllBatches({
        kernelId: req.query.kernelId,
        status: req.query.status as any,
      });
      return { batches };
    },
  );

  // Batch detail with slots
  app.get<{ Params: { batchId: string } }>("/api/batches/:batchId", async (req) => {
    const batch = batchTracker.getBatch(req.params.batchId);
    if (!batch) return { error: "not_found" };
    return { batch, events: batchTracker.getEvents(req.params.batchId) };
  });

  // Batches containing a specific job's samples
  app.get<{ Params: { jobId: string } }>("/api/batches/by-job/:jobId", async (req) => {
    const batches = batchTracker.getBatchesForJob(req.params.jobId);
    return { batches };
  });

  // Add sample slot to assembling batch
  app.post<{ Params: { batchId: string }; Body: Omit<SampleSlot, "id" | "status"> }>(
    "/api/batches/:batchId/slots",
    async (req, reply) => {
      try {
        const slot = batchTracker.addSample(
          req.params.batchId,
          req.body as Omit<SampleSlot, "id" | "status">,
        );
        return { slot };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );
}

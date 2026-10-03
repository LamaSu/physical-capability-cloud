import type { FastifyInstance } from "fastify";
import { sensorPipeline } from "../services.js";
import { gateJobRead, jobRecordFilterOf, keepAsSent, refuseJobRead } from "../readmodels/job-read-gate.js";
import type { SensorAnomaly } from "@pcc/spec";

// Collected anomalies (pipeline emits these; we store for REST queries AND persist to DB)
const recentAnomalies: SensorAnomaly[] = [];
sensorPipeline.onAnomaly((a) => {
  recentAnomalies.push(a);
  if (recentAnomalies.length > 200) recentAnomalies.shift();
});

export async function sensorRoutes(app: FastifyInstance) {
  // List all registered sensor channels — merge pipeline + DB descriptors
  app.get("/api/sensors/channels", async () => {
    const pipelineChannels = sensorPipeline.getDescriptors();
    // If pipeline has channels, use those (live). Otherwise fall back to DB.
    if (pipelineChannels.length > 0) {
      return { channels: pipelineChannels, source: "pipeline" };
    }
    // No live channels — future: could read from DB sensor_channel_descriptors
    return { channels: [], source: "empty" };
  });

  // Channels for a specific kernel
  app.get<{ Params: { kernelId: string } }>("/api/sensors/channels/:kernelId", async (req) => {
    const pipelineChannels = sensorPipeline.getDescriptors();
    return { channels: pipelineChannels, kernelId: req.params.kernelId };
  });

  // Recent readings for a channel (live from pipeline ring buffer). A reading tagged with a
  // job is that job's record (F3 round 2): asking for one job's readings runs the job read
  // gate, and a job the caller may not read has none. Every reading also passes the record
  // filter, judged as it is sent (review r3 of #403, HIGH): it is kept only when the caller may
  // read every job it names, or, naming no job, every kernel it names; a reading naming
  // neither is an admin's.
  app.get<{ Params: { channel: string }; Querystring: { limit?: string; jobId?: string; since?: string } }>(
    "/api/sensors/readings/:channel",
    async (req, reply) => {
      let keep: (reading: unknown) => boolean;
      if (req.query.jobId) {
        const gate = gateJobRead(req, req.query.jobId);
        if (!gate.ok && gate.kind !== "not_found") return refuseJobRead(reply, gate);
        const filter = jobRecordFilterOf(req);
        if (!filter.ok) return refuseJobRead(reply, filter);
        keep = (reading) => gate.ok && filter.keep(reading);
      } else {
        const filter = jobRecordFilterOf(req);
        if (!filter.ok) return refuseJobRead(reply, filter);
        keep = filter.keep;
      }
      const limit = parseInt(req.query.limit ?? "50", 10);
      let readings = keepAsSent(sensorPipeline.getRecent(req.params.channel, Math.min(limit, 500)), keep) as Array<{
        jobId?: unknown;
        timestamp: string;
      }>;
      if (req.query.jobId) {
        readings = readings.filter((r) => r.jobId === req.query.jobId);
      }
      if (req.query.since) {
        const since = new Date(req.query.since).getTime();
        readings = readings.filter((r) => new Date(r.timestamp).getTime() >= since);
      }
      return { readings, channel: req.params.channel };
    },
  );

  // Aggregated data for a channel (live from pipeline)
  app.get<{ Params: { channel: string }; Querystring: { windowMs?: string; jobId?: string } }>(
    "/api/sensors/aggregates/:channel",
    async (req) => {
      const windowMs = parseInt(req.query.windowMs ?? "60000", 10);
      const aggregate = sensorPipeline.aggregate(req.params.channel, windowMs);
      if (!aggregate) return { aggregate: null };
      return { aggregate };
    },
  );

  // Recent anomalies — check in-memory first, fall back to DB for history
  app.get<{ Querystring: { kernelId?: string; severity?: string; source?: string } }>(
    "/api/sensors/anomalies",
    async (req) => {
      // In-memory anomalies from pipeline (DB history deferred to Wave 2)
      let anomalies = [...recentAnomalies];
      if (req.query.kernelId) {
        anomalies = anomalies.filter((a) => a.kernelId === req.query.kernelId);
      }
      if (req.query.severity) {
        anomalies = anomalies.filter((a) => a.severity === req.query.severity);
      }
      return { anomalies };
    },
  );
}

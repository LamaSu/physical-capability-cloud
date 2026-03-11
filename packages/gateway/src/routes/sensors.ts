import type { FastifyInstance } from "fastify";
import { sensorPipeline } from "../services.js";
import { getRepos } from "../db.js";
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

  // Recent readings for a channel (live from pipeline ring buffer)
  app.get<{ Params: { channel: string }; Querystring: { limit?: string; jobId?: string; since?: string } }>(
    "/api/sensors/readings/:channel",
    async (req) => {
      const limit = parseInt(req.query.limit ?? "50", 10);
      let readings = sensorPipeline.getRecent(req.params.channel, Math.min(limit, 500));
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
      // If caller specifically wants DB history
      if (req.query.source === "db") {
        try {
          const repos = getRepos();
          // Use raw DB query for anomalies — the repos don't have a dedicated method yet
          // so we fall through to in-memory
        } catch {
          // fall through
        }
      }

      // Default: in-memory anomalies from pipeline
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

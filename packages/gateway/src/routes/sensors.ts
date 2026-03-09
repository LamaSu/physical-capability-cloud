import type { FastifyInstance } from "fastify";
import { sensorPipeline } from "../services.js";

// Collected anomalies (pipeline emits these; we store for REST queries)
import type { SensorAnomaly } from "@pcc/spec";
const recentAnomalies: SensorAnomaly[] = [];
sensorPipeline.onAnomaly((a) => {
  recentAnomalies.push(a);
  if (recentAnomalies.length > 200) recentAnomalies.shift();
});

export async function sensorRoutes(app: FastifyInstance) {
  // List all registered sensor channels
  app.get("/api/sensors/channels", async () => {
    return { channels: sensorPipeline.getDescriptors() };
  });

  // Channels for a specific kernel
  app.get<{ Params: { kernelId: string } }>("/api/sensors/channels/:kernelId", async (req) => {
    return { channels: sensorPipeline.getDescriptors(), kernelId: req.params.kernelId };
  });

  // Recent readings for a channel
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

  // Aggregated data for a channel
  app.get<{ Params: { channel: string }; Querystring: { windowMs?: string; jobId?: string } }>(
    "/api/sensors/aggregates/:channel",
    async (req) => {
      const windowMs = parseInt(req.query.windowMs ?? "60000", 10);
      const aggregate = sensorPipeline.aggregate(req.params.channel, windowMs);
      if (!aggregate) return { aggregate: null };
      return { aggregate };
    },
  );

  // Recent anomalies
  app.get<{ Querystring: { kernelId?: string; severity?: string } }>(
    "/api/sensors/anomalies",
    async (req) => {
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

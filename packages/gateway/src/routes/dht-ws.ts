/**
 * DHT WebSocket Routes — makes the gateway a DHT bootstrap node.
 *
 * - GET /ws/dht                — WebSocket endpoint for DHT peer connections
 * - GET /api/dht/query         — REST fallback for querying capabilities
 * - GET /api/dht/peers         — List connected DHT peers + registry stats
 * - GET /api/dht/metrics       — Snapshot of DHT telemetry counters + recent events
 * - GET /api/dht/events/stream — SSE stream of live DHT metric events
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { DHTNode, dhtTelemetry } from "@pcc/dht";
import { pipelineTelemetry } from "../telemetry.js";

let gatewayDHTNode: DHTNode | null = null;

/** Get or create the gateway's DHT node (singleton) */
function getGatewayDHTNode(): DHTNode {
  if (!gatewayDHTNode) {
    gatewayDHTNode = new DHTNode({
      identity: {
        did: "did:pcc:gateway",
        publicKey: "",
        endpoints: [
          {
            transport: "websocket-relay",
            url: "wss://capability.network/ws/dht",
            priority: 1,
          },
        ],
      },
      bootstrapNodes: [], // Gateway IS the bootstrap; don't self-connect
      port: 0, // Don't listen on a separate port; use Fastify's WS
      defaultTTL: 5,
      queryTimeoutMs: 5000,
    });
  }
  return gatewayDHTNode;
}

export async function dhtWebSocketRoutes(app: FastifyInstance) {
  const dhtNode = getGatewayDHTNode();

  // Start the node (pruning timer, etc.)
  await dhtNode.start();

  // ── WebSocket endpoint ─────────────────────────────────────────────
  app.get("/ws/dht", { websocket: true }, (socket) => {
    dhtNode.handleConnection(socket);
  });

  // ── REST: query capabilities ───────────────────────────────────────
  app.get("/api/dht/query", async (req) => {
    const q = req.query as Record<string, string>;
    const filter = {
      type: q.type,
      materials: q.materials ? q.materials.split(",") : undefined,
      maxPrice: q.maxPrice ? parseFloat(q.maxPrice) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    };

    const results = await dhtNode.query(filter);
    pipelineTelemetry.emit("pipeline-" + Date.now(), "dht_query", "completed", { metadata: { type: filter.type, resultCount: results.length } });
    return { results, count: results.length };
  });

  // ── REST: peer info + stats ────────────────────────────────────────
  app.get("/api/dht/peers", async () => {
    return {
      peers: dhtNode.getPeers(),
      stats: dhtNode.getRegistry().stats(),
      totalAnnouncements: dhtNode.getRegistry().size,
    };
  });

  // ── REST: telemetry metrics snapshot ──────────────────────────────
  app.get("/api/dht/metrics", async () => {
    return {
      metrics: dhtTelemetry.getMetrics(),
      recentEvents: dhtTelemetry.getRecentEvents().slice(-50),
    };
  });

  // ── SSE: live DHT event stream ─────────────────────────────────────
  app.get("/api/dht/events/stream", async (req, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send the current metrics snapshot on connect
    const snapshot = JSON.stringify({
      type: "snapshot",
      metrics: dhtTelemetry.getMetrics(),
    });
    reply.raw.write(`event: snapshot\ndata: ${snapshot}\n\n`);

    // Forward live metric events to this SSE client
    const onMetric = (event: import("@pcc/dht").DHTMetricEvent) => {
      try {
        reply.raw.write(`event: metric\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected; cleanup handled by req.raw.on("close")
      }
    };
    dhtTelemetry.on("metric", onMetric as (...args: unknown[]) => void);

    // Heartbeat to keep the connection alive through proxies
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      dhtTelemetry.removeListener("metric", onMetric as (...args: unknown[]) => void);
    });

    // Keep the Fastify handler alive until the client disconnects
    await new Promise<void>(() => {});
  });

  // Clean up on shutdown
  app.addHook("onClose", async () => {
    await dhtNode.stop();
    gatewayDHTNode = null;
  });
}

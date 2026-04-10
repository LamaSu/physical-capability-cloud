/**
 * DHT WebSocket Routes — makes the gateway a DHT bootstrap node.
 *
 * - GET /ws/dht                — WebSocket endpoint for DHT peer connections
 * - GET /api/dht/query         — REST fallback for querying capabilities
 * - GET /api/dht/peers         — List connected DHT peers + registry stats
 * - GET /api/dht/metrics       — Snapshot of DHT telemetry counters + recent events
 * - GET /api/dht/events/stream — SSE stream of live DHT metric events
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { DHTNode, dhtTelemetry } from "@pcc/dht";
import { pipelineTelemetry } from "../telemetry.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";

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

  // ── WebSocket endpoint (auth required to prevent unauthorized DHT peers) ──
  app.get("/ws/dht", { websocket: true }, (socket: any, req: FastifyRequest) => {
    // Require API key in query string or Authorization header
    const { apiKey } = req.query as { apiKey?: string };
    const authHeader = req.headers.authorization;
    const hasAuth = authHeader?.startsWith("Bearer pcc_") || apiKey?.startsWith("pcc_") || !!(req as any).userId;

    if (!hasAuth) {
      socket.close(4001, "Authentication required for DHT peer connections");
      return;
    }

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

  // ── REST: announce capabilities ─────────────────────────────────────
  app.post("/api/dht/announce", async (req, reply) => {
    // Require authentication — prevents DHT registry poisoning with fake kernels
    const apiKeyId = (req as any).apiKeyId;
    const operatorId = (req as any).operatorId;
    const userId = (req as any).userId;
    if (!apiKeyId && !userId) {
      return reply.status(401).send({ error: "Authentication required for DHT announcements" });
    }

    const announcement = req.body as any;
    if (!announcement || !announcement.kernelId || !announcement.capabilities) {
      return reply.status(400).send({ error: "kernelId and capabilities required" });
    }
    // Store in the registry directly
    const registry = dhtNode.getRegistry();
    registry.store({
      kernelDid: announcement.kernelDid ?? `did:pcc:${announcement.kernelId}`,
      kernelId: announcement.kernelId,
      capabilities: announcement.capabilities,
      endpoints: announcement.endpoints ?? [],
      ttlSeconds: announcement.ttlSeconds ?? 300,
      timestamp: new Date().toISOString(),
      signature: announcement.signature ?? "",
    });
    // Broadcast to connected DHT peers
    dhtNode.announce({
      kernelDid: announcement.kernelDid ?? `did:pcc:${announcement.kernelId}`,
      kernelId: announcement.kernelId,
      capabilities: announcement.capabilities,
      endpoints: announcement.endpoints ?? [],
      ttlSeconds: announcement.ttlSeconds ?? 300,
      timestamp: new Date().toISOString(),
      signature: announcement.signature ?? "",
    });
    return { announced: true, kernelId: announcement.kernelId };
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

  // ── SSE: live DHT event stream (auth + connection limit) ────────────
  app.get("/api/dht/events/stream", async (req, reply: FastifyReply) => {
    // Require auth (this endpoint was missed in SEC-17/SEC-18)
    const apiKeyId = (req as any).apiKeyId;
    const userId = (req as any).userId;
    if (!apiKeyId && !userId) {
      return reply.status(401).send({ error: "Authentication required for DHT event stream" });
    }

    // SSE connection limit
    if (!canOpenSSE(req.ip)) {
      return reply.status(429).send({ error: "too_many_connections" });
    }
    trackSSEOpen(req.ip);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
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
      trackSSEClose(req.ip);
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

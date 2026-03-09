import type { FastifyInstance, FastifyReply } from "fastify";
import { streamHub, type StreamEvent } from "./stream-hub.js";

const clients = new Set<FastifyReply>();

export function broadcastNotification(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.raw.write(payload);
    } catch {
      clients.delete(client);
    }
  }

  // Also publish to StreamHub global topic
  const streamEvent: StreamEvent = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    type: event,
    timestamp: new Date().toISOString(),
    topic: { type: "global", id: "*" },
    payload: data,
  };
  streamHub.publish([{ type: "global", id: "*" }], streamEvent);
}

export async function notificationSSE(app: FastifyInstance) {
  app.get("/sse/notifications", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    reply.raw.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    clients.add(reply);

    req.raw.on("close", () => {
      clients.delete(reply);
    });

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
        clients.delete(reply);
      }
    }, 15_000);

    req.raw.on("close", () => clearInterval(heartbeat));

    // Don't close the connection
    await new Promise(() => {});
  });
}

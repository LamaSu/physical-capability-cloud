import type { FastifyInstance } from "fastify";

/**
 * POST /api/agent/chat — proxies to Claude API with streaming.
 * Expects ANTHROPIC_API_KEY env var on the gateway.
 */
export async function agentChatRoutes(app: FastifyInstance) {
  app.post("/api/agent/chat", async (req, reply) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return reply.status(500).send({ error: "ANTHROPIC_API_KEY not configured on gateway" });
    }

    const body = req.body as {
      system?: string;
      messages: unknown[];
      tools?: unknown[];
      max_tokens?: number;
      stream?: boolean;
    };

    const anthropicBody = {
      model: "claude-sonnet-4-20250514",
      system: body.system,
      messages: body.messages,
      tools: body.tools,
      max_tokens: body.max_tokens ?? 4096,
      stream: body.stream ?? true,
    };

    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(anthropicBody),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        app.log.error({ status: upstream.status, body: errText }, "Claude API error");
        return reply.status(upstream.status).send({ error: errText });
      }

      if (body.stream && upstream.body) {
        // Stream SSE events through to client
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          app.log.error(err, "Stream read error");
        } finally {
          reply.raw.end();
        }

        return;
      }

      // Non-streaming: return JSON directly
      const json = await upstream.json();
      return reply.send(json);
    } catch (err) {
      app.log.error(err, "Failed to proxy to Claude API");
      return reply.status(502).send({ error: "Failed to reach Claude API" });
    }
  });
}

import type { FastifyInstance } from "fastify";
import { isDemoRoutesOn, markDemo } from "../config/demo-routes.js";

const mockConversations = [
  {
    id: "conv-001",
    topic: "FDM capability discovery",
    participants: ["user-agent", "broker-agent", "kernel-nyc-agent"],
    messageCount: 6,
    status: "completed" as const,
    startedAt: "2026-03-03T14:32:00Z",
  },
  {
    id: "conv-002",
    topic: "CNC quote request",
    participants: ["user-agent", "broker-agent", "kernel-sf-agent"],
    messageCount: 4,
    status: "active" as const,
    startedAt: "2026-03-03T14:35:00Z",
  },
];

// ── Demo gate (board N34, the server side of PX-3) ────────────────────
//
// Both routes in this plugin answer from the two fixture conversations above: they read
// no agent bus and no store. Served as live data, that is plausible fiction. So outside
// demo mode the WHOLE plugin fails closed: the onRequest hook in agentRoutes answers 501
// not_available before any handler runs, and points at the route that does read the
// gateway's agent bus. A route added to this plugin later is refused by default. Both
// hooks are encapsulated: server.ts registers this plugin with app.register and no
// fastify-plugin wrapper, so the other /api/agents/* routes never see them.
//
// With PCC_DEMO_ROUTES=true the fixtures are served as before, and every response says
// so: the x-pcc-demo: true header, plus mock: true, demo: true on object bodies.

const DEMO_HEADER = "x-pcc-demo";

// Not "not recorded on this gateway": the agent bus does record conversations, at the
// live route below. This route just never read them.
const REFUSAL = {
  message:
    "Agent conversations are not recorded by this route, so nothing is returned rather than an example. " +
    "The gateway's live agent bus is read at GET /api/agents/live/conversations.",
  see: ["GET /api/agents/live/conversations"],
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function agentRoutes(app: FastifyInstance) {
  // Demo gate (see above). Refuses before any handler runs outside demo mode.
  app.addHook("onRequest", async (_req, reply) => {
    if (isDemoRoutesOn()) {
      reply.header(DEMO_HEADER, "true");
      return;
    }
    return reply.code(501).send({ error: "not_available", message: REFUSAL.message, see: REFUSAL.see });
  });
  // A demo response's object body says so too; the header above covers any other shape.
  app.addHook("preSerialization", async (_req, reply, payload: unknown) =>
    reply.getHeader(DEMO_HEADER) === "true" && isPlainObject(payload) ? markDemo("demo", payload) : payload,
  );

  app.get("/api/agents/conversations", async () => {
    return { conversations: mockConversations };
  });

  app.get<{ Params: { convId: string } }>("/api/agents/conversations/:convId", async (req) => {
    const conv = mockConversations.find((c) => c.id === req.params.convId);
    if (!conv) return { error: "not_found" };
    return { conversation: conv };
  });
}

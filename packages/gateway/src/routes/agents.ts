import type { FastifyInstance } from "fastify";

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

export async function agentRoutes(app: FastifyInstance) {
  app.get("/api/agents/conversations", async () => {
    return { conversations: mockConversations };
  });

  app.get<{ Params: { convId: string } }>("/api/agents/conversations/:convId", async (req) => {
    const conv = mockConversations.find((c) => c.id === req.params.convId);
    if (!conv) return { error: "not_found" };
    return { conversation: conv };
  });
}

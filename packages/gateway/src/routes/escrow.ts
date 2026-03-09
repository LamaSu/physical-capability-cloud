import type { FastifyInstance } from "fastify";

const mockEscrows = [
  { id: "esc-001", cwmId: "cwm-001", totalAmount: "77.00", currency: "USDC", status: "active", milestoneCount: 2 },
  { id: "esc-002", cwmId: "cwm-002", totalAmount: "245.00", currency: "USDC", status: "active", milestoneCount: 1 },
  { id: "esc-003", cwmId: "cwm-003", totalAmount: "18.50", currency: "USDC", status: "funded", milestoneCount: 1 },
];

export async function escrowRoutes(app: FastifyInstance) {
  app.get("/api/escrow", async () => {
    return { escrows: mockEscrows };
  });

  app.get<{ Params: { escrowId: string } }>("/api/escrow/:escrowId", async (req) => {
    const escrow = mockEscrows.find((e) => e.id === req.params.escrowId);
    if (!escrow) return { error: "not_found" };
    return { escrow };
  });
}

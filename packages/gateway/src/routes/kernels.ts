import type { FastifyInstance } from "fastify";

const mockKernels = [
  { id: "kernel-nyc", name: "NYC MakerSpace", status: "online", capabilities: ["fdm", "laser-cut"], reputation: 950 },
  { id: "kernel-sf", name: "SF Precision Workshop", status: "online", capabilities: ["cnc-3axis"], reputation: 870 },
  { id: "kernel-la", name: "LA Fab Lab", status: "offline", capabilities: ["sla"], reputation: 720 },
];

export async function kernelRoutes(app: FastifyInstance) {
  app.get("/api/kernels", async () => {
    return { kernels: mockKernels };
  });

  app.get<{ Params: { kernelId: string } }>("/api/kernels/:kernelId", async (req) => {
    const kernel = mockKernels.find((k) => k.id === req.params.kernelId);
    if (!kernel) return { error: "not_found" };
    return { kernel };
  });
}

import type { FastifyInstance } from "fastify";

// Mock job data (will be replaced with live agent data later)
const mockJobs = [
  { id: "job-001", stepId: "step-1", cwmId: "cwm-001", status: "executing", progress: 67, kernelId: "kernel-nyc", name: "FDM Print — Gear Housing" },
  { id: "job-002", stepId: "step-2", cwmId: "cwm-002", status: "executing", progress: 23, kernelId: "kernel-sf", name: "CNC Mill — Mounting Bracket" },
  { id: "job-003", stepId: "step-3", cwmId: "cwm-003", status: "queued", progress: 0, kernelId: "kernel-nyc", name: "Laser Cut — Control Panel" },
  { id: "job-004", stepId: "step-4", cwmId: "cwm-001", status: "completed", progress: 100, kernelId: "kernel-nyc", name: "FDM Print — Enclosure Base" },
];

export async function jobRoutes(app: FastifyInstance) {
  app.get("/api/jobs", async () => {
    return { jobs: mockJobs };
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (req) => {
    const job = mockJobs.find((j) => j.id === req.params.jobId);
    if (!job) return { error: "not_found" };
    return { job };
  });
}

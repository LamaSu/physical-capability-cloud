import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getRepos } from "../db.js";

export async function kernelRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>(
    "/api/kernels",
    async (req) => {
      try {
        const repos = getRepos();
        const kernels = req.query.status
          ? repos.kernels.findByStatus(req.query.status)
          : repos.kernels.findAll();

        // Enrich each kernel with its capabilities list (types)
        const enriched = kernels.map((k) => {
          const caps = repos.capabilities.findByKernel(k.id);
          return {
            ...k,
            capabilities: caps.map((c) => c.type),
          };
        });

        return { kernels: enriched };
      } catch {
        return { kernels: [] };
      }
    },
  );

  app.get<{ Params: { kernelId: string } }>("/api/kernels/:kernelId", async (req) => {
    try {
      const repos = getRepos();
      const kernel = repos.kernels.findById(req.params.kernelId);
      if (!kernel) return { error: "not_found" };

      // Attach full capability objects and devices
      const capabilities = repos.capabilities.findByKernel(kernel.id);
      const devices = repos.kernels.findDevicesByKernel(kernel.id);

      return { kernel: { ...kernel, capabilities, devices } };
    } catch {
      return { error: "db_unavailable" };
    }
  });

  app.get<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/devices",
    async (req) => {
      try {
        const repos = getRepos();
        const devices = repos.kernels.findDevicesByKernel(req.params.kernelId);
        return { devices };
      } catch {
        return { devices: [] };
      }
    },
  );

  app.get<{ Params: { kernelId: string } }>(
    "/api/kernels/:kernelId/jobs",
    async (req) => {
      try {
        const repos = getRepos();
        const jobs = repos.jobs.findByKernel(req.params.kernelId);
        return { jobs };
      } catch {
        return { jobs: [] };
      }
    },
  );

  app.post<{
    Body: { id?: string; name?: string; operatorAddress?: string; location?: string; physicalAddress?: string };
  }>("/api/kernels", async (req, reply) => {
    const repos = getRepos();
    const id = req.body.id || `kernel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const kernel = {
      id,
      name: req.body.name || "New Kernel",
      operatorAddress:
        req.body.operatorAddress || "0x0000000000000000000000000000000000000000",
      publicKey: `0x${crypto.randomBytes(32).toString("hex")}`,
      location: { lat: 0, lng: 0 } as { lat: number; lng: number },
      physicalAddress: req.body.physicalAddress || req.body.location || "",
      status: "online",
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      version: "0.1.0",
      reputation: 0,
      totalJobsCompleted: 0,
      maxAssuranceTier: 2,
    };
    const inserted = repos.kernels.insert(kernel);
    return reply.code(201).send({ kernel: inserted });
  });
}

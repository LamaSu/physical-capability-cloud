import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getRepos } from "../db.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";

export async function kernelRoutes(app: FastifyInstance) {
  // Kernels with lastHeartbeat older than this threshold are considered stale
  const STALE_HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes

  app.get<{ Querystring: { status?: string } }>(
    "/api/kernels",
    async (req) => {
      try {
        const repos = getRepos();
        const kernels = req.query.status
          ? repos.kernels.findByStatus(req.query.status)
          : repos.kernels.findAll();

        const now = Date.now();

        // Enrich each kernel with its capabilities list (types) and staleness flag
        const enriched = kernels.map((k) => {
          const caps = repos.capabilities.findByKernel(k.id);

          // Mark kernels as stale if their lastHeartbeat is older than 5 minutes
          let effectiveStatus = k.status;
          let isStale = false;
          if (k.lastHeartbeat && k.status === "online") {
            const heartbeatAge = now - new Date(k.lastHeartbeat).getTime();
            if (heartbeatAge > STALE_HEARTBEAT_MS) {
              effectiveStatus = "stale";
              isStale = true;
            }
          }

          return {
            ...k,
            status: effectiveStatus,
            isStale,
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
    trackServerEvent("kernel_registered", {
      kernelId: kernel.id,
      name: kernel.name,
      operatorAddress: kernel.operatorAddress,
    }, (req as any).operatorId ?? (req as any).apiKeyId);
    auditService.log({
      eventType: "kernel.created",
      actor: (req as any).operatorId ?? (req as any).apiKeyId ?? kernel.operatorAddress,
      resourceType: "kernel",
      resourceId: kernel.id,
      action: "create",
      metadata: { name: kernel.name, operatorAddress: kernel.operatorAddress },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return reply.code(201).send({ kernel: inserted });
  });

  // ── POST /api/kernels/:kernelId/heartbeat ─────────────────────────────────
  // Per-kernel heartbeat alias — pcc-node daemons call this path.
  // Delegates to the same logic as POST /api/operator/heartbeat.
  app.post<{
    Params: { kernelId: string };
    Body: { status?: string; capabilities?: Array<Record<string, unknown>>; timestamp?: number };
  }>("/api/kernels/:kernelId/heartbeat", async (req, reply) => {
    const { kernelId } = req.params;
    const { status = "online", capabilities } = req.body ?? {};
    const now = new Date().toISOString();
    const repos = getRepos();

    const kernel = repos.kernels.findById(kernelId);
    if (kernel) {
      try {
        repos.kernels.update(kernelId, {
          status: status === "offline" ? "offline" : "online",
          lastHeartbeat: now,
        });
      } catch { /* soft fail */ }
    }

    // Upsert capability announcements if provided
    if (capabilities && capabilities.length > 0) {
      for (const cap of capabilities) {
        const capType = (cap.type as string) ?? (cap.capability_type as string);
        if (!capType) continue;
        const capId = `cap-${kernelId}-${capType}`;
        try {
          const existing = repos.capabilities.findById(capId);
          if (!existing) {
            repos.capabilities.insert({
              id: capId,
              kernelId,
              type: capType,
              name: (cap.name as string) ?? `${capType} — ${kernelId}`,
              description: (cap.description as string) ?? `Auto-registered from heartbeat for kernel ${kernelId}`,
              materials: (cap.materials as string[]) ?? [],
              assuranceTiers: (cap.assuranceTiers as number[]) ?? [0, 1],
              pricing: (cap.pricing as any) ?? { currency: "USDC", baseCost: "0", minimum: "0" },
              availability: (cap.availability as any) ?? {},
              location: (cap.location as any) ?? { lat: 0, lng: 0 },
            } as any);
          }
        } catch { /* non-fatal */ }
      }
    }

    return {
      acknowledged: true,
      kernelId,
      status,
      capabilitiesReceived: capabilities?.length ?? 0,
      timestamp: now,
    };
  });

  // ── POST /api/kernels/:kernelId/capabilities ──────────────────────────────
  // Capability announcement from pcc-node daemons.
  app.post<{
    Params: { kernelId: string };
    Body: { capabilities?: Array<Record<string, unknown>>; devices?: string[]; signature?: string };
  }>("/api/kernels/:kernelId/capabilities", async (req) => {
    const { kernelId } = req.params;
    const { capabilities = [], devices = [] } = req.body ?? {};
    const now = new Date().toISOString();

    return {
      acknowledged: true,
      kernelId,
      capabilitiesReceived: capabilities.length,
      devicesReceived: devices.length,
      timestamp: now,
    };
  });
}

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getRepos } from "../db.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";

/**
 * Build a "next step" hint pointing operators at POST /api/capabilities.
 *
 * Discovery context: POST /api/kernels creates a kernel row but does NOT make
 * the operator discoverable. The catalog (GET /api/capabilities) filters on
 * capabilities, not kernels — a kernel with zero capabilities is correctly
 * invisible to user-agents browsing for skills. This hint tells the operator
 * that an additional POST is required.
 *
 * See docs/DEPLOY.md (Runtime Env Semantics) and
 * pcc-operator-onboarding-and-categories.md (Part A item 14).
 */
function buildCapabilityRegistrationHint(kernelId: string) {
  return {
    action: "POST /api/capabilities",
    explanation:
      `Your kernel is registered but is not yet discoverable. ` +
      `PCC catalog discovery filters on capabilities, not kernels. ` +
      `POST at least one capability tied to this kernel via ` +
      `{ kernelId: "${kernelId}", type: "<category.action>", name: "<human-name>", ... } ` +
      `to appear in GET /api/capabilities and become discoverable to user-agents.`,
    documentationUrl: "/docs/onboarding/capability-registration",
    exampleCurl:
      `curl -X POST <gateway>/api/capabilities ` +
      `-H 'Authorization: Bearer <key>' ` +
      `-H 'Content-Type: application/json' ` +
      `-d '{"kernelId":"${kernelId}","type":"pizza.order","name":"..."}'`,
  };
}

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

      // Discovery status: kernel-only rows are not catalog-visible.
      // A kernel with >= 1 capability is discoverable; otherwise the operator
      // still needs to POST /api/capabilities.
      const capabilityCount = capabilities.length;
      const discoveryStatus =
        capabilityCount >= 1
          ? "discoverable"
          : "kernel-registered-not-discoverable";

      const responseKernel: Record<string, unknown> = {
        ...kernel,
        capabilities,
        devices,
        capabilityCount,
        discoveryStatus,
      };

      // Surface the same hint on GET when the kernel is still not discoverable,
      // so an operator polling /api/kernels/:id after registration sees what to
      // do next — not just on the POST response that may have been lost.
      if (discoveryStatus === "kernel-registered-not-discoverable") {
        responseKernel.nextStep = buildCapabilityRegistrationHint(kernel.id);
      }

      return { kernel: responseKernel };
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

    // A freshly registered kernel has no capabilities yet, so it is not
    // discoverable via GET /api/capabilities. Tell the operator the next
    // step explicitly — this is purely additive; existing clients that
    // only consume `kernel.id` keep working.
    return reply.code(201).send({
      kernel: inserted,
      capabilities: [],
      discoveryStatus: "kernel-registered-not-discoverable",
      nextStep: buildCapabilityRegistrationHint(kernel.id),
    });
  });
}

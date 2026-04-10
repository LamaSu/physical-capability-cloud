/**
 * Kernel Facade — Shop Kernel registration, heartbeat, and health management.
 *
 * Maps to L1.1 (Kernel Registry) in the standards taxonomy.
 * Replaces inline DB access in routes/kernels.ts with standardized
 * populator-based DTOs.
 */

import crypto from "node:crypto";
import { type Result, ok, err, Errors } from "@pcc/spec";
import { BaseFacade } from "./base.facade.js";
import type {
  KernelDTO,
  KernelHealthSnapshot,
  DeviceStatusDTO,
  JobDTO,
  PopulationContext,
  AgentRole,
} from "./types.js";
import {
  populateKernelDTO,
  populateKernelHealthSnapshot,
  populateKernelList,
  type RawKernel,
} from "./populators/kernel.populator.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";

// ── Input interfaces ────────────────────────────────────────────────────────

export interface KernelFilters {
  status?: string;
}

export interface CreateKernelInput {
  id?: string;
  name?: string;
  operatorAddress?: string;
  /** physicalAddress string (legacy alias) */
  location?: string;
  physicalAddress?: string;
}

export interface HeartbeatInput {
  status?: string;
  capabilities?: Array<Record<string, unknown>>;
  timestamp?: number;
}

export interface HeartbeatResult {
  acknowledged: true;
  kernelId: string;
  status: string;
  capabilitiesReceived: number;
  timestamp: string;
}

export interface CapabilityAnnouncementInput {
  capabilities?: Array<Record<string, unknown>>;
  devices?: string[];
  signature?: string;
}

export interface AnnouncementResult {
  acknowledged: true;
  kernelId: string;
  capabilitiesReceived: number;
  devicesReceived: number;
  timestamp: string;
}

// ── Facade ─────────────────────────────────────────────────────────────────

export class KernelFacade extends BaseFacade {
  protected readonly allowedRoles: readonly AgentRole[] = [
    "discovery",
    "execution",
    "operator",
    "admin",
  ];

  constructor() {
    super("kernel");
  }

  /**
   * List all kernels with staleness detection and capability type enrichment.
   * Replaces: GET /api/kernels
   */
  async list(
    filters?: KernelFilters,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<KernelDTO[]>> {
    return this.execute("list", async () => {
      const context = this.defaultContext(ctx);

      const kernels = filters?.status
        ? this.repos.kernels.findByStatus(filters.status)
        : this.repos.kernels.findAll();

      // Batch-load all capabilities for these kernels (prevents N+1)
      const capabilityMap = this.buildCapabilityMap(kernels.map((k) => k.id));

      return populateKernelList(kernels as any as RawKernel[], capabilityMap, context);
    });
  }

  /**
   * Get a single kernel by ID with full health snapshot (devices + recent jobs).
   * Replaces: GET /api/kernels/:kernelId
   */
  async getById(
    kernelId: string,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<KernelHealthSnapshot>> {
    return this.execute("getById", async () => {
      const context = this.defaultContext({ includeReputation: true, ...ctx });

      const kernel = this.repos.kernels.findById(kernelId);
      if (!kernel) {
        throw new NotFoundError("kernel", kernelId);
      }

      const capabilities = this.repos.capabilities.findByKernel(kernelId);
      const devices = this.repos.kernels.findDevicesByKernel(kernelId);
      const recentJobs = this.repos.jobs.findByKernel(kernelId);

      if (context.includeReputation && kernel) {
        context.reputationCache = new Map([[kernel.id, kernel.reputation ?? 500]]);
      }

      return populateKernelHealthSnapshot(
        kernel as any as RawKernel,
        capabilities,
        devices as any[],
        recentJobs as any[],
        context,
      );
    });
  }

  /**
   * Get devices for a kernel.
   * Replaces: GET /api/kernels/:kernelId/devices
   */
  async getDevices(kernelId: string): Promise<Result<DeviceStatusDTO[]>> {
    return this.execute("getDevices", async () => {
      const raw = this.repos.kernels.findDevicesByKernel(kernelId);
      return raw.map((d: any) => ({
        id: d.id,
        type: d.type,
        model: d.model,
        status: (d.status ?? "offline") as DeviceStatusDTO["status"],
        healthStatus: (d.healthStatus ?? "unknown") as DeviceStatusDTO["healthStatus"],
        adapterType: d.adapterType ?? undefined,
        capabilities: d.capabilities ?? d.contributesToCapabilities ?? [],
      }));
    });
  }

  /**
   * Get jobs for a kernel.
   * Replaces: GET /api/kernels/:kernelId/jobs
   */
  async getJobs(kernelId: string): Promise<Result<JobDTO[]>> {
    return this.execute("getJobs", async () => {
      const jobs = this.repos.jobs.findByKernel(kernelId);
      const kernel = this.repos.kernels.findById(kernelId);

      return jobs.map((job: any) => ({
        id: job.id,
        capabilityId: job.capabilityId,
        kernelId: job.kernelId,
        status: job.status as JobDTO["status"],
        progress: job.progress ?? undefined,
        assuranceTier: 0 as JobDTO["assuranceTier"],
        createdAt: job.startedAt ?? new Date().toISOString(),
        updatedAt: job.completedAt ?? undefined,
        kernelName: kernel?.name,
        capabilityType: undefined,
        evidenceCount: 0,
        escrowStatus: undefined,
        estimatedCompletion: undefined,
      }));
    });
  }

  /**
   * Register (upsert) a kernel.
   * Returns created: true on first creation, created: false on update.
   * Replaces: POST /api/kernels
   */
  async register(
    body: CreateKernelInput,
    actorId?: string,
    ip?: string,
    userAgent?: string,
  ): Promise<Result<{ kernel: KernelDTO; created: boolean }>> {
    return this.execute("register", async () => {
      const repos = this.repos;
      const id = body.id || `kernel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const context = this.defaultContext();

      const existing = repos.kernels.findById(id);
      if (existing) {
        // Upsert: update heartbeat + optional fields
        const updates: Record<string, unknown> = {
          lastHeartbeat: new Date().toISOString(),
          status: "online",
        };
        if (body.name) updates.name = body.name;
        if (body.physicalAddress || body.location) {
          updates.physicalAddress = body.physicalAddress || body.location;
        }
        const updated = repos.kernels.update(id, updates);
        const kernel = updated ?? existing;
        const capabilities = repos.capabilities.findByKernel(id);
        return {
          kernel: populateKernelDTO(kernel as any as RawKernel, capabilities, context),
          created: false,
        };
      }

      const kernelData = {
        id,
        name: body.name || "New Kernel",
        operatorAddress: body.operatorAddress || "0x0000000000000000000000000000000000000000",
        publicKey: `0x${crypto.randomBytes(32).toString("hex")}`,
        location: { lat: 0, lng: 0 } as { lat: number; lng: number },
        physicalAddress: body.physicalAddress || body.location || "",
        status: "online",
        registeredAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
        version: "0.1.0",
        reputation: 0,
        totalJobsCompleted: 0,
        maxAssuranceTier: 2,
      };

      const inserted = repos.kernels.insert(kernelData);

      trackServerEvent(
        "kernel_registered",
        { kernelId: id, name: kernelData.name, operatorAddress: kernelData.operatorAddress },
        actorId,
      );
      auditService.log({
        eventType: "kernel.created",
        actor: actorId ?? kernelData.operatorAddress,
        resourceType: "kernel",
        resourceId: id,
        action: "create",
        metadata: { name: kernelData.name, operatorAddress: kernelData.operatorAddress },
        ip,
        userAgent,
      });

      const capabilities = repos.capabilities.findByKernel(id);
      return {
        kernel: populateKernelDTO(inserted as any as RawKernel, capabilities, context),
        created: true,
      };
    });
  }

  /**
   * Handle a heartbeat from a kernel daemon.
   * Updates status, upserts capabilities announced in the heartbeat.
   * Replaces: POST /api/kernels/:kernelId/heartbeat
   */
  async heartbeat(
    kernelId: string,
    body: HeartbeatInput,
  ): Promise<Result<HeartbeatResult>> {
    return this.execute("heartbeat", async () => {
      const { status = "online", capabilities } = body ?? {};
      const now = new Date().toISOString();
      const repos = this.repos;

      const kernel = repos.kernels.findById(kernelId);
      if (kernel) {
        try {
          repos.kernels.update(kernelId, {
            status: status === "offline" ? "offline" : "online",
            lastHeartbeat: now,
          });
        } catch {
          // soft fail
        }
      }

      // Upsert capability announcements
      let capabilitiesReceived = 0;
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
          } catch {
            // non-fatal
          }
          capabilitiesReceived++;
        }
      }

      return {
        acknowledged: true as const,
        kernelId,
        status,
        capabilitiesReceived,
        timestamp: now,
      };
    });
  }

  /**
   * Accept a capability announcement from a kernel daemon.
   * Currently a stub — returns acknowledged without upsert (unlike heartbeat).
   * Replaces: POST /api/kernels/:kernelId/capabilities
   *
   * TODO: Implement full announcement verification (Ed25519 signature check
   * on the announcement payload, then upsert capabilities and devices).
   */
  async announceCapabilities(
    kernelId: string,
    body: CapabilityAnnouncementInput,
  ): Promise<Result<AnnouncementResult>> {
    return this.execute("announceCapabilities", async () => {
      const now = new Date().toISOString();
      const capabilities = body.capabilities ?? [];
      const devices = body.devices ?? [];

      return {
        acknowledged: true as const,
        kernelId,
        capabilitiesReceived: capabilities.length,
        devicesReceived: devices.length,
        timestamp: now,
      };
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Build a map of kernelId → capabilities[] for batch population.
   * Calls findByKernel for each kernel ID to avoid N+1 within the list path.
   */
  private buildCapabilityMap(kernelIds: string[]): Map<string, any[]> {
    const map = new Map<string, any[]>();
    for (const id of kernelIds) {
      try {
        const caps = this.repos.capabilities.findByKernel(id);
        map.set(id, caps);
      } catch {
        map.set(id, []);
      }
    }
    return map;
  }
}

/** Internal error for flow control — caught by BaseFacade.execute() */
class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} '${id}' not found`);
    this.name = "NotFoundError";
  }
}

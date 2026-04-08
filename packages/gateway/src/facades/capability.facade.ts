/**
 * Capability Facade — discovery, SKU management, and technical specs.
 *
 * Maps to L1.2 (Capability Marketplace) in the standards taxonomy.
 * Replaces inline enrichment in routes/capabilities.ts with
 * standardized populator-based DTOs.
 */

import { type Result, ok, Errors } from "@pcc/spec";
import type { ShopKernel } from "@pcc/spec";
import { BaseFacade } from "./base.facade.js";
import type {
  CapabilityDTO,
  CapabilitySearchCriteria,
  PopulationContext,
  AgentRole,
  PaginationParams,
  PaginatedResult,
} from "./types.js";
import {
  populateCapabilityDTO,
  populateCapabilityList,
} from "./populators/capability.populator.js";

/** Input shape for creating a new capability instance */
export interface CreateCapabilityInput {
  id?: string;
  kernelId: string;
  type: string;
  name?: string;
  description?: string;
  location?: { lat: number; lng: number };
  pricing?: { currency: string; baseCost: string; perMinute?: string; minimum: string };
  materials?: string[];
  assuranceTiers?: number[];
}

export class CapabilityFacade extends BaseFacade {
  protected readonly allowedRoles: readonly AgentRole[] = [
    "discovery",
    "negotiation",
    "execution",
    "operator",
    "admin",
  ];

  constructor() {
    super("capability");
  }

  /**
   * List all capabilities with enrichment.
   * Replaces: GET /api/capabilities (inline enrichment)
   */
  async list(
    ctx?: Partial<PopulationContext>,
    pagination?: PaginationParams,
  ): Promise<Result<PaginatedResult<CapabilityDTO>>> {
    return this.execute("list", async () => {
      const context = this.defaultContext(ctx);
      const offset = pagination?.offset ?? 0;
      const limit = pagination?.limit ?? 50;

      const allCapabilities = this.repos.capabilities.findAll();
      const total = allCapabilities.length;
      const page = allCapabilities.slice(offset, offset + limit);

      // Batch-load kernels to avoid N+1
      const kernelIds = [...new Set(page.map((c) => c.kernelId))];
      const kernelMap = this.loadKernelMap(kernelIds);

      // Pre-load reputations if requested
      if (context.includeReputation) {
        context.reputationCache = await this.preloadReputations(kernelIds);
      }

      const items = populateCapabilityList(page as any, kernelMap as any, context);

      return {
        items,
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
      };
    });
  }

  /**
   * Get a single capability by ID with full enrichment.
   * Replaces: GET /api/capabilities/:id
   */
  async getById(
    capabilityId: string,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<CapabilityDTO>> {
    return this.execute("getById", async () => {
      const context = this.defaultContext({ includeReputation: true, ...ctx });

      const capability = this.repos.capabilities.findById(capabilityId);
      if (!capability) {
        throw new NotFoundError("capability", capabilityId);
      }

      const kernel = this.repos.kernels.findById(capability.kernelId);
      if (context.includeReputation && kernel) {
        context.reputationCache = new Map([[kernel.id, kernel.reputation ?? 500]]);
      }

      return populateCapabilityDTO(capability as any, kernel as any ?? undefined, context);
    });
  }

  /**
   * Search capabilities with filtering and reputation-weighted ranking.
   * Addresses L2.2.2 (Discovery & Routing) requirements.
   */
  async search(
    criteria: CapabilitySearchCriteria,
    ctx?: Partial<PopulationContext>,
    pagination?: PaginationParams,
  ): Promise<Result<PaginatedResult<CapabilityDTO>>> {
    return this.execute("search", async () => {
      const context = this.defaultContext({ includeReputation: true, ...ctx });
      const offset = pagination?.offset ?? 0;
      const limit = pagination?.limit ?? 20;

      // Start with full set, apply filters
      let candidates = this.repos.capabilities.findAll();

      if (criteria.type) {
        candidates = candidates.filter((c) => c.type === criteria.type);
      }
      if (criteria.materials?.length) {
        candidates = candidates.filter((c) =>
          criteria.materials!.some((m) => c.materials.includes(m)),
        );
      }
      if (criteria.assuranceTier !== undefined) {
        candidates = candidates.filter((c) =>
          c.assuranceTiers.includes(criteria.assuranceTier!),
        );
      }
      if (criteria.query) {
        const q = criteria.query.toLowerCase();
        candidates = candidates.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.type.toLowerCase().includes(q) ||
            c.materials.some((m) => m.toLowerCase().includes(q)),
        );
      }

      // Load kernels for enrichment
      const kernelIds = [...new Set(candidates.map((c) => c.kernelId))];
      const kernelMap = this.loadKernelMap(kernelIds);
      context.reputationCache = await this.preloadReputations(kernelIds);

      // Filter by reputation if requested
      if (criteria.minReputation !== undefined) {
        candidates = candidates.filter((c) => {
          const rep = context.reputationCache?.get(c.kernelId) ?? 500;
          return rep >= criteria.minReputation!;
        });
      }

      // Rank: available first, then by reputation desc, then queue depth asc
      candidates.sort((a, b) => {
        const aKernel = kernelMap.get(a.kernelId);
        const bKernel = kernelMap.get(b.kernelId);
        const aOnline = aKernel?.status === "online" ? 1 : 0;
        const bOnline = bKernel?.status === "online" ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;

        const aRep = context.reputationCache?.get(a.kernelId) ?? 500;
        const bRep = context.reputationCache?.get(b.kernelId) ?? 500;
        if (aRep !== bRep) return bRep - aRep;

        return a.queueDepth - b.queueDepth;
      });

      const total = candidates.length;
      const page = candidates.slice(offset, offset + limit);
      const items = populateCapabilityList(page as any, kernelMap as any, context);

      return { items, total, offset, limit, hasMore: offset + limit < total };
    });
  }

  /**
   * Get capabilities for a specific kernel.
   * Replaces: GET /api/capabilities/by-kernel/:kernelId
   */
  async listByKernel(
    kernelId: string,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<CapabilityDTO[]>> {
    return this.execute("listByKernel", async () => {
      const context = this.defaultContext(ctx);
      const capabilities = this.repos.capabilities.findByKernel(kernelId);
      const kernel = this.repos.kernels.findById(kernelId);
      const kernelMap = new Map<string, any>();
      if (kernel) kernelMap.set(kernelId, kernel);
      return populateCapabilityList(capabilities as any, kernelMap as any, context);
    });
  }

  /**
   * Get capabilities by type.
   * Replaces: GET /api/capabilities/by-type/:type
   */
  async listByType(
    type: string,
    ctx?: Partial<PopulationContext>,
  ): Promise<Result<CapabilityDTO[]>> {
    return this.execute("listByType", async () => {
      const context = this.defaultContext(ctx);
      const capabilities = this.repos.capabilities.findByType(type);
      const kernelIds = [...new Set(capabilities.map((c) => c.kernelId))];
      const kernelMap = this.loadKernelMap(kernelIds);
      return populateCapabilityList(capabilities as any, kernelMap as any, context);
    });
  }

  /**
   * Create a new capability instance (upsert-style: returns existing if already present).
   * Replaces: POST /api/capabilities (inline DB access)
   */
  async create(
    body: CreateCapabilityInput,
  ): Promise<Result<{ capability: CapabilityDTO; created: boolean }>> {
    return this.execute("create", async () => {
      const { kernelId, type } = body;
      if (!kernelId || !type) {
        throw Object.assign(new Error("kernelId and type required"), { name: "BadRequestError" });
      }
      const id = body.id || `cap-${kernelId}-${type}`;
      const context = this.defaultContext();

      const existing = this.repos.capabilities.findById(id);
      if (existing) {
        const kernel = this.repos.kernels.findById(existing.kernelId);
        const dto = populateCapabilityDTO(existing as any, kernel as any ?? undefined, context);
        return { capability: dto, created: false };
      }

      const cap = this.repos.capabilities.insert({
        id,
        kernelId,
        type,
        name: body.name || `${type} capability`,
        description: body.description || "",
        location: body.location || { lat: 0, lng: 0 },
        pricing: body.pricing || { currency: "USDC", baseCost: "0", minimum: "0" },
        materials: body.materials || [],
        assuranceTiers: body.assuranceTiers || [0, 1],
        availability: {},
      });
      const kernel = this.repos.kernels.findById(kernelId);
      const dto = populateCapabilityDTO(cap as any, kernel as any ?? undefined, context);
      return { capability: dto, created: true };
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private loadKernelMap(kernelIds: string[]): Map<string, any> {
    const map = new Map<string, any>();
    for (const id of kernelIds) {
      try {
        const kernel = this.repos.kernels.findById(id);
        if (kernel) map.set(id, kernel);
      } catch {
        // Non-fatal: capability exists but kernel may have been removed
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

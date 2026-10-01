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
import {
  buildAssuranceCeilingMap,
  ceilingFor,
  clampAssuranceTiers,
} from "../services/assurance-ceiling.js";

/**
 * Filter expired rows out of a capability list (feat/ed25519-keys-and-kernel-ttl).
 *
 * A row is "expired" iff `validUntil` is set AND parses to a timestamp
 * strictly before `now`. NULL or empty `validUntil` is treated as
 * "no opinion" (legacy pre-migration rows stay visible until they get a
 * heartbeat). Unparseable timestamps also keep the row — we don't want
 * a corrupted column to silently DoS the catalog.
 */
export function filterCapabilitiesByTtl<
  T extends { validUntil?: string | null; valid_until?: string | null },
>(rows: T[], now: Date = new Date()): T[] {
  const nowMs = now.getTime();
  return rows.filter((r) => {
    const raw = r.validUntil ?? r.valid_until;
    if (raw == null || raw === "") return true;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return true;
    return parsed > nowMs;
  });
}

/**
 * The id of a kernel's capability of `type`: `cap-<kernelId>-<type>`.
 *
 * WP-C R5 (capability-id squat). Capability ids are global, and the heartbeat
 * (KernelFacade.heartbeat) and setup/register-device derive this same id for a
 * kernel's own listing. When POST /api/capabilities accepted a caller-chosen
 * id, one operator could pre-take `cap-<victimKernel>-<type>` on its own
 * kernel; the victim's heartbeat then left the foreign row alone and never
 * created its own. So an id is always DERIVED, never chosen: a body id that
 * disagrees with the derived one is refused (400 capability_id_mismatch).
 */
export function capabilityIdFor(kernelId: string, type: string): string {
  return `cap-${kernelId}-${type}`;
}

/** Input shape for creating a new capability instance */
export interface CreateCapabilityInput {
  /**
   * Optional, and only accepted when it equals the derived id
   * `cap-<kernelId>-<type>` (see {@link capabilityIdFor}). Anything else is a
   * 400 `capability_id_mismatch`.
   */
  id?: string;
  kernelId: string;
  type: string;
  name?: string;
  description?: string;
  location?: { lat: number; lng: number };
  pricing?: { currency: string; baseCost: string; perMinute?: string; minimum: string };
  materials?: string[];
  assuranceTiers?: number[];
  /** Human-node SLA — only set for human-operator capabilities. */
  sla?: {
    acceptanceWindowSec: number;
    completionDeadlineSec: number;
    presence?: "available" | "busy" | "offline";
    mode?: "on-demand" | "scheduled" | "recurring";
    onTimeout?: string;
    onDeadlineMiss?: string;
  };
  /**
   * Availability — when this capability is reachable. Stored verbatim in the
   * `availability` JSON column. Callers (e.g. the A2A `pcc-author-integration`
   * skill) should pre-serialize via `serializeAvailability()` from
   * `routes/operator-channels.ts` so the column carries the canonical shape.
   * Omitted = stored as `{}` (treated as "always" by downstream agents).
   */
  availability?: Record<string, unknown>;
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
   *
   * Filters expired rows by default (feat/ed25519-keys-and-kernel-ttl).
   * Pass `includeExpired: true` via ctx for debug / sweeper queries.
   */
  async list(
    ctx?: Partial<PopulationContext> & { includeExpired?: boolean },
    pagination?: PaginationParams,
  ): Promise<Result<PaginatedResult<CapabilityDTO>>> {
    return this.execute("list", async () => {
      const context = this.defaultContext(ctx);
      const offset = pagination?.offset ?? 0;
      const limit = pagination?.limit ?? 50;

      // TODO(wave-4 / T1.9 follow-up): swap to
      // `this.repos.capabilities.findAll({ where: { tenantId: ctx.tenantId } })`
      // once the schema migration adds `tenant_id` columns. Capability LISTING
      // is intentionally cross-tenant (buyer marketplace surfacing) — confirm
      // that opt-out is still desired vs scope to ctx.tenantId at that time.
      const allCapabilitiesRaw = this.repos.capabilities.findAll();
      // Drop expired rows from the default response. Caller can opt back
      // in (debug / sweeper / migration scripts) via includeExpired:true.
      const allCapabilities = ctx?.includeExpired
        ? allCapabilitiesRaw
        : filterCapabilitiesByTtl(allCapabilitiesRaw as any);
      const total = allCapabilities.length;
      const page = allCapabilities.slice(offset, offset + limit);

      // Batch-load kernels to avoid N+1
      const kernelIds = [...new Set(page.map((c: any) => c.kernelId))];
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
   * Distinct capability `type` values currently registered in the catalog,
   * INCLUDING ad-hoc types the network priced/composed but has no compile-time
   * template for. Backs the public GET /api/capabilities/types union.
   *
   * Pushed to SQL as SELECT DISTINCT (see CapabilityRepository.distinctTypes) —
   * never materializes the full capability set. No enrichment, no TTL filter:
   * a type on offer at any row is a type the network advertises.
   */
  async distinctTypes(): Promise<Result<string[]>> {
    return this.execute("distinctTypes", async () => {
      return this.repos.capabilities.distinctTypes();
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
      if (criteria.query) {
        const q = criteria.query.toLowerCase();
        candidates = candidates.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.type.toLowerCase().includes(q) ||
            c.materials.some((m) => m.toLowerCase().includes(q)),
        );
      }

      // Load kernels (one batched query) for the tier filter and enrichment.
      const kernelMap = this.loadKernelMap([...new Set(candidates.map((c) => c.kernelId))]);

      // WP-C: filter on the SERVED tiers, meaning the claim clamped to the owning
      // kernel's served ceiling, effectiveMaxAssuranceTier = min(the kernel's
      // claimed tier, its authorized ceiling), the bound contracting applies. A
      // row claiming [0,1,2] on a kernel served at 1 does not match
      // assuranceTier=2. The ceiling is evaluated once per kernel.
      if (criteria.assuranceTier !== undefined) {
        const ceilings = buildAssuranceCeilingMap(kernelMap.values());
        candidates = candidates.filter((c) =>
          clampAssuranceTiers(c.assuranceTiers, ceilingFor(ceilings, c.kernelId)).includes(
            criteria.assuranceTier!,
          ),
        );
      }

      const kernelIds = [...new Set(candidates.map((c) => c.kernelId))];
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
   *
   * Honors the same TTL filter as `list()`.
   */
  async listByKernel(
    kernelId: string,
    ctx?: Partial<PopulationContext> & { includeExpired?: boolean },
  ): Promise<Result<CapabilityDTO[]>> {
    return this.execute("listByKernel", async () => {
      const context = this.defaultContext(ctx);
      const capabilitiesRaw = this.repos.capabilities.findByKernel(kernelId);
      const capabilities = ctx?.includeExpired
        ? capabilitiesRaw
        : filterCapabilitiesByTtl(capabilitiesRaw as any);
      const kernel = this.repos.kernels.findById(kernelId);
      const kernelMap = new Map<string, any>();
      if (kernel) kernelMap.set(kernelId, kernel);
      return populateCapabilityList(capabilities as any, kernelMap as any, context);
    });
  }

  /**
   * Get capabilities by type.
   * Replaces: GET /api/capabilities/by-type/:type
   *
   * Honors the same TTL filter as `list()`.
   */
  async listByType(
    type: string,
    ctx?: Partial<PopulationContext> & { includeExpired?: boolean },
  ): Promise<Result<CapabilityDTO[]>> {
    return this.execute("listByType", async () => {
      const context = this.defaultContext(ctx);
      const capabilitiesRaw = this.repos.capabilities.findByType(type);
      const capabilities = ctx?.includeExpired
        ? capabilitiesRaw
        : filterCapabilitiesByTtl(capabilitiesRaw as any);
      const kernelIds = [...new Set(capabilities.map((c: any) => c.kernelId))];
      const kernelMap = this.loadKernelMap(kernelIds);
      return populateCapabilityList(capabilities as any, kernelMap as any, context);
    });
  }

  /**
   * Create a new capability instance (upsert-style: returns existing if already present).
   * Replaces: POST /api/capabilities (inline DB access)
   *
   * WP-C R5: the id is derived, `cap-<kernelId>-<type>` ({@link capabilityIdFor}).
   *   - a body `id` that disagrees with it is refused: 400 `capability_id_mismatch`;
   *   - when the derived id already belongs to a DIFFERENT kernel's row, the
   *     create is refused with `capability_id_taken` (the route answers 409).
   *     It never hands back another kernel's row as if it were the caller's
   *     ("created: false"). Kernel ids and types may both contain "-", so two
   *     (kernelId, type) pairs can derive the same id; see the open issue in
   *     the WP-C report.
   * Ownership of `kernelId` is the CALLER's check (POST /api/capabilities runs
   * requireKernelOwner first).
   */
  async create(
    body: CreateCapabilityInput,
  ): Promise<Result<{ capability: CapabilityDTO; created: boolean }>> {
    return this.execute("create", async () => {
      const { kernelId, type } = body ?? ({} as Partial<CreateCapabilityInput>);
      if (typeof kernelId !== "string" || !kernelId || typeof type !== "string" || !type) {
        throw Object.assign(new Error("kernelId and type required"), { name: "BadRequestError" });
      }
      const id = capabilityIdFor(kernelId, type);
      const requestedId = body.id as unknown;
      if (requestedId !== undefined && requestedId !== null && requestedId !== "" && requestedId !== id) {
        throw Object.assign(
          new Error(
            `A capability id is derived as '${id}' (cap-<kernelId>-<type>); the body id disagrees`,
          ),
          { name: "BadRequestError", code: "capability_id_mismatch" },
        );
      }
      const context = this.defaultContext();

      const existing = this.repos.capabilities.findById(id);
      if (existing && existing.kernelId !== kernelId) {
        throw Object.assign(
          new Error(`Capability id '${id}' already belongs to another kernel`),
          { name: "BadRequestError", code: "capability_id_taken" },
        );
      }
      if (existing) {
        const kernel = this.repos.kernels.findById(existing.kernelId);
        const dto = populateCapabilityDTO(existing as any, kernel as any ?? undefined, context);
        return { capability: dto, created: false };
      }

      // feat/ed25519-keys-and-kernel-ttl — stamp the soft expiry at create
      // time so a never-heartbeated capability still appears in the catalog
      // for the first TTL window. The kernel facade's heartbeat handler
      // extends it from there.
      const nowIso = new Date().toISOString();
      const { computeValidUntilIso } = await import("./kernel.facade.js");
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
        availability: body.availability ?? {},
        sla: body.sla ?? null,
        lastHeartbeatAt: nowIso,
        validUntil: computeValidUntilIso(new Date()),
      } as any);
      const kernel = this.repos.kernels.findById(kernelId);
      const dto = populateCapabilityDTO(cap as any, kernel as any ?? undefined, context);
      return { capability: dto, created: true };
    });
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  /**
   * Batch-load kernels by id with ONE IN-list query (chunked inside the repo),
   * not one findById per kernel. A kernel missing from the map is treated
   * downstream as unknown: no enrichment, and an assurance ceiling of 0.
   */
  private loadKernelMap(kernelIds: string[]): Map<string, any> {
    const map = new Map<string, any>();
    const unique = [...new Set(kernelIds)];
    if (unique.length === 0) return map;
    try {
      for (const kernel of this.repos.kernels.findByIds(unique)) {
        if (kernel) map.set(kernel.id, kernel);
      }
    } catch {
      // Non-fatal: capabilities still render; their kernels count as unknown
      // (unavailable, assurance ceiling 0 — fail closed).
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

/**
 * Tool Catalog routes — registry of adapter/kernel packages independent of
 * live operator instances. Companion to /api/capabilities (operator-bound)
 * and /api/marketplace (live offerings).
 *
 * Demand signals at the capability-type level (POST /api/tool-catalog/bounty)
 * route to tool maintainers, enabling pull-side market discovery: buyers
 * signal want, tool maintainers see signal even with no live operator, then
 * recruit/stand-up an operator or build the missing tool.
 *
 * Storage: in-memory Map for the initial scaffold. Production wiring will
 * replace with the same persistence layer used by /api/marketplace + /api/bounty
 * (see settlement-facade.ts + bounty-service.ts) — kept minimal here so the
 * route surface is reviewable independently.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ToolCatalogQuerySchema,
  ToolCatalogRegistrationSchema,
  TypeLevelBountyRequestSchema,
  type ToolCatalogEntry,
  type ToolCatalogListing,
  type TypeLevelBountyResponse,
} from "@pcc/spec";

const catalog = new Map<string, ToolCatalogEntry>();

function nowISO(): string {
  return new Date().toISOString();
}

function findByPackageName(packageName: string): ToolCatalogEntry | undefined {
  for (const entry of catalog.values()) {
    if (entry.packageName === packageName) return entry;
  }
  return undefined;
}

function filterEntries(
  entries: ToolCatalogEntry[],
  q: {
    capabilityType?: string;
    status?: string;
    language?: string;
    search?: string;
  },
): ToolCatalogEntry[] {
  let out = entries;
  if (q.capabilityType) {
    out = out.filter((e) => e.capabilityTypes.includes(q.capabilityType!));
  }
  if (q.status) {
    out = out.filter((e) => e.status === q.status);
  }
  if (q.language) {
    out = out.filter((e) => e.language === q.language);
  }
  if (q.search) {
    const needle = q.search.toLowerCase();
    out = out.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.description.toLowerCase().includes(needle) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(needle)),
    );
  }
  return out;
}

export async function toolCatalogRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/tool-catalog/register — register a new tool or update an existing one
  app.post("/api/tool-catalog/register", async (req, reply) => {
    const parsed = ToolCatalogRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_failed",
        message: "Invalid registration payload",
        details: parsed.error.format(),
      });
    }

    const reg = parsed.data;

    // Idempotent upsert by packageName (preferred) or repoUrl
    const existing = reg.packageName
      ? findByPackageName(reg.packageName)
      : Array.from(catalog.values()).find((e) => e.repoUrl === reg.repoUrl);

    if (existing) {
      const updated: ToolCatalogEntry = {
        ...existing,
        ...reg,
        updatedAt: nowISO(),
      };
      catalog.set(updated.id, updated);
      return reply.code(200).send(updated);
    }

    const id = `tool_${randomUUID()}`;
    const entry: ToolCatalogEntry = {
      id,
      ...reg,
      registeredAt: nowISO(),
      updatedAt: nowISO(),
    };
    catalog.set(id, entry);
    return reply.code(201).send(entry);
  });

  // GET /api/tool-catalog — paginated list with filters
  app.get("/api/tool-catalog", async (req, reply) => {
    const parsed = ToolCatalogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_failed",
        message: "Invalid query parameters",
        details: parsed.error.format(),
      });
    }

    const q = parsed.data;
    const all = Array.from(catalog.values());
    const filtered = filterEntries(all, q);
    const slice = filtered.slice(q.offset, q.offset + q.limit);

    const response: ToolCatalogListing = {
      entries: slice,
      total: filtered.length,
      offset: q.offset,
      limit: q.limit,
    };
    return reply.send(response);
  });

  // GET /api/tool-catalog/by-type/:type — quick lookup of tools implementing a capability type
  app.get<{ Params: { type: string } }>(
    "/api/tool-catalog/by-type/:type",
    async (req, reply) => {
      const all = Array.from(catalog.values());
      const matches = all.filter((e) =>
        e.capabilityTypes.includes(req.params.type),
      );
      return reply.send({
        capabilityType: req.params.type,
        tools: matches,
        count: matches.length,
      });
    },
  );

  // GET /api/tool-catalog/:id — single entry detail (by id or packageName)
  app.get<{ Params: { id: string } }>(
    "/api/tool-catalog/:id",
    async (req, reply) => {
      const direct = catalog.get(req.params.id);
      if (direct) return reply.send(direct);
      const byPkg = findByPackageName(req.params.id);
      if (byPkg) return reply.send(byPkg);
      return reply.code(404).send({
        error: "not_found",
        message: `No tool registered with id or packageName: ${req.params.id}`,
      });
    },
  );

  // POST /api/tool-catalog/bounty — type-level demand signal
  //
  // Routes demand to all maintainers of tools implementing capabilityType.
  // For the scaffold, returns the match set; full bounty/escrow integration
  // happens in a follow-on PR via @pcc/payments.
  app.post("/api/tool-catalog/bounty", async (req, reply) => {
    const parsed = TypeLevelBountyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_failed",
        message: "Invalid bounty payload",
        details: parsed.error.format(),
      });
    }
    const b = parsed.data;

    const all = Array.from(catalog.values());
    let matches = all.filter((e) =>
      e.capabilityTypes.includes(b.capabilityType),
    );
    if (b.preferredMaintainers && b.preferredMaintainers.length > 0) {
      const allow = new Set(b.preferredMaintainers);
      matches = matches.filter((e) => allow.has(e.maintainerDid));
    }

    const expiresAt =
      b.deadline ??
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const bountyId = `bty_${randomUUID()}`;
    const response: TypeLevelBountyResponse = {
      bountyId,
      capabilityType: b.capabilityType,
      matchingToolsNotified: matches.length,
      matchingTools: matches.map((e) => ({
        id: e.id,
        name: e.name,
        maintainerDid: e.maintainerDid,
      })),
      expiresAt,
    };

    return reply.code(201).send(response);
  });
}

/** Test helper: clear the in-memory store between test cases */
export function _clearCatalogForTests(): void {
  catalog.clear();
}

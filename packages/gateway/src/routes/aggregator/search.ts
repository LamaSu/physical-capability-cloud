/**
 * GET /api/aggregator/tools/search — public registry query.
 *
 * Returns up to N IndexedTools matching the supplied filter (q, actionClass,
 * minTrustTier, skill, domain). Sorted ascending by id for stable pagination.
 *
 * Read-only and public per spec §4.1. No auth required to browse the index;
 * invocation is gated on /api/aggregator/invoke separately.
 *
 * Ranker mode: gated by PCC_RANKER_MODE (legacy | shadow | hybrid). In
 * `legacy` (default) the response is bit-for-bit identical to Phase 1 —
 * substring match + sort-by-id. In `hybrid` the response is HybridRanker
 * scored RankedHits. In `shadow`, both run in parallel and the legacy
 * results are served while the hybrid output goes to the shadow log.
 */

import type { FastifyInstance } from "fastify";
import {
  RegistryRankerBridge,
  createRegistryRanker,
} from "@pcc/aggregator";
import {
  appendShadowEvent,
  buildShadowEvent,
  presetNames,
  type RankerProfile,
} from "@pcc/tool-index";
import type {
  IndexedTool,
  IndexedToolActionClass,
  TrustTier,
} from "@pcc/spec";
import { isHybridActive, isHybridServed, readRankerMode } from "../../ranker-config.js";
import { getAggregatorRegistry } from "./index.js";

interface SearchQuery {
  q?: string;
  actionClass?: IndexedToolActionClass;
  minTrustTier?: TrustTier;
  skill?: string;
  domain?: string;
  limit?: string;
  offset?: string;
  profile?: string;
  explain?: string;
}

interface SearchResponse {
  tools: IndexedTool[];
  total: number;
  limit: number;
  offset: number;
  ranker?: string;
  profile?: string;
}

/** Singleton bridge — lazily constructed on first hybrid/shadow query. */
let _bridge: RegistryRankerBridge | undefined;

function getBridge(): RegistryRankerBridge {
  if (!_bridge) {
    _bridge = createRegistryRanker(getAggregatorRegistry());
  }
  return _bridge;
}

/** Reset for tests. */
export function _resetAggregatorBridgeForTests(): void {
  _bridge = undefined;
}

function pickProfile(raw: unknown): RankerProfile {
  if (typeof raw !== "string") return "agent-default";
  const valid = presetNames();
  return (valid as string[]).includes(raw) ? (raw as RankerProfile) : "agent-default";
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: SearchQuery; Reply: SearchResponse }>(
    "/api/aggregator/tools/search",
    async (req, reply) => {
      const registry = getAggregatorRegistry();
      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);
      const mode = readRankerMode();
      const profile = pickProfile(req.query.profile);
      const explain = req.query.explain === "true";

      // Legacy substring + sort-by-id query.
      const legacyTools = registry.query({
        q: req.query.q,
        actionClass: req.query.actionClass,
        minTrustTier: req.query.minTrustTier,
        skill: req.query.skill,
        domain: req.query.domain,
        limit,
        offset,
      });

      // Hybrid: only fire when the bridge is active.
      let hybridTools: IndexedTool[] = [];
      if (isHybridActive(mode)) {
        const bridge = getBridge();
        const rankerHits = await bridge.rank({
          q: req.query.q,
          filter: {
            minTrustTier: req.query.minTrustTier,
            actionClassAllowlist: req.query.actionClass
              ? [req.query.actionClass]
              : undefined,
            skill: req.query.skill,
            domain: req.query.domain,
          },
          profile,
          topK: Math.min(limit + offset, 100),
          explain,
        });
        hybridTools = rankerHits.slice(offset, offset + limit).map((h) => h.tool);
      }

      // Shadow telemetry.
      if (mode === "shadow") {
        const event = buildShadowEvent({
          query: req.query.q ?? "",
          legacyTop5: legacyTools.slice(0, 5).map((t) => ({
            id: t.id,
            score: 0, // legacy doesn't expose scores
          })),
          hybridTop5: hybridTools.slice(0, 5).map((t) => ({
            id: t.id,
            score: 0, // already-truncated to top-K above; rank order preserved
          })),
        });
        void appendShadowEvent(event, {
          onError: (e) =>
            app.log.warn(
              `[aggregator/search] shadow log append failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
        });
      }

      // Serve hybrid when explicitly enabled; legacy otherwise.
      if (isHybridServed(mode) && hybridTools.length > 0) {
        const total = registry.count();
        return reply.send({
          tools: hybridTools,
          total,
          limit,
          offset,
          ranker: "hybrid",
          profile,
        });
      }

      // Total = full registry count (Phase 1 simplification). Phase 2 will
      // compute a precise filtered total via DB aggregate.
      const total = registry.count();
      return reply.send({
        tools: legacyTools,
        total,
        limit,
        offset,
        ranker: mode === "shadow" ? "legacy-shadow" : "legacy",
      });
    },
  );
}

function parseLimit(s: string | undefined): number {
  const n = Number.parseInt(s ?? "50", 10);
  if (Number.isNaN(n)) return 50;
  return Math.min(200, Math.max(1, n));
}

function parseOffset(s: string | undefined): number {
  const n = Number.parseInt(s ?? "0", 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, n);
}

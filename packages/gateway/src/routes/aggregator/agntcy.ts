/**
 * /api/aggregator/{ingest,publish}/agntcy + /api/aggregator/agntcy/status.
 *
 * AGNTCY ADS + OASF bidirectional bridge admin routes. Reuses the same
 * `PCC_AGGREGATOR_ADMINS` allowlist gate that the MCP / OpenAPI ingest
 * routes use — keeps the operator surface uniform.
 *
 * - POST /api/aggregator/ingest/agntcy   — trigger an inbound OASF search,
 *   project records to IndexedTool drafts, run them through the existing
 *   6-stage pipeline.
 * - POST /api/aggregator/publish/agntcy  — project ONE IndexedTool to
 *   OASF, sign it via Sigstore, push to AGNTCY ADS, announce on the DHT.
 * - GET  /api/aggregator/agntcy/status   — bridge state + counters.
 *
 * The OIDC bearer comes from the `AGNTCY_OIDC_TOKEN` env var — never
 * accepted from the request body so credentials don't leak to any
 * caller surface.
 *
 * Spec: ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md §5, §10 (item 1)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AgntcyAdsPublisher,
  AgntcyAdsSourceAdapter,
  cosignShellSpawn,
  runPipeline,
  type PipelineRunResult,
} from "@pcc/aggregator";
import type { IndexedTool } from "@pcc/spec";
import { getAggregatorRegistry } from "./index.js";

// ── Bridge state (process-local; Phase 2 moves to DB) ─────────────────────

interface BridgeState {
  lastIngestAt?: string;
  lastPublishAt?: string;
  recordsIngested: number;
  recordsPublished: number;
  lastError?: string;
}

const state: BridgeState = {
  recordsIngested: 0,
  recordsPublished: 0,
};

/** Test seam — reset counters. */
export function resetAgntcyBridgeState(): void {
  state.lastIngestAt = undefined;
  state.lastPublishAt = undefined;
  state.recordsIngested = 0;
  state.recordsPublished = 0;
  state.lastError = undefined;
}

// ── Admin allowlist (mirror of routes/aggregator/ingest.ts) ───────────────

function isAggregatorAdmin(operatorId: string | undefined | null): boolean {
  if (!operatorId) return false;
  const raw = process.env.PCC_AGGREGATOR_ADMINS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(operatorId.toLowerCase());
}

function requireAggregatorAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const callerId =
    (req as unknown as { operatorId?: string }).operatorId ??
    (req as unknown as { userId?: string }).userId;
  if (!callerId) {
    void reply.status(401).send({ error: "authentication_required" });
    return null;
  }
  if (!isAggregatorAdmin(callerId)) {
    void reply.status(403).send({
      error: "forbidden",
      message:
        "AGNTCY bridge endpoints require operator on PCC_AGGREGATOR_ADMINS allowlist.",
    });
    return null;
  }
  return callerId;
}

// ── Body schemas ──────────────────────────────────────────────────────────

interface AgntcyIngestBody {
  /** Skill filter — required per AGNTCY G6. */
  skill?: string;
  domains?: string[];
  features?: string[];
  limit?: number;
  /** AGNTCY ADS endpoint URL (default: AGNTCY_API_URL env var). */
  url?: string;
  /** Optional headers (rarely needed for AGNTCY). */
  headers?: Record<string, string>;
  /** Whether to run the verify stage. Defaults to true. */
  runVerify?: boolean;
}

interface AgntcyPublishBody {
  /** The IndexedTool to publish. Required. */
  tool?: IndexedTool;
  /** Endpoint override (default: AGNTCY_API_URL env var). */
  endpoint?: string;
  /** Whether to also announce on the DHT. Default true. */
  announce?: boolean;
  /** Disable sigstore signing (for smoke tests). */
  enableSigstore?: boolean;
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function agntcyAdminRoutes(app: FastifyInstance): Promise<void> {
  /** Bridge status — counters + last error + env configuration. */
  app.get("/api/aggregator/agntcy/status", async () => {
    return {
      bridge: "agntcy-ads",
      endpoint:
        process.env.AGNTCY_API_URL ?? "https://prod.api.ads.outshift.io",
      oidcClientId: process.env.AGNTCY_OIDC_CLIENT_ID ?? "(not configured)",
      cosignBinary: process.env.COSIGN_BINARY_PATH ?? "cosign",
      sigstoreEnabled: process.env.AGNTCY_SIGSTORE_DISABLED !== "true",
      ...state,
    };
  });

  /**
   * Trigger an inbound search against AGNTCY ADS and run results through
   * the existing 6-stage pipeline (discover → fetch → transform →
   * enrich → verify → publish). Reuses runPipeline so AGNTCY records
   * land in the same IndexedToolRegistry as MCP / OpenAPI records.
   */
  app.post<{
    Body: AgntcyIngestBody;
    Reply: PipelineRunResult | { error: string; message?: string };
  }>(
    "/api/aggregator/ingest/agntcy",
    async (req, reply) => {
      const caller = requireAggregatorAdmin(req, reply);
      if (!caller) return reply;
      const body = req.body ?? {};
      if (!body.skill || typeof body.skill !== "string") {
        return reply.status(400).send({
          error: "skill_required",
          message: "AGNTCY spec G6 requires a skill filter.",
        });
      }
      const adapter = new AgntcyAdsSourceAdapter({
        skill: body.skill,
        domains: body.domains,
        features: body.features,
        limit: body.limit,
        authToken: process.env.AGNTCY_OIDC_TOKEN,
      });
      try {
        const url =
          body.url ??
          process.env.AGNTCY_API_URL ??
          "https://prod.api.ads.outshift.io";
        const result = await runPipeline(
          adapter,
          { url, headers: body.headers },
          getAggregatorRegistry(),
          { runVerify: body.runVerify ?? true },
        );
        state.lastIngestAt = new Date().toISOString();
        state.recordsIngested += result.published.length;
        if (result.errors.length > 0) state.lastError = result.errors[0];
        return reply.send(result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        state.lastError = msg;
        return reply
          .status(502)
          .send({ error: "agntcy_ingest_failed", message: msg });
      }
    },
  );

  /**
   * Publish ONE IndexedTool outbound to AGNTCY ADS. The OIDC bearer
   * comes from `AGNTCY_OIDC_TOKEN` env var, NOT request body.
   */
  app.post<{
    Body: AgntcyPublishBody;
  }>(
    "/api/aggregator/publish/agntcy",
    async (req, reply) => {
      const caller = requireAggregatorAdmin(req, reply);
      if (!caller) return reply;
      const token = process.env.AGNTCY_OIDC_TOKEN;
      if (!token) {
        return reply.status(503).send({
          error: "agntcy_not_configured",
          message:
            "AGNTCY_OIDC_TOKEN env var is required to publish. Acquire from prod.idp.ads.outshift.io.",
        });
      }
      const body = req.body ?? {};
      if (!body.tool?.id) {
        return reply.status(400).send({
          error: "bad_request",
          message: "Request body must include `tool: IndexedTool`.",
        });
      }
      const publisher = new AgntcyAdsPublisher({
        endpoint: body.endpoint ?? process.env.AGNTCY_API_URL,
        enableSigstore:
          body.enableSigstore !== undefined
            ? body.enableSigstore
            : process.env.AGNTCY_SIGSTORE_DISABLED !== "true",
      });
      try {
        const result = await publisher.publish(body.tool, {
          authToken: token,
          announce: body.announce,
          cosignSpawn: cosignShellSpawn,
        });
        if (result.externalCid) {
          state.lastPublishAt = new Date().toISOString();
          state.recordsPublished++;
        }
        if (result.errors.length > 0) state.lastError = result.errors[0];
        return reply.send(result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        state.lastError = msg;
        return reply
          .status(502)
          .send({ error: "agntcy_publish_failed", message: msg });
      }
    },
  );
}

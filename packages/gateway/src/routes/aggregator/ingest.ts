/**
 * /api/aggregator/ingest/* — admin-gated MCP + OpenAPI ingest routes.
 *
 * Each POST endpoint accepts a body with the upstream URL to crawl plus
 * optional headers / source-type override. Returns a PipelineRunResult
 * summarizing per-stage success counts + the published IndexedTool[].
 *
 * Auth gate: same pattern as admin-demand routes — operator must be on
 * PCC_AGGREGATOR_ADMINS allowlist (comma-separated, closed-by-default).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  McpSourceAdapter,
  OpenApiSourceAdapter,
  runPipeline,
  type PipelineRunResult,
} from "@pcc/aggregator";
import type { ToolSourceType } from "@pcc/spec";
import { getAggregatorRegistry } from "./index.js";

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
        "Aggregator ingest endpoints require operator on PCC_AGGREGATOR_ADMINS allowlist.",
    });
    return null;
  }
  return callerId;
}

interface IngestBody {
  /** URL of the MCP server / OpenAPI doc to ingest. Required. */
  url?: string;
  /** Optional headers (e.g. API keys) the upstream needs. */
  headers?: Record<string, string>;
  /** Override the recorded source.type (defaults to mcp-directory / openapi-doc). */
  sourceType?: ToolSourceType;
  /** Optional upstream vendor label to record. */
  upstreamVendor?: string;
  /** Whether to run the verify stage. Defaults to true for admin ingests. */
  runVerify?: boolean;
}

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: IngestBody; Reply: PipelineRunResult | { error: string } }>(
    "/api/aggregator/ingest/mcp",
    async (req, reply) => {
      const caller = requireAggregatorAdmin(req, reply);
      if (!caller) return reply;
      const body = req.body ?? {};
      if (!body.url || typeof body.url !== "string") {
        return reply.status(400).send({ error: "url_required" });
      }
      const adapter = new McpSourceAdapter({
        sourceType: body.sourceType,
        upstreamVendor: body.upstreamVendor,
      });
      const result = await runPipeline(
        adapter,
        { url: body.url, headers: body.headers },
        getAggregatorRegistry(),
        { runVerify: body.runVerify ?? true },
      );
      return reply.send(result);
    },
  );

  app.post<{ Body: IngestBody; Reply: PipelineRunResult | { error: string } }>(
    "/api/aggregator/ingest/openapi",
    async (req, reply) => {
      const caller = requireAggregatorAdmin(req, reply);
      if (!caller) return reply;
      const body = req.body ?? {};
      if (!body.url || typeof body.url !== "string") {
        return reply.status(400).send({ error: "url_required" });
      }
      const adapter = new OpenApiSourceAdapter({
        sourceType: body.sourceType,
        upstreamVendor: body.upstreamVendor,
      });
      const result = await runPipeline(
        adapter,
        { url: body.url, headers: body.headers },
        getAggregatorRegistry(),
        { runVerify: body.runVerify ?? true },
      );
      return reply.send(result);
    },
  );
}

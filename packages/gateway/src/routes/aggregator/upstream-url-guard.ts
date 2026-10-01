/**
 * Registration-time SSRF guard for IndexedTool.upstreamUrl.
 *
 * Ingest is admin-allowlisted (PCC_AGGREGATOR_ADMINS, closed by default), but
 * the admin does not author upstreamUrl: each adapter copies it out of
 * third-party catalog content, unvalidated (OpenAPI servers[0].url or an
 * absolute path key, AGNTCY locators[].urls[0], the MCP server URL). Whatever a
 * catalog says therefore became the destination of every later
 * POST /api/aggregator/invoke/:toolId, which any authenticated caller can make.
 *
 * invoke.ts re-checks and dials only through the outbound guard (that is the
 * control that matters: DNS answers can change after registration). This module
 * is the registration-time half: a tool whose upstream is not an allowed
 * destination is refused BEFORE it is written to the registry, with a reason
 * recorded under the pipeline's publish stage.
 *
 * The aggregator package is not touched: the pipeline already supports a
 * no-write run (`publishToRegistry: false`), so the gateway runs it that way,
 * vets what the pipeline would have published, and performs the upserts itself.
 */

import {
  runPipeline,
  type AdapterInput,
  type IndexedToolRegistry,
  type PipelineRunOptions,
  type PipelineRunResult,
  type SourceAdapter,
} from "@pcc/aggregator";
import type { IndexedTool } from "@pcc/spec";
import { checkOutboundUrl } from "../../services/outbound-url-guard.js";

/** `upstream_url_not_allowed:<rule>` when the URL is not an acceptable destination, else null. */
export function upstreamUrlRefusal(upstreamUrl: unknown): string | null {
  const check = checkOutboundUrl(upstreamUrl);
  return check.ok ? null : `upstream_url_not_allowed:${check.reason}`;
}

/**
 * runPipeline(), except a tool whose upstreamUrl fails the outbound URL check is
 * never written to the registry. Refused tools are reported per tool id under the
 * "publish" stage's errors and are absent from `published`.
 */
export async function runPipelineVetted(
  adapter: SourceAdapter,
  input: AdapterInput,
  registry: IndexedToolRegistry,
  options: PipelineRunOptions = {},
): Promise<PipelineRunResult> {
  // A dry run writes nothing, so there is nothing to vet.
  if (options.publishToRegistry === false) return runPipeline(adapter, input, registry, options);

  // The pipeline decides what would be published; the gateway decides what is written.
  const result = await runPipeline(adapter, input, registry, { ...options, publishToRegistry: false });

  const written: IndexedTool[] = [];
  const refused: Record<string, string> = {};
  for (const tool of result.published) {
    const refusal = upstreamUrlRefusal(tool.upstreamUrl);
    if (refusal) {
      refused[tool.id] = refusal;
      continue;
    }
    try {
      registry.upsert(tool);
      written.push(tool);
    } catch (err) {
      refused[tool.id] = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    ...result,
    published: written,
    stages: result.stages.map((s) =>
      s.stage === "publish" ? { ...s, succeeded: written.length, errors: { ...s.errors, ...refused } } : s,
    ),
  };
}

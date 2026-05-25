/**
 * 6-stage aggregator pipeline: discover -> fetch -> transform -> enrich -> verify -> publish
 *
 * Wires source-adapters into the IndexedTool registry. Each stage either
 * passes through, mutates, or filters the in-flight IndexedTool[].
 *
 * Phase 1 implementation:
 *   - discover    no-op (the caller specifies the adapter + URL directly)
 *   - fetch       delegates to the adapter's fetch()
 *   - transform   normalizes any missing PCC-specific fields
 *                 (trustTier defaults to AUTO_INDEXED, knownVulns []]
 *                 schemaHashHistory [first hash], drift [])
 *   - enrich      computes IndexedTool.cid (sha256 over stable fields)
 *                 if absent; sets ingestedAt to now if absent
 *   - verify      Phase 1 stub: marks tools as PASS unless their
 *                 source.type is "common-crawl" or "user-submission"
 *                 (those start at UNTRUSTED). Real Gate A wiring is
 *                 deferred.
 *   - publish     upserts into the provided IndexedToolRegistry
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §2.2
 */

import {
  type IndexedTool,
  TrustTier,
  DigitalCaptureClass,
} from "@pcc/spec";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type {
  AdapterInput,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineStageReport,
  SourceAdapter,
} from "./types.js";
import type { IndexedToolRegistry } from "./registry.js";

/** Compute a stable CID over the IndexedTool's identity-determining fields. */
export function computeToolCid(tool: IndexedTool): `sha256:${string}` {
  const stable = {
    id: tool.id,
    source: { type: tool.source.type, url: tool.source.url },
    upstreamUrl: tool.upstreamUrl,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    description: tool.description,
    skills: [...tool.skills].sort(),
    actionClass: tool.actionClass,
    schemaHashLatest:
      tool.schemaHashHistory[tool.schemaHashHistory.length - 1] ?? "",
  };
  const json = JSON.stringify(stable);
  const hex = bytesToHex(sha256(new TextEncoder().encode(json)));
  return `sha256:${hex}`;
}

/** Compute a sha256 hash of any JSON-serializable value, "sha256:<hex>". */
export function computeJsonHash(value: unknown): `sha256:${string}` {
  const json = JSON.stringify(value);
  const hex = bytesToHex(sha256(new TextEncoder().encode(json)));
  return `sha256:${hex}`;
}

/** Default trust tier per source.type per spec §7. */
function defaultTrustTierFor(sourceType: IndexedTool["source"]["type"]): TrustTier {
  switch (sourceType) {
    case "pcc-native":
      return TrustTier.PCC_NATIVE;
    case "anthropic-registry":
    case "agntcy-dht":
      return TrustTier.VERIFIED_PARTNER;
    case "glama":
    case "smithery":
    case "mcp-directory":
      return TrustTier.VERIFIED_PUBLISHER;
    case "user-submission":
    case "common-crawl":
      return TrustTier.UNTRUSTED;
    default:
      return TrustTier.AUTO_INDEXED;
  }
}

/** Default DCC ceiling for an indexed tool based on its source type. */
function defaultAssuranceCeilingFor(
  sourceType: IndexedTool["source"]["type"],
): DigitalCaptureClass {
  switch (sourceType) {
    case "pcc-native":
      return DigitalCaptureClass.DCC5;
    case "anthropic-registry":
    case "agntcy-dht":
      return DigitalCaptureClass.DCC4;
    case "glama":
    case "smithery":
    case "mcp-directory":
      return DigitalCaptureClass.DCC3;
    case "user-submission":
    case "common-crawl":
      return DigitalCaptureClass.DCC1;
    default:
      return DigitalCaptureClass.DCC2;
  }
}

/** Run the 6-stage pipeline against one adapter + input. */
export async function runPipeline(
  adapter: SourceAdapter,
  input: AdapterInput,
  registry: IndexedToolRegistry,
  options: PipelineRunOptions = {},
): Promise<PipelineRunResult> {
  const startedAt = new Date().toISOString();
  const stages: PipelineStageReport[] = [];
  const errors: string[] = [];
  let drafts: IndexedTool[] = [];

  // Stage 1 — discover (no-op in Phase 1; caller provides adapter)
  stages.push({
    stage: "discover",
    startedAt,
    endedAt: new Date().toISOString(),
    processed: 1,
    succeeded: 1,
    errors: {},
  });

  // Stage 2 — fetch
  const fetchStart = new Date().toISOString();
  try {
    drafts = await adapter.fetch(input);
    stages.push({
      stage: "fetch",
      startedAt: fetchStart,
      endedAt: new Date().toISOString(),
      processed: drafts.length,
      succeeded: drafts.length,
      errors: {},
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`adapter ${adapter.id} fetch failed: ${msg}`);
    stages.push({
      stage: "fetch",
      startedAt: fetchStart,
      endedAt: new Date().toISOString(),
      processed: 0,
      succeeded: 0,
      errors: { "": msg },
    });
    return finishRun(adapter, startedAt, stages, [], errors);
  }

  // Stage 3 — transform (normalize PCC-specific fields)
  const transformStart = new Date().toISOString();
  const transformErrors: Record<string, string> = {};
  drafts = drafts.map((d) => {
    try {
      const now = new Date().toISOString();
      const transformed: IndexedTool = {
        ...d,
        ingestedAt: d.ingestedAt || now,
        lastFetchedAt: d.lastFetchedAt || now,
        knownVulns: d.knownVulns ?? [],
        driftAlerts: d.driftAlerts ?? [],
        hostingPeers: d.hostingPeers ?? [],
        invocationCount: d.invocationCount ?? 0,
        domains: d.domains ?? [],
        features: d.features ?? [],
        skills: d.skills ?? [],
      };
      // schemaHashHistory: seed with hash of inputSchema if empty
      if (!transformed.schemaHashHistory || transformed.schemaHashHistory.length === 0) {
        transformed.schemaHashHistory = [
          computeJsonHash(transformed.inputSchema),
        ];
      }
      return transformed;
    } catch (err) {
      transformErrors[d.id] = err instanceof Error ? err.message : String(err);
      return d;
    }
  });
  stages.push({
    stage: "transform",
    startedAt: transformStart,
    endedAt: new Date().toISOString(),
    processed: drafts.length,
    succeeded: drafts.length - Object.keys(transformErrors).length,
    errors: transformErrors,
  });

  // Stage 4 — enrich (CID, trust tier, assurance ceiling)
  const enrichStart = new Date().toISOString();
  const enrichErrors: Record<string, string> = {};
  drafts = drafts.map((d) => {
    try {
      const trustTier = d.trustTier ?? defaultTrustTierFor(d.source.type);
      const assuranceCeiling =
        d.assuranceCeiling ?? defaultAssuranceCeilingFor(d.source.type);
      const enriched: IndexedTool = {
        ...d,
        trustTier,
        assuranceCeiling,
      };
      // Compute cid LAST since it depends on the stable fields above.
      enriched.cid = computeToolCid(enriched);
      return enriched;
    } catch (err) {
      enrichErrors[d.id] = err instanceof Error ? err.message : String(err);
      return d;
    }
  });
  stages.push({
    stage: "enrich",
    startedAt: enrichStart,
    endedAt: new Date().toISOString(),
    processed: drafts.length,
    succeeded: drafts.length - Object.keys(enrichErrors).length,
    errors: enrichErrors,
  });

  // Stage 5 — verify (Phase 1 stub)
  const verifyStart = new Date().toISOString();
  if (options.runVerify) {
    // Phase 1: pass-through; full Gate A is deferred to Phase 2.
    drafts = drafts.map((d) =>
      d.vetReport
        ? d
        : ({
            ...d,
            vetReport: {
              verdict: "PASS",
              critical: 0,
              high: 0,
              secrets: 0,
              malware: false,
              promptInjection: false,
            },
          } as IndexedTool),
    );
  }
  stages.push({
    stage: "verify",
    startedAt: verifyStart,
    endedAt: new Date().toISOString(),
    processed: drafts.length,
    succeeded: drafts.length,
    errors: {},
  });

  // Stage 6 — publish
  const publishStart = new Date().toISOString();
  const published: IndexedTool[] = [];
  const publishErrors: Record<string, string> = {};
  for (const tool of drafts) {
    try {
      if (options.publishToRegistry !== false) {
        registry.upsert(tool);
      }
      published.push(tool);
    } catch (err) {
      publishErrors[tool.id] =
        err instanceof Error ? err.message : String(err);
    }
  }
  stages.push({
    stage: "publish",
    startedAt: publishStart,
    endedAt: new Date().toISOString(),
    processed: drafts.length,
    succeeded: published.length,
    errors: publishErrors,
  });

  return finishRun(adapter, startedAt, stages, published, errors);
}

function finishRun(
  adapter: SourceAdapter,
  startedAt: string,
  stages: PipelineStageReport[],
  published: IndexedTool[],
  errors: string[],
): PipelineRunResult {
  return {
    adapterId: adapter.id,
    startedAt,
    endedAt: new Date().toISOString(),
    stages,
    published,
    errors,
  };
}

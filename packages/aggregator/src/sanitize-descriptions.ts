/**
 * Sanitize external tool descriptions.
 *
 * External MCP servers and OpenAPI specs can ship tool descriptions that
 * are themselves prompt-injection payloads ("ignore previous instructions",
 * "you are now DAN", etc). The aggregator stores those verbatim (with a
 * 280-char cap) and downstream LLM agents will read them. The cap does
 * NOT prevent injection — payloads fit well under 280 chars.
 *
 * Defense: run PCC's existing PatternScanner from `@pcc/a2a` against the
 * description of every externally-sourced IndexedTool. On a BLOCK or
 * REVIEW verdict, mark the tool as `trustTier: "QUARANTINED"` and emit a
 * `vetReport.verdict: "FAIL"` with `promptInjection: true`. Quarantined
 * tools remain INDEXED for visibility (operators can see what's out there)
 * but the invoke proxy refuses to call them.
 *
 * Rationale for quarantine over redact:
 *   - Quarantine preserves the original description for operator review and
 *     forensics — an attacker's payload IS evidence.
 *   - Redacting silently leaves the tool callable, just with a different
 *     blurb; an attacker can re-submit with a clean description later.
 *   - Quarantine produces a cleaner downstream signal (`trustTier === QUARANTINED`)
 *     that downstream consumers already check before invocation.
 *
 * Internal-source tools (`pcc-native`) bypass the scan — their descriptions
 * are owned by us and don't need to be treated as adversarial input.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §10 (copyright +
 *      content safety) and packages/a2a/src/content-scanner.ts (PatternScanner).
 */

import type { IndexedTool, ToolSourceType } from "@pcc/spec";
import { TrustTier } from "@pcc/spec";
import { PatternScanner, type ContentScanner } from "@pcc/a2a";

/**
 * Source types that the sanitizer treats as EXTERNAL (adversarial input).
 * Anything not in this set — currently just `pcc-native` — bypasses the
 * scan.
 */
const EXTERNAL_SOURCE_TYPES: ReadonlySet<ToolSourceType> = new Set<ToolSourceType>([
  "anthropic-registry",
  "glama",
  "mcp-so",
  "smithery",
  "pulsemcp",
  "mcp-directory",
  "apis-guru",
  "common-crawl",
  "agntcy-dht",
  "nanda-index",
  "well-known",
  "user-submission",
  "openapi-doc",
]);

export function isExternalSourceType(t: ToolSourceType): boolean {
  return EXTERNAL_SOURCE_TYPES.has(t);
}

/** Singleton default scanner — created lazily on first call. */
let defaultScanner: ContentScanner | null = null;
function getDefaultScanner(): ContentScanner {
  if (!defaultScanner) defaultScanner = new PatternScanner();
  return defaultScanner;
}

/**
 * Scan one tool's description and, if the scanner reports BLOCK or REVIEW,
 * return a clone with `trustTier: QUARANTINED` + `vetReport.verdict: "FAIL"`
 * + `vetReport.promptInjection: true`.
 *
 * On a SAFE description (or for internal-source tools) returns the input
 * unchanged. Never throws — scanner errors fall through with the input
 * preserved (we'd rather index a possibly-bad tool than crash the pipeline).
 */
export async function sanitizeToolDescription(
  tool: IndexedTool,
  scanner: ContentScanner = getDefaultScanner(),
): Promise<IndexedTool> {
  if (!isExternalSourceType(tool.source.type)) return tool;
  if (!tool.description) return tool;

  let result;
  try {
    result = await scanner.scan(tool.description, {
      sourceAgentId: tool.upstreamVendor ?? tool.source.url,
      intentType: "indexed-tool-description",
    });
  } catch {
    // Scanner failure is not a reason to silently downgrade trust — but
    // it's also not a reason to crash the pipeline. Pass-through.
    return tool;
  }

  if (result.decision === "PASS") return tool;

  // BLOCK or REVIEW → quarantine the tool.
  const triggered = result.triggeredLayers.join(",") || "unknown";
  const baseReport = tool.vetReport ?? {
    verdict: "UNVETTED",
    critical: 0,
    high: 0,
    secrets: 0,
    malware: false,
    promptInjection: false,
  };
  return {
    ...tool,
    trustTier: TrustTier.QUARANTINED,
    vetReport: {
      ...baseReport,
      verdict: "FAIL",
      promptInjection: true,
    },
    knownVulns: tool.knownVulns?.length
      ? [...new Set([...tool.knownVulns, `prompt-injection:${triggered}`])]
      : [`prompt-injection:${triggered}`],
  } as IndexedTool;
}

/**
 * Batch variant — applies {@link sanitizeToolDescription} to every tool
 * in the input list. Preserves order; quarantine status is per-tool.
 */
export async function sanitizeToolDescriptions(
  tools: IndexedTool[],
  scanner?: ContentScanner,
): Promise<IndexedTool[]> {
  const s = scanner ?? getDefaultScanner();
  return Promise.all(tools.map((t) => sanitizeToolDescription(t, s)));
}

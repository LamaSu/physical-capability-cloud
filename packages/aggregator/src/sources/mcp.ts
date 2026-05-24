/**
 * MCP source-adapter — ingests tools from an MCP server's tools/list endpoint.
 *
 * Phase 1 supports HTTP/SSE-style MCP servers (POST JSON-RPC) — the stdio
 * spawn path requires harness.exe and is deferred. The adapter:
 *
 *   1. Sends a JSON-RPC "tools/list" request to the server.
 *   2. Parses each Tool entry (per MCP spec):
 *      { name, description, inputSchema }
 *   3. Converts each to a draft IndexedTool with sourceType="mcp-directory"
 *      (the upstream is generally listed in a directory; the actual
 *      directory of origin is set by the caller via source.url).
 *   4. Returns the array. The pipeline's transform/enrich stages fill in
 *      the remaining fields (cid, trustTier, assuranceCeiling, ...).
 *
 * The adapter is intentionally tolerant of partial responses — if a single
 * tool entry is malformed, it's logged in `errors` and skipped, not
 * thrown.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §2.2 Stage 2
 */

import type { IndexedTool, ToolSourceType } from "@pcc/spec";
import type { SourceAdapter, AdapterInput } from "../types.js";

/** Shape of one MCP Tool per the MCP spec. */
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** JSON-RPC response envelope for tools/list. */
interface McpToolsListResponse {
  jsonrpc?: "2.0";
  id?: number | string;
  result?: { tools?: McpTool[] };
  error?: { code: number; message: string; data?: unknown };
}

/** Options unique to the MCP adapter. */
export interface McpAdapterOptions {
  /** Source type to record on the IndexedTool. Defaults to "mcp-directory". */
  sourceType?: ToolSourceType;
  /** Optional upstream vendor label to record. */
  upstreamVendor?: string;
}

export class McpSourceAdapter implements SourceAdapter {
  readonly id = "mcp";
  readonly sourceType: ToolSourceType;
  private upstreamVendor?: string;

  constructor(options: McpAdapterOptions = {}) {
    this.sourceType = options.sourceType ?? "mcp-directory";
    this.upstreamVendor = options.upstreamVendor;
  }

  async fetch(input: AdapterInput): Promise<IndexedTool[]> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = new Date().toISOString();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const response = await fetchImpl(input.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(input.headers ?? {}),
      },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `MCP tools/list returned ${response.status} ${response.statusText} from ${input.url}`,
      );
    }

    const json = (await response.json()) as McpToolsListResponse;
    if (json.error) {
      throw new Error(
        `MCP server returned JSON-RPC error ${json.error.code}: ${json.error.message}`,
      );
    }
    const tools = json.result?.tools ?? [];
    const drafts: IndexedTool[] = [];

    for (const tool of tools) {
      if (!tool.name || typeof tool.name !== "string") {
        // Tolerate malformed entries — skip not throw.
        continue;
      }
      const id = `mcp:${input.url}#${tool.name}`;
      // The transform/enrich stages will fill cid, trustTier, etc.
      // We use placeholder sha256 (32 'a'-chars) per the SHA256 regex
      // and let the pipeline replace it with the real CID.
      const placeholderCid = ("sha256:" + "0".repeat(64)) as `sha256:${string}`;
      drafts.push({
        id,
        cid: placeholderCid,
        version: now, // ingestion date as version fallback
        source: {
          type: this.sourceType,
          url: input.url,
          fetchedAt: now,
        },
        ingestedAt: now,
        ingestionMethod: "mcp-list",
        upstreamId: tool.name,
        upstreamUrl: input.url,
        upstreamVendor: this.upstreamVendor,
        skills: deriveSkillsFromMcp(tool),
        domains: [],
        features: [],
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
        description: autoSummarize(tool.description ?? tool.name),
        // PCC-specific defaults — pipeline.enrich overrides
        actionClass: inferActionClass(tool),
        assuranceCeiling: "DCC2" as IndexedTool["assuranceCeiling"],
        trustTier: "AUTO_INDEXED" as IndexedTool["trustTier"],
        knownVulns: [],
        lastFetchedAt: now,
        invocationCount: 0,
        driftAlerts: [],
        schemaHashHistory: [],
        hostingPeers: [],
      });
    }

    return drafts;
  }
}

/** Factory for tests / DI. */
export function makeMcpSourceAdapter(
  options: McpAdapterOptions = {},
): McpSourceAdapter {
  return new McpSourceAdapter(options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-summarize a tool description to 2-3 sentences (max ~280 chars).
 *
 * Per spec §10.1, PCC stores its own 2-3-line summary rather than
 * verbatim upstream copy, to dodge the DMCA risk on creative descriptions.
 * Phase 1 implementation is just a length cap; Phase 2 swaps in an LLM
 * paraphrase pass.
 */
function autoSummarize(input: string): string {
  if (!input) return "(no description)";
  const trimmed = input.trim();
  if (trimmed.length <= 280) return trimmed;
  // Truncate at the nearest sentence boundary <= 280.
  const cut = trimmed.slice(0, 280);
  const lastDot = cut.lastIndexOf(".");
  if (lastDot > 100) return cut.slice(0, lastDot + 1);
  return cut + "…";
}

/**
 * Derive a coarse skill taxonomy from an MCP tool's name + description.
 * Phase 1 returns [name] as a single-element array; Phase 2 maps to OASF.
 */
function deriveSkillsFromMcp(tool: McpTool): string[] {
  return [tool.name];
}

/**
 * Infer the PCC action class from an MCP tool descriptor.
 *
 * Heuristics (Phase 1):
 *   - name contains "delete"/"remove"/"kill" -> write
 *   - name contains "read"/"get"/"list"/"search" -> read
 *   - name contains "run"/"exec"/"call" -> exec
 *   - default -> read (most MCP tools are read-only)
 */
function inferActionClass(tool: McpTool): IndexedTool["actionClass"] {
  const n = (tool.name || "").toLowerCase();
  if (/(delete|remove|kill|drop)/.test(n)) return "write";
  if (/(run|exec|invoke|call|spawn)/.test(n)) return "exec";
  if (/(read|get|list|search|fetch|find|describe)/.test(n)) return "read";
  return "read";
}

/**
 * @pcc/tool-index — Phase 1 types
 *
 * IndexedTool is the canonical shape for any tool the index knows about,
 * regardless of source. Phase 1 indexes only PCC's own 218-tool
 * agent-package.json; Phase 3 will add loaders for external MCP servers,
 * OpenAPI specs, and skills.
 */

/** Where a tool came from. */
export type ToolSource = "pcc-mcp" | "external-mcp" | "openapi" | "skill";

/** HTTP endpoint mapping for tools that resolve to an HTTP call. */
export interface ToolEndpoint {
  /** HTTP method — "GET", "POST", "PUT", "PATCH", "DELETE", etc. */
  method: string;
  /** Path template — e.g. "/api/jobs/{jobId}" */
  path: string;
}

/**
 * The canonical shape for any tool the index knows about.
 *
 * `id` is unique across the entire index. Conventional shape:
 *   "<sourcePrefix>:<toolName>"
 *   e.g. "pcc:pcc_get_job", "ext:filesystem:read_file"
 */
export interface IndexedTool {
  /** Globally unique id, e.g. "pcc:pcc_get_job". */
  id: string;
  /** Where this tool came from. */
  source: ToolSource;
  /**
   * Source-specific subID (for `external-mcp`, the server URL/name; for
   * `openapi`, the spec id). Omitted for `pcc-mcp` since it's implicit.
   */
  sourceId?: string;
  /** Display name (matches `name` field in agent-package.json). */
  name: string;
  /** Human-readable description used for retrieval matching. */
  description: string;
  /** Input JSON schema (free-form record — passed through unchanged). */
  schema: Record<string, unknown>;
  /** Optional free-form tags. */
  tags?: string[];
  /**
   * Optional list of PCC capability type strings this tool relates to
   * (e.g. ["3d-printing", "cnc"]). Phase 2+ inference.
   */
  capabilities?: string[];
  /** HTTP endpoint mapping for tools resolvable to an HTTP call. */
  endpoint?: ToolEndpoint;
  /**
   * Dense embedding vector. Computed lazily on first search if absent.
   * Length must match the active provider's `dim`.
   */
  embedding?: number[];
}

/** A single search hit — tool plus its cosine-similarity score in [0, 1]. */
export interface ToolSearchHit {
  tool: IndexedTool;
  /** Cosine similarity in [-1, 1]; for unit vectors typically [0, 1]. */
  score: number;
}

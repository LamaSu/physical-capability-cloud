/**
 * @pcc/tool-index — agent-package.json loader
 *
 * Reads PCC's canonical agent-package.json (the 218-tool catalog) and maps
 * each tool to an IndexedTool with source="pcc-mcp".
 *
 * Schema mapping (input → IndexedTool):
 *   tool.name        → name + id ("pcc:<name>")
 *   tool.description → description
 *   tool.input_schema → schema
 *   tool.endpoint    → endpoint  (method + path, path passed through unchanged)
 *
 * Tools without a `name` or `description` are skipped (defensive — the
 * canonical file is well-formed, but the loader should tolerate drift).
 */

import { readFileSync } from "node:fs";
import type { IndexedTool, ToolEndpoint } from "../types.js";

/** Shape of one tool entry in agent-package.json. */
interface AgentPackageTool {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  endpoint?: unknown;
  tags?: unknown;
}

/** Shape of the agent-package.json root object. */
interface AgentPackageRoot {
  schema?: unknown;
  name?: unknown;
  version?: unknown;
  toolCount?: unknown;
  tools?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asEndpoint(v: unknown): ToolEndpoint | undefined {
  if (!isRecord(v)) return undefined;
  const method = typeof v.method === "string" ? v.method : undefined;
  const path = typeof v.path === "string" ? v.path : undefined;
  if (!method || !path) return undefined;
  return { method, path };
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const filtered = v.filter((x): x is string => typeof x === "string");
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Convert one raw agent-package tool to an IndexedTool. Returns null if
 * the tool is missing required fields (name, description).
 */
export function mapAgentPackageTool(raw: AgentPackageTool): IndexedTool | null {
  if (typeof raw.name !== "string" || !raw.name) return null;
  if (typeof raw.description !== "string" || !raw.description) return null;
  const schema = isRecord(raw.input_schema) ? raw.input_schema : {};
  const endpoint = asEndpoint(raw.endpoint);
  const tags = asStringArray(raw.tags);
  const indexed: IndexedTool = {
    id: `pcc:${raw.name}`,
    source: "pcc-mcp",
    name: raw.name,
    description: raw.description,
    schema,
  };
  if (endpoint) indexed.endpoint = endpoint;
  if (tags) indexed.tags = tags;
  return indexed;
}

/**
 * Parse an already-loaded agent-package.json object into IndexedTools.
 * Use this when the JSON is in memory (tests, fetched over HTTP).
 */
export function indexAgentPackage(root: unknown): IndexedTool[] {
  if (!isRecord(root)) return [];
  const r = root as AgentPackageRoot;
  if (!Array.isArray(r.tools)) return [];
  const out: IndexedTool[] = [];
  for (const t of r.tools) {
    if (!isRecord(t)) continue;
    const mapped = mapAgentPackageTool(t as AgentPackageTool);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * Read agent-package.json from disk and return IndexedTools. Throws on
 * read or parse errors — callers should treat absence as a fatal config
 * problem (the index has nothing to serve).
 */
export function loadAgentPackage(jsonPath: string): IndexedTool[] {
  const raw = readFileSync(jsonPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return indexAgentPackage(parsed);
}

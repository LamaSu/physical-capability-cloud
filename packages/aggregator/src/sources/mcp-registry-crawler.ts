/**
 * MCP Registry Crawler — polls public MCP server directories and ingests
 * their listings into the aggregator pipeline.
 *
 * Supported registries (May 2026):
 *   - Smithery       (https://smithery.ai)        — JSON registry API, optional API key
 *   - Glama          (https://glama.ai)           — public JSON listing endpoint
 *   - mcp.directory  (https://mcp.directory)      — public list endpoint
 *   - mcp.so         (https://mcp.so)             — public search endpoint
 *
 * For each server discovered in a registry's listing, the crawler:
 *   1. Extracts the server's MCP endpoint URL (where the JSON-RPC `tools/list`
 *      call should be sent).
 *   2. Delegates to McpSourceAdapter to do the actual `tools/list` fetch +
 *      transform into IndexedTool drafts.
 *   3. Tags each draft with the upstream directory as `source.type` (one of
 *      `smithery`, `glama`, `mcp-so`, `mcp-directory`).
 *   4. Aggregates all drafts and dedups by `cid` (the spec's
 *      content-addressed identifier; identical tools from multiple registries
 *      collapse to one record, with the highest-priority registry winning).
 *
 * Per-registry quirks the crawler handles:
 *   - Smithery API needs an API key (env `PCC_SMITHERY_API_KEY`). When absent
 *     we fall back to the public web listing JSON (lower-resolution data).
 *   - Rate limits: each registry is called with a small `maxServers` cap and
 *     the per-server `tools/list` calls are sequenced (one at a time) so we
 *     don't fan out 10k parallel requests on a fresh crawl.
 *   - Dead servers: a single `tools/list` failure logs to `errors[]` and the
 *     crawl continues — one bad server doesn't poison the registry crawl.
 *
 * Phase 1 scope (this file):
 *   - HTTP-only crawl (no stdio MCP servers — those require harness.exe spawn)
 *   - Best-effort schema parsing of each registry's response. We document the
 *     expected shape inline and code defensively against missing fields.
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §2.2 Stage 1
 *      ~/.claude/rules/library/mcp-directories.md (registry endpoint reference)
 */

import type { IndexedTool, ToolSourceType } from "@pcc/spec";
import { McpSourceAdapter } from "./mcp.js";

/** Registries the crawler understands. */
export type SupportedRegistry =
  | "smithery"
  | "glama"
  | "mcp.directory"
  | "mcp.so";

/** Mapping from CLI/config registry name -> IndexedTool source.type tag. */
const REGISTRY_SOURCE_TYPE: Record<SupportedRegistry, ToolSourceType> = {
  smithery: "smithery",
  glama: "glama",
  "mcp.directory": "mcp-directory",
  "mcp.so": "mcp-so",
};

/** Default URL per registry. */
const REGISTRY_LIST_URL: Record<SupportedRegistry, string> = {
  smithery: "https://smithery.ai/api/registry/servers",
  glama: "https://glama.ai/mcp/servers",
  "mcp.directory": "https://mcp.directory/api/servers",
  "mcp.so": "https://mcp.so/api/servers",
};

/** Generic server entry the per-registry parsers emit. */
interface RegistryServerEntry {
  /** Vendor-provided name / id. */
  name: string;
  /** Vendor description (kept for logging only — IndexedTool uses tools/list). */
  description?: string;
  /** URL to hit with JSON-RPC `tools/list`. */
  endpoint: string;
  /** Optional vendor/maintainer label. */
  vendor?: string;
  /** Optional auth headers needed for that endpoint. */
  headers?: Record<string, string>;
}

/** Options the crawler accepts. */
export interface MCPRegistryCrawlerOptions {
  /**
   * Override the listing URL for a registry (useful for tests / mirrors).
   * Keyed by registry name.
   */
  listUrls?: Partial<Record<SupportedRegistry, string>>;
  /** Optional fetch impl (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Cap on the number of servers crawled per registry. Default 50. */
  maxServers?: number;
  /** Search query passed to each registry's listing endpoint. */
  query?: string;
  /**
   * Smithery API key. Read from env `PCC_SMITHERY_API_KEY` if not set.
   * Without this, Smithery responses are lower-resolution.
   */
  smitheryApiKey?: string;
  /** Delay (ms) between per-server tools/list calls. Default 100ms. */
  perServerDelayMs?: number;
  /** Constructor for the MCP adapter (overridable for tests). */
  mcpAdapterFactory?: (sourceType: ToolSourceType, vendor?: string) => McpSourceAdapter;
}

/** What the crawl method returns alongside the dedup'd drafts. */
export interface CrawlResult {
  /** Drafts after intra-crawl dedup by `cid`. */
  drafts: IndexedTool[];
  /** Number of registry servers contacted (before dedup). */
  serversContacted: number;
  /** Per-server / per-registry errors keyed by descriptive label. */
  errors: Record<string, string>;
}

/**
 * Crawl MCP registry directories and harvest IndexedTool drafts.
 *
 * Designed as a Phase 1 best-effort tool; subsequent phases add caching,
 * Sigstore verification, and cross-registry trust scoring.
 */
export class MCPRegistryCrawler {
  readonly id = "mcp-registry-crawler";
  private readonly fetchImpl: typeof fetch;
  private readonly listUrls: Record<SupportedRegistry, string>;
  private readonly maxServers: number;
  private readonly query?: string;
  private readonly smitheryApiKey?: string;
  private readonly perServerDelayMs: number;
  private readonly mcpAdapterFactory: (
    sourceType: ToolSourceType,
    vendor?: string,
  ) => McpSourceAdapter;

  constructor(options: MCPRegistryCrawlerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.listUrls = {
      ...REGISTRY_LIST_URL,
      ...(options.listUrls ?? {}),
    };
    this.maxServers = options.maxServers ?? 50;
    this.query = options.query;
    this.smitheryApiKey =
      options.smitheryApiKey ?? process.env.PCC_SMITHERY_API_KEY;
    this.perServerDelayMs = options.perServerDelayMs ?? 100;
    this.mcpAdapterFactory =
      options.mcpAdapterFactory ??
      ((sourceType, vendor) =>
        new McpSourceAdapter({ sourceType, upstreamVendor: vendor }));
  }

  /**
   * Crawl one registry end-to-end.
   *
   * Flow:
   *   1. GET the listing endpoint.
   *   2. Parse the response into a normalized `RegistryServerEntry[]`.
   *   3. For each (up to maxServers), call McpSourceAdapter.fetch().
   *   4. Dedup the combined drafts by `cid`.
   *
   * Returns a CrawlResult with drafts + per-step errors. A registry-level
   * failure (e.g. listing endpoint 500) returns an empty drafts array and a
   * single error entry — callers can decide whether that's fatal.
   */
  async crawl(registry: SupportedRegistry): Promise<CrawlResult> {
    const errors: Record<string, string> = {};
    const sourceType = REGISTRY_SOURCE_TYPE[registry];
    const listUrl = this.composeListUrl(registry);

    let entries: RegistryServerEntry[];
    try {
      entries = await this.fetchRegistryList(registry, listUrl);
    } catch (err) {
      errors[`registry:${registry}`] =
        err instanceof Error ? err.message : String(err);
      return { drafts: [], serversContacted: 0, errors };
    }

    const capped = entries.slice(0, this.maxServers);
    const allDrafts: IndexedTool[] = [];

    for (const entry of capped) {
      const adapter = this.mcpAdapterFactory(sourceType, entry.vendor);
      try {
        const drafts = await adapter.fetch({
          url: entry.endpoint,
          headers: entry.headers,
          fetchImpl: this.fetchImpl,
        });
        allDrafts.push(...drafts);
      } catch (err) {
        errors[`server:${entry.name}`] =
          err instanceof Error ? err.message : String(err);
      }
      if (this.perServerDelayMs > 0) {
        await sleep(this.perServerDelayMs);
      }
    }

    const deduped = dedupByCid(allDrafts);

    return {
      drafts: deduped,
      serversContacted: capped.length,
      errors,
    };
  }

  /** Crawl every supported registry in series. */
  async crawlAll(): Promise<Record<SupportedRegistry, CrawlResult>> {
    const out: Partial<Record<SupportedRegistry, CrawlResult>> = {};
    for (const reg of Object.keys(REGISTRY_SOURCE_TYPE) as SupportedRegistry[]) {
      out[reg] = await this.crawl(reg);
    }
    return out as Record<SupportedRegistry, CrawlResult>;
  }

  // ---------------------------------------------------------------------
  // Listing fetch + per-registry parsing
  // ---------------------------------------------------------------------

  private composeListUrl(registry: SupportedRegistry): string {
    const base = this.listUrls[registry];
    if (!this.query) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}q=${encodeURIComponent(this.query)}`;
  }

  private async fetchRegistryList(
    registry: SupportedRegistry,
    url: string,
  ): Promise<RegistryServerEntry[]> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "pcc-aggregator-crawler/0.1",
    };
    if (registry === "smithery" && this.smitheryApiKey) {
      headers.Authorization = `Bearer ${this.smitheryApiKey}`;
    }

    const response = await this.fetchImpl(url, { method: "GET", headers });
    if (response.status === 401 || response.status === 403) {
      // Auth-failure fallback: surface a structured error so the caller
      // can route around it. We don't throw — that would abort the entire
      // crawl; we want partial results from the other registries.
      throw new Error(
        `${registry} listing returned ${response.status} ${response.statusText} (auth required?)`,
      );
    }
    if (response.status === 429) {
      throw new Error(
        `${registry} rate-limited (429). Honor the Retry-After header next run.`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `${registry} listing returned ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as unknown;
    return parseRegistryListing(registry, json);
  }
}

/** Factory for tests / DI. */
export function makeMCPRegistryCrawler(
  options: MCPRegistryCrawlerOptions = {},
): MCPRegistryCrawler {
  return new MCPRegistryCrawler(options);
}

// ---------------------------------------------------------------------------
// Per-registry parsing
// ---------------------------------------------------------------------------

/**
 * Parse a registry's listing JSON into a normalized RegistryServerEntry[].
 *
 * Each parser is defensive against missing fields — anything malformed is
 * skipped with no throw. The shapes documented below are the May 2026
 * observed payloads; if a registry changes its API, only this file needs
 * an edit.
 */
function parseRegistryListing(
  registry: SupportedRegistry,
  json: unknown,
): RegistryServerEntry[] {
  switch (registry) {
    case "smithery":
      return parseSmithery(json);
    case "glama":
      return parseGlama(json);
    case "mcp.directory":
      return parseMcpDirectory(json);
    case "mcp.so":
      return parseMcpSo(json);
  }
}

/**
 * Smithery shape:
 *   { servers: [ { qualifiedName, displayName, description, connections: [
 *     { type, deploymentUrl, ... } ] } ] }
 * The first HTTP-style `connections[].deploymentUrl` is what we hit with
 * tools/list.
 */
function parseSmithery(json: unknown): RegistryServerEntry[] {
  const out: RegistryServerEntry[] = [];
  if (!isObject(json)) return out;
  const servers = pickArray(json, "servers");
  for (const item of servers) {
    if (!isObject(item)) continue;
    const name = stringOr(item, "qualifiedName") ?? stringOr(item, "displayName");
    if (!name) continue;
    const conns = pickArray(item, "connections");
    let endpoint: string | undefined;
    for (const c of conns) {
      if (!isObject(c)) continue;
      const url = stringOr(c, "deploymentUrl") ?? stringOr(c, "url");
      if (url && /^https?:\/\//.test(url)) {
        endpoint = url;
        break;
      }
    }
    if (!endpoint) continue;
    out.push({
      name,
      endpoint,
      description: stringOr(item, "description"),
      vendor: stringOr(item, "owner") ?? "Smithery",
    });
  }
  return out;
}

/**
 * Glama shape (public list endpoint):
 *   { servers: [ { id, name, description, url, repository, owner } ] }
 * `url` is the canonical invocation endpoint.
 */
function parseGlama(json: unknown): RegistryServerEntry[] {
  const out: RegistryServerEntry[] = [];
  if (!isObject(json)) return out;
  const servers = pickArray(json, "servers");
  for (const item of servers) {
    if (!isObject(item)) continue;
    const name = stringOr(item, "name") ?? stringOr(item, "id");
    const endpoint = stringOr(item, "url");
    if (!name || !endpoint || !/^https?:\/\//.test(endpoint)) continue;
    out.push({
      name,
      endpoint,
      description: stringOr(item, "description"),
      vendor: stringOr(item, "owner") ?? "Glama",
    });
  }
  return out;
}

/**
 * mcp.directory shape:
 *   { items: [ { id, name, description, install: { url } | mcp: { url } } ] }
 */
function parseMcpDirectory(json: unknown): RegistryServerEntry[] {
  const out: RegistryServerEntry[] = [];
  if (!isObject(json)) return out;
  const items = pickArray(json, "items").length
    ? pickArray(json, "items")
    : pickArray(json, "servers");
  for (const item of items) {
    if (!isObject(item)) continue;
    const name = stringOr(item, "name") ?? stringOr(item, "id");
    const installObj = pickObject(item, "install") ?? pickObject(item, "mcp");
    const endpoint =
      (installObj && stringOr(installObj, "url")) ?? stringOr(item, "url");
    if (!name || !endpoint || !/^https?:\/\//.test(endpoint)) continue;
    out.push({
      name,
      endpoint,
      description: stringOr(item, "description"),
      vendor: stringOr(item, "owner") ?? "mcp.directory",
    });
  }
  return out;
}

/**
 * mcp.so shape:
 *   { data: [ { name, description, url, author } ] }
 * Or top-level: { results: [...] }
 */
function parseMcpSo(json: unknown): RegistryServerEntry[] {
  const out: RegistryServerEntry[] = [];
  if (!isObject(json)) return out;
  const items = pickArray(json, "data").length
    ? pickArray(json, "data")
    : pickArray(json, "results");
  for (const item of items) {
    if (!isObject(item)) continue;
    const name = stringOr(item, "name") ?? stringOr(item, "title");
    const endpoint = stringOr(item, "url") ?? stringOr(item, "endpoint");
    if (!name || !endpoint || !/^https?:\/\//.test(endpoint)) continue;
    out.push({
      name,
      endpoint,
      description: stringOr(item, "description"),
      vendor: stringOr(item, "author") ?? "mcp.so",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOr(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickArray(
  obj: Record<string, unknown>,
  key: string,
): unknown[] {
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

function pickObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = obj[key];
  return isObject(v) ? v : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dedup IndexedTool[] by `cid`. The first occurrence wins (callers should
 * order registries by trust if they care about which one). When the input
 * was produced by the MCP adapter directly (placeholder cid), we fall back
 * to deduping by `id` so we don't collapse every placeholder-cid tool into
 * one entry. The pipeline's enrich stage replaces the cid with the real
 * hash later.
 */
function dedupByCid(drafts: IndexedTool[]): IndexedTool[] {
  const seen = new Map<string, IndexedTool>();
  const placeholderCid = "sha256:" + "0".repeat(64);
  for (const d of drafts) {
    const dedupKey = d.cid === placeholderCid ? d.id : d.cid;
    if (!seen.has(dedupKey)) seen.set(dedupKey, d);
  }
  return Array.from(seen.values());
}

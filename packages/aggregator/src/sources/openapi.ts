/**
 * OpenAPI source-adapter — ingests one IndexedTool per operation in an
 * OpenAPI 3.x document.
 *
 * Accepts a URL to a JSON document (Phase 1 — YAML deferred to Phase 2),
 * parses the `paths` object, and converts each (path, method) pair into
 * a draft IndexedTool. The operation's `operationId` is used as the
 * upstream tool name; missing operationIds get a synthetic
 * "method_path" derived name.
 *
 * Limitations (Phase 1):
 *   - JSON only (no YAML parser dep)
 *   - $ref'd schemas are stored as-is (consumers must resolve)
 *   - No auth-scheme awareness yet — defaulting to actionClass derived
 *     from the HTTP method
 *
 * See: ai/research/universal-tool-aggregator-2026-05-23.md §2.2 Stage 2
 */

import type { IndexedTool, ToolSourceType } from "@pcc/spec";
import type { SourceAdapter, AdapterInput } from "../types.js";
import { assertSafeFetchUrl } from "../url-guard.js";

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, unknown>;
  tags?: string[];
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
  patch?: OpenApiOperation;
  options?: OpenApiOperation;
  head?: OpenApiOperation;
}

interface OpenApiDoc {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string }>;
  paths?: Record<string, OpenApiPathItem>;
}

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiAdapterOptions {
  sourceType?: ToolSourceType;
  upstreamVendor?: string;
}

export class OpenApiSourceAdapter implements SourceAdapter {
  readonly id = "openapi";
  readonly sourceType: ToolSourceType;
  private upstreamVendor?: string;

  constructor(options: OpenApiAdapterOptions = {}) {
    this.sourceType = options.sourceType ?? "openapi-doc";
    this.upstreamVendor = options.upstreamVendor;
  }

  async fetch(input: AdapterInput): Promise<IndexedTool[]> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = new Date().toISOString();

    // SSRF guard — reject internal/private/loopback hosts BEFORE fetch.
    // Errors bubble as SSRFRejected for telemetry to group on.
    assertSafeFetchUrl(input.url);

    const response = await fetchImpl(input.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(
        `OpenAPI fetch returned ${response.status} ${response.statusText} from ${input.url}`,
      );
    }

    const doc = (await response.json()) as OpenApiDoc;
    if (!doc.openapi && !doc.swagger) {
      throw new Error(`Not an OpenAPI / Swagger document: ${input.url}`);
    }

    const baseUrl =
      doc.servers?.[0]?.url ??
      // Fall back to the directory of the doc URL.
      input.url.replace(/\/[^/]*$/, "");

    const placeholderCid = ("sha256:" + "0".repeat(64)) as `sha256:${string}`;
    const drafts: IndexedTool[] = [];
    const paths = doc.paths ?? {};

    for (const [pathStr, pathItem] of Object.entries(paths)) {
      for (const method of HTTP_METHODS) {
        const op = (pathItem as Record<HttpMethod, OpenApiOperation | undefined>)[
          method
        ];
        if (!op) continue;

        const opName =
          op.operationId ??
          `${method}_${pathStr.replace(/[^a-zA-Z0-9]+/g, "_")}`;
        const id = `openapi:${input.url}#${opName}`;
        const upstreamUrl = joinUrl(baseUrl, pathStr);

        drafts.push({
          id,
          cid: placeholderCid,
          version: doc.info?.version ?? now,
          source: {
            type: this.sourceType,
            url: input.url,
            fetchedAt: now,
          },
          ingestedAt: now,
          ingestionMethod: "openapi",
          upstreamId: opName,
          upstreamUrl,
          upstreamVendor: this.upstreamVendor ?? doc.info?.title,
          skills: op.tags ?? [opName],
          domains: [],
          features: [],
          inputSchema: buildInputSchema(op),
          outputSchema: undefined,
          description: autoSummarize(
            op.summary || op.description || doc.info?.title || opName,
          ),
          actionClass: actionClassFor(method),
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
    }

    return drafts;
  }
}

export function makeOpenApiSourceAdapter(
  options: OpenApiAdapterOptions = {},
): OpenApiSourceAdapter {
  return new OpenApiSourceAdapter(options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  if (path.startsWith("http")) return path;
  if (base.endsWith("/")) base = base.slice(0, -1);
  if (!path.startsWith("/")) path = "/" + path;
  return base + path;
}

function autoSummarize(input: string): string {
  if (!input) return "(no description)";
  const trimmed = input.trim();
  if (trimmed.length <= 280) return trimmed;
  return trimmed.slice(0, 277) + "…";
}

/** Phase 1: heuristic input-schema synthesis from OpenAPI op fields. */
function buildInputSchema(op: OpenApiOperation): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: {},
  };
  if (op.parameters && Array.isArray(op.parameters)) {
    (schema as { parameters?: unknown[] }).parameters = op.parameters;
  }
  if (op.requestBody?.content) {
    const jsonContent = op.requestBody.content["application/json"];
    if (jsonContent?.schema) {
      (schema as { body?: unknown }).body = jsonContent.schema;
    }
  }
  return schema;
}

/** Map HTTP method to PCC action class. */
function actionClassFor(method: HttpMethod): IndexedTool["actionClass"] {
  switch (method) {
    case "get":
    case "head":
    case "options":
      return "read";
    case "delete":
      return "write";
    case "post":
    case "put":
    case "patch":
      return "write";
  }
}

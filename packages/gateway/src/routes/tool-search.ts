/**
 * BigTool-style retrieval over PCC's 218-tool agent-package.json catalog.
 *
 * The package @pcc/tool-index does the embedding + cosine work. This route
 * file is the gateway HTTP surface around it:
 *
 *   POST /api/tools/search   Body: {query, topK?, source?}
 *                            Returns: {tools: Array<{id, name, description, source, score, endpoint}>, ...}
 *                            Public-read by design — the catalog itself is
 *                            already served publicly at /agent-package.json.
 *
 *   GET  /api/tools/status   Returns: {indexed, providers: {embedding, dim}, lastReload}
 *                            Public-read.
 *
 *   POST /api/tools/reload   Requires the caller's operatorId to be on the
 *                            PCC_TOOL_INDEX_ADMINS allowlist (closed-by-default).
 *                            Re-reads agent-package.json from disk and rebuilds
 *                            the index.
 *
 * Index lifecycle:
 *   - The ToolIndex singleton is initialized lazily: the first search()
 *     /status / reload call triggers loading agent-package.json from disk
 *     and seeding the index. Embeddings are computed lazily on first search
 *     by the index-store layer.
 *   - The path to agent-package.json is resolved (in order):
 *       1. process.env.PCC_AGENT_PACKAGE_PATH   (explicit override)
 *       2. apps/dashboard/public/agent-package.json (the canonical 218-tool
 *          file as of v2.11.x; auto-located relative to repo root)
 *       3. agent-package-test.json at repo root  (smoke-test fixture, last resort)
 *   - If none resolve, the index initializes empty and /status reports
 *     `indexed: 0`. Search returns an empty tools[] list. The error is
 *     logged once at boot so operators notice.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ToolIndex,
  loadAgentPackage,
  selectEmbeddingProvider,
  type IndexedTool,
  type ToolSource,
} from "@pcc/tool-index";

// ── Allowlist for /reload ────────────────────────────────────────────────

/**
 * Comma-separated operatorIds/wallet addresses (lower-cased). If empty,
 * NO operator may call /reload. Production must opt-in explicitly.
 */
function isToolIndexAdmin(operatorId: string | undefined | null): boolean {
  if (!operatorId) return false;
  const raw = process.env.PCC_TOOL_INDEX_ADMINS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(operatorId.toLowerCase());
}

function requireToolIndexAdmin(
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
  if (!isToolIndexAdmin(callerId)) {
    void reply.status(403).send({
      error: "forbidden",
      message:
        "Tool-index reload requires operator on PCC_TOOL_INDEX_ADMINS allowlist.",
    });
    return null;
  }
  return callerId;
}

// ── Index singleton ──────────────────────────────────────────────────────

interface IndexState {
  index: ToolIndex;
  lastReload: string; // ISO timestamp
  loadedFromPath: string | null;
}

let state: IndexState | null = null;

/**
 * Locate the agent-package.json file. Honors PCC_AGENT_PACKAGE_PATH, then
 * tries the canonical dashboard public location relative to either the
 * compiled dist (packages/gateway/dist/routes/) or the source (packages/
 * gateway/src/routes/), then falls back to agent-package-test.json at the
 * repo root.
 *
 * Returns null if no file is found. Callers should treat that as a config
 * problem and proceed with an empty index.
 */
function resolveAgentPackagePath(): string | null {
  const override = process.env.PCC_AGENT_PACKAGE_PATH;
  if (override && existsSync(override)) return resolvePath(override);

  // packages/gateway/{dist,src}/routes/tool-search.{js,ts}
  // Walk up to repo root and try canonical locations.
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    // import.meta.url may be undefined in some bundler paths; fall back
    here = process.cwd();
  }
  // Repo root candidates: 4 levels up from src/routes, 4 levels up from dist/routes
  const candidates = [
    // packages/gateway/{src,dist}/routes -> 4 up = repo root
    resolvePath(here, "..", "..", "..", "..", "apps", "dashboard", "public", "agent-package.json"),
    // packages/gateway/{src,dist} -> 3 up
    resolvePath(here, "..", "..", "..", "apps", "dashboard", "public", "agent-package.json"),
    // Fallback: cwd-relative
    resolvePath(process.cwd(), "apps", "dashboard", "public", "agent-package.json"),
    // Smoke-test fixture
    resolvePath(here, "..", "..", "..", "..", "agent-package-test.json"),
    resolvePath(process.cwd(), "agent-package-test.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Build a fresh ToolIndex and seed it from disk if a manifest is found.
 * Returns the resolved manifest path (or null on miss).
 */
function buildIndex(
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): { index: ToolIndex; path: string | null; tools: IndexedTool[] } {
  const provider = selectEmbeddingProvider(process.env);
  const index = new ToolIndex(provider);
  const path = resolveAgentPackagePath();
  let tools: IndexedTool[] = [];
  if (!path) {
    logger?.warn?.(
      "[tool-search] agent-package.json not found at PCC_AGENT_PACKAGE_PATH or canonical locations; index is empty.",
    );
    return { index, path: null, tools };
  }
  try {
    tools = loadAgentPackage(path);
    index.add(tools);
    logger?.info?.(
      `[tool-search] indexed ${tools.length} tools from ${path} (provider=${provider.name})`,
    );
  } catch (err) {
    logger?.warn?.(
      `[tool-search] failed to load ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { index, path, tools };
}

/**
 * Get the singleton index, building it lazily on first call. Logger is
 * passed through to the build step on the first call only.
 */
function getIndex(logger?: {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}): IndexState {
  if (state) return state;
  const built = buildIndex(logger);
  state = {
    index: built.index,
    lastReload: new Date().toISOString(),
    loadedFromPath: built.path,
  };
  return state;
}

/**
 * Pre-warm the index at server boot. Safe to call even if agent-package.json
 * is missing — the index just stays empty until /reload is called.
 *
 * Exported so server.ts can opt into eager initialization. If never called,
 * the first /search lazily initializes.
 */
export function prewarmToolIndex(logger?: {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}): void {
  if (state) return;
  getIndex(logger);
}

/**
 * Test-only: reset the singleton so the next call rebuilds from scratch.
 * Used by __tests__/tool-search.test.ts to swap PCC_AGENT_PACKAGE_PATH
 * between cases without leaking state.
 */
export function _testResetToolIndex(): void {
  state = null;
}

// ── Routes ────────────────────────────────────────────────────────────────

type ToolSourceFilter = ToolSource | undefined;

function isToolSource(v: unknown): v is ToolSource {
  return (
    typeof v === "string" &&
    (v === "pcc-mcp" || v === "external-mcp" || v === "openapi" || v === "skill")
  );
}

export async function toolSearchRoutes(app: FastifyInstance) {
  // ── POST /api/tools/search ─────────────────────────────────────────────
  app.post<{
    Body: {
      query?: unknown;
      topK?: unknown;
      source?: unknown;
    };
  }>("/api/tools/search", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = body.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      return reply.status(400).send({
        error: "bad_request",
        message: "query must be a non-empty string",
      });
    }
    // Cap topK at 50 to keep responses bounded.
    let topK = 10;
    if (typeof body.topK === "number" && Number.isFinite(body.topK)) {
      topK = Math.max(1, Math.min(50, Math.floor(body.topK)));
    }
    const sourceFilter: ToolSourceFilter = isToolSource(body.source)
      ? body.source
      : undefined;

    const st = getIndex({
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
    });
    const hits = await st.index.search(query, {
      topK,
      source: sourceFilter,
    });
    return reply.send({
      tools: hits.map((h) => ({
        id: h.tool.id,
        name: h.tool.name,
        description: h.tool.description,
        source: h.tool.source,
        score: h.score,
        endpoint: h.tool.endpoint ?? null,
      })),
      query,
      topK,
      source: sourceFilter ?? null,
      total: hits.length,
    });
  });

  // ── GET /api/tools/status ──────────────────────────────────────────────
  app.get("/api/tools/status", async (_req, reply) => {
    const st = getIndex({
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
    });
    return reply.send({
      indexed: st.index.size(),
      providers: {
        embedding: st.index.providerName,
        dim: st.index.dim,
      },
      lastReload: st.lastReload,
      loadedFromPath: st.loadedFromPath,
    });
  });

  // ── POST /api/tools/reload ─────────────────────────────────────────────
  // Auth-gated: only operators on PCC_TOOL_INDEX_ADMINS may rebuild.
  app.post("/api/tools/reload", async (req, reply) => {
    if (!requireToolIndexAdmin(req, reply)) return;
    const built = buildIndex({
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
    });
    state = {
      index: built.index,
      lastReload: new Date().toISOString(),
      loadedFromPath: built.path,
    };
    return reply.send({
      reloaded: true,
      indexed: state.index.size(),
      providers: {
        embedding: state.index.providerName,
        dim: state.index.dim,
      },
      lastReload: state.lastReload,
      loadedFromPath: state.loadedFromPath,
    });
  });
}

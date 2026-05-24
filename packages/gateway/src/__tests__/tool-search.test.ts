/**
 * Tests for the BigTool-style retrieval gateway routes:
 *
 *   POST /api/tools/search   — natural-language ranked search
 *   GET  /api/tools/status   — index size + provider info + lastReload
 *   POST /api/tools/reload   — auth-gated rebuild
 *
 * The index is seeded from a fixture agent-package.json so tests do not
 * depend on the live 218-tool file (which changes under us as the catalog
 * grows). PCC_AGENT_PACKAGE_PATH points at the fixture; PCC_EMBEDDING_PROVIDER
 * is left unset so the deterministic hash fallback is used (no network).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  toolSearchRoutes,
  _testResetToolIndex,
} from "../routes/tool-search.js";

const FIXTURE_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agent-package-fixture.json",
);

const ADMIN_OPERATOR = "operator@admin.example.com";
const NON_ADMIN_OPERATOR = "operator@other.example.com";

/**
 * Build a bare Fastify app with the tool-search routes. Decorates the
 * request with a fixed operatorId so we can test auth gates without
 * standing up the full apiGate / siwe stack.
 */
async function buildApp(opts: { operatorId?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Decorate request with operatorId so the reload allowlist check can see it.
  app.decorateRequest("operatorId", null);
  app.addHook("onRequest", async (req) => {
    if (opts.operatorId !== undefined) {
      (req as unknown as { operatorId: string | null }).operatorId =
        opts.operatorId;
    }
  });
  await app.register(toolSearchRoutes);
  await app.ready();
  return app;
}

describe("POST /api/tools/search", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_AGENT_PACKAGE_PATH = FIXTURE_PATH;
    delete process.env.PCC_EMBEDDING_PROVIDER;
    _testResetToolIndex();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.PCC_AGENT_PACKAGE_PATH;
    _testResetToolIndex();
  });

  it("returns ranked tools for a valid query", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: "how do I list jobs", topK: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      tools: Array<{
        id: string;
        name: string;
        description: string;
        source: string;
        score: number;
        endpoint: { method: string; path: string } | null;
      }>;
      query: string;
      topK: number;
      total: number;
    }>();
    expect(body.query).toBe("how do I list jobs");
    expect(body.topK).toBe(3);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.length).toBeLessThanOrEqual(3);
    // Each hit must have the expected shape.
    for (const t of body.tools) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.source).toBe("string");
      expect(typeof t.score).toBe("number");
      // Ids are conventional "pcc:<toolName>"
      expect(t.id.startsWith("pcc:")).toBe(true);
    }
    // Scores must be in non-increasing order (ranked).
    for (let i = 1; i < body.tools.length; i++) {
      expect(body.tools[i - 1]!.score).toBeGreaterThanOrEqual(
        body.tools[i]!.score,
      );
    }
  });

  it("400s when query is missing or empty", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { topK: 5 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: string }>().error).toBe("bad_request");

    const empty = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: "   " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<{ error: string }>().error).toBe("bad_request");

    const wrongType = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: 42 },
    });
    expect(wrongType.statusCode).toBe(400);
  });

  it("honors a source filter (returns no hits when filter excludes everything)", async () => {
    // Fixture only has pcc-mcp tools. Filtering by external-mcp must yield 0.
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: "anything", source: "external-mcp" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tools: unknown[]; source: string | null }>();
    expect(body.tools).toEqual([]);
    expect(body.source).toBe("external-mcp");

    // ...and pcc-mcp filter returns the indexed tools.
    const res2 = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: "anything", source: "pcc-mcp" },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json<{ tools: unknown[]; source: string | null }>();
    expect(body2.tools.length).toBeGreaterThan(0);
    expect(body2.source).toBe("pcc-mcp");
  });
});

describe("GET /api/tools/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_AGENT_PACKAGE_PATH = FIXTURE_PATH;
    delete process.env.PCC_EMBEDDING_PROVIDER;
    _testResetToolIndex();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.PCC_AGENT_PACKAGE_PATH;
    _testResetToolIndex();
  });

  it("returns the expected shape with the loaded fixture size", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tools/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      indexed: number;
      providers: { embedding: string; dim: number };
      lastReload: string;
      loadedFromPath: string | null;
    }>();
    // The fixture has 4 tools (see fixtures/agent-package-fixture.json).
    expect(body.indexed).toBe(4);
    expect(typeof body.providers.embedding).toBe("string");
    expect(body.providers.embedding.length).toBeGreaterThan(0);
    // Hash fallback is 256-dim; OpenAI is 1536. We do not set
    // PCC_EMBEDDING_PROVIDER=openai here, so we expect 256.
    expect(body.providers.dim).toBe(256);
    // lastReload is an ISO timestamp.
    expect(() => new Date(body.lastReload).toISOString()).not.toThrow();
    expect(body.loadedFromPath).toBe(FIXTURE_PATH);
  });

  it("reports empty index when the manifest is missing", async () => {
    process.env.PCC_AGENT_PACKAGE_PATH = resolvePath(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "does-not-exist.json",
    );
    _testResetToolIndex();
    await app.close();
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/tools/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ indexed: number; loadedFromPath: string | null }>();
    // Note: the resolver may fall through to the canonical
    // apps/dashboard/public/agent-package.json if it exists in the worktree.
    // We only assert that loadedFromPath is NOT the (missing) override.
    expect(body.loadedFromPath).not.toBe(process.env.PCC_AGENT_PACKAGE_PATH);
  });
});

describe("POST /api/tools/reload", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    process.env.PCC_AGENT_PACKAGE_PATH = FIXTURE_PATH;
    delete process.env.PCC_EMBEDDING_PROVIDER;
    _testResetToolIndex();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.PCC_AGENT_PACKAGE_PATH;
    delete process.env.PCC_TOOL_INDEX_ADMINS;
    _testResetToolIndex();
  });

  it("401s when no operator is authenticated", async () => {
    process.env.PCC_TOOL_INDEX_ADMINS = ADMIN_OPERATOR;
    app = await buildApp({ operatorId: undefined });
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/reload",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe("authentication_required");
  });

  it("403s when authenticated but not on the admin allowlist", async () => {
    process.env.PCC_TOOL_INDEX_ADMINS = ADMIN_OPERATOR;
    app = await buildApp({ operatorId: NON_ADMIN_OPERATOR });
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/reload",
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: string; message: string }>();
    expect(body.error).toBe("forbidden");
    expect(body.message).toContain("PCC_TOOL_INDEX_ADMINS");
  });

  it("403s when allowlist is empty (closed by default)", async () => {
    delete process.env.PCC_TOOL_INDEX_ADMINS;
    app = await buildApp({ operatorId: ADMIN_OPERATOR });
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/reload",
    });
    expect(res.statusCode).toBe(403);
  });

  it("reloads and returns updated metadata when admin calls it", async () => {
    process.env.PCC_TOOL_INDEX_ADMINS = ADMIN_OPERATOR;
    app = await buildApp({ operatorId: ADMIN_OPERATOR });

    // Touch status first so we know what lastReload was at construction.
    const before = await app.inject({
      method: "GET",
      url: "/api/tools/status",
    });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json<{ indexed: number; lastReload: string }>();
    expect(beforeBody.indexed).toBe(4);

    // Sleep 5ms to guarantee a strictly-later ISO timestamp on reload.
    await new Promise((r) => setTimeout(r, 5));

    const res = await app.inject({
      method: "POST",
      url: "/api/tools/reload",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      reloaded: boolean;
      indexed: number;
      providers: { embedding: string; dim: number };
      lastReload: string;
      loadedFromPath: string | null;
    }>();
    expect(body.reloaded).toBe(true);
    expect(body.indexed).toBe(4);
    expect(body.loadedFromPath).toBe(FIXTURE_PATH);
    // Reload's lastReload must be strictly after the initial-build one.
    expect(new Date(body.lastReload).getTime()).toBeGreaterThan(
      new Date(beforeBody.lastReload).getTime(),
    );
  });
});

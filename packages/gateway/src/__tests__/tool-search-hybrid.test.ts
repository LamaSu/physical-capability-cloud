/**
 * Tests for the PCC_RANKER_MODE rollout on /api/tools/search.
 *
 * Three modes:
 *   - legacy (default) — naive cosine.
 *   - shadow           — run both, serve legacy, log hybrid.
 *   - hybrid           — serve hybrid output directly.
 *
 * Backwards-compat: all existing tool-search tests must continue to pass
 * with no env vars set. New tests below validate the mode switch only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { resolve as resolvePath, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  toolSearchRoutes,
  _testResetToolIndex,
} from "../routes/tool-search.js";

const FIXTURE_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agent-package-fixture.json",
);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("operatorId", null);
  await app.register(toolSearchRoutes);
  await app.ready();
  return app;
}

describe("PCC_RANKER_MODE — status endpoint surfaces mode", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.PCC_AGENT_PACKAGE_PATH = FIXTURE_PATH;
    delete process.env.PCC_EMBEDDING_PROVIDER;
    _testResetToolIndex();
  });
  afterEach(async () => {
    await app?.close();
    delete process.env.PCC_AGENT_PACKAGE_PATH;
    delete process.env.PCC_RANKER_MODE;
    _testResetToolIndex();
  });

  it("legacy mode (default): status.ranker.mode='legacy', hybridIndexed=0", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/tools/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ranker: { mode: string; hybridIndexed: number; profiles: string[] };
    }>();
    expect(body.ranker.mode).toBe("legacy");
    expect(body.ranker.hybridIndexed).toBe(0);
    expect(body.ranker.profiles).toContain("agent-default");
  });

  it("hybrid mode: status.ranker.mode='hybrid', hybridIndexed > 0", async () => {
    process.env.PCC_RANKER_MODE = "hybrid";
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/tools/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ranker: { mode: string; hybridIndexed: number };
    }>();
    expect(body.ranker.mode).toBe("hybrid");
    expect(body.ranker.hybridIndexed).toBeGreaterThan(0);
  });
});

describe("PCC_RANKER_MODE — search response includes ranker field", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.PCC_AGENT_PACKAGE_PATH = FIXTURE_PATH;
    delete process.env.PCC_EMBEDDING_PROVIDER;
    _testResetToolIndex();
  });
  afterEach(async () => {
    await app?.close();
    delete process.env.PCC_AGENT_PACKAGE_PATH;
    delete process.env.PCC_RANKER_MODE;
    _testResetToolIndex();
  });

  it("legacy: ranker='legacy'", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: "jobs", topK: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ranker: string }>().ranker).toBe("legacy");
  });

  it("hybrid: ranker='hybrid' and tools include rank", async () => {
    process.env.PCC_RANKER_MODE = "hybrid";
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: "jobs", topK: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ranker: string;
      tools: Array<{ id: string; rank?: number; score: number }>;
    }>();
    expect(body.ranker).toBe("hybrid");
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools[0]?.rank).toBe(1);
  });
});

describe("PCC_RANKER_MODE — shadow mode writes JSONL telemetry", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pcc-ranker-shadow-"));
    process.env.PCC_AGENT_PACKAGE_PATH = FIXTURE_PATH;
    process.env.PCC_RANKER_MODE = "shadow";
    process.env.PCC_RANKER_SHADOW_LOG = join(tmpDir, "shadow.jsonl");
    delete process.env.PCC_EMBEDDING_PROVIDER;
    _testResetToolIndex();
  });
  afterEach(async () => {
    await app?.close();
    delete process.env.PCC_AGENT_PACKAGE_PATH;
    delete process.env.PCC_RANKER_MODE;
    delete process.env.PCC_RANKER_SHADOW_LOG;
    _testResetToolIndex();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("serves legacy results and writes hybrid output to the shadow log", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/tools/search",
      payload: { query: "jobs", topK: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ranker: string }>().ranker).toBe("legacy-shadow");

    // The append is fire-and-forget — give the event loop a tick to flush.
    await new Promise((r) => setTimeout(r, 100));

    const contents = await readFile(
      process.env.PCC_RANKER_SHADOW_LOG!,
      "utf-8",
    ).catch(() => "");
    expect(contents.length).toBeGreaterThan(0);
    const lines = contents.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const event = JSON.parse(lines[0]!);
    expect(event.query).toBe("jobs");
    expect(Array.isArray(event.legacyTop5)).toBe(true);
    expect(Array.isArray(event.hybridTop5)).toBe(true);
    expect(typeof event.overlap).toBe("number");
  });
});

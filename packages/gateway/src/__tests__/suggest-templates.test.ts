/**
 * Tests for the bidirectional onboarding substrate:
 *   - CsdRegistry usage tracking (recordUsage, getUsage)
 *   - CsdRegistry suggest (keyword overlap, kind filter, popularity fallback)
 *   - CsdRegistry findUrlByType + popular
 *   - HTTP routes: GET /api/csd/suggest, GET /api/csd/popular
 *   - A2A skill: pcc-suggest-templates (description, query alias, kind filter,
 *     empty query → popularity, no matches → nextStep hint)
 *   - A2A pcc-author-integration auto-records adoption when type matches a CSD
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { CsdRegistry, loadBuiltinCsds } from "@pcc/spec";
import { createStore } from "@pcc/store";
import { csdRoutes, resetCsdRegistry } from "../routes/csd.js";
import { a2aTasksRoutes, __resetA2ATasksForTest } from "../routes/a2a-tasks.js";
import { initStore, closeStore } from "../db.js";

// ── CsdRegistry helper tests ────────────────────────────────────────────────

describe("CsdRegistry — usage tracking", () => {
  let registry: CsdRegistry;

  beforeEach(() => {
    registry = loadBuiltinCsds();
  });

  it("getUsage returns zero shape for never-used CSD", () => {
    const usage = registry.getUsage("pcc://capabilities/fdm/v2");
    expect(usage.count).toBe(0);
    expect(usage.recentAdopters).toEqual([]);
    expect(usage.lastUsedAt).toBeNull();
  });

  it("recordUsage bumps count + tracks adopter + stamps lastUsedAt", () => {
    registry.recordUsage("pcc://capabilities/fdm/v2", "agent-1");
    const u = registry.getUsage("pcc://capabilities/fdm/v2");
    expect(u.count).toBe(1);
    expect(u.recentAdopters).toEqual(["agent-1"]);
    expect(u.lastUsedAt).toBeTruthy();
  });

  it("recordUsage dedups recent adopters but counts every adoption", () => {
    registry.recordUsage("pcc://capabilities/fdm/v2", "agent-1");
    registry.recordUsage("pcc://capabilities/fdm/v2", "agent-2");
    registry.recordUsage("pcc://capabilities/fdm/v2", "agent-1"); // dedup
    const u = registry.getUsage("pcc://capabilities/fdm/v2");
    expect(u.count).toBe(3);
    // agent-1 should appear once, at the end (most recent)
    expect(u.recentAdopters).toEqual(["agent-2", "agent-1"]);
  });

  it("recordUsage is a silent no-op for unknown CSDs", () => {
    registry.recordUsage("pcc://does-not-exist", "agent-1");
    const u = registry.getUsage("pcc://does-not-exist");
    expect(u.count).toBe(0);
  });

  it("popular returns CSDs sorted by usage count desc", () => {
    registry.recordUsage("pcc://capabilities/cnc-3axis/v2", "a");
    registry.recordUsage("pcc://capabilities/cnc-3axis/v2", "b");
    registry.recordUsage("pcc://capabilities/cnc-3axis/v2", "c");
    registry.recordUsage("pcc://capabilities/fdm/v2", "a");
    const top = registry.popular(5);
    expect(top[0]!.csd.url).toBe("pcc://capabilities/cnc-3axis/v2");
    expect(top[0]!.usage.count).toBe(3);
    expect(top[1]!.csd.url).toBe("pcc://capabilities/fdm/v2");
    expect(top[1]!.usage.count).toBe(1);
  });
});

describe("CsdRegistry — suggest", () => {
  let registry: CsdRegistry;

  beforeEach(() => {
    registry = loadBuiltinCsds();
  });

  it("matches CSDs by description keyword", () => {
    // FDM CSD's name + description should contain "FDM" / "filament" tokens
    const matches = registry.suggest("FDM");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.csd.url).toContain("fdm");
    expect(matches[0]!.score).toBeGreaterThan(0);
  });

  it("returns empty array when no tokens overlap", () => {
    const matches = registry.suggest("blockchain rocket helicopter unicorn");
    expect(matches).toEqual([]);
  });

  it("empty query falls back to popularity sort", () => {
    registry.recordUsage("pcc://capabilities/sla/v2", "a");
    registry.recordUsage("pcc://capabilities/sla/v2", "b");
    const matches = registry.suggest("");
    expect(matches[0]!.csd.url).toBe("pcc://capabilities/sla/v2");
  });

  it("limit clamps results", () => {
    const matches = registry.suggest("printing", { limit: 2 });
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it("kind filter restricts to one kind", () => {
    const baseOnly = registry.suggest("", { kind: "base", limit: 100 });
    for (const m of baseOnly) {
      expect(m.csd.kind).toBe("base");
    }
  });
});

describe("CsdRegistry — findUrlByType", () => {
  let registry: CsdRegistry;

  beforeEach(() => {
    registry = loadBuiltinCsds();
  });

  it("returns the URL for a registered type", () => {
    // All 5 builtin CSDs have a "type" field
    const fdmUrl = registry.findUrlByType("fdm");
    expect(fdmUrl).toBe("pcc://capabilities/fdm/v2");
  });

  it("returns undefined for unregistered type", () => {
    expect(registry.findUrlByType("not-a-real-type")).toBeUndefined();
  });
});

// ── HTTP route tests ─────────────────────────────────────────────────────────

describe("HTTP /api/csd/suggest + /api/csd/popular", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetCsdRegistry();
    app = Fastify({ logger: false });
    await app.register(csdRoutes);
    await app.ready();
  });

  it("GET /api/csd/suggest returns suggestions for a query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/csd/suggest?q=FDM&limit=3",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions[0]!.score).toBeGreaterThan(0);
    await app.close();
  });

  it("GET /api/csd/suggest with no query returns popularity-ordered top", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/csd/suggest?limit=2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestions.length).toBeLessThanOrEqual(2);
    await app.close();
  });

  it("GET /api/csd/popular returns popularity-ordered list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/csd/popular?limit=10",
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().popular)).toBe(true);
    await app.close();
  });
});

// ── A2A skill tests ──────────────────────────────────────────────────────────

describe("A2A pcc-suggest-templates skill", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_A2A_AUTH_DISABLED = "true";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(a2aTasksRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    delete process.env.PCC_A2A_AUTH_DISABLED;
  });

  beforeEach(() => {
    resetCsdRegistry();
    __resetA2ATasksForTest();
  });

  it("suggest by description returns scored candidates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          skill: "pcc-suggest-templates",
          params: {
            description: "I want to publish my FDM 3D printer as a capability",
            limit: 3,
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.state).toBe("COMPLETED");
    const data = body.result.artifacts[0].data;
    expect(data.suggestions.length).toBeGreaterThan(0);
    expect(data.suggestions[0].relevanceScore).toBeGreaterThan(0);
    expect(data.nextStep).toContain("pcc-author-integration");
  });

  it("accepts query alias for description", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: {
          skill: "pcc-suggest-templates",
          params: { query: "laser cut" },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().result.artifacts[0].data;
    expect(data.suggestions.length).toBeGreaterThan(0);
  });

  it("no match returns helpful nextStep + empty suggestions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/send",
        params: {
          skill: "pcc-suggest-templates",
          params: { description: "rocket unicorn blockchain helicopter" },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().result.artifacts[0].data;
    expect(data.suggestions).toEqual([]);
    expect(data.nextStep).toContain("no template");
  });

  it("empty query falls back to popularity-ordered suggestions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tasks/send",
        params: {
          skill: "pcc-suggest-templates",
          params: { limit: 5 },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().result.artifacts[0].data;
    expect(data.suggestions.length).toBeLessThanOrEqual(5);
  });
});

describe("pcc-author-integration auto-records CSD adoption", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.PCC_A2A_AUTH_DISABLED = "true";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(a2aTasksRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    delete process.env.PCC_A2A_AUTH_DISABLED;
  });

  beforeEach(() => {
    resetCsdRegistry();
    __resetA2ATasksForTest();
  });

  it("bumps CSD usage when capability type matches a registered CSD", async () => {
    // FDM CSD exists in the built-in registry; type "fdm" → record adoption
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          skill: "pcc-author-integration",
          params: {
            lane: "machine",
            name: "My Prusa MK4",
            type: "fdm",
            location: { lat: 0, lng: 0 },
            operatorAddress: "0xtest-adopter",
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.state).toBe("COMPLETED");
    // Query usage via the GET /api/csd/popular endpoint shape
    const csdRes = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: {
          skill: "pcc-suggest-templates",
          params: { description: "fdm" },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    const suggestions = csdRes.json().result.artifacts[0].data.suggestions;
    const fdmSuggestion = suggestions.find((s: { url: string }) => s.url === "pcc://capabilities/fdm/v2");
    expect(fdmSuggestion).toBeDefined();
    expect(fdmSuggestion!.usage.count).toBe(1);
    expect(fdmSuggestion!.usage.recentAdopters).toContain("0xtest-adopter");
  });

  it("does NOT bump usage for capability types with no matching CSD", async () => {
    // type "not-a-real-csd-type" doesn't match any builtin
    const res = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/send",
        params: {
          skill: "pcc-author-integration",
          params: {
            lane: "machine",
            name: "My weird machine",
            type: "not-a-real-csd-type",
            location: { lat: 0, lng: 0 },
          },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    // No CSD got bumped — all usage counts remain 0
    const popRes = await app.inject({
      method: "POST",
      url: "/a2a/tasks/send",
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: {
          skill: "pcc-suggest-templates",
          params: { limit: 100 },
        },
      }),
      headers: { "content-type": "application/json" },
    });
    const suggestions = popRes.json().result.artifacts[0].data.suggestions;
    for (const s of suggestions) {
      expect(s.usage.count).toBe(0);
    }
  });
});

// ── CsdRegistry with SQLite-backed CsdUsageRepository ─────────────────────────
//
// Validates the public API of CsdRegistry is identical whether usage is held
// in-memory or persisted to SQLite. The registry constructor accepts the
// CsdUsageRepository interface; loadBuiltinCsds() forwards it. Close+reopen
// proves the counter survives a process restart.

describe("CsdRegistry — SQLite-backed usage attribution survives restart", () => {
  it("persists counters across store close + reopen on a file DB", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "csd-registry-persist-"));
    const dbPath = join(dir, "pcc.sqlite");
    try {
      // Round 1 — record usage through the registry's public API
      const s1 = createStore({ dbPath, seed: false });
      const reg1 = loadBuiltinCsds(s1.repos.csdUsage);
      reg1.recordUsage("pcc://capabilities/fdm/v2", "0xagent-1");
      reg1.recordUsage("pcc://capabilities/fdm/v2", "0xagent-2");
      reg1.recordUsage("pcc://capabilities/cnc-3axis/v2", "0xagent-1");
      // Sanity — the in-process registry reads back what it just wrote
      expect(reg1.getUsage("pcc://capabilities/fdm/v2").count).toBe(2);
      expect(reg1.popular(5)[0]!.csd.url).toBe("pcc://capabilities/fdm/v2");
      s1.close();

      // Round 2 — fresh registry instance against the same DB file
      const s2 = createStore({ dbPath, seed: false });
      const reg2 = loadBuiltinCsds(s2.repos.csdUsage);
      const fdm = reg2.getUsage("pcc://capabilities/fdm/v2");
      expect(fdm.count).toBe(2);
      expect(fdm.recentAdopters).toEqual(["0xagent-1", "0xagent-2"]);
      // suggest() reads through the bulk getMany() — popularity tie-break still works
      const fdmMatches = reg2.suggest("fdm");
      expect(fdmMatches[0]!.csd.url).toBe("pcc://capabilities/fdm/v2");
      expect(fdmMatches[0]!.usage.count).toBe(2);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores recordUsage for unknown CSDs (same as in-memory)", async () => {
    const s = createStore({ seed: false });
    const reg = loadBuiltinCsds(s.repos.csdUsage);
    reg.recordUsage("pcc://does-not-exist/v1", "0xagent");
    // No row written, no error, no count
    expect(reg.getUsage("pcc://does-not-exist/v1").count).toBe(0);
    s.close();
  });
});

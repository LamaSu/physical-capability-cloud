/**
 * pizza-llm-bootstrap test suite.
 *
 * Validates the LLM-bootstrap centerpiece (restored from the auto-closed
 * PR #111). The bootstrap is 4 static assets under apps/dashboard/public/:
 *
 *   - pizza-llm-agent-prompt.md         — the system prompt the user pastes
 *   - pizza-llm-agent-prompt.html       — browser-rendered view
 *   - pizza-llm-bootstrap.html          — landing page
 *   - pcc-agent-package-pizza.json      — 11-tool filtered subset of the
 *                                         full agent-package.json
 *
 * The risk this test guards against: someone refactors a route and the
 * pizza-package's endpoint reference quietly goes stale, breaking the demo
 * silently. Each tool in pcc-agent-package-pizza.json declares an endpoint
 * { method, path }; this suite checks that EVERY declared endpoint actually
 * resolves to a registered route on the gateway, modulo path parameter
 * conventions ({id} → :id, {type} → :type).
 *
 * Static-file checks ensure the assets ship in the build output of the
 * dashboard package and have non-empty contents.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { pizzaDemoRoutes } from "../routes/pizza-demo.js";
import { csdRoutes } from "../routes/csd.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { composeRoutes } from "../routes/compose.js";
import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore } from "../db.js";

// ── Asset locations ──────────────────────────────────────────────────────────
// Test runs from packages/gateway; assets live at apps/dashboard/public.
const REPO_ROOT = resolve(__dirname, "../../../..");
const PUBLIC_DIR = join(REPO_ROOT, "apps", "dashboard", "public");

const PROMPT_MD = join(PUBLIC_DIR, "pizza-llm-agent-prompt.md");
const PROMPT_HTML = join(PUBLIC_DIR, "pizza-llm-agent-prompt.html");
const BOOTSTRAP_HTML = join(PUBLIC_DIR, "pizza-llm-bootstrap.html");
const AGENT_PKG = join(PUBLIC_DIR, "pcc-agent-package-pizza.json");

interface PizzaTool {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
  endpoint: { method: string; path: string };
}

interface PizzaAgentPackage {
  schema: string;
  name: string;
  version: string;
  toolCount: number;
  api_base: string;
  system_prompt: string;
  tools: PizzaTool[];
  metadata: { tool_count: number; updated: string };
}

// ── App fixture ──────────────────────────────────────────────────────────────
const registeredRoutes = new Set<string>();

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });

  // Capture every (METHOD, path) registration at the moment Fastify accepts
  // the route definition — runs once per route, BEFORE app.ready().
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      registeredRoutes.add(`${String(m).toUpperCase()} ${route.url}`);
    }
  });

  await app.register(pizzaDemoRoutes);
  await app.register(csdRoutes);
  await app.register(capabilityRoutes);
  await app.register(composeRoutes);
  await app.register(provisionRoutes);
  await app.ready();
  return app;
}

/**
 * Normalize an OpenAPI-style path with curly-brace params to the Fastify
 * colon-prefixed param style: /api/demo/orders/{id}/confirm → /api/demo/orders/:id/confirm
 * Leaves query strings alone (those come on a separate URL part).
 *
 * Also strips any query string segment from the canonical path — pizza-package
 * declares e.g. /api/csd/suggest as the endpoint; query params come in input_schema.
 */
function normalizePathParams(p: string): string {
  const noQuery = p.split("?")[0]!;
  return noQuery.replace(/\{([^}]+)\}/g, ":$1");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pizza-llm-bootstrap — static asset presence", () => {
  it("ships pizza-llm-agent-prompt.md (the centerpiece prompt)", () => {
    expect(existsSync(PROMPT_MD)).toBe(true);
    const txt = readFileSync(PROMPT_MD, "utf8");
    expect(txt.length).toBeGreaterThan(5_000); // ~290-line markdown body
    expect(txt).toMatch(/^# You are a pizza-ordering agent on PCC/);
    expect(txt).toContain("SECTION 1 — Who you are");
    expect(txt).toContain("SECTION 3 — The conversation flow");
    expect(txt).toContain("/api/demo/pizza-order");
    expect(txt).toContain("/api/demo/orders/:id/confirm");
  });

  it("ships pizza-llm-agent-prompt.html (rendered view)", () => {
    expect(existsSync(PROMPT_HTML)).toBe(true);
    const txt = readFileSync(PROMPT_HTML, "utf8");
    expect(txt).toMatch(/<!DOCTYPE html>/i);
    // self-contained renderer pulls the .md at runtime; reference must be live
    expect(txt).toContain("/pizza-llm-agent-prompt.md");
    // copy button is the load-bearing bit for the user
    expect(txt).toMatch(/copyAll|Copy full prompt/);
  });

  it("ships pizza-llm-bootstrap.html (landing page)", () => {
    expect(existsSync(BOOTSTRAP_HTML)).toBe(true);
    const txt = readFileSync(BOOTSTRAP_HTML, "utf8");
    expect(txt).toMatch(/<!DOCTYPE html>/i);
    // landing references the other 3 assets and points users at /order.html
    expect(txt).toContain("/pizza-llm-agent-prompt.md");
    expect(txt).toContain("/pizza-llm-agent-prompt.html");
    expect(txt).toContain("/pcc-agent-package-pizza.json");
    expect(txt).toContain("/order.html");
  });

  it("ships pcc-agent-package-pizza.json with valid structure", () => {
    expect(existsSync(AGENT_PKG)).toBe(true);
    const raw = readFileSync(AGENT_PKG, "utf8");
    // Parse must not throw — that's the bare minimum guarantee for an
    // LLM ingesting it as a tool schema.
    const pkg = JSON.parse(raw) as PizzaAgentPackage;

    expect(pkg.schema).toBe("pcc-agent-package-pizza/1.0");
    expect(pkg.api_base).toBe("https://capability.network");
    expect(Array.isArray(pkg.tools)).toBe(true);
    expect(pkg.tools.length).toBeGreaterThan(0);
    expect(pkg.toolCount).toBe(pkg.tools.length);
    expect(pkg.metadata.tool_count).toBe(pkg.tools.length);
    expect(pkg.system_prompt).toMatch(/pizza-ordering agent/);
  });
});

describe("pizza-llm-bootstrap — every tool's endpoint resolves on the gateway", () => {
  let app: FastifyInstance;
  let pkg: PizzaAgentPackage;

  beforeAll(async () => {
    app = await buildApp();
    pkg = JSON.parse(readFileSync(AGENT_PKG, "utf8")) as PizzaAgentPackage;
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("collected the gateway's registered routes (smoke check)", () => {
    expect(registeredRoutes.size).toBeGreaterThan(0);
  });

  it("every pizza tool declares an endpoint", () => {
    for (const tool of pkg.tools) {
      expect(tool.endpoint).toBeDefined();
      expect(tool.endpoint.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(tool.endpoint.path).toMatch(/^\//);
    }
  });

  it("each pizza tool's endpoint matches a registered route on the gateway", () => {
    const missing: string[] = [];
    for (const tool of pkg.tools) {
      const method = tool.endpoint.method.toUpperCase();
      const path = normalizePathParams(tool.endpoint.path);
      const key = `${method} ${path}`;
      if (!registeredRoutes.has(key)) missing.push(`${tool.name}: ${key}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("pizza-llm-bootstrap — semantic checks against the demo flow", () => {
  let pkg: PizzaAgentPackage;

  beforeAll(() => {
    pkg = JSON.parse(readFileSync(AGENT_PKG, "utf8")) as PizzaAgentPackage;
  });

  it("includes the core ordering loop: discover → plan → confirm → watch", () => {
    const names = new Set(pkg.tools.map((t) => t.name));
    // The 4 load-bearing tools the prompt walks the LLM through
    expect(names.has("discover_csd_suggestions")).toBe(true);
    expect(names.has("place_pizza_order")).toBe(true);
    expect(names.has("confirm_order")).toBe(true);
    expect(names.has("watch_order")).toBe(true);
  });

  it("uses /api/csd/suggest for CSD discovery (master's actual endpoint)", () => {
    const discover = pkg.tools.find((t) => t.name === "discover_csd_suggestions");
    expect(discover).toBeDefined();
    expect(discover!.endpoint.method).toBe("GET");
    expect(discover!.endpoint.path).toBe("/api/csd/suggest");
  });

  it("does NOT reference /api/csd/by-type or /confirm-delivery (endpoints not on master)", () => {
    // These two endpoints were added in the dead PR #111 but never landed.
    // Re-introducing references would break the demo against the live gateway.
    // Note: /api/capabilities/by-type/{type} IS a valid master endpoint and
    // is legitimately referenced — only /api/csd/by-type is the stale one.
    for (const tool of pkg.tools) {
      expect(tool.endpoint.path).not.toMatch(/^\/api\/csd\/by-type/);
      expect(tool.endpoint.path).not.toContain("confirm-delivery");
    }
  });
});

describe("pizza-llm-bootstrap — non-zero file sizes (build sanity)", () => {
  it.each([
    ["pizza-llm-agent-prompt.md", PROMPT_MD, 5_000],
    ["pizza-llm-agent-prompt.html", PROMPT_HTML, 5_000],
    ["pizza-llm-bootstrap.html", BOOTSTRAP_HTML, 5_000],
    ["pcc-agent-package-pizza.json", AGENT_PKG, 5_000],
  ])("%s is at least %d bytes", (_name, path, minBytes) => {
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThanOrEqual(minBytes);
  });
});

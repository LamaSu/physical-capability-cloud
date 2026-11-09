import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { spaceRoutes } from "../routes/spaces.js";
import { orchestratorRoutes } from "../routes/orchestrator.js";
import { logisticsRoutes } from "../routes/logistics.js";
import { protocolRoutes } from "../routes/protocols.js";
import * as marketplace from "../routes/marketplace.js";
import { discoverRoutes } from "../routes/discover.js";
import * as registry from "../routes/registry.js";
import { contextPackRoutes } from "../routes/context-pack.js";

async function recordedKeys(plugin: FastifyPluginAsync): Promise<Set<string>> {
  const app = Fastify({ logger: false });
  const keys = new Set<string>();
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== "HEAD") keys.add(`${method} ${route.url}`);
    }
  });
  try {
    await app.register(plugin);
    await app.ready();
    return keys;
  } finally {
    await app.close();
  }
}

let app: FastifyInstance;
let gated: Set<string>;

beforeAll(async () => {
  const familyKeys = await Promise.all([
    agentRoutes, spaceRoutes, orchestratorRoutes, logisticsRoutes,
    protocolRoutes, marketplace.marketplaceRoutes, discoverRoutes,
  ].map(recordedKeys));
  const marketplaceExports = marketplace as unknown as Record<string, readonly string[] | undefined>;
  // The fallback lets the test expose the base's advertised routes before N34 adds the export.
  const n43Writes = new Set(marketplaceExports.MARKETPLACE_N43_WRITES ?? [
    "POST /api/marketplace/listings", "PUT /api/marketplace/listings/:id",
    "DELETE /api/marketplace/listings/:id", "POST /api/marketplace/orders",
  ]);
  gated = new Set(familyKeys.flatMap((keys) => [...keys]).filter((key) => !n43Writes.has(key)));
  const registryKeys = await recordedKeys(registry.registryRoutes);
  const registryExports = registry as unknown as Record<string, readonly string[] | undefined>;
  const attestations = registryExports.REGISTRY_ATTESTATION_ROUTES
    ?? [...registryKeys].filter((key) => key.startsWith("GET /api/registry/attestations"));
  expect(attestations).toHaveLength(2);
  for (const key of attestations) {
    expect(registryKeys.has(key)).toBe(true);
    gated.add(key);
  }
  expect(gated.size).toBeGreaterThan(50);
  app = Fastify({ logger: false });
  await app.register(contextPackRoutes);
  await app.ready();
});

afterAll(async () => { await app?.close(); });

describe("N34 agent context pack", () => {
  it("D1 removes every gated route from the markdown", async () => {
    const res = await app.inject({ method: "GET", url: "/agent-context-pack" });
    expect(res.statusCode).toBe(200);
    const advertised = res.body.split("\n").filter((line) => line.startsWith("| ")).map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return `${cells[1]} ${cells[2]}`;
    });
    expect(advertised.filter((key) => gated.has(key))).toEqual([]);
    const paths = new Set([...gated].map((key) => key.slice(key.indexOf(" ") + 1)));
    for (const path of paths) {
      for (const suffix of [" ", "|", "`", ")", "\n"]) {
        expect(res.body.includes(path + suffix), `${path} followed by ${JSON.stringify(suffix)}`).toBe(false);
      }
      expect(res.body.endsWith(path), path).toBe(false);
    }
  });

  it("D2 removes every gated route from the JSON endpoint groups", async () => {
    const res = await app.inject({ method: "GET", url: "/agent-context-pack.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { endpointGroups: Array<{ endpoints: Array<{ method: string; path: string }> }> };
    const advertised = body.endpointGroups.flatMap((group) => group.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`));
    expect(advertised.filter((key) => gated.has(key))).toEqual([]);
  });

  it("D3 preserves the real route rows and the discovery group", async () => {
    const markdown = await app.inject({ method: "GET", url: "/agent-context-pack" });
    for (const row of [
      "| GET | /api/capabilities |", "| GET | /api/agent/tools |",
      "| POST | /api/negotiate/session |", "| POST | /api/onboard/analyze |",
      "| POST | /api/csd/resolve |",
    ]) expect(markdown.body).toContain(row);
    const json = await app.inject({ method: "GET", url: "/agent-context-pack.json" });
    const body = json.json() as { endpointGroups: Array<{ name: string; endpoints: Array<{ method: string; path: string }> }> };
    const discovery = body.endpointGroups.find((group) => group.name === "Discovery & Marketplace");
    expect(discovery).toBeDefined();
    for (const path of ["/api/capabilities", "/api/kernels"]) {
      expect(discovery!.endpoints.some((endpoint) => endpoint.method === "GET" && endpoint.path === path)).toBe(true);
    }
  });

  it("D4 leaves no markdown endpoint table empty", async () => {
    const res = await app.inject({ method: "GET", url: "/agent-context-pack" });
    const lines = res.body.split("\n");
    const headers = lines.flatMap((line, index) => line === "| Method | Path | Description |" ? [index] : []);
    expect(headers.length).toBeGreaterThan(0);
    for (const index of headers) {
      expect(lines[index + 1]).toBe("|--------|------|-------------|");
      expect(lines[index + 2], `table at markdown line ${index + 1}`).toMatch(/^\| (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \| /);
    }
  });
});

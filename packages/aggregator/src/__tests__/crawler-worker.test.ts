import { describe, it, expect, vi } from "vitest";
import {
  parseCrawlerWorkerConfig,
  runOneCrawl,
} from "../crawler-worker.js";
import { MCPRegistryCrawler } from "../sources/mcp-registry-crawler.js";
import { IndexedToolRegistry } from "../registry.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseCrawlerWorkerConfig", () => {
  it("returns sensible defaults when env is empty", () => {
    const cfg = parseCrawlerWorkerConfig({});
    expect(cfg.intervalMs).toBe(60 * 60 * 1000);
    expect(cfg.registries.sort()).toEqual([
      "glama",
      "mcp.directory",
      "mcp.so",
      "smithery",
    ]);
    expect(cfg.maxServers).toBe(50);
    expect(cfg.runOnce).toBe(false);
  });

  it("respects PCC_CRAWLER_INTERVAL_MS but floors at 1 minute", () => {
    expect(parseCrawlerWorkerConfig({ PCC_CRAWLER_INTERVAL_MS: "120000" }).intervalMs).toBe(
      120_000,
    );
    expect(parseCrawlerWorkerConfig({ PCC_CRAWLER_INTERVAL_MS: "1000" }).intervalMs).toBe(
      60_000,
    );
  });

  it("filters PCC_CRAWLER_REGISTRIES to supported values", () => {
    const cfg = parseCrawlerWorkerConfig({
      PCC_CRAWLER_REGISTRIES: "smithery,bogus, glama  ",
    });
    expect(cfg.registries.sort()).toEqual(["glama", "smithery"]);
  });

  it("falls back to all registries when filter yields zero", () => {
    const cfg = parseCrawlerWorkerConfig({
      PCC_CRAWLER_REGISTRIES: "bogus-only",
    });
    expect(cfg.registries).toHaveLength(4);
  });

  it("sets runOnce when PCC_CRAWLER_RUN_ONCE=1 or true", () => {
    expect(parseCrawlerWorkerConfig({ PCC_CRAWLER_RUN_ONCE: "1" }).runOnce).toBe(true);
    expect(parseCrawlerWorkerConfig({ PCC_CRAWLER_RUN_ONCE: "true" }).runOnce).toBe(true);
    expect(parseCrawlerWorkerConfig({ PCC_CRAWLER_RUN_ONCE: "no" }).runOnce).toBe(false);
  });

  it("forwards PCC_CRAWLER_QUERY and PCC_CRAWLER_MAX_SERVERS", () => {
    const cfg = parseCrawlerWorkerConfig({
      PCC_CRAWLER_QUERY: "vector",
      PCC_CRAWLER_MAX_SERVERS: "3",
    });
    expect(cfg.query).toBe("vector");
    expect(cfg.maxServers).toBe(3);
  });
});

describe("runOneCrawl", () => {
  it("publishes drafts through the 6-stage pipeline into the registry", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://smithery.ai/")) {
        return jsonResponse({
          servers: [
            {
              qualifiedName: "smithery/srv-one",
              connections: [
                {
                  type: "http",
                  deploymentUrl: "https://srv-one.smithery.ai/mcp",
                },
              ],
            },
          ],
        });
      }
      if (url === "https://srv-one.smithery.ai/mcp") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              {
                name: "tool_alpha",
                description: "alpha",
                inputSchema: { type: "object" },
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const crawler = new MCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    });
    const registry = new IndexedToolRegistry();
    const totals = await runOneCrawl(crawler, registry, {
      intervalMs: 60_000,
      registries: ["smithery"],
      maxServers: 50,
      runOnce: true,
    });

    expect(totals.smithery.published).toBe(1);
    expect(registry.count()).toBe(1);
    const all = registry.all();
    expect(all[0]?.upstreamId).toBe("tool_alpha");
    expect(all[0]?.source.type).toBe("smithery");
  });
});

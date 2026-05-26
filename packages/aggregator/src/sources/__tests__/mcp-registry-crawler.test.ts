import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import {
  MCPRegistryCrawler,
  makeMCPRegistryCrawler,
  type SupportedRegistry,
} from "../mcp-registry-crawler.js";
import { McpSourceAdapter } from "../mcp.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SMITHERY_LISTING = {
  servers: [
    {
      qualifiedName: "smithery/example-server-1",
      displayName: "Example Server 1",
      description: "Demo MCP server #1",
      owner: "smithery-bot",
      connections: [
        { type: "http", deploymentUrl: "https://example-1.smithery.ai/mcp" },
      ],
    },
    {
      qualifiedName: "smithery/example-server-2",
      displayName: "Example Server 2",
      connections: [
        { type: "http", deploymentUrl: "https://example-2.smithery.ai/mcp" },
      ],
    },
    {
      // Malformed: no name + no connections — should be skipped.
      description: "should be skipped",
    },
  ],
};

const GLAMA_LISTING = {
  servers: [
    {
      id: "glama-srv-1",
      name: "Glama Server 1",
      description: "From Glama",
      url: "https://srv1.glama.example/mcp",
      owner: "glama-publisher",
    },
    {
      // Missing url — skipped.
      id: "glama-srv-2",
      name: "Glama Server 2",
    },
  ],
};

const MCP_DIRECTORY_LISTING = {
  items: [
    {
      id: "mcpd-1",
      name: "Dir Server 1",
      description: "From mcp.directory",
      install: { url: "https://srv1.mcpdir.example/mcp" },
      owner: "dir-author",
    },
  ],
};

const MCP_SO_LISTING = {
  data: [
    {
      name: "mcp.so Server",
      url: "https://srv1.mcpso.example/mcp",
      description: "From mcp.so",
      author: "so-author",
    },
  ],
};

const TOOLS_LIST_RESPONSE = (toolName: string) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      {
        name: toolName,
        description: `Tool ${toolName}`,
        inputSchema: { type: "object" },
      },
    ],
  },
});

/**
 * Build a fetch mock that routes by URL. The first argument-match wins.
 */
function buildFetchMock(
  routes: Array<{
    match: (url: string) => boolean;
    respond: () => Response | Promise<Response>;
  }>,
): Mock {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const r of routes) {
      if (r.match(url)) return r.respond();
    }
    throw new Error(`unexpected fetch URL in test: ${url}`);
  });
}

describe("MCPRegistryCrawler.crawl", () => {
  it("crawls Smithery listing and harvests tools per server", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://smithery.ai/api/registry/servers"),
        respond: () => jsonResponse(SMITHERY_LISTING),
      },
      {
        match: (u) => u === "https://example-1.smithery.ai/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("smithery_tool_a")),
      },
      {
        match: (u) => u === "https://example-2.smithery.ai/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("smithery_tool_b")),
      },
    ]);

    const crawler = makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    });

    const result = await crawler.crawl("smithery");

    expect(result.drafts).toHaveLength(2);
    expect(result.serversContacted).toBe(2); // malformed server filtered out
    const names = result.drafts.map((d) => d.upstreamId).sort();
    expect(names).toEqual(["smithery_tool_a", "smithery_tool_b"]);
    for (const draft of result.drafts) {
      expect(draft.source.type).toBe("smithery");
    }
  });

  it("crawls Glama listing and ignores entries with missing url", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://glama.ai/mcp/servers"),
        respond: () => jsonResponse(GLAMA_LISTING),
      },
      {
        match: (u) => u === "https://srv1.glama.example/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("glama_tool_x")),
      },
    ]);

    const crawler = makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    });

    const result = await crawler.crawl("glama");

    expect(result.drafts).toHaveLength(1);
    expect(result.serversContacted).toBe(1);
    expect(result.drafts[0]?.source.type).toBe("glama");
    expect(result.drafts[0]?.upstreamId).toBe("glama_tool_x");
  });

  it("crawls mcp.directory listing", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://mcp.directory/api/servers"),
        respond: () => jsonResponse(MCP_DIRECTORY_LISTING),
      },
      {
        match: (u) => u === "https://srv1.mcpdir.example/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("dir_tool_q")),
      },
    ]);

    const crawler = makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    });

    const result = await crawler.crawl("mcp.directory");

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.source.type).toBe("mcp-directory");
  });

  it("crawls mcp.so listing", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://mcp.so/api/servers"),
        respond: () => jsonResponse(MCP_SO_LISTING),
      },
      {
        match: (u) => u === "https://srv1.mcpso.example/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("so_tool_w")),
      },
    ]);

    const crawler = makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    });

    const result = await crawler.crawl("mcp.so");

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.source.type).toBe("mcp-so");
  });

  it("dedups drafts emitted with identical id (placeholder-cid fallback)", async () => {
    // Both servers happen to emit the same tool name; since adapter drafts
    // share a placeholder cid, dedup falls back to id. Because each comes
    // from a different endpoint URL, ids differ — so both survive. To
    // really test dedup, point the listing at the same endpoint twice.
    const sameEndpointListing = {
      servers: [
        {
          qualifiedName: "smithery/dupe-1",
          connections: [
            { type: "http", deploymentUrl: "https://same.smithery.ai/mcp" },
          ],
        },
        {
          qualifiedName: "smithery/dupe-2",
          connections: [
            { type: "http", deploymentUrl: "https://same.smithery.ai/mcp" },
          ],
        },
      ],
    };
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://smithery.ai/api/registry/servers"),
        respond: () => jsonResponse(sameEndpointListing),
      },
      {
        match: (u) => u === "https://same.smithery.ai/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("same_tool")),
      },
    ]);

    const result = await makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    }).crawl("smithery");

    expect(result.serversContacted).toBe(2);
    // Two adapter.fetch() calls => two drafts, both with the same id
    // (mcp:https://same.smithery.ai/mcp#same_tool). Dedup collapses them.
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.upstreamId).toBe("same_tool");
  });

  it("records per-server errors and keeps crawling on dead servers", async () => {
    const listing = {
      servers: [
        {
          qualifiedName: "smithery/healthy",
          connections: [
            { type: "http", deploymentUrl: "https://healthy.smithery.ai/mcp" },
          ],
        },
        {
          qualifiedName: "smithery/dead",
          connections: [
            { type: "http", deploymentUrl: "https://dead.smithery.ai/mcp" },
          ],
        },
      ],
    };
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://smithery.ai/api/registry/servers"),
        respond: () => jsonResponse(listing),
      },
      {
        match: (u) => u === "https://healthy.smithery.ai/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("ok_tool")),
      },
      {
        match: (u) => u === "https://dead.smithery.ai/mcp",
        respond: () => new Response("nope", { status: 503 }),
      },
    ]);

    const result = await makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    }).crawl("smithery");

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.upstreamId).toBe("ok_tool");
    expect(result.errors["server:smithery/dead"]).toMatch(/503/);
  });

  it("returns structured error (no throw) when listing endpoint 5xx's", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://smithery.ai/api/registry/servers"),
        respond: () => new Response("broken", { status: 500 }),
      },
    ]);

    const result = await makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    }).crawl("smithery");

    expect(result.drafts).toHaveLength(0);
    expect(result.serversContacted).toBe(0);
    expect(result.errors["registry:smithery"]).toMatch(/500/);
  });

  it("returns structured error on Smithery 401 (auth-failure fallback)", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://smithery.ai/api/registry/servers"),
        respond: () =>
          new Response("unauthorized", {
            status: 401,
            statusText: "Unauthorized",
          }),
      },
    ]);

    const result = await makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    }).crawl("smithery");

    expect(result.drafts).toHaveLength(0);
    expect(result.errors["registry:smithery"]).toMatch(/401/);
    expect(result.errors["registry:smithery"]).toMatch(/auth required/i);
  });

  it("returns structured error on 429 (rate limit) — preserving partial progress", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://mcp.so/api/servers"),
        respond: () =>
          new Response("rate limited", {
            status: 429,
            statusText: "Too Many Requests",
          }),
      },
    ]);

    const result = await makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    }).crawl("mcp.so");

    expect(result.drafts).toHaveLength(0);
    expect(result.errors["registry:mcp.so"]).toMatch(/rate-limited/);
  });

  it("honors the maxServers cap", async () => {
    const many = {
      servers: Array.from({ length: 5 }, (_, i) => ({
        qualifiedName: `smithery/srv-${i}`,
        connections: [
          { type: "http", deploymentUrl: `https://srv-${i}.smithery.ai/mcp` },
        ],
      })),
    };
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://smithery.ai/api/registry/servers"),
        respond: () => jsonResponse(many),
      },
      {
        match: (u) => u.includes(".smithery.ai/mcp"),
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("t")),
      },
    ]);

    const result = await makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxServers: 2,
      perServerDelayMs: 0,
    }).crawl("smithery");

    expect(result.serversContacted).toBe(2);
  });

  it("uses an injected mcpAdapterFactory (test seam)", async () => {
    const fakeFactory = vi.fn(
      (sourceType: import("@pcc/spec").ToolSourceType) =>
        new McpSourceAdapter({ sourceType }),
    );
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://glama.ai/mcp/servers"),
        respond: () => jsonResponse(GLAMA_LISTING),
      },
      {
        match: (u) => u === "https://srv1.glama.example/mcp",
        respond: () => jsonResponse(TOOLS_LIST_RESPONSE("inj_tool")),
      },
    ]);

    const crawler = new MCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
      mcpAdapterFactory: fakeFactory,
    });
    await crawler.crawl("glama");
    expect(fakeFactory).toHaveBeenCalledTimes(1);
    expect(fakeFactory).toHaveBeenCalledWith("glama", "glama-publisher");
  });

  it("sends Authorization header to Smithery when API key is set", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://smithery.ai/")) {
        const auth = (init?.headers as Record<string, string> | undefined)?.[
          "Authorization"
        ];
        expect(auth).toBe("Bearer test-key-abc");
        return jsonResponse({ servers: [] });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const crawler = makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      smitheryApiKey: "test-key-abc",
      perServerDelayMs: 0,
    });
    await crawler.crawl("smithery");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("appends ?q= when query is set", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("q=")) {
        expect(url).toContain("q=embedding");
        return jsonResponse({ servers: [] });
      }
      throw new Error(`expected query string, got ${url}`);
    });

    const crawler = makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      query: "embedding",
      perServerDelayMs: 0,
    });
    await crawler.crawl("smithery");
  });
});

describe("MCPRegistryCrawler.crawlAll", () => {
  it("crawls every supported registry sequentially", async () => {
    const fetchMock = buildFetchMock([
      {
        match: (u) => u.startsWith("https://smithery.ai/"),
        respond: () => jsonResponse({ servers: [] }),
      },
      {
        match: (u) => u.startsWith("https://glama.ai/"),
        respond: () => jsonResponse({ servers: [] }),
      },
      {
        match: (u) => u.startsWith("https://mcp.directory/"),
        respond: () => jsonResponse({ items: [] }),
      },
      {
        match: (u) => u.startsWith("https://mcp.so/"),
        respond: () => jsonResponse({ data: [] }),
      },
    ]);

    const out = await makeMCPRegistryCrawler({
      fetchImpl: fetchMock as unknown as typeof fetch,
      perServerDelayMs: 0,
    }).crawlAll();

    const registries = Object.keys(out).sort() as SupportedRegistry[];
    expect(registries).toEqual(
      ["glama", "mcp.directory", "mcp.so", "smithery"] as SupportedRegistry[],
    );
    for (const reg of registries) {
      expect(out[reg].drafts).toHaveLength(0);
    }
  });
});

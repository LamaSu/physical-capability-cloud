import { describe, it, expect, vi } from "vitest";
import { McpSourceAdapter, makeMcpSourceAdapter } from "../mcp.js";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

describe("McpSourceAdapter.fetch", () => {
  it("parses tools/list response into draft IndexedTools", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            {
              name: "search_papers",
              description: "Search academic papers by keyword",
              inputSchema: { type: "object", properties: { q: { type: "string" } } },
            },
            {
              name: "delete_record",
              description: "Permanently delete a record by id",
              inputSchema: { type: "object", properties: { id: { type: "string" } } },
            },
            {
              name: "run_simulation",
              description: "Run a Monte Carlo simulation",
              inputSchema: { type: "object" },
            },
          ],
        },
      }),
    );

    const adapter = makeMcpSourceAdapter();
    const drafts = await adapter.fetch({
      url: "https://mcp.example.com/server",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(drafts).toHaveLength(3);
    expect(drafts[0]?.upstreamId).toBe("search_papers");
    expect(drafts[0]?.actionClass).toBe("read");
    expect(drafts[1]?.actionClass).toBe("write");
    expect(drafts[2]?.actionClass).toBe("exec");
    expect(drafts[0]?.ingestionMethod).toBe("mcp-list");
    expect(drafts[0]?.id).toContain("search_papers");
    expect(drafts[0]?.skills).toEqual(["search_papers"]);
  });

  it("auto-summarizes long descriptions", async () => {
    const longDesc = "This is a description. ".repeat(50);
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        result: { tools: [{ name: "t1", description: longDesc, inputSchema: {} }] },
      }),
    );
    const drafts = await makeMcpSourceAdapter().fetch({
      url: "https://x",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(drafts[0]?.description.length).toBeLessThanOrEqual(280);
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      makeMcpSourceAdapter().fetch({
        url: "https://broken",
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/500/);
  });

  it("throws on JSON-RPC error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "method not found" },
      }),
    );
    await expect(
      makeMcpSourceAdapter().fetch({
        url: "https://x",
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/method not found/);
  });

  it("skips malformed tool entries instead of throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        result: {
          tools: [
            { description: "no name" }, // skipped
            { name: "valid_tool", inputSchema: {} },
          ],
        },
      }),
    );
    const drafts = await makeMcpSourceAdapter().fetch({
      url: "https://x",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.upstreamId).toBe("valid_tool");
  });

  it("custom sourceType is honored", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        result: { tools: [{ name: "t", inputSchema: {} }] },
      }),
    );
    const drafts = await new McpSourceAdapter({
      sourceType: "smithery",
      upstreamVendor: "Smithery, Inc.",
    }).fetch({
      url: "https://x",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(drafts[0]?.source.type).toBe("smithery");
    expect(drafts[0]?.upstreamVendor).toBe("Smithery, Inc.");
  });
});

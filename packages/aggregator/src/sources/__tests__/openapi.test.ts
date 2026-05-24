import { describe, it, expect, vi } from "vitest";
import { OpenApiSourceAdapter, makeOpenApiSourceAdapter } from "../openapi.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_DOC = {
  openapi: "3.0.0",
  info: { title: "Sample API", version: "1.2.3" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/users": {
      get: {
        operationId: "listUsers",
        summary: "List all users",
        tags: ["users"],
      },
      post: {
        operationId: "createUser",
        summary: "Create a new user",
        tags: ["users"],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } } },
            },
          },
        },
      },
    },
    "/users/{id}": {
      get: { operationId: "getUser", summary: "Get a user by id" },
      delete: { operationId: "deleteUser", summary: "Delete a user" },
    },
  },
};

describe("OpenApiSourceAdapter.fetch", () => {
  it("parses every operation into a draft IndexedTool", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_DOC));
    const drafts = await makeOpenApiSourceAdapter().fetch({
      url: "https://api.example.com/openapi.json",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(drafts).toHaveLength(4);
    const ids = drafts.map((d) => d.upstreamId);
    expect(ids).toContain("listUsers");
    expect(ids).toContain("createUser");
    expect(ids).toContain("getUser");
    expect(ids).toContain("deleteUser");
  });

  it("HTTP methods map to actionClass", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_DOC));
    const drafts = await makeOpenApiSourceAdapter().fetch({
      url: "https://api.example.com/openapi.json",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(drafts.find((d) => d.upstreamId === "listUsers")?.actionClass).toBe(
      "read",
    );
    expect(drafts.find((d) => d.upstreamId === "createUser")?.actionClass).toBe(
      "write",
    );
    expect(drafts.find((d) => d.upstreamId === "deleteUser")?.actionClass).toBe(
      "write",
    );
  });

  it("upstreamUrl joins server.url + path", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_DOC));
    const drafts = await makeOpenApiSourceAdapter().fetch({
      url: "https://api.example.com/openapi.json",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(
      drafts.find((d) => d.upstreamId === "listUsers")?.upstreamUrl,
    ).toBe("https://api.example.com/v1/users");
    expect(
      drafts.find((d) => d.upstreamId === "getUser")?.upstreamUrl,
    ).toBe("https://api.example.com/v1/users/{id}");
  });

  it("synthesizes operationId from method+path when missing", async () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "X" },
      servers: [{ url: "https://x" }],
      paths: {
        "/items": {
          get: { summary: "list items" },
        },
      },
    };
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(doc));
    const drafts = await makeOpenApiSourceAdapter().fetch({
      url: "https://x/openapi.json",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.upstreamId).toMatch(/get_/);
  });

  it("source.type defaults to openapi-doc, can override", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse(SAMPLE_DOC));
    const a = await makeOpenApiSourceAdapter().fetch({
      url: "https://x",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(a[0]?.source.type).toBe("openapi-doc");

    const b = await new OpenApiSourceAdapter({
      sourceType: "apis-guru",
    }).fetch({
      url: "https://x",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(b[0]?.source.type).toBe("apis-guru");
  });

  it("rejects non-OpenAPI documents", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ foo: "bar" }));
    await expect(
      makeOpenApiSourceAdapter().fetch({
        url: "https://nope",
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Not an OpenAPI/);
  });

  it("propagates HTTP errors", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(
      makeOpenApiSourceAdapter().fetch({
        url: "https://nope",
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/404/);
  });

  it("version is read from info.version when available", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_DOC));
    const drafts = await makeOpenApiSourceAdapter().fetch({
      url: "https://x",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(drafts[0]?.version).toBe("1.2.3");
  });
});

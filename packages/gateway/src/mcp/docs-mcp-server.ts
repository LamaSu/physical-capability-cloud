/**
 * Public "docs" MCP surface — the second, read-only MCP transport PCC
 * advertises alongside the product `/mcp` server (see http-mcp-server.ts).
 * Where `/mcp` lets an agent DO things (discover, negotiate, settle),
 * `/mcp/docs` lets an agent LEARN things: real PCC documentation exposed as
 * MCP resources, plus a `search_docs` tool. No auth, no upstream API calls,
 * no write paths — every handler only ever reads files already committed to
 * the repo, or the gateway's own live OpenAPI description.
 *
 * Deliberately NOT sourced from the repo-root CLAUDE.md: that file carries
 * internal harness/ops directives (deploy-pipeline internals, infra hosts,
 * security-scanner thresholds) that must not be exposed on an unauthenticated
 * public endpoint. docs/AGENT_INTEGRATION.md is the doc that self-identifies
 * as the public, agent-facing integration reference — its own header points
 * *away* from CLAUDE.md ("For a quick primer + MANDATORY project rules, see
 * CLAUDE.md"), i.e. CLAUDE.md is the internal primer and this is the external
 * one — so it is the correct, safe source for docs://pcc/agent-guide.
 *
 * Session plumbing intentionally duplicates (rather than shares) the small
 * amount of Streamable HTTP boilerplate in http-mcp-server.ts: that surface
 * is authenticated/proxying and load-bearing, and this one is public/
 * read-only with no bearer-auth passthrough — keeping them independent means
 * a change to one can never regress the other.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
// Side-effect import: pulls in @fastify/swagger's `declare module "fastify"`
// augmentation (adds FastifyInstance.swagger()) so app.swagger() below
// type-checks even in isolation from server.ts, which registers the plugin.
import "@fastify/swagger";
import { z } from "zod";
import { loadAgentPackage, PCC_MCP_ICON_URL } from "./http-mcp-server.js";
import { resolveGatewayAsset } from "./mcp-app-view.js";

export const DOCS_MOUNT_PATH = "/mcp/docs";
const DOCS_SESSION_TTL_MS = 10 * 60 * 1000;
const DOCS_MAX_SESSIONS = 50;

export const DOCS_AGENT_GUIDE_URI = "docs://pcc/agent-guide";
export const DOCS_API_URI = "docs://pcc/api";
export const DOCS_QUICKSTART_URI = "docs://pcc/quickstart";

interface ProseDoc {
  uri: string;
  name: string;
  title: string;
  description: string;
  /** Repo-root-relative path segments, resolved via resolveGatewayAsset. */
  segments: string[];
  envVarOverride: string;
}

// The two prose docs — real files already in the repo, read fresh on every
// resource/search call (same "discovery follows updates" choice
// loadAgentPackage() and mcp-app-view.ts's readPccUiKitSource() make).
const PROSE_DOCS: ProseDoc[] = [
  {
    uri: DOCS_AGENT_GUIDE_URI,
    name: "pcc-agent-guide",
    title: "PCC Agent Integration Guide",
    description:
      "Full API reference, DTOs, MCP tools, operator onboarding, and environment variables for " +
      "agents integrating with the PCC gateway.",
    segments: ["docs", "AGENT_INTEGRATION.md"],
    envVarOverride: "PCC_DOC_AGENT_GUIDE_PATH",
  },
  {
    uri: DOCS_QUICKSTART_URI,
    name: "pcc-quickstart",
    title: "PCC Quickstarts",
    description:
      "Pick-your-surface quickstart index: Claude Code, Claude Desktop, and Claude.ai web.",
    segments: ["docs", "quickstart", "README.md"],
    envVarOverride: "PCC_DOC_QUICKSTART_PATH",
  },
];

function readProseDoc(doc: ProseDoc): string {
  return readFileSync(resolveGatewayAsset(doc.segments, doc.envVarOverride), "utf8");
}

function registerDocsResources(server: McpServer, app: FastifyInstance): void {
  for (const doc of PROSE_DOCS) {
    server.registerResource(
      doc.name,
      doc.uri,
      { title: doc.title, description: doc.description, mimeType: "text/markdown" },
      async () => ({
        contents: [{ uri: doc.uri, mimeType: "text/markdown", text: readProseDoc(doc) }],
      }),
    );
  }

  // The API reference resource is the gateway's OWN live OpenAPI 3.0
  // description (same document served at GET /openapi.json) rather than a
  // hand-maintained markdown copy — zero drift risk, and it is generated
  // fresh per read from whatever routes are actually registered.
  server.registerResource(
    "pcc-api-reference",
    DOCS_API_URI,
    {
      title: "PCC API Reference (OpenAPI)",
      description:
        "The gateway's live OpenAPI 3.0 description — every real HTTP endpoint and schema, " +
        "generated at request time from the running routes. Same document as GET /openapi.json.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: DOCS_API_URI,
          mimeType: "application/json",
          text: JSON.stringify(app.swagger()),
        },
      ],
    }),
  );
}

function registerSearchDocsTool(server: McpServer): void {
  server.registerTool(
    "search_docs",
    {
      title: "Search PCC docs",
      description:
        "Case-insensitive full-text search across PCC's public prose documentation " +
        `(${DOCS_AGENT_GUIDE_URI}, ${DOCS_QUICKSTART_URI}) — returns matching lines with their ` +
        "source URI and line number.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Text to search for."),
      },
    },
    async ({ query }) => {
      const needle = query.toLowerCase();
      const hits: string[] = [];
      for (const doc of PROSE_DOCS) {
        const lines = readProseDoc(doc).split("\n");
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(needle)) {
            hits.push(`${doc.uri}:${index + 1}: ${line.trim()}`);
          }
        });
      }
      const text = hits.length
        ? hits.slice(0, 25).join("\n")
        : `No matches for "${query}" in ${PROSE_DOCS.map((d) => d.uri).join(", ")}.`;
      return { content: [{ type: "text" as const, text }] };
    },
  );
}

function createDocsMcpServer(app: FastifyInstance, version: string): McpServer {
  const server = new McpServer(
    {
      name: "Physical Capability Cloud Docs",
      title: "PCC Documentation",
      version,
      description:
        "Read-only documentation surface for the Physical Capability Cloud — the agent " +
        "integration guide, live OpenAPI reference, and quickstarts, as MCP resources. " +
        "For the tools that DO things (discover, negotiate, settle), see the product MCP server.",
      icons: [{ src: PCC_MCP_ICON_URL, mimeType: "image/svg+xml" }],
    },
    { capabilities: { resources: {}, tools: {} } },
  );
  registerDocsResources(server, app);
  registerSearchDocsTool(server);
  return server;
}

// ---------------------------------------------------------------------------
// Streamable HTTP session plumbing — same shape as http-mcp-server.ts's
// proven implementation (session map keyed by mcp-session-id, TTL prune,
// slot eviction, CORS, hijack-and-hand-off to the SDK transport), scaled
// down: no bearer-auth attach, since this transport never calls upstream.
// ---------------------------------------------------------------------------

interface DocsSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastAccessAt: number;
}

function setDocsCorsHeaders(reply: FastifyReply): void {
  reply.raw.setHeader("access-control-allow-origin", "*");
  reply.raw.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  reply.raw.setHeader(
    "access-control-allow-headers",
    "Accept, Authorization, Content-Type, Last-Event-ID, Mcp-Protocol-Version, Mcp-Session-Id",
  );
  reply.raw.setHeader("access-control-expose-headers", "Mcp-Protocol-Version, Mcp-Session-Id");
}

function docsHeaderValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendDocsJsonRpcError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) return;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
  );
}

/** Public, read-only Streamable HTTP MCP transport for PCC's documentation.
 * Register before the gateway API auth gate — docs are public. */
export async function docsHttpMcpRoutes(app: FastifyInstance): Promise<void> {
  const sessions = new Map<string, DocsSession>();
  const packVersion = loadAgentPackage().version;

  const closeSessions = async (entries: DocsSession[]): Promise<void> => {
    await Promise.allSettled(entries.map(({ server }) => server.close()));
  };

  const pruneExpiredSessions = async (): Promise<void> => {
    const cutoff = Date.now() - DOCS_SESSION_TTL_MS;
    const expired: DocsSession[] = [];
    for (const [sessionId, session] of sessions) {
      if (session.lastAccessAt > cutoff) continue;
      sessions.delete(sessionId);
      expired.push(session);
    }
    await closeSessions(expired);
  };

  const reserveSessionSlot = async (): Promise<void> => {
    if (sessions.size < DOCS_MAX_SESSIONS) return;
    const oldest = [...sessions.entries()].sort(
      ([, left], [, right]) => left.lastAccessAt - right.lastAccessAt,
    )[0];
    if (!oldest) return;
    sessions.delete(oldest[0]);
    await closeSessions([oldest[1]]);
  };

  app.options(DOCS_MOUNT_PATH, async (_request, reply) => {
    setDocsCorsHeaders(reply);
    return reply.status(204).send();
  });

  app.post<{ Body: unknown }>(DOCS_MOUNT_PATH, async (request, reply) => {
    setDocsCorsHeaders(reply);
    await pruneExpiredSessions();

    const sessionId = docsHeaderValue(request, "mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) session.lastAccessAt = Date.now();

    if (!session && !sessionId && isInitializeRequest(request.body)) {
      await reserveSessionSlot();
      const server = createDocsMcpServer(app, packVersion);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, {
            server,
            transport,
            lastAccessAt: Date.now(),
          });
        },
      });
      transport.onclose = () => {
        const initializedSessionId = transport.sessionId;
        if (initializedSessionId) sessions.delete(initializedSessionId);
      };
      await server.connect(transport);
      session = { server, transport, lastAccessAt: Date.now() };
    }

    if (!session) {
      return reply.status(sessionId ? 404 : 400).send({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: sessionId
            ? "Bad Request: Invalid MCP session ID"
            : "Bad Request: Initialize the MCP session first",
        },
        id: null,
      });
    }

    reply.hijack();
    try {
      await session.transport.handleRequest(
        request.raw as IncomingMessage,
        reply.raw,
        request.body,
      );
    } catch (error) {
      request.log.error({ err: error }, "Docs Streamable HTTP MCP request failed");
      sendDocsJsonRpcError(reply.raw, 500, "Internal MCP server error");
    }
  });

  app.get(DOCS_MOUNT_PATH, async (request, reply) => {
    setDocsCorsHeaders(reply);
    await pruneExpiredSessions();
    const sessionId = docsHeaderValue(request, "mcp-session-id");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session ID" },
        id: null,
      });
    }
    session.lastAccessAt = Date.now();

    reply.hijack();
    try {
      await session.transport.handleRequest(request.raw as IncomingMessage, reply.raw);
    } catch (error) {
      request.log.error({ err: error }, "Docs Streamable HTTP MCP SSE request failed");
      sendDocsJsonRpcError(reply.raw, 500, "Internal MCP server error");
    }
  });

  app.delete(DOCS_MOUNT_PATH, async (request, reply) => {
    setDocsCorsHeaders(reply);
    await pruneExpiredSessions();
    const sessionId = docsHeaderValue(request, "mcp-session-id");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      return reply.status(400).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session ID" },
        id: null,
      });
    }
    session.lastAccessAt = Date.now();

    reply.hijack();
    try {
      await session.transport.handleRequest(request.raw as IncomingMessage, reply.raw);
    } catch (error) {
      request.log.error({ err: error }, "Docs Streamable HTTP MCP delete failed");
      sendDocsJsonRpcError(reply.raw, 500, "Internal MCP server error");
    }
  });

  app.addHook("onClose", async () => {
    const activeSessions = [...sessions.values()];
    sessions.clear();
    await closeSessions(activeSessions);
  });
}

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildRenderDashboardTool,
  enrichOnRampToolResult,
  handleRenderDashboardTool,
  isOnRampUiTool,
  onRampToolUiMeta,
  registerMcpAppDashboardSlugResource,
  registerMcpAppHttpRoute,
  registerMcpAppResource,
  RENDER_DASHBOARD_TOOL_NAME,
} from "./mcp-app-view.js";

const PCC_API_BASE_URL = "https://capability.network";
const MCP_SESSION_TTL_MS = 10 * 60 * 1000;
const MCP_MAX_SESSIONS = 100;
const MCP_INSTRUCTIONS =
  "Discover PCC capabilities before committing work. Use read-only catalog tools first, " +
  "confirm configuration and pricing with the user before write operations, and verify " +
  "job evidence before reporting physical work complete. Protected PCC API operations " +
  "require a Bearer key provisioned through POST /api/auth/provision.";

type JsonObject = Record<string, unknown>;
type EndpointMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface AgentPackageTool {
  name: string;
  description: string;
  input_schema: Tool["inputSchema"];
  endpoint: {
    method: EndpointMethod;
    path: string;
  };
}

export interface AgentPackage {
  name: string;
  version: string;
  description: string;
  tools: AgentPackageTool[];
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastAccessAt: number;
}

type McpIncomingMessage = IncomingMessage & { auth?: AuthInfo };

function resolveAgentPackagePath(): string {
  const override = process.env.PCC_AGENT_PACKAGE_PATH;
  if (override && existsSync(override)) return resolvePath(override);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolvePath(
      here,
      "..",
      "..",
      "..",
      "..",
      "apps",
      "dashboard",
      "public",
      "agent-package.json",
    ),
    resolvePath(
      here,
      "..",
      "..",
      "..",
      "apps",
      "dashboard",
      "public",
      "agent-package.json",
    ),
    resolvePath(
      process.cwd(),
      "apps",
      "dashboard",
      "public",
      "agent-package.json",
    ),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "agent-package.json was not found; set PCC_AGENT_PACKAGE_PATH to its absolute path",
    );
  }
  return found;
}

/** Load the canonical pack on every request so discovery follows pack updates. */
export function loadAgentPackage(): AgentPackage {
  const raw = JSON.parse(
    readFileSync(resolveAgentPackagePath(), "utf8"),
  ) as Partial<AgentPackage>;

  if (
    typeof raw.name !== "string" ||
    typeof raw.version !== "string" ||
    typeof raw.description !== "string" ||
    !Array.isArray(raw.tools)
  ) {
    throw new Error("agent-package.json does not have the expected package shape");
  }

  return raw as AgentPackage;
}

function toolDescription(tool: AgentPackageTool): string {
  const description = tool.description.trim();
  return description.length >= 20
    ? description
    : `${description.replace(/[.\s]+$/u, "")}. Invoke the corresponding PCC API operation.`;
}

function toMcpTool(tool: AgentPackageTool): Tool {
  const method = tool.endpoint.method;
  return {
    name: tool.name,
    description: toolDescription(tool),
    inputSchema: tool.input_schema,
    annotations: {
      readOnlyHint: method === "GET",
      destructiveHint: method === "DELETE",
    },
    // MCP Apps: the 5 On-Ramp dashboard tools render UI. Declaring
    // `_meta.ui.resourceUri` = the ui://pcc/dashboard/{slug} template on the
    // tools/list definition lets a host know the tool is UI-bearing before it
    // is ever called; the concrete per-slug view is carried on the call result.
    ...(isOnRampUiTool(tool.name) ? { _meta: onRampToolUiMeta() } : {}),
  };
}

function encodeQueryValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => encodeQueryValue(item));
  }
  if (value !== null && typeof value === "object") {
    return [JSON.stringify(value)];
  }
  return [String(value)];
}

function buildProxyRequest(
  tool: AgentPackageTool,
  rawArguments: JsonObject,
): { url: URL; body?: string } | { error: string } {
  const args = { ...rawArguments };
  let endpointPath = tool.endpoint.path;
  if (/^https?:\/\//iu.test(endpointPath)) {
    const packedUrl = new URL(endpointPath);
    endpointPath = `${packedUrl.pathname}${packedUrl.search}`;
  }
  const pathParameters = new Set<string>();

  for (const match of endpointPath.matchAll(/\{([^}]+)\}/gu)) {
    pathParameters.add(match[1]);
  }
  for (const match of endpointPath.matchAll(/\/:([A-Za-z0-9_]+)/gu)) {
    pathParameters.add(match[1]);
  }

  for (const name of pathParameters) {
    const value = args[name];
    if (value === undefined || value === null || value === "") {
      return { error: `Missing required path parameter: ${name}` };
    }
    const encoded = encodeURIComponent(String(value));
    endpointPath = endpointPath
      .replaceAll(`{${name}}`, encoded)
      .replace(new RegExp(`:${name}(?=/|$)`, "gu"), encoded);
    delete args[name];
  }

  const url = new URL(endpointPath, PCC_API_BASE_URL);
  if (url.origin !== PCC_API_BASE_URL) {
    return { error: `PCC tool endpoint escaped the configured API origin: ${endpointPath}` };
  }
  if (tool.endpoint.method === "GET" || tool.endpoint.method === "DELETE") {
    for (const [name, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      for (const encodedValue of encodeQueryValue(value)) {
        url.searchParams.append(name, encodedValue);
      }
    }
    return { url };
  }

  return { url, body: JSON.stringify(args) };
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

async function readUpstreamPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return { status: response.status };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

async function proxyToolCall(
  tool: AgentPackageTool,
  rawArguments: JsonObject,
  token: string | undefined,
  signal: AbortSignal,
) {
  const proxyRequest = buildProxyRequest(tool, rawArguments);
  if ("error" in proxyRequest) return errorResult(proxyRequest.error);

  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (proxyRequest.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  try {
    const response = await fetch(proxyRequest.url, {
      method: tool.endpoint.method,
      headers,
      body: proxyRequest.body,
      signal,
    });
    const payload = await readUpstreamPayload(response);

    if (!response.ok) {
      if (response.status === 401 && !token) {
        return errorResult(
          `Authentication required for ${tool.name}. Provision a PCC Bearer key with ` +
            `POST /api/auth/provision, then retry this MCP call with Authorization: Bearer <key>. ` +
            `Upstream response: ${resultText(payload)}`,
        );
      }
      return errorResult(
        `PCC API request failed with HTTP ${response.status}: ${resultText(payload)}`,
      );
    }

    // On-Ramp UI tools additionally carry an MCP-Apps resource_link (and, for
    // the single-artifact tools, `_meta.ui.resourceUri`) to the saved-dashboard
    // view — IN ADDITION to the text below, so text-only consumers are intact.
    const text = resultText(payload);
    if (isOnRampUiTool(tool.name)) {
      return enrichOnRampToolResult(tool.name, payload, text);
    }
    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (error) {
    return errorResult(
      `PCC API request could not be completed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Served, verified-200 icon for the product surface AND the docs surface
 * (see docs-mcp-server.ts) — same asset apps/dashboard/public/pcc-icon.svg
 * that /.well-known/mcp/server-card.json's `logo`/`icon` fields already
 * reference. Kept as one constant so a future icon swap only edits one line. */
export const PCC_MCP_ICON_URL = `${PCC_API_BASE_URL}/pcc-icon.svg`;

function createMcpServer(pack: AgentPackage): McpServer {
  const toolsByName = new Map(pack.tools.map((tool) => [tool.name, tool]));
  const server = new McpServer(
    {
      name: "Physical Capability Cloud",
      // Registry-branding fields carried directly on Implementation (NOT
      // under _meta — ImplementationSchema has no _meta key; title/
      // description/icons are first-class fields), so a scanner reading the
      // live `initialize` handshake sees name+icon+description without
      // needing a second request to server-card.json.
      title: "Physical Capability Cloud",
      version: pack.version,
      description: pack.description,
      icons: [{ src: PCC_MCP_ICON_URL, mimeType: "image/svg+xml" }],
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...pack.tools.map(toMcpTool), buildRenderDashboardTool()],
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const rawArguments = request.params.arguments;

    if (typeof name !== "string" || name.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid params: tool name is required");
    }
    if (
      rawArguments !== undefined &&
      (typeof rawArguments !== "object" || rawArguments === null || Array.isArray(rawArguments))
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid params: arguments for "${name}" must be an object`,
      );
    }
    const args = rawArguments ?? {};

    if (name === RENDER_DASHBOARD_TOOL_NAME) {
      return handleRenderDashboardTool(args);
    }

    const tool = toolsByName.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Method not found: unknown PCC tool "${name}"`);
    }
    return proxyToolCall(tool, args, extra.authInfo?.token, extra.signal);
  });

  registerMcpAppResource(server);
  registerMcpAppDashboardSlugResource(server);

  return server;
}

function setCorsHeaders(reply: FastifyReply): void {
  reply.raw.setHeader("access-control-allow-origin", "*");
  reply.raw.setHeader(
    "access-control-allow-methods",
    "GET, POST, DELETE, OPTIONS",
  );
  reply.raw.setHeader(
    "access-control-allow-headers",
    "Accept, Authorization, Content-Type, Last-Event-ID, Mcp-Protocol-Version, Mcp-Session-Id",
  );
  reply.raw.setHeader(
    "access-control-expose-headers",
    "Mcp-Protocol-Version, Mcp-Session-Id",
  );
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function attachBearerAuth(request: FastifyRequest): void {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  if (!match) return;

  (request.raw as McpIncomingMessage).auth = {
    token: match[1].trim(),
    clientId: "pcc-streamable-http",
    scopes: [],
  };
}

function sendJsonRpcError(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  if (response.headersSent) return;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/** Public Streamable HTTP MCP transport. Register before the gateway API auth gate. */
export async function httpMcpRoutes(app: FastifyInstance): Promise<void> {
  const sessions = new Map<string, McpSession>();

  registerMcpAppHttpRoute(app);

  const closeSessions = async (entries: McpSession[]): Promise<void> => {
    await Promise.allSettled(entries.map(({ server }) => server.close()));
  };

  const pruneExpiredSessions = async (): Promise<void> => {
    const cutoff = Date.now() - MCP_SESSION_TTL_MS;
    const expired: McpSession[] = [];
    for (const [sessionId, session] of sessions) {
      if (session.lastAccessAt > cutoff) continue;
      sessions.delete(sessionId);
      expired.push(session);
    }
    await closeSessions(expired);
  };

  const reserveSessionSlot = async (): Promise<void> => {
    if (sessions.size < MCP_MAX_SESSIONS) return;
    const oldest = [...sessions.entries()].sort(
      ([, left], [, right]) => left.lastAccessAt - right.lastAccessAt,
    )[0];
    if (!oldest) return;
    sessions.delete(oldest[0]);
    await closeSessions([oldest[1]]);
  };

  app.options("/mcp", async (_request, reply) => {
    setCorsHeaders(reply);
    return reply.status(204).send();
  });

  app.post<{ Body: unknown }>("/mcp", async (request, reply) => {
    setCorsHeaders(reply);
    attachBearerAuth(request);
    await pruneExpiredSessions();

    const sessionId = headerValue(request, "mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) session.lastAccessAt = Date.now();

    if (!session && !sessionId && isInitializeRequest(request.body)) {
      await reserveSessionSlot();
      const pack = loadAgentPackage();
      const server = createMcpServer(pack);
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
        request.raw as McpIncomingMessage,
        reply.raw,
        request.body,
      );
    } catch (error) {
      request.log.error({ err: error }, "Streamable HTTP MCP request failed");
      sendJsonRpcError(reply.raw, 500, "Internal MCP server error");
    }
  });

  app.get("/mcp", async (request, reply) => {
    setCorsHeaders(reply);
    attachBearerAuth(request);
    await pruneExpiredSessions();
    const sessionId = headerValue(request, "mcp-session-id");
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
      await session.transport.handleRequest(
        request.raw as McpIncomingMessage,
        reply.raw,
      );
    } catch (error) {
      request.log.error({ err: error }, "Streamable HTTP MCP SSE request failed");
      sendJsonRpcError(reply.raw, 500, "Internal MCP server error");
    }
  });

  app.delete("/mcp", async (request, reply) => {
    setCorsHeaders(reply);
    attachBearerAuth(request);
    await pruneExpiredSessions();
    const sessionId = headerValue(request, "mcp-session-id");
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
      await session.transport.handleRequest(
        request.raw as McpIncomingMessage,
        reply.raw,
      );
    } catch (error) {
      request.log.error({ err: error }, "Streamable HTTP MCP delete failed");
      sendJsonRpcError(reply.raw, 500, "Internal MCP server error");
    }
  });

  app.addHook("onClose", async () => {
    const activeSessions = [...sessions.values()];
    sessions.clear();
    await closeSessions(activeSessions);
  });
}

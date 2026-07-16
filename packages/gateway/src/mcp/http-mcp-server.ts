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
  isMcpAppSurfaceAvailable,
  isOnRampUiTool,
  MCP_APP_SURFACE_UNAVAILABLE_MESSAGE,
  onRampToolOutputSchema,
  onRampToolUiMeta,
  primeMcpAppAssets,
  registerMcpAppHttpRoute,
  registerMcpAppResources,
  RENDER_DASHBOARD_TOOL_NAME,
} from "./mcp-app-view.js";
import { resolveApiKeyFromToken } from "../auth/api-key-auth.js";
import {
  getOperationPolicyByToolName,
  typedOperationTools,
  TYPED_OP_TOOL_PREFIX,
  type OpPrincipal,
} from "./operation-policy.js";
import { resolveMcpApiBase, mcpApiBaseUnavailableMessage } from "./mcp-api-base.js";

// Branding only (server-card icon) — NOT the proxy data plane. The upstream API
// origin the proxy forwards to is resolved per-request via resolveMcpApiBase()
// (validated, environment-local, fail-closed); see mcp-api-base.ts.
const PCC_PUBLIC_ORIGIN = "https://capability.network";
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
  const mcpTool: Tool = {
    name: tool.name,
    description: toolDescription(tool),
    inputSchema: tool.input_schema,
    annotations: {
      readOnlyHint: method === "GET",
      destructiveHint: method === "DELETE",
    },
  };
  if (isOnRampUiTool(tool.name)) {
    // MCP Apps: the 5 On-Ramp dashboard tools render UI. Declare the FIXED,
    // predeclared ui:// resource on the tools/list definition (saved for the
    // single-artifact tools, gallery for search — never a {slug} template) so a
    // host can tell the tool is UI-bearing and prefetch the view before ever
    // calling it, plus an outputSchema for the structuredContent the call
    // returns (which the fixed view renders over the lifecycle).
    mcpTool._meta = onRampToolUiMeta(tool.name);
    mcpTool.outputSchema = onRampToolOutputSchema(tool.name) as unknown as Tool["outputSchema"];
  }
  return mcpTool;
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
  base: string,
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

  const url = new URL(endpointPath, base);
  if (url.origin !== base) {
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
  readOnlySurface = false,
) {
  // Fail closed: never fall back to production. resolveMcpApiBase() validates +
  // environment-isolates the upstream origin; an unavailable base disables the
  // proxy rather than silently forwarding the caller's bearer to prod.
  const baseResolution = resolveMcpApiBase();
  if ("error" in baseResolution) return errorResult(baseResolution.error);
  const proxyRequest = buildProxyRequest(tool, rawArguments, baseResolution.origin);
  if ("error" in proxyRequest) return errorResult(proxyRequest.error);

  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  // The read-only /mcp/apps surface marks EVERY proxied call passive: a route
  // that would otherwise record a side effect on a plain GET (e.g. the artifact
  // recall's loadCount/updatedAt bump) MUST skip it. Defense-in-depth for the
  // whole surface, not just get_dashboard — an accepted read never mutates.
  if (readOnlySurface) headers.set("x-pcc-mcp-readonly", "1");
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

    // On-Ramp UI tools additionally carry `structuredContent` (the artifact's
    // manifest, or projected search entries) + the canonical `_meta.ui.resourceUri`
    // for the fixed saved/gallery view — IN ADDITION to the text below, so
    // text-only consumers are intact and private artifacts render from THIS
    // authenticated result (never a second anonymous lookup).
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
export const PCC_MCP_ICON_URL = `${PCC_PUBLIC_ORIGIN}/pcc-icon.svg`;

/**
 * Dispatch a validated tools/call to its handler. Exported as a pure function so
 * the unknown-tool + argument-coercion CONTRACT is unit-testable without standing
 * up the Streamable HTTP transport.
 *
 * Restores the pre-#257 `/mcp` behavior existing clients depend on (audit
 * directive 8): an unknown (or empty) tool name resolves to a tool-level
 * `CallToolResult { isError: true }`, NEVER a thrown JSON-RPC protocol error
 * (MethodNotFound). The caller passes `params.arguments ?? {}` exactly as before —
 * no added `InvalidParams` throw. Non-object `arguments` are already rejected by
 * the SDK's CallToolRequestSchema (`z.record(z.string(), z.unknown())`) BEFORE
 * this runs, so no arg-type guard is needed or wanted here — a non-object simply
 * cannot reach this function through the transport.
 */
/**
 * Derive the authenticated principal for a typed operation IN-PROCESS from the
 * forwarded bearer — the string the transport surfaces as `extra.authInfo.token`
 * (see attachBearerAuth). This is a local key-DB hash lookup (resolveApiKeyFromToken);
 * the token is NEVER forwarded to the upstream API for a typed op. Returns null
 * (fail closed) for a missing / malformed / expired / revoked / unknown token —
 * i.e. anonymous or invalid credentials cannot obtain a principal.
 */
function deriveOpPrincipal(token: string | undefined): OpPrincipal | null {
  const record = resolveApiKeyFromToken(token);
  if (!record || !record.operatorId) return null;
  return { operatorId: record.operatorId, apiKeyId: record.id };
}

/**
 * Handle a dedicated `pcc.op.*` typed operation. This path NEVER proxies to the
 * upstream API — it derives the principal in-process and drives the facade
 * directly — so the forwarded bearer is never sent to any proxy destination.
 *
 * Order (fail closed at each step): (1) resolve the operation policy by tool
 * name (default-DENY — an unregistered tool is unknown); (2) validate + STRIP
 * arguments to a fresh whitelisted object (a manifest-supplied actor/tenant/
 * operator/owner id is dropped, never trusted); (3) derive the principal from
 * the credential (missing/invalid ⇒ auth-required); (4) resource-authorize
 * against the DERIVED principal; (5) invoke. Errors are tool-level isError
 * results and never contain the credential.
 */
export async function handleTypedOperation(
  toolName: string,
  args: JsonObject,
  token: string | undefined,
) {
  const policy = getOperationPolicyByToolName(toolName);
  if (!policy) return errorResult(`Unknown operation: ${toolName}`);

  const validated = policy.validateArguments(args);
  if (!validated) return errorResult(`Invalid arguments for ${policy.operationId}`);

  const principal = deriveOpPrincipal(token);
  if (!principal) return errorResult("Authentication required");

  const authz = await policy.authorize(principal, validated);
  if (!authz.ok) return errorResult(authz.message);

  const result = await policy.invoke(principal, validated);
  if (!result.ok) return errorResult(result.message);

  return {
    structuredContent: result.data,
    content: [{ type: "text" as const, text: resultText(result.data) }],
  };
}

export async function dispatchToolCall(
  toolsByName: Map<string, AgentPackageTool>,
  name: string,
  args: JsonObject,
  token: string | undefined,
  signal: AbortSignal,
  readOnlySurface = false,
) {
  if (name === RENDER_DASHBOARD_TOOL_NAME) {
    return handleRenderDashboardTool(args);
  }
  // Typed host-mediated operations (R4 PR2): the registry IS the allowlist and
  // the handler derives the principal + authorizes in-process. Routed BEFORE the
  // raw proxy lookup so a typed op never falls through to the pass-through relay.
  if (name.startsWith(TYPED_OP_TOOL_PREFIX)) {
    return handleTypedOperation(name, args, token);
  }
  const tool = toolsByName.get(name);
  if (!tool) {
    return errorResult(`Unknown PCC tool: ${name}`);
  }
  return proxyToolCall(tool, args, token, signal, readOnlySurface);
}

/**
 * The reviewed read-only app-surface proxy allowlist — EXPLICIT and
 * effect-classified. A `GET` method proves only the transport verb, NOT the
 * absence of server-side effects: GET `/api/artifacts/:id` recall bumps
 * loadCount + updatedAt, and other GET tools do chain/IPFS reads (external
 * network), poll/lease, or trigger snapshots. "read-only" is an EFFECT property,
 * not a transport one, so the app surface admits a raw proxy tool ONLY if it is
 * named in this set (GET remains required as belt-and-suspenders).
 *
 * Each entry was individually reviewed to be a passive local read: no
 * counter/timestamp writes, no lazy inserts/initialisation, no lease/heartbeat/
 * queue/trigger effects, no token consumption, no external-network or on-chain
 * reads, no analytics/"last viewed" mutation. `get_dashboard`'s recall counter is
 * suppressed FOR THIS SURFACE via the `x-pcc-mcp-readonly` passive header that the
 * read-only dispatch sets (see proxyToolCall) and the recall route honours.
 *
 * Adding a tool here REQUIRES an individual effect review. The exact-set snapshot
 * test in mcp-apps-readonly-surface.test.ts fails if this set changes, so a newly
 * added GET proxy tool can NEVER enter the app surface automatically — it must be
 * reviewed and added here with justification.
 */
export const READONLY_APP_PROXY_TOOLS: ReadonlySet<string> = new Set([
  // Dashboard recall + discovery (the gen-UI core).
  "get_dashboard", //      GET /api/artifacts/{idOrSlug} — passive via x-pcc-mcp-readonly
  "search_dashboards", //  GET /api/artifacts
  // Kernel discovery — KernelFacade DB reads, no default reputation enrichment.
  "list_kernels", //       GET /api/kernels
  "get_kernel", //         GET /api/kernels/{kernelId}
  "get_kernel_devices", // GET /api/kernels/{kernelId}/devices
  "get_kernel_jobs", //    GET /api/kernels/{kernelId}/jobs
  // Job status — JobFacade DB reads.
  "list_jobs", //          GET /api/jobs
  "get_job", //            GET /api/jobs/{jobId}
  // Capability discovery — static type/template reads.
  "list_capability_types", // GET /api/capabilities/types
  "search_capabilities", //   GET /api/capabilities/templates
]);

/**
 * The read-only app-surface allowlist — the SINGLE predicate enforced IDENTICALLY
 * at BOTH `tools/list` (advertise only these) AND CallTool dispatch (a call to a
 * non-allowlisted name errors, never proxies), so the surface cannot be bypassed
 * by calling an un-advertised tool. Default-DENY: anything not positively matched
 * below is excluded.
 *
 * Allowed:
 *   1. render_pcc_dashboard — pure client-side manifest render (no server effect).
 *   2. a REGISTERED typed operation with `stateChanging === false` (today only
 *      pcc.op.capability.request_quote; an unregistered id → null → denied, and a
 *      state-changing op such as job.cancel → denied even once it registers).
 *   3. a raw proxy tool that is BOTH GET AND in the reviewed, effect-classified
 *      READONLY_APP_PROXY_TOOLS set above (GET alone is insufficient).
 * Excluded by falling through to false: every POST/PATCH/PUT/DELETE proxy tool
 * (save/fork/update_dashboard, escrow fund/release/dispute, …), every GET proxy
 * tool NOT in the reviewed set (chain/IPFS reads, polls, snapshots, …), any
 * unregistered or state-changing typed op, and any unknown name.
 */
export function isReadOnlyAppTool(
  name: string,
  toolsByName: Map<string, AgentPackageTool>,
): boolean {
  if (name === RENDER_DASHBOARD_TOOL_NAME) return true;
  if (name.startsWith(TYPED_OP_TOOL_PREFIX)) {
    const policy = getOperationPolicyByToolName(name);
    return policy !== null && policy.stateChanging === false;
  }
  const tool = toolsByName.get(name);
  return (
    tool !== undefined &&
    tool.endpoint.method === "GET" &&
    READONLY_APP_PROXY_TOOLS.has(name)
  );
}

/** A mounted Streamable-HTTP MCP surface. `readOnly` gates BOTH tools/list and
 * CallTool dispatch to the isReadOnlyAppTool allowlist AND applies the prod domain
 * gate; the full surface leaves the tool set + dispatch exactly as they were. */
interface McpSurface {
  mountPath: string;
  readOnly: boolean;
}

/** The existing full agent/dev surface — every proxy tool + render + typed ops. */
const FULL_MCP_SURFACE: McpSurface = { mountPath: "/mcp", readOnly: false };
/** The read-only gen-UI surface — the isReadOnlyAppTool allowlist only. */
const READONLY_APP_SURFACE: McpSurface = { mountPath: "/mcp/apps", readOnly: true };

/** The `/mcp/apps` prod domain gate as a guard message (null = surface available). */
function appSurfaceGuardMessage(): string | null {
  return isMcpAppSurfaceAvailable() ? null : MCP_APP_SURFACE_UNAVAILABLE_MESSAGE;
}

/** Throw the JSON-RPC error the read-only app surface returns when it is disabled
 * (prod + placeholder domain) — used on tools/list + CallTool for that surface. */
function assertAppSurfaceAvailable(): void {
  const message = appSurfaceGuardMessage();
  if (message) throw new McpError(ErrorCode.InvalidRequest, message);
}

/** Fail closed the WHOLE MCP feature (both /mcp and /mcp/apps, tools/list AND
 * CallTool) when the upstream API base is unavailable — missing/invalid, or a
 * non-production deployment pointed at production. There is NO production
 * fallback; the gateway stays healthy but the proxy surfaces are disabled until
 * PCC_API_BASE_URL is correctly configured. See mcp-api-base.ts. */
function assertMcpApiBaseAvailable(): void {
  const message = mcpApiBaseUnavailableMessage();
  if (message) throw new McpError(ErrorCode.InvalidRequest, message);
}

function createMcpServer(pack: AgentPackage, surface: McpSurface): McpServer {
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

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Fail closed for BOTH /mcp and /mcp/apps if the upstream proxy base is
    // unavailable (missing/invalid, or a non-prod deployment aimed at prod) — the
    // proxy must never silently target production.
    assertMcpApiBaseAvailable();
    // Raw proxy tools + the UI render tool + the dedicated typed-operation tools
    // (pcc.op.*). The typed tools are additive: they never replace or shadow a
    // raw tool, and only they route through the server-authorized policy handler.
    const tools = [
      ...pack.tools.map(toMcpTool),
      buildRenderDashboardTool(),
      ...typedOperationTools(),
    ];
    if (!surface.readOnly) return { tools };
    // Read-only app surface: fail-closed prod domain gate FIRST, then advertise
    // ONLY the isReadOnlyAppTool allowlist — the SAME predicate the dispatcher
    // enforces below, so the advertised set and the callable set cannot diverge.
    assertAppSurfaceAvailable();
    return { tools: tools.filter((tool) => isReadOnlyAppTool(tool.name, toolsByName)) };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Fail closed for BOTH surfaces if the upstream proxy base is unavailable —
    // before any dispatch, so a proxy call can never target production.
    assertMcpApiBaseAvailable();
    // Coerce arguments exactly as the pre-#257 handler did (`?? {}`); the SDK
    // schema has already guaranteed `arguments` is an object-or-undefined. All
    // tool-not-found / handler routing lives in the exported dispatchToolCall so
    // the restored contract (unknown tool → isError result, never a thrown
    // protocol error — directive 8) is unit-testable off-transport.
    const args = request.params.arguments ?? {};
    if (surface.readOnly) {
      // Fail-closed prod domain gate, then the SAME allowlist tools/list uses. A
      // non-allowlisted (mutating) name returns a tool-level isError and NEVER
      // reaches dispatchToolCall — so it can never proxy to the upstream write,
      // even if the caller guessed an un-advertised tool name.
      assertAppSurfaceAvailable();
      if (!isReadOnlyAppTool(request.params.name, toolsByName)) {
        return errorResult(
          `Tool not available on the read-only PCC app surface: ${request.params.name}`,
        );
      }
    }
    return dispatchToolCall(
      toolsByName,
      request.params.name,
      args,
      extra.authInfo?.token,
      extra.signal,
      surface.readOnly,
    );
  });

  // The full surface registers the UI resources unchanged; the read-only app
  // surface additionally gates every ui:// read behind the prod domain check.
  registerMcpAppResources(
    server,
    surface.readOnly ? { surfaceGuard: appSurfaceGuardMessage } : undefined,
  );

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

/**
 * Register ONE Streamable HTTP MCP surface at `surface.mountPath`. Both the full
 * agent/dev surface (`/mcp`) and the read-only gen-UI surface (`/mcp/apps`) share
 * this plumbing; they differ only in the `surface` config, which createMcpServer
 * uses to gate tools/list + CallTool + the ui:// reads. Keeping ONE registrar (vs
 * duplicating the session boilerplate) means the two surfaces cannot drift.
 */
async function registerStreamableMcpSurface(
  app: FastifyInstance,
  surface: McpSurface,
): Promise<void> {
  // Fail fast at BOOT if a mandatory MCP-App asset (pcc-ui.js / manifest.schema.json)
  // or the agent package is missing from the runtime image, rather than throwing
  // inside tools/list / resources/read at request time (directive 6). server.ts
  // awaits this registration, so a throw here aborts startup with a clear message
  // and the deploy /health smoke check catches it.
  primeMcpAppAssets();
  loadAgentPackage();

  const sessions = new Map<string, McpSession>();

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

  app.options(surface.mountPath, async (_request, reply) => {
    setCorsHeaders(reply);
    return reply.status(204).send();
  });

  app.post<{ Body: unknown }>(surface.mountPath, async (request, reply) => {
    setCorsHeaders(reply);
    attachBearerAuth(request);
    await pruneExpiredSessions();

    const sessionId = headerValue(request, "mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) session.lastAccessAt = Date.now();

    if (!session && !sessionId && isInitializeRequest(request.body)) {
      await reserveSessionSlot();
      const pack = loadAgentPackage();
      const server = createMcpServer(pack, surface);
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

  app.get(surface.mountPath, async (request, reply) => {
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

  app.delete(surface.mountPath, async (request, reply) => {
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

/** Public Streamable HTTP MCP transport (the FULL agent/dev surface) at /mcp.
 * Register before the gateway API auth gate. Behavior is unchanged from before
 * the read-only surface was added — every proxy tool + render + typed ops. */
export async function httpMcpRoutes(app: FastifyInstance): Promise<void> {
  // The plain-HTTP mirror of the render view is a fixed, surface-independent path,
  // registered ONCE here so the second /mcp/apps mount never double-registers it.
  registerMcpAppHttpRoute(app);
  await registerStreamableMcpSurface(app, FULL_MCP_SURFACE);
}

/** Public, server-enforced READ-ONLY Streamable HTTP MCP surface at /mcp/apps —
 * exposes ONLY the isReadOnlyAppTool allowlist, enforced at BOTH tools/list and
 * CallTool dispatch, plus the prod domain gate (gates 5/6). Register before the
 * gateway API auth gate, like /mcp. The full /mcp surface is left untouched. */
export async function appsHttpMcpRoutes(app: FastifyInstance): Promise<void> {
  await registerStreamableMcpSurface(app, READONLY_APP_SURFACE);
}

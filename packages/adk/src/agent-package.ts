/**
 * The agent package, pinned. The ADK carries no hand-written tool JSON
 * (#2392): generated/agent-pin.ts is generated from the package the dashboard
 * serves, with its version, tool count and the sha256 of its exact bytes.
 *
 * `resolveToolRequest` turns a tool call into an HTTP request against the
 * configured gateway. It is pure: no network, and no credentials, so the
 * caller decides where a key may go (the N50 lesson). It refuses any tool whose
 * endpoint is not a gateway path, such as an absolute localhost URL.
 */

import { sha256 } from "@pcc/spec";
import { AGENT_PACKAGE_PIN, AGENT_TOOLS, type AgentToolName } from "./generated/agent-pin.js";
import type { AgentToolEndpoint } from "./agent-package-types.js";

export { AGENT_PACKAGE_PIN, AGENT_TOOLS };
export type { AgentToolName, AgentToolEndpoint };

export type AdkToolErrorCode =
  | "unknown_tool"
  | "not_a_gateway_path"
  | "missing_input"
  | "bad_path_param"
  | "bad_base_url";

export class AdkToolError extends Error {
  readonly code: AdkToolErrorCode;
  constructor(code: AdkToolErrorCode, message: string) {
    super(message);
    this.name = "AdkToolError";
    this.code = code;
  }
}

export interface ToolRequest {
  method: AgentToolEndpoint["method"];
  url: string;
  /** JSON body for POST, PUT and PATCH; absent for GET and DELETE. */
  body?: string;
}

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function baseOrigin(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AdkToolError("bad_base_url", `baseUrl is not a URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AdkToolError("bad_base_url", `baseUrl must be http(s): ${baseUrl}`);
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new AdkToolError("bad_base_url", "baseUrl must not carry a query, fragment or credentials");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

function pathParam(name: string, value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AdkToolError("missing_input", `path parameter "${name}" is required`);
  }
  const text = String(value);
  // "." and ".." would be resolved away by URL normalization and move the call
  // to another route; an empty segment would do the same.
  if (text === "" || text === "." || text === "..") {
    throw new AdkToolError("bad_path_param", `path parameter "${name}" cannot be "${text}"`);
  }
  return encodeURIComponent(text);
}

function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      params.append(key, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * The HTTP request for one agent-package tool call, against `baseUrl`.
 * Throws AdkToolError; never touches the network.
 */
export function resolveToolRequest(
  name: string,
  input: Record<string, unknown>,
  options: { baseUrl: string },
): ToolRequest {
  const tool = (AGENT_TOOLS as Record<string, AgentToolEndpoint>)[name];
  if (!tool) throw new AdkToolError("unknown_tool", `no tool named "${name}" in agent package ${AGENT_PACKAGE_PIN.version}`);
  if (!tool.path.startsWith("/") || tool.path.startsWith("//")) {
    throw new AdkToolError(
      "not_a_gateway_path",
      `tool "${name}" points at ${tool.path}, not a gateway path; the ADK will not call it`,
    );
  }
  const missing = tool.required.filter((field) => input[field] === undefined || input[field] === null);
  if (missing.length > 0) {
    throw new AdkToolError("missing_input", `tool "${name}" needs: ${missing.join(", ")}`);
  }

  const rest: Record<string, unknown> = { ...input };
  const path = tool.path.replace(PLACEHOLDER, (_match, param: string) => {
    const encoded = pathParam(param, rest[param]);
    delete rest[param];
    return encoded;
  });

  const origin = baseOrigin(options.baseUrl);
  if (tool.method === "GET" || tool.method === "DELETE") {
    return { method: tool.method, url: `${origin}${path}${queryString(rest)}` };
  }
  return { method: tool.method, url: `${origin}${path}`, body: JSON.stringify(rest) };
}

export interface AgentPackageCheck {
  /** True when the live bytes are exactly the pinned ones. */
  matches: boolean;
  pinned: { version: string; toolCount: number; sha256: string };
  live: { version: string | null; toolCount: number | null; sha256: string };
}

/** Compare a live /agent-package.json (its exact text) with the pin. */
export async function checkAgentPackage(text: string): Promise<AgentPackageCheck> {
  const liveSha = await sha256(text);
  let version: string | null = null;
  let toolCount: number | null = null;
  try {
    const parsed = JSON.parse(text) as { version?: unknown; tools?: unknown };
    version = typeof parsed.version === "string" ? parsed.version : null;
    toolCount = Array.isArray(parsed.tools) ? parsed.tools.length : null;
  } catch {
    // Not JSON: it cannot match, and there is nothing to read.
  }
  return {
    matches: liveSha === AGENT_PACKAGE_PIN.sha256,
    pinned: {
      version: AGENT_PACKAGE_PIN.version,
      toolCount: AGENT_PACKAGE_PIN.toolCount,
      sha256: AGENT_PACKAGE_PIN.sha256,
    },
    live: { version, toolCount, sha256: liveSha },
  };
}

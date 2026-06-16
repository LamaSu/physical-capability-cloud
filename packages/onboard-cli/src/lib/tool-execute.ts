/**
 * Execute one LLM-emitted tool call against the live PCC gateway.
 *
 * The gateway dashboard chat (#159) self-injects via `app.inject` to the
 * same Fastify instance — we don't have that luxury from a user laptop, so
 * we make real HTTP calls. Tool name → endpoint mapping comes from the
 * agent package the gateway just served us.
 *
 * Behavior parity with onboard-chat.ts:
 *   - Path params like {id} are interpolated from input.
 *   - GET/DELETE: remaining keys go on the query string.
 *   - POST/PATCH/PUT: remaining keys go in the JSON body.
 *   - Unknown tool ⇒ 404 result, no network call.
 *   - Network errors ⇒ 500 + a friendly error body the LLM can read.
 *
 * Auth: we pass through `Authorization: Bearer <pccApiKey>` when present,
 * so authenticated flows (POST /api/capabilities etc.) work the same way
 * from the CLI as they do from the dashboard. Unauthenticated calls let
 * the gateway's apiGate return its normal 401/403 — the LLM reacts in
 * plain English exactly like it does in #159.
 */

import type { AgentPackageTool } from "./agent-package.js";

export interface ToolCallResult {
  status: number;
  result: unknown;
  /** Full URL we hit, useful for logging when verbose. */
  url: string;
  /** HTTP method we used. */
  method: string;
  /** Wall clock time of the call in ms. */
  durationMs: number;
}

export interface ToolExecuteOptions {
  /** Base URL of the PCC gateway. */
  gatewayUrl: string;
  /** Tool descriptor from the agent package. */
  tool: AgentPackageTool;
  /** Input the LLM emitted. */
  input: Record<string, unknown>;
  /** Optional PCC API key for authenticated endpoints. */
  pccApiKey?: string;
  /** Override fetch (test injection). */
  fetchFn?: typeof fetch;
  /** Abort/timeout. */
  signal?: AbortSignal;
}

export async function executeToolCall(opts: ToolExecuteOptions): Promise<ToolCallResult> {
  const { tool, input, gatewayUrl, pccApiKey, fetchFn = fetch, signal } = opts;
  const start = Date.now();

  if (!tool.endpoint) {
    return {
      status: 404,
      result: {
        error: "tool_has_no_endpoint",
        message: `Tool ${tool.name} has no endpoint mapping in the agent package.`,
      },
      url: "",
      method: "",
      durationMs: Date.now() - start,
    };
  }

  const method = tool.endpoint.method.toUpperCase();
  const { path, pathParams } = interpolatePath(tool.endpoint.path, input);

  const base = gatewayUrl.replace(/\/+$/, "");
  let url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  let body: BodyInit | undefined;
  const headers: Record<string, string> = { accept: "application/json" };
  if (pccApiKey) headers.authorization = `Bearer ${pccApiKey}`;

  if (method === "GET" || method === "DELETE" || method === "HEAD") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) {
      if (pathParams.has(key)) continue;
      if (value === undefined || value === null) continue;
      params.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const qs = params.toString();
    if (qs) url = `${url}?${qs}`;
  } else {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (pathParams.has(key)) continue;
      payload[key] = value;
    }
    body = JSON.stringify(payload);
    headers["content-type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetchFn(url, { method, headers, body, signal });
  } catch (err) {
    return {
      status: 500,
      result: {
        error: "network_error",
        message: (err as Error).message,
      },
      url,
      method,
      durationMs: Date.now() - start,
    };
  }

  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  return {
    status: res.status,
    result: parsed,
    url,
    method,
    durationMs: Date.now() - start,
  };
}

/**
 * Interpolate `{param}` placeholders in a path using values from `input`.
 * Returns the substituted path plus the set of keys that were consumed
 * (so the caller doesn't echo them into the query string / body).
 */
export function interpolatePath(
  template: string,
  input: Record<string, unknown>,
): { path: string; pathParams: Set<string> } {
  const consumed = new Set<string>();
  const path = template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    consumed.add(key);
    const v = input[key];
    return v == null ? "" : encodeURIComponent(String(v));
  });
  return { path, pathParams: consumed };
}

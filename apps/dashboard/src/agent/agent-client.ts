// ---------------------------------------------------------------------------
// Agent tool execution — calls PCC API endpoints directly
// ---------------------------------------------------------------------------

import type { ToolCall } from "./agent-types.js";
import { toolEndpoints } from "./agent-tools.js";

/** Execute a tool call by calling the gateway API. Returns the result. */
export async function executeToolCall(
  toolCall: ToolCall,
  navigate?: (path: string) => void,
  walletStatus?: { connected: boolean; address?: string },
): Promise<unknown> {
  const endpoint = toolEndpoints[toolCall.name];
  if (!endpoint) {
    return { error: `Unknown tool: ${toolCall.name}` };
  }

  if (endpoint.clientOnly) {
    if (toolCall.name === "navigate_to_page") {
      const path = toolCall.input.path as string;
      navigate?.(path);
      return { navigated: true, path };
    }
    if (toolCall.name === "check_wallet_status") {
      return walletStatus ?? { connected: false };
    }
    return { error: "Unknown client-only tool" };
  }

  const path = typeof endpoint.path === "function" ? endpoint.path(toolCall.input) : endpoint.path;
  const options: RequestInit = { method: endpoint.method };

  if (endpoint.method === "POST" && endpoint.body) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(endpoint.body(toolCall.input));
  }

  try {
    const res = await fetch(`/api${path}`, options);
    if (!res.ok) {
      return { error: `API ${res.status}: ${res.statusText}` };
    }
    return await res.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Request failed" };
  }
}

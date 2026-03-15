// ---------------------------------------------------------------------------
// Agent client — relays messages to user's connected agent via gateway
// ---------------------------------------------------------------------------

import type { AgentMessage, ToolCall } from "./agent-types.js";
import { agentTools, toolEndpoints } from "./agent-tools.js";
import { useChatStore } from "../stores/chat-store.js";

const MAX_CONTEXT_MESSAGES = 20;

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

interface ClaudeContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface StreamDelta {
  type: string;
  index?: number;
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
  };
}

export interface AgentStreamCallbacks {
  onText: (text: string) => void;
  onToolCall: (toolCall: ToolCall) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

function buildClaudeMessages(messages: AgentMessage[]): ClaudeMessage[] {
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);
  const result: ClaudeMessage[] = [];

  for (const msg of recent) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const blocks: ClaudeContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
      }
      if (blocks.length > 0) {
        result.push({ role: "assistant", content: blocks });
      }
    }
    if (msg.toolResults && msg.toolResults.length > 0) {
      const blocks: ClaudeContentBlock[] = msg.toolResults.map((tr) => ({
        type: "tool_result" as const,
        tool_use_id: tr.toolCallId,
        content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
        is_error: tr.isError,
      }));
      result.push({ role: "user", content: blocks });
    }
  }

  return result;
}

export async function sendAgentMessage(
  messages: AgentMessage[],
  callbacks: AgentStreamCallbacks,
): Promise<void> {
  const conn = useChatStore.getState().agentConnection;
  if (!conn?.connected) {
    callbacks.onError("No agent connected. Use /connect to link your agent.");
    return;
  }

  const claudeMessages = buildClaudeMessages(messages);

  try {
    const res = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_endpoint: conn.endpoint,
        agent_api_key: conn.apiKey,
        provider: conn.provider,
        messages: claudeMessages,
        include_tools: true,
        max_tokens: 4096,
        stream: true,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      callbacks.onError(`Agent error: ${res.status} — ${text}`);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      callbacks.onError("No response stream");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolId = "";
    let currentToolName = "";
    let toolInputJson = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          callbacks.onDone();
          return;
        }

        let event: StreamDelta;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === "content_block_start" && event.content_block) {
          if (event.content_block.type === "tool_use") {
            currentToolId = event.content_block.id ?? "";
            currentToolName = event.content_block.name ?? "";
            toolInputJson = "";
          }
        } else if (event.type === "content_block_delta" && event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text) {
            callbacks.onText(event.delta.text);
          } else if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
            toolInputJson += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolId && currentToolName) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(toolInputJson || "{}");
            } catch { /* empty */ }
            callbacks.onToolCall({ id: currentToolId, name: currentToolName, input });
            currentToolId = "";
            currentToolName = "";
            toolInputJson = "";
          }
        } else if (event.type === "message_stop") {
          callbacks.onDone();
          return;
        }
      }
    }

    callbacks.onDone();
  } catch (err) {
    callbacks.onError(err instanceof Error ? err.message : "Unknown error");
  }
}

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

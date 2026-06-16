/**
 * Conversational PCC onboarding loop.
 *
 * Pure, transport-agnostic core that runs the same Anthropic tool-use
 * loop the gateway's POST /api/onboard/chat endpoint does (see
 * packages/gateway/src/routes/onboard-chat.ts) — but instead of
 * self-injecting against a Fastify instance, it makes outbound HTTPS
 * calls against a configurable gateway URL.
 *
 * Why local-loop instead of just opening a browser to /onboard/chat?
 *  - Works in environments where the user has Anthropic creds but no
 *    PCC-hosted API key.
 *  - Keeps the whole transcript local — useful for ops who want to
 *    paste it into a ticket or commit it for audit.
 *  - Mirrors the agent-pack discovery story: "any LLM with this
 *    package.json can talk to PCC". The CLI is just the LLM-with-a-
 *    package-on-a-laptop case.
 *
 * Inputs:
 *  - apiKey: Anthropic API key (from env or prompt)
 *  - gatewayUrl: where to call tools (defaults to capability.network)
 *  - model: Claude model id (defaults to claude-sonnet-4-6)
 *  - emitter: optional event emitter for streaming output to the UI
 *
 * Outputs:
 *  - { messages, toolCalls, done } per user message
 *  - Same conversation envelope as the gateway endpoint, so a future
 *    `--resume <conversationId>` flag could swap the loop for a remote
 *    call without changing the CLI surface.
 */

import type { AgentPackage, AgentPackageTool } from "./agent-package.js";
import { executeToolCall as defaultExecuteToolCall } from "./tool-execute.js";

// Re-export so consumers (and tests) can use one entry point.
export {
  fetchAgentPackage,
  AgentPackageError,
  type AgentPackage,
  type AgentPackageTool,
} from "./agent-package.js";
export {
  executeToolCall,
  interpolatePath,
  type ToolCallResult,
  type ToolExecuteOptions,
} from "./tool-execute.js";

// We allow `any` for the Anthropic SDK constructor signature so we don't
// drag its full type surface into this peer-light package.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAnthropic = any;

export type ToolCallTrace = {
  name: string;
  args: Record<string, unknown>;
  status: number;
  result: unknown;
  durationMs: number;
};

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type LoopOptions = {
  /** Anthropic API key. */
  apiKey: string;
  /** PCC gateway base URL. */
  gatewayUrl?: string;
  /** Override model. */
  model?: string;
  /** Authorization bearer token to attach to gateway tool calls. */
  pccApiKey?: string;
  /** Optional fetch impl (tests). */
  fetchImpl?: typeof fetch;
  /** Optional Anthropic client factory (tests). */
  anthropicFactory?: (apiKey: string) => AnyAnthropic;
  /** Callback fired for each LLM text chunk + tool call. */
  emitter?: LoopEmitter;
  /** Hard cap on Anthropic round-trips per user message. */
  maxTurns?: number;
  /** Hard cap on tool calls per user message. */
  maxToolCalls?: number;
};

export type LoopEmitter = {
  onAssistantText?: (text: string) => void;
  onToolCallStart?: (name: string, args: Record<string, unknown>) => void;
  onToolCallEnd?: (trace: ToolCallTrace) => void;
};

export type SendMessageResult = {
  assistant: string;
  toolCalls: ToolCallTrace[];
  done: boolean;
  doneReason: "end_turn" | "max_turns" | "tool_call_budget" | "error";
  turns: number;
  error?: string;
};

export const DEFAULT_GATEWAY = "https://capability.network";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_MAX_TOOL_CALLS = 12;

async function loadAnthropic(): Promise<AnyAnthropic | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional peer at install time
    const mod = await import("@anthropic-ai/sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mod as any).default ?? (mod as any).Anthropic ?? null;
  } catch {
    return null;
  }
}

/**
 * Drive one user message through the LLM/tool loop until the LLM
 * either falls silent (end_turn) or hits a budget cap.
 *
 * Returns the same envelope the gateway endpoint does so the dashboard
 * UI and the CLI can render identically.
 */
export async function sendMessage(
  pkg: AgentPackage,
  conversation: AnthropicMessage[],
  userMessage: string,
  opts: LoopOptions,
): Promise<SendMessageResult> {
  const gatewayUrl = opts.gatewayUrl ?? DEFAULT_GATEWAY;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  const ctor = opts.anthropicFactory ? null : await loadAnthropic();
  const client = opts.anthropicFactory
    ? opts.anthropicFactory(opts.apiKey)
    : ctor
      ? new ctor({ apiKey: opts.apiKey })
      : null;
  if (!client) {
    return {
      assistant: "",
      toolCalls: [],
      done: false,
      doneReason: "error",
      turns: 0,
      error:
        "@anthropic-ai/sdk failed to load. Reinstall the CLI (`npm i -g @pcc/onboard` or `npx -y @pcc/onboard`).",
    };
  }

  const toolByName = new Map<string, AgentPackageTool>();
  for (const t of pkg.tools) {
    if (!t.name || !t.input_schema) continue;
    toolByName.set(t.name, t);
  }
  const tools = Array.from(toolByName.values()).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.input_schema,
  }));

  conversation.push({ role: "user", content: userMessage });

  const toolCalls: ToolCallTrace[] = [];
  let lastAssistantText = "";
  let turns = 0;
  let totalToolCalls = 0;
  let doneReason: SendMessageResult["doneReason"] = "max_turns";

  while (turns < maxTurns) {
    turns += 1;

    let res: {
      content: Array<
        | { type: "text"; text: string }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          }
      >;
      stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    };
    try {
      res = await client.messages.create({
        model,
        max_tokens: 4096,
        system: pkg.system_prompt,
        tools,
        messages: conversation,
      });
    } catch (err) {
      const errMsg = (err as Error).message;
      // Push a soft assistant note so the transcript is honest about what happened.
      conversation.push({
        role: "assistant",
        content: `(LLM call failed: ${errMsg})`,
      });
      return {
        assistant: lastAssistantText,
        toolCalls,
        done: false,
        doneReason: "error",
        turns,
        error: errMsg,
      };
    }

    const assistantContent: ContentBlock[] = [];
    const toolResultsForNextTurn: ContentBlock[] = [];
    let calledThisTurn = false;
    let textThisTurn = "";

    for (const block of res.content) {
      if (block.type === "text") {
        textThisTurn += block.text;
        assistantContent.push({ type: "text", text: block.text });
        if (block.text) opts.emitter?.onAssistantText?.(block.text);
      } else if (block.type === "tool_use") {
        calledThisTurn = true;
        totalToolCalls += 1;

        if (totalToolCalls > maxToolCalls) {
          const errResult = {
            error: "tool_call_budget_exceeded",
            message: `Hit ${maxToolCalls} tool calls in one user turn.`,
          };
          assistantContent.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
          toolResultsForNextTurn.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(errResult),
          });
          doneReason = "tool_call_budget";
          continue;
        }

        assistantContent.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });

        opts.emitter?.onToolCallStart?.(block.name, block.input);

        const tool = toolByName.get(block.name);
        let status = 404;
        let result: unknown = {
          error: "unknown_tool",
          name: block.name,
        };
        let durationMs = 0;
        if (tool) {
          const exec = await defaultExecuteToolCall({
            tool,
            input: block.input,
            gatewayUrl,
            pccApiKey: opts.pccApiKey,
            fetchFn: opts.fetchImpl,
          });
          durationMs = exec.durationMs;
          status = exec.status;
          result = exec.result;
        }
        const trace: ToolCallTrace = {
          name: block.name,
          args: block.input,
          status,
          result,
          durationMs,
        };
        toolCalls.push(trace);
        toolResultsForNextTurn.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
        opts.emitter?.onToolCallEnd?.(trace);
      }
    }

    if (textThisTurn) lastAssistantText = textThisTurn;

    conversation.push({ role: "assistant", content: assistantContent });

    if (!calledThisTurn) {
      doneReason = "end_turn";
      break;
    }

    conversation.push({ role: "user", content: toolResultsForNextTurn });

    if (doneReason === "tool_call_budget") break;

    if (
      res.stop_reason === "end_turn" ||
      res.stop_reason === "stop_sequence"
    ) {
      doneReason = "end_turn";
      break;
    }
  }

  return {
    assistant: lastAssistantText || "(no text response — see toolCalls)",
    toolCalls,
    done: doneReason === "end_turn",
    doneReason,
    turns,
  };
}

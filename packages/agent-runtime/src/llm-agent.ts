// llm-agent.ts — raw Anthropic tool-use loop, vendor-free LLM driver.
//
// Multi-turn loop: ask Claude → if stop_reason=tool_use, run tool, feed result, repeat.
//
// Why no Guild SDK / framework: closed beta, opaque pricing, runtime lock-in. The
// raw Messages API shape (system + messages + tools + tool_use/tool_result) is
// also implemented by AWS Bedrock and GCP Vertex, so we keep optionality.
//
// MCP support: the 0.40.x SDK does not yet ship `@anthropic-ai/sdk/helpers/beta/mcp`.
// We expose tools as plain Tool defs + a toolCallers map. When the SDK gains MCP
// helpers in a later minor, swap to BetaToolRunner. See TODO(post-wave-2).
//
// TODO(wave-2.5): integrate with `BaseAgent.getToolDefinitions()` so that an
// agent extending BaseAgent can pass `agent.getToolDefinitions()` here directly
// and get a homogeneous tool surface. The current shape (Tool[] + toolCallers
// map) is intentionally framework-agnostic so it can be used standalone.

import Anthropic from "@anthropic-ai/sdk";

export type ToolDef = Anthropic.Tool;

/** A function that executes a tool given its model-supplied input. Return value
 *  is JSON-serialized into the tool_result content block. */
export type ToolCaller = (input: unknown) => Promise<unknown>;

export interface LLMAgentOptions {
  /** Anthropic client (DI for testing). Defaults to a fresh instance reading
   *  ANTHROPIC_API_KEY from env. */
  client?: Anthropic;
  /** Model id, e.g. "claude-sonnet-4-6". */
  model?: string;
  /** max_tokens per turn. */
  maxTokens?: number;
}

export interface ChatOptions {
  /** Hard cap on tool-use rounds. Default 12. */
  maxTurns?: number;
  /** System prompt for this conversation. */
  system?: string;
  /** Per-iteration callback — useful for streaming UIs / progress logs. */
  onStep?: (step: { iteration: number; stop_reason: string | null; toolCalls: Anthropic.ToolUseBlock[] }) => void;
}

export interface ChatResult {
  /** Full message history including assistant + tool_result turns. */
  messages: Anthropic.MessageParam[];
  /** The final assistant message (stop_reason = end_turn or stop_sequence). */
  final: Anthropic.Message;
  /** Convenience: concatenated text from the final assistant turn. */
  text: string;
  /** Total tool calls executed across all turns. */
  toolCalls: number;
  /** Number of model turns consumed. */
  iterations: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TURNS = 12;

export class LLMAgent {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private tools: ToolDef[];
  private toolCallers: Record<string, ToolCaller>;

  constructor(
    tools: ToolDef[],
    toolCallers: Record<string, ToolCaller>,
    opts: LLMAgentOptions = {}
  ) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.tools = tools;
    this.toolCallers = toolCallers;
  }

  /** Run a multi-turn tool-use loop. Returns the full transcript + final message. */
  async chat(input: string, opts: ChatOptions = {}): Promise<ChatResult> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: input }];
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    let toolCalls = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(opts.system ? { system: opts.system } : {}),
        tools: this.tools,
        messages,
      });

      // Append the assistant turn no matter what — the API needs it before any
      // tool_result block to keep the conversation well-formed.
      messages.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      opts.onStep?.({ iteration: turn, stop_reason: resp.stop_reason, toolCalls: toolUses });

      // Terminal turn: end_turn / stop_sequence / max_tokens / refusal — return.
      if (resp.stop_reason !== "tool_use") {
        const text = resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return { messages, final: resp, text, toolCalls, iterations: turn + 1 };
      }

      // Run each tool call. Errors become is_error tool_results so the model
      // can recover rather than the loop blowing up.
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (tu) => {
          const caller = this.toolCallers[tu.name];
          if (!caller) {
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: JSON.stringify({ error: `unknown tool: ${tu.name}` }),
              is_error: true,
            };
          }
          try {
            const out = await caller(tu.input);
            toolCalls++;
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: JSON.stringify(out ?? null),
            };
          } catch (err) {
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
              is_error: true,
            };
          }
        })
      );

      messages.push({ role: "user", content: toolResults });
    }

    throw new Error(`LLMAgent.chat exceeded maxTurns=${maxTurns}`);
  }

  // TODO(post-wave-2): once @anthropic-ai/sdk ships its MCP helpers
  // (`@anthropic-ai/sdk/helpers/beta/mcp` BetaToolRunner), wire a `chatWithMcp`
  // variant that consumes MCP servers natively. The current shape (Tool[] +
  // toolCallers) is the manual fallback.
}

/** Convenience factory mirrors the `runAgent({...})` shape from the research doc.
 *  Useful for one-shot calls where you don't want to hold an instance. */
export async function runAgent(opts: {
  tools: ToolDef[];
  toolCallers: Record<string, ToolCaller>;
  userPrompt: string;
  system?: string;
  model?: string;
  maxTurns?: number;
  client?: Anthropic;
  onStep?: ChatOptions["onStep"];
}): Promise<ChatResult> {
  const agent = new LLMAgent(opts.tools, opts.toolCallers, {
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });
  return agent.chat(opts.userPrompt, {
    ...(opts.system ? { system: opts.system } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.onStep ? { onStep: opts.onStep } : {}),
  });
}

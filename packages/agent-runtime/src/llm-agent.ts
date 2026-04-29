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
// Hardening (Tier 1, 2026-04-29):
//   - T1.7: tighten default maxTurns 12 → 8; add maxToolCalls (default 16) and
//     maxInputTokens (default 200_000) ceilings; throw BudgetExceededError past
//     either. Reserve a hard-coded set of tool names (fund_wallet, transfer,
//     withdraw, eval, exec, delete_*, drop_*, destroy_*) and reject duplicates
//     in the constructor + factory.
//   - T1.11: pass maxRetries: 3 to the Anthropic client constructor when we
//     create it ourselves (caller-provided clients keep their own retry policy).
//     Wrap messages.create errors so 429 / 5xx are surfaced with retryable=true
//     in a domain-typed RetryableLLMError.

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
  /** Hard ceiling on cumulative tool calls across all turns. Default 16.
   *  T1.7 — prevents runaway loops from exhausting budget on tool spam. */
  maxToolCalls?: number;
  /** Hard ceiling on cumulative input tokens reported by the API. Default 200_000.
   *  T1.7 — caps cost per chat() invocation independent of maxTurns. */
  maxInputTokens?: number;
  /** Number of retries the Anthropic client should attempt on 429 / 5xx. Default 3.
   *  T1.11 — only applied when we construct the client ourselves. */
  maxRetries?: number;
}

export interface ChatOptions {
  /** Hard cap on tool-use rounds. Default 8 (was 12 pre-T1.7). */
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
const DEFAULT_MAX_TURNS = 8; // T1.7: was 12
const DEFAULT_MAX_TOOL_CALLS = 16; // T1.7
const DEFAULT_MAX_INPUT_TOKENS = 200_000; // T1.7
const DEFAULT_MAX_RETRIES = 3; // T1.11

/**
 * Reserved tool names. Templates that try to register tools with these names
 * are rejected at construction time. The set covers two threat models:
 *
 *   1. Wallet/financial verbs that, if shadowed by a malicious template,
 *      could route real funds through a fake handler.
 *   2. Code-execution verbs that, if registered with a permissive caller,
 *      hand the model an arbitrary-execution primitive.
 *
 * The exact strings here are matched verbatim; the prefix list is matched
 * against `name.startsWith(prefix + "_")` to also catch e.g. `delete_user`,
 * `drop_table`, `destroy_account`.
 */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "fund_wallet",
  "transfer",
  "withdraw",
  "eval",
  "exec",
]);

const RESERVED_TOOL_PREFIXES: ReadonlyArray<string> = [
  "delete_",
  "drop_",
  "destroy_",
  "withdraw_",
  "transfer_",
  "fund_",
];

/**
 * Validate the tool list against the reservation rules and check for
 * duplicate names. Throws a descriptive Error on the first violation.
 *
 * Exported so `runAgent` (the factory) can apply the same check before
 * constructing the LLMAgent — keeps the validation in one place.
 */
export function validateToolNames(tools: ReadonlyArray<ToolDef>): void {
  const seen = new Set<string>();
  for (const t of tools) {
    if (RESERVED_TOOL_NAMES.has(t.name)) {
      throw new Error(`tool name "${t.name}" is reserved`);
    }
    for (const prefix of RESERVED_TOOL_PREFIXES) {
      if (t.name.startsWith(prefix)) {
        throw new Error(`tool name "${t.name}" is reserved (matches reserved prefix "${prefix}")`);
      }
    }
    if (seen.has(t.name)) {
      throw new Error(`duplicate tool name "${t.name}"`);
    }
    seen.add(t.name);
  }
}

/** Domain error raised when an Anthropic API error is retryable (429 / 5xx).
 *  T1.11 — gives upstream callers a consistent shape to react to. */
export class RetryableLLMError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "RetryableLLMError";
  }
}

/** Domain error raised when chat() exhausts a budget cap. T1.7. */
export class BudgetExceededError extends Error {
  readonly retryable = false;
  constructor(
    message: string,
    public readonly budget: "maxTurns" | "maxToolCalls" | "maxInputTokens"
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function isRetryableStatus(status: number | null | undefined): boolean {
  if (status == null) return false;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Wrap an Anthropic.messages.create error so 429 / 5xx surface as
 * RetryableLLMError. The Anthropic SDK already retries internally up to
 * `maxRetries`; this wrapper just ensures whatever propagates out has a
 * stable shape for the caller's reaction logic.
 */
function classifyApiError(err: unknown): never {
  // The SDK exposes APIError with a numeric `status`. We can't import the
  // type without a hard dep on its surface, so duck-type defensively.
  const anyErr = err as { status?: number; message?: string; name?: string } | null;
  const status = anyErr?.status ?? null;
  const message = anyErr?.message ?? String(err);
  if (isRetryableStatus(status)) {
    throw new RetryableLLMError(`Anthropic API error ${status}: ${message}`, status, err);
  }
  throw err;
}

export class LLMAgent {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private maxToolCalls: number;
  private maxInputTokens: number;
  private tools: ToolDef[];
  private toolCallers: Record<string, ToolCaller>;

  constructor(
    tools: ToolDef[],
    toolCallers: Record<string, ToolCaller>,
    opts: LLMAgentOptions = {}
  ) {
    validateToolNames(tools);
    // T1.11: when we own the client, install the retry policy. Caller-supplied
    // clients keep their existing config (test stubs etc.).
    this.client =
      opts.client ??
      new Anthropic({ maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.maxInputTokens = opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    this.tools = tools;
    this.toolCallers = toolCallers;
  }

  /** Run a multi-turn tool-use loop. Returns the full transcript + final message. */
  async chat(input: string, opts: ChatOptions = {}): Promise<ChatResult> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: input }];
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    let toolCalls = 0;
    let totalInputTokens = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      let resp: Anthropic.Message;
      try {
        resp = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          ...(opts.system ? { system: opts.system } : {}),
          tools: this.tools,
          messages,
        });
      } catch (err) {
        classifyApiError(err); // throws — function is `never`
        throw err; // unreachable, satisfies TS control-flow analysis
      }

      // T1.7: track cumulative input tokens. The SDK's usage object reports
      // per-turn counts; we sum them. Caller can rate-limit the agent at this
      // boundary by setting maxInputTokens.
      const usage = resp.usage as Anthropic.Usage | undefined;
      if (usage?.input_tokens) {
        totalInputTokens += usage.input_tokens;
        if (totalInputTokens > this.maxInputTokens) {
          throw new BudgetExceededError(
            `LLMAgent.chat exceeded maxInputTokens=${this.maxInputTokens} (used ${totalInputTokens})`,
            "maxInputTokens"
          );
        }
      }

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

      // T1.7: gate the upcoming tool calls against the budget. If invoking
      // them would push us over maxToolCalls we throw immediately rather than
      // running them and then refusing to continue.
      if (toolCalls + toolUses.length > this.maxToolCalls) {
        throw new BudgetExceededError(
          `LLMAgent.chat would exceed maxToolCalls=${this.maxToolCalls} (already ${toolCalls}, ${toolUses.length} more requested)`,
          "maxToolCalls"
        );
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

    throw new BudgetExceededError(
      `LLMAgent.chat exceeded maxTurns=${maxTurns}`,
      "maxTurns"
    );
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
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxRetries?: number;
  client?: Anthropic;
  onStep?: ChatOptions["onStep"];
}): Promise<ChatResult> {
  const agent = new LLMAgent(opts.tools, opts.toolCallers, {
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxToolCalls !== undefined ? { maxToolCalls: opts.maxToolCalls } : {}),
    ...(opts.maxInputTokens !== undefined ? { maxInputTokens: opts.maxInputTokens } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  });
  return agent.chat(opts.userPrompt, {
    ...(opts.system ? { system: opts.system } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.onStep ? { onStep: opts.onStep } : {}),
  });
}

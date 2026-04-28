// llm-agent.test.ts — vitest cases for the raw-Anthropic tool-use loop.
//
// We never hit the real API. The Anthropic client is a hand-mocked object whose
// `messages.create` is a queue: each call returns the next pre-canned response.
// That keeps the tests deterministic, dep-light (no `vi.mock` on a CommonJS
// SDK whose default-export shape is annoying), and fast.

import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { LLMAgent, runAgent, type ToolDef } from "./llm-agent.js";

/** Build a fake Anthropic client whose `messages.create` returns the provided
 *  responses in order. Throws if the agent calls `create` more times than
 *  there are scripted responses (catches infinite loops fast). */
function makeFakeClient(responses: Anthropic.Message[]): {
  client: Anthropic;
  create: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const create = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("test: ran out of scripted Anthropic responses");
    return next;
  });
  // Cast through unknown — we only stub the surface area the agent touches.
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

/** Synthesize a Message with the minimum fields the agent inspects. */
function msg(args: {
  stop_reason: Anthropic.Message["stop_reason"];
  content: Anthropic.ContentBlock[];
}): Anthropic.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: args.content,
    stop_reason: args.stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  };
}

const echoTool: ToolDef = {
  name: "echo",
  description: "Echo the input back verbatim.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

describe("LLMAgent.chat", () => {
  it("calls a registered tool with the model's input and feeds the result back", async () => {
    const { client, create } = makeFakeClient([
      msg({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "echo",
            input: { text: "hi" },
          } as Anthropic.ToolUseBlock,
        ],
      }),
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "you said hi", citations: [] } as Anthropic.TextBlock],
      }),
    ]);

    const echoCaller = vi.fn(async (input: unknown) => ({
      echoed: (input as { text: string }).text,
    }));

    const agent = new LLMAgent([echoTool], { echo: echoCaller }, { client });
    const result = await agent.chat("say hi");

    // The tool got the model-supplied input.
    expect(echoCaller).toHaveBeenCalledTimes(1);
    expect(echoCaller).toHaveBeenCalledWith({ text: "hi" });

    // Two round-trips: the tool_use turn, then the wrap-up turn.
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.text).toBe("you said hi");

    // The full transcript the agent built: [user(prompt), assistant(tool_use),
    // user(tool_result), assistant(end_turn)]. We check the tool_result turn
    // at index 2.
    expect(result.messages).toHaveLength(4);
    const toolResultTurn = result.messages[2];
    expect(toolResultTurn?.role).toBe("user");
    expect(Array.isArray(toolResultTurn?.content)).toBe(true);
    const blocks = toolResultTurn?.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks[0]?.tool_use_id).toBe("tu_1");
    expect(blocks[0]?.content).toBe(JSON.stringify({ echoed: "hi" }));
  });

  it("returns the final message immediately on stop_reason=end_turn (no tool)", async () => {
    const { client, create } = makeFakeClient([
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "nothing to do", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const agent = new LLMAgent([], {}, { client });
    const result = await agent.chat("hello");
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.text).toBe("nothing to do");
    expect(result.final.stop_reason).toBe("end_turn");
  });

  it("throws when maxTurns is exceeded (boundary)", async () => {
    // Always emit tool_use → forces the loop to keep going forever in principle.
    const responses: Anthropic.Message[] = Array.from({ length: 5 }, () =>
      msg({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `tu_${Math.random()}`,
            name: "echo",
            input: { text: "loop" },
          } as Anthropic.ToolUseBlock,
        ],
      })
    );
    const { client } = makeFakeClient(responses);
    const agent = new LLMAgent(
      [echoTool],
      { echo: async () => ({ ok: true }) },
      { client }
    );
    await expect(agent.chat("loop forever", { maxTurns: 3 })).rejects.toThrow(
      /exceeded maxTurns=3/
    );
  });

  it("honors the system prompt on every turn", async () => {
    const { client, create } = makeFakeClient([
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const agent = new LLMAgent([], {}, { client });
    await agent.chat("hi", { system: "you are a haiku" });
    const args = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    expect(args.system).toBe("you are a haiku");
  });

  it("turns thrown tool errors into is_error tool_results so the model can recover", async () => {
    const { client } = makeFakeClient([
      msg({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_err",
            name: "echo",
            input: { text: "oops" },
          } as Anthropic.ToolUseBlock,
        ],
      }),
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "recovered", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const agent = new LLMAgent(
      [echoTool],
      {
        echo: async () => {
          throw new Error("boom");
        },
      },
      { client }
    );
    const result = await agent.chat("trigger an error");
    // The error did NOT bubble out — it became a tool_result with is_error.
    expect(result.text).toBe("recovered");
    // Final transcript: [user, assistant, user(tool_result), assistant]
    const toolResultTurn = result.messages[2];
    const blocks = toolResultTurn?.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
    expect(blocks[0]?.content).toContain("boom");
    // toolCalls only counts SUCCESSFUL invocations.
    expect(result.toolCalls).toBe(0);
  });

  it("flags unknown tool names as is_error tool_results without invoking anything", async () => {
    const { client } = makeFakeClient([
      msg({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_unknown",
            name: "does_not_exist",
            input: {},
          } as Anthropic.ToolUseBlock,
        ],
      }),
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const echoCaller = vi.fn();
    const agent = new LLMAgent([echoTool], { echo: echoCaller }, { client });
    const result = await agent.chat("call missing tool");
    expect(echoCaller).not.toHaveBeenCalled();
    // Final transcript: [user, assistant, user(tool_result), assistant]
    const toolResultTurn = result.messages[2];
    const blocks = toolResultTurn?.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
    expect(blocks[0]?.content).toContain("unknown tool");
    expect(result.toolCalls).toBe(0);
  });

  it("invokes onStep with iteration metadata + tool calls", async () => {
    const { client } = makeFakeClient([
      msg({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_step",
            name: "echo",
            input: { text: "trace me" },
          } as Anthropic.ToolUseBlock,
        ],
      }),
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const onStep = vi.fn();
    const agent = new LLMAgent(
      [echoTool],
      { echo: async (i) => ({ got: i }) },
      { client }
    );
    await agent.chat("trace", { onStep });
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(onStep.mock.calls[0]?.[0].iteration).toBe(0);
    expect(onStep.mock.calls[0]?.[0].stop_reason).toBe("tool_use");
    expect(onStep.mock.calls[0]?.[0].toolCalls).toHaveLength(1);
    expect(onStep.mock.calls[1]?.[0].stop_reason).toBe("end_turn");
    expect(onStep.mock.calls[1]?.[0].toolCalls).toHaveLength(0);
  });
});

describe("runAgent (one-shot factory)", () => {
  it("threads opts through to LLMAgent.chat", async () => {
    const { client, create } = makeFakeClient([
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const result = await runAgent({
      tools: [],
      toolCallers: {},
      userPrompt: "hi",
      system: "be brief",
      maxTurns: 3,
      client,
    });
    const args = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    expect(args.system).toBe("be brief");
    expect(result.text).toBe("done");
  });
});

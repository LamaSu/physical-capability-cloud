/**
 * Tests for sendMessage — the chat loop that drives Anthropic + the gateway.
 *
 * We never call real Anthropic here. anthropicFactory injects a fake client
 * that lets us script `messages.create()` responses. fetchImpl injects a
 * fake gateway so tool calls land on a known stub.
 *
 * The chat loop in #159 has the same semantics; we exercise the same paths:
 *   - single-shot end_turn (no tools)
 *   - one tool call → result → end_turn
 *   - multi-turn tool loop
 *   - unknown tool ⇒ 404 trace
 *   - max-turns cap
 *   - tool-call-budget cap
 *   - LLM error → graceful return with doneReason 'error'
 */
import { describe, it, expect, vi } from "vitest";
import {
  sendMessage,
  type AnthropicMessage,
  type AgentPackage,
} from "../lib/onboard-loop.js";

function makeFakeAnthropic(responses: any[]): (apiKey: string) => any {
  let idx = 0;
  return (_apiKey: string) => ({
    messages: {
      create: vi.fn(async () => {
        const next = responses[idx];
        idx++;
        if (!next) throw new Error("ran out of scripted responses");
        if (next instanceof Error) throw next;
        return next;
      }),
    },
  });
}

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: "OK",
      text: async () => JSON.stringify(body),
    }) as unknown as Response,
  );
}

const SAMPLE_PKG: AgentPackage = {
  system_prompt: "You are PCC's onboarding assistant. Be brief.",
  tools: [
    {
      name: "list_capability_types",
      description: "List capability types",
      input_schema: { type: "object", properties: {} },
      endpoint: { method: "GET", path: "/api/capabilities/types" },
    },
    {
      name: "create_kernel",
      description: "Register a kernel",
      input_schema: { type: "object", properties: { name: { type: "string" } } },
      endpoint: { method: "POST", path: "/api/kernels" },
    },
  ],
};

describe("sendMessage — basic flow", () => {
  it("returns end_turn when LLM speaks text without a tool call", async () => {
    const fake = makeFakeAnthropic([
      {
        content: [{ type: "text", text: "Welcome! What would you like to do?" }],
        stop_reason: "end_turn",
      },
    ]);
    const conversation: AnthropicMessage[] = [];
    const result = await sendMessage(SAMPLE_PKG, conversation, "hi", {
      apiKey: "sk-test",
      anthropicFactory: fake,
    });

    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("end_turn");
    expect(result.assistant).toContain("Welcome");
    expect(result.toolCalls).toEqual([]);
    expect(result.turns).toBe(1);
    expect(conversation.length).toBe(2); // user + assistant
  });

  it("runs a tool call and feeds the result back", async () => {
    const fake = makeFakeAnthropic([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "list_capability_types",
            input: {},
          },
        ],
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "text", text: "We support 3d-printing, cnc, hplc." }],
        stop_reason: "end_turn",
      },
    ]);
    const fetchImpl = makeFetch(200, { types: ["3d-printing", "cnc", "hplc"] });
    const conversation: AnthropicMessage[] = [];

    const result = await sendMessage(SAMPLE_PKG, conversation, "what can I do?", {
      apiKey: "sk-test",
      anthropicFactory: fake,
      fetchImpl,
    });

    expect(result.done).toBe(true);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe("list_capability_types");
    expect(result.toolCalls[0].status).toBe(200);
    expect(result.assistant).toContain("3d-printing");
    expect(result.turns).toBe(2);
  });

  it("captures durationMs >= 0 for each tool call", async () => {
    const fake = makeFakeAnthropic([
      {
        content: [{ type: "tool_use", id: "t1", name: "list_capability_types", input: {} }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ]);
    const result = await sendMessage(SAMPLE_PKG, [], "go", {
      apiKey: "sk-test",
      anthropicFactory: fake,
      fetchImpl: makeFetch(200, {}),
    });
    expect(result.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("sendMessage — edge cases", () => {
  it("returns 404 for an unknown tool but keeps the loop going", async () => {
    const fake = makeFakeAnthropic([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "nonexistent_tool",
            input: {},
          },
        ],
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "text", text: "Sorry — let me try a different approach." }],
        stop_reason: "end_turn",
      },
    ]);

    const result = await sendMessage(SAMPLE_PKG, [], "do something weird", {
      apiKey: "sk-test",
      anthropicFactory: fake,
    });

    expect(result.toolCalls[0].status).toBe(404);
    expect((result.toolCalls[0].result as any).error).toBe("unknown_tool");
    expect(result.done).toBe(true);
  });

  it("hits the max-turns cap when the model keeps emitting tool_use", async () => {
    const repeatedToolUse = {
      content: [{ type: "tool_use", id: "t-loop", name: "list_capability_types", input: {} }],
      stop_reason: "tool_use",
    };
    const fake = makeFakeAnthropic(Array.from({ length: 20 }, () => repeatedToolUse));
    const fetchImpl = makeFetch(200, { types: [] });

    const result = await sendMessage(SAMPLE_PKG, [], "loop forever", {
      apiKey: "sk-test",
      anthropicFactory: fake,
      fetchImpl,
      maxTurns: 3,
    });

    expect(result.doneReason).toBe("max_turns");
    expect(result.done).toBe(false);
    expect(result.turns).toBe(3);
  });

  it("hits the tool-call budget when the model emits many tool calls", async () => {
    const fake = makeFakeAnthropic([
      {
        content: [
          { type: "tool_use", id: "a", name: "list_capability_types", input: {} },
          { type: "tool_use", id: "b", name: "list_capability_types", input: {} },
          { type: "tool_use", id: "c", name: "list_capability_types", input: {} },
        ],
        stop_reason: "tool_use",
      },
    ]);
    const fetchImpl = makeFetch(200, { types: [] });
    const result = await sendMessage(SAMPLE_PKG, [], "spam", {
      apiKey: "sk-test",
      anthropicFactory: fake,
      fetchImpl,
      maxToolCalls: 2,
    });
    expect(result.doneReason).toBe("tool_call_budget");
  });

  it("emits onAssistantText + onToolCallEnd hooks", async () => {
    const fake = makeFakeAnthropic([
      {
        content: [
          { type: "text", text: "calling..." },
          { type: "tool_use", id: "t1", name: "list_capability_types", input: {} },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ]);
    const fetchImpl = makeFetch(200, { types: [] });
    const texts: string[] = [];
    const calls: string[] = [];

    await sendMessage(SAMPLE_PKG, [], "go", {
      apiKey: "sk-test",
      anthropicFactory: fake,
      fetchImpl,
      emitter: {
        onAssistantText: (t) => texts.push(t),
        onToolCallEnd: (trace) => calls.push(trace.name),
      },
    });

    expect(texts.length).toBeGreaterThan(0);
    expect(calls).toContain("list_capability_types");
  });

  it("returns doneReason=error with an error string when Anthropic throws", async () => {
    const fake = makeFakeAnthropic([new Error("429 rate_limit")]);
    const conversation: AnthropicMessage[] = [];
    const result = await sendMessage(SAMPLE_PKG, conversation, "hello", {
      apiKey: "sk-test",
      anthropicFactory: fake,
    });
    expect(result.done).toBe(false);
    expect(result.doneReason).toBe("error");
    expect(result.error).toContain("429");
  });
});

describe("sendMessage — auth pass-through", () => {
  it("attaches the PCC bearer to tool-call fetches", async () => {
    const fake = makeFakeAnthropic([
      {
        content: [{ type: "tool_use", id: "t1", name: "create_kernel", input: { name: "k1" } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 201,
        statusText: "Created",
        text: async () => JSON.stringify({ id: "k1" }),
      }) as unknown as Response,
    );

    await sendMessage(SAMPLE_PKG, [], "register", {
      apiKey: "sk-test",
      anthropicFactory: fake,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pccApiKey: "pcc_live_xyz",
    });

    const init = (fetchImpl as any).mock.calls[0][1];
    expect(init.headers.authorization).toBe("Bearer pcc_live_xyz");
  });
});

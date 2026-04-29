// onboarder-agent.test.ts — end-to-end happy path with a mocked Anthropic
// client and mocked sub-tools. Verifies that the OnboarderAgent wires
// LLMAgent + the 5 tool callers correctly: when the model says "call
// extract_url with input X", we get a tool_result back with the right shape.

import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { LLMAgent, type ToolDef } from "@pcc/agent-runtime";

import { OnboarderAgent } from "./onboarder-agent.js";
import { ONBOARDER_SYSTEM_PROMPT } from "./system-prompt.js";

// Mock the SDK exports at the module boundary so the agent's tool callers
// run against fakes. Keeps the test fast + deterministic.
vi.mock("@pcc/orchestrator-sdk", async () => {
  const actual = await vi.importActual<typeof import("@pcc/orchestrator-sdk")>(
    "@pcc/orchestrator-sdk"
  );
  return {
    ...actual,
    extractStructured: vi.fn(async () => ({
      name: "Oakland Titanium Mills",
      machines: [{ name: "Mazak Integrex i-400", kind: "5-axis mill-turn" }],
      services: ["titanium machining", "inconel turning"],
      contact: "ops@example.com",
      certifications: ["AS9100 Rev D"],
    })),
    publishOperator: vi.fn(async (p: { enterprise_id: string; name: string }) => ({
      registration_id: `reg-${p.enterprise_id.slice(0, 6)}`,
      discovery_url: `https://capability.network/operators/${p.enterprise_id.slice(0, 6)}`,
      dht_announced: true,
    })),
    searchCapabilities: vi.fn(async () => ({
      templates: [{ capabilityType: "fdm" }],
      items: [],
    })),
    writeOperatorMirror: vi.fn(async (p: { name: string }) => ({
      path: `/tmp/operators/${p.name.replace(/\s+/g, "-").toLowerCase()}.html`,
      slug: p.name.replace(/\s+/g, "-").toLowerCase(),
      url_path: `/operators/${p.name.replace(/\s+/g, "-").toLowerCase()}.html`,
    })),
    createAgentWallet: vi.fn(async (input: { enterprise_id: string }) => ({
      address: `0xabc${input.enterprise_id.slice(0, 6)}`,
      chain: "base-sepolia",
      funded: false,
      private_key_redacted: "0xabcd***1234",
    })),
  };
});

// Helper to build a fake Anthropic client that returns scripted responses.
function makeFakeClient(responses: Anthropic.Message[]): {
  client: Anthropic;
  create: ReturnType<typeof vi.fn>;
} {
  const queue = [...responses];
  const create = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("test: ran out of scripted responses");
    return next;
  });
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

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

describe("OnboarderAgent", () => {
  it("exposes 5 tools matching the discovery flow surface", () => {
    const tools = OnboarderAgent.getToolDefinitions();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "create_wallet",
      "extract_url",
      "publish_operator",
      "search_pcc",
      "write_static_mirror",
    ]);
  });

  it("each tool has an object input_schema with required fields", () => {
    const tools = OnboarderAgent.getToolDefinitions();
    for (const tool of tools) {
      const s = tool.input_schema as { type?: string; required?: string[] };
      expect(s.type).toBe("object");
      expect(Array.isArray(s.required)).toBe(true);
      expect(s.required!.length).toBeGreaterThan(0);
    }
  });

  it("uses ONBOARDER_SYSTEM_PROMPT by default and threads it to LLMAgent.chat", async () => {
    const { client, create } = makeFakeClient([
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Got it. What's your shop's website?", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const onboarder = new OnboarderAgent({ client });
    const result = await onboarder.chat("Hi, I have a machine shop");

    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    expect(args.system).toBe(ONBOARDER_SYSTEM_PROMPT);
    // The 5 tools should be advertised on every turn.
    expect(args.tools).toHaveLength(5);
    expect((args.tools as ToolDef[]).map((t) => t.name).sort()).toEqual([
      "create_wallet",
      "extract_url",
      "publish_operator",
      "search_pcc",
      "write_static_mirror",
    ]);
    expect(result.systemPrompt).toBe(ONBOARDER_SYSTEM_PROMPT);
    expect(result.text).toContain("website");
  });

  it("end-to-end: extract_url then publish_operator flow", async () => {
    const { client } = makeFakeClient([
      // Turn 1: model calls extract_url
      msg({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_extract",
            name: "extract_url",
            input: { url: "https://oaklandtitanium.example", goal: "extract profile" },
          } as Anthropic.ToolUseBlock,
        ],
      }),
      // Turn 2: model calls publish_operator with extracted data
      msg({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_publish",
            name: "publish_operator",
            input: {
              enterprise_id: "ent-12345",
              name: "Oakland Titanium Mills",
              capabilities: ["titanium machining", "inconel turning"],
              certifications: ["AS9100 Rev D"],
              contact_email: "ops@example.com",
            },
          } as Anthropic.ToolUseBlock,
        ],
      }),
      // Turn 3: model wraps up
      msg({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: "Done. Oakland Titanium Mills is registered at https://capability.network/operators/ent-12.",
            citations: [],
          } as Anthropic.TextBlock,
        ],
      }),
    ]);

    const onboarder = new OnboarderAgent({ client });
    const result = await onboarder.chat("My shop is at https://oaklandtitanium.example");

    // Expect 3 turns total (2 tool calls + final text).
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(2);
    expect(result.text).toContain("Oakland Titanium Mills");
    expect(result.text).toContain("registered");

    // Verify the tool_result from extract_url was fed back as the second user
    // turn (index 2 in messages: user-prompt, assistant(tool_use), user(tool_result), ...).
    const extractToolResultTurn = result.messages[2];
    expect(extractToolResultTurn?.role).toBe("user");
    const extractBlocks = extractToolResultTurn?.content as Anthropic.ToolResultBlockParam[];
    expect(extractBlocks[0]?.tool_use_id).toBe("tu_extract");
    expect(extractBlocks[0]?.is_error).toBeUndefined();
    const extractParsed = JSON.parse(extractBlocks[0]?.content as string);
    expect(extractParsed.name).toBe("Oakland Titanium Mills");
    expect(extractParsed.machines).toHaveLength(1);

    // Verify the tool_result from publish_operator was fed back as the
    // fourth message turn (after assistant publishes).
    const publishToolResultTurn = result.messages[4];
    expect(publishToolResultTurn?.role).toBe("user");
    const publishBlocks = publishToolResultTurn?.content as Anthropic.ToolResultBlockParam[];
    expect(publishBlocks[0]?.tool_use_id).toBe("tu_publish");
    expect(publishBlocks[0]?.is_error).toBeUndefined();
    const publishParsed = JSON.parse(publishBlocks[0]?.content as string);
    expect(publishParsed.registration_id).toBe("reg-ent-12");
    expect(publishParsed.dht_announced).toBe(true);
  });

  it("forwards an injected llmAgent (DI seam for production wiring)", async () => {
    const fakeAgent = {
      chat: vi.fn(async () => ({
        messages: [],
        final: { stop_reason: "end_turn" } as Anthropic.Message,
        text: "delegated",
        toolCalls: 0,
        iterations: 1,
      })),
    } as unknown as LLMAgent;

    const onboarder = new OnboarderAgent({ llmAgent: fakeAgent });
    const result = await onboarder.chat("hi");
    expect(fakeAgent.chat).toHaveBeenCalledOnce();
    // The injected agent receives the system prompt via opts.
    const callOpts = (fakeAgent.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(callOpts.system).toBe(ONBOARDER_SYSTEM_PROMPT);
    expect(result.text).toBe("delegated");
  });

  it("respects custom systemPrompt + maxTurns", async () => {
    const { client, create } = makeFakeClient([
      msg({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok", citations: [] } as Anthropic.TextBlock],
      }),
    ]);
    const onboarder = new OnboarderAgent({
      client,
      systemPrompt: "custom prompt",
      maxTurns: 5,
    });
    const result = await onboarder.chat("hi");
    const args = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParams;
    expect(args.system).toBe("custom prompt");
    expect(result.systemPrompt).toBe("custom prompt");
  });
});

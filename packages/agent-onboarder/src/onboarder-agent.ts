// OnboarderAgent — the brain that drives operator discovery + onboarding.
//
// Shape: a thin wrapper over LLMAgent (from @pcc/agent-runtime) that wires up
// 5 tool callers (extract_url, search_pcc, publish_operator,
// write_static_mirror, create_wallet) with the discovery system prompt.
//
// Why thin: each tool is its own module + tested in isolation. The agent's
// only job is to glue them together and give the LLM a coherent surface.
//
// TODO(wave-2.5): once `BaseAgent` from @pcc/agent-runtime gains a way to
// produce strictly Anthropic-format Tool[] (currently `getToolDefinitions()`
// returns a shape that's *similar* but not type-identical), make
// OnboarderAgent extend BaseAgent and feed `agent.getToolDefinitions()` into
// LLMAgent directly. This eliminates the manual TOOL_DEFS list below.
//
// TODO(wave-3): replace publish_operator's stub `agent_url` with a real one
// once the Pipecat voice doorway is up. For now we leave it null/undefined
// because the chat console is the only public face.

import type Anthropic from "@anthropic-ai/sdk";
import { LLMAgent, type ChatOptions, type ChatResult, type ToolCaller, type ToolDef } from "@pcc/agent-runtime";
import { z } from "zod";

import {
  extractStructured,
  publishOperator,
  searchCapabilities,
  writeOperatorMirror,
  createAgentWallet,
  type DiscoveryProfile,
} from "@pcc/orchestrator-sdk";
import { ONBOARDER_SYSTEM_PROMPT } from "./system-prompt.js";

/** Default schema used by extract_url when the model doesn't supply its own.
 *  Mirrors the v1 backend's draftSchema so downstream consumers see the same
 *  fields. */
const DEFAULT_EXTRACT_SCHEMA = z.object({
  name: z.string(),
  machines: z
    .array(
      z.object({
        name: z.string(),
        kind: z.string().optional(),
        envelope: z.string().optional(),
        notes: z.string().optional(),
      })
    )
    .optional(),
  hours: z.string().optional(),
  services: z.array(z.string()).optional(),
  contact: z.string().optional(),
  certifications: z.array(z.string()).optional(),
});

/** Tool surface as Anthropic.Tool[]. Hand-curated to keep the model's view of
 *  the agent stable across refactors. */
const TOOL_DEFS: ToolDef[] = [
  {
    name: "extract_url",
    description:
      "Pull a structured capability profile from an operator's website using stealth fetch + Claude tool-use. Returns name, machines, hours, services, contact, certifications.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to scrape (https://...)" },
        goal: {
          type: "string",
          description: "What you want extracted. Default: 'Extract company name, machines, hours, services, contact, and certifications.'",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "search_pcc",
    description: "Search the PCC capability network for existing capabilities and templates that match the operator's services.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text query, e.g. 'titanium 5-axis machining'" },
        limit: { type: "number", description: "Max results to return. Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "publish_operator",
    description:
      "Register the operator on PCC and announce to the DHT. Returns a discovery URL. Idempotent — safe to call multiple times during a session.",
    input_schema: {
      type: "object",
      properties: {
        enterprise_id: { type: "string", description: "Stable session id for this onboarding" },
        name: { type: "string" },
        url: { type: "string" },
        city: { type: "string" },
        capabilities: { type: "array", items: { type: "string" }, description: "Plain-text capability labels" },
        materials: { type: "array", items: { type: "string" } },
        hours: { type: "string" },
        certifications: { type: "array", items: { type: "string" } },
        agent_url: { type: "string" },
        marketplace_url: { type: "string" },
        contact_email: { type: "string" },
      },
      required: ["enterprise_id", "name", "capabilities"],
    },
  },
  {
    name: "write_static_mirror",
    description:
      "Generate the operator's static SEO mirror (HTML + JSON-LD). Call after publish_operator. Returns the on-disk path and url_path.",
    input_schema: {
      type: "object",
      properties: {
        enterprise_id: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        city: { type: "string" },
        capabilities: { type: "array", items: { type: "string" } },
        materials: { type: "array", items: { type: "string" } },
        hours: { type: "string" },
        certifications: { type: "array", items: { type: "string" } },
        agent_url: { type: "string" },
        marketplace_url: { type: "string" },
        contact_email: { type: "string" },
      },
      required: ["enterprise_id", "name", "capabilities"],
    },
  },
  {
    name: "create_wallet",
    description:
      "Mint a fresh Base Sepolia wallet for the operator using viem (no CDP). Local key generation, no network call. Returns address + redacted private key.",
    input_schema: {
      type: "object",
      properties: {
        enterprise_id: { type: "string", description: "Stable session id" },
      },
      required: ["enterprise_id"],
    },
  },
];

export interface OnboarderAgentOptions {
  /** Override system prompt. Defaults to ONBOARDER_SYSTEM_PROMPT. */
  systemPrompt?: string;
  /** Anthropic client (DI for testing). */
  client?: Anthropic;
  /** Model id, e.g. "claude-sonnet-4-6". */
  model?: string;
  /** Max tool-use turns per chat call. Default 12. */
  maxTurns?: number;
  /** Override the underlying LLMAgent (DI for testing). When set, the
   *  constructor uses it as-is; tools/system-prompt args still wire up the
   *  `chat()` API but won't re-create the agent. */
  llmAgent?: LLMAgent;
}

export interface OnboarderChatResult extends ChatResult {
  /** The system prompt that was actually sent. */
  systemPrompt: string;
}

/**
 * OnboarderAgent — wraps LLMAgent with the 5 onboarding tools and the
 * discovery system prompt. Drop-in replacement for the v1 backend's
 * hand-rolled state-machine + REST endpoints.
 *
 * Usage:
 *   const agent = new OnboarderAgent();
 *   const result = await agent.chat("My shop is at https://example.com");
 */
export class OnboarderAgent {
  private agent: LLMAgent;
  private systemPrompt: string;
  private maxTurns: number;

  constructor(opts: OnboarderAgentOptions = {}) {
    this.systemPrompt = opts.systemPrompt ?? ONBOARDER_SYSTEM_PROMPT;
    this.maxTurns = opts.maxTurns ?? 12;
    this.agent =
      opts.llmAgent ??
      new LLMAgent(TOOL_DEFS, this.buildToolCallers(), {
        ...(opts.client ? { client: opts.client } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      });
  }

  /** Run a single user-prompt turn through the tool-use loop. */
  async chat(input: string, opts: Omit<ChatOptions, "system"> = {}): Promise<OnboarderChatResult> {
    const result = await this.agent.chat(input, {
      ...opts,
      system: this.systemPrompt,
      maxTurns: opts.maxTurns ?? this.maxTurns,
    });
    return { ...result, systemPrompt: this.systemPrompt };
  }

  /** Build the Anthropic-shaped Tool[] that the model sees. Exposed for
   *  callers that want to introspect the agent's surface (e.g. tests, docs). */
  static getToolDefinitions(): ToolDef[] {
    return TOOL_DEFS;
  }

  // ── Internal ────────────────────────────────────────────────────

  private buildToolCallers(): Record<string, ToolCaller> {
    return {
      extract_url: async (raw) => {
        const input = raw as { url: string; goal?: string };
        return extractStructured({
          url: input.url,
          schema: DEFAULT_EXTRACT_SCHEMA,
          goal:
            input.goal ??
            "Extract company name, machines (each with name, kind, envelope/dimensions, notes), operating hours, services offered, primary contact email, and certifications.",
        });
      },
      search_pcc: async (raw) => {
        const input = raw as { query: string; limit?: number };
        return searchCapabilities(input.query, input.limit !== undefined ? { limit: input.limit } : {});
      },
      publish_operator: async (raw) => {
        const profile = raw as DiscoveryProfile;
        return publishOperator(profile);
      },
      write_static_mirror: async (raw) => {
        const profile = raw as DiscoveryProfile;
        return writeOperatorMirror(profile);
      },
      create_wallet: async (raw) => {
        const input = raw as { enterprise_id: string };
        return createAgentWallet(input);
      },
    };
  }
}

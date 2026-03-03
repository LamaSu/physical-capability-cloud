/**
 * BaseAgent — the foundation every PCC agent extends.
 *
 * Provides:
 * - Identity (AgentCard)
 * - Wallet (sign, pay, interact with contracts)
 * - Messaging (send/receive A2A messages via the bus)
 * - Tool registry (actions the agent can take)
 * - Intent handler registry (what intents this agent responds to)
 */

import type {
  AgentCard,
  AgentRole,
  A2AMessage,
  Intent,
  Conversation,
} from "@pcc/a2a";
import { MessageBus } from "@pcc/a2a";
import { AgentWallet, type WalletConfig } from "./wallet.js";
import type { Address } from "@pcc/spec";
import { ids } from "@pcc/spec";

/** A tool an agent can use */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/** Handler for a specific intent type */
export type IntentHandler = (
  message: A2AMessage,
  agent: BaseAgent,
) => Promise<Intent | null>;

export interface BaseAgentConfig {
  name: string;
  role: AgentRole;
  description: string;
  wallet?: WalletConfig;
  bus: MessageBus;
}

export abstract class BaseAgent {
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
  readonly description: string;
  readonly wallet: AgentWallet;
  readonly card: AgentCard;

  protected bus: MessageBus;
  protected tools: Map<string, AgentTool> = new Map();
  protected intentHandlers: Map<string, IntentHandler> = new Map();
  private running = false;

  constructor(config: BaseAgentConfig) {
    this.id = ids.job(); // reusing id generator, prefix doesn't matter for agents
    this.name = config.name;
    this.role = config.role;
    this.description = config.description;
    this.wallet = new AgentWallet(config.wallet);
    this.bus = config.bus;

    this.card = {
      id: this.id,
      name: this.name,
      role: this.role,
      walletAddress: this.wallet.address,
      capabilities: [],
      endpoint: `agent://${this.id}`,
      description: this.description,
      supportedIntents: [],
      publicKey: this.wallet.address, // simplified: use address as public key
    };
  }

  /** Start the agent — register on bus and begin handling messages */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Update card with registered intents
    this.card.supportedIntents = [...this.intentHandlers.keys()];

    // Register on bus
    this.bus.register(this.card);
    this.bus.subscribe(this.id, (msg) => this.handleMessage(msg));

    this.onStart();
  }

  /** Stop the agent */
  stop(): void {
    this.running = false;
    this.bus.unregister(this.id);
    this.onStop();
  }

  /** Send a message to another agent */
  async send(
    to: string,
    intent: Intent,
    conversationId?: string,
    inReplyTo?: string,
  ): Promise<A2AMessage> {
    const message: A2AMessage = {
      id: ids.job(),
      conversationId: conversationId ?? ids.job(),
      from: this.id,
      to,
      intent,
      timestamp: new Date().toISOString(),
      inReplyTo,
    };

    // Sign the message
    const sig = await this.wallet.signMessage(
      JSON.stringify({ id: message.id, intent: message.intent.type, timestamp: message.timestamp }),
    );
    message.signature = sig;

    await this.bus.send(message);
    return message;
  }

  /** Reply to a message */
  async reply(original: A2AMessage, intent: Intent): Promise<A2AMessage> {
    return this.send(original.from, intent, original.conversationId, original.id);
  }

  /** Find agents that can handle a specific intent */
  findAgentsForIntent(intentType: string): AgentCard[] {
    return this.bus.findByIntent(intentType);
  }

  /** Find agents by role */
  findAgentsByRole(role: AgentRole): AgentCard[] {
    return this.bus.findAgents(role);
  }

  /** Start a new conversation with another agent */
  async startConversation(
    toAgentId: string,
    intent: Intent,
  ): Promise<{ message: A2AMessage; conversationId: string }> {
    const conversationId = ids.job();
    const message = await this.send(toAgentId, intent, conversationId);
    return { message, conversationId };
  }

  /** Register a tool this agent can use */
  protected registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Register a handler for an intent type */
  protected onIntent(intentType: string, handler: IntentHandler): void {
    this.intentHandlers.set(intentType, handler);
  }

  /** Get all registered tools (for LLM tool-use) */
  getTools(): AgentTool[] {
    return [...this.tools.values()];
  }

  /** Get tool definitions in OpenAI/Anthropic function-calling format */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }]),
        ),
        required: Object.entries(tool.parameters)
          .filter(([, v]) => v.required !== false)
          .map(([k]) => k),
      },
    }));
  }

  /** Execute a tool by name */
  async executeTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(params);
  }

  // ── Internal ────────────────────────────────────────────────────

  private async handleMessage(message: A2AMessage): Promise<void> {
    const handler = this.intentHandlers.get(message.intent.type);
    if (handler) {
      const response = await handler(message, this);
      if (response) {
        await this.reply(message, response);
      }
    } else {
      // No handler — send error
      await this.reply(message, {
        type: "error",
        code: "unsupported_intent",
        message: `Agent ${this.name} does not handle intent: ${message.intent.type}`,
        retryable: false,
      });
    }
  }

  /** Called when agent starts — override in subclasses */
  protected onStart(): void {}

  /** Called when agent stops — override in subclasses */
  protected onStop(): void {}
}

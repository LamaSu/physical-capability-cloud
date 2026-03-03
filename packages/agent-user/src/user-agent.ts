/**
 * User Agent — the agent a user (or their AI) talks to.
 *
 * This agent:
 *   1. Holds the user's wallet
 *   2. Translates user intent into A2A messages to the broker
 *   3. Evaluates quotes and options
 *   4. Approves and funds escrow
 *   5. Tracks job progress
 *   6. Receives completed items via courier
 *
 * In the real world, this is what Claude/OpenClaw/any LLM agent
 * would use as its "manufacturing toolkit."
 */

import { BaseAgent } from "@pcc/agent-runtime";
import type { MessageBus, A2AMessage, Intent, QuoteResponseIntent, WorkflowAcceptedIntent, JobStatusResponseIntent, CapabilitiesResponseIntent } from "@pcc/a2a";
import type { CWM, SHA256 } from "@pcc/spec";
import { ids } from "@pcc/spec";

/** Callback for when the user agent receives a response that needs user attention */
export type UserNotificationCallback = (notification: UserNotification) => void;

export interface UserNotification {
  type: "capabilities_found" | "quote_received" | "workflow_accepted" | "payment_needed" | "job_update" | "job_completed" | "message" | "error";
  data: unknown;
  conversationId: string;
  requiresAction: boolean;
  /** Human-readable summary */
  summary: string;
}

export class UserAgent extends BaseAgent {
  private notifications: UserNotification[] = [];
  private notifyCallback?: UserNotificationCallback;
  private pendingQuotes: Map<string, QuoteResponseIntent> = new Map();
  private activePlanId?: string;
  private brokerAgentId?: string;

  constructor(bus: MessageBus, walletConfig?: { privateKey?: `0x${string}` }) {
    super({
      name: "User Agent",
      role: "user",
      description: "Represents a user: discovers capabilities, negotiates quotes, funds escrow, tracks jobs",
      wallet: walletConfig,
      bus,
    });

    this.setupIntentHandlers();
    this.setupTools();
  }

  /** Set callback for notifications */
  onNotification(cb: UserNotificationCallback): void {
    this.notifyCallback = cb;
  }

  /** Get all notifications */
  getNotifications(): UserNotification[] {
    return [...this.notifications];
  }

  // ── High-Level Actions (what an LLM would call) ────────────────

  /** Ask the broker: "What can do X?" */
  async discoverCapabilities(opts: {
    capabilityType?: string;
    material?: string;
    maxPrice?: string;
    assuranceTier?: number;
    query?: string;
  }): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "discover_capabilities",
      ...opts,
    });
    return { conversationId };
  }

  /** Ask the broker for a quote */
  async requestQuote(opts: {
    capabilityType: string;
    params: Record<string, unknown>;
    assuranceTier?: number;
    quantity?: number;
  }): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "request_quote",
      capabilityType: opts.capabilityType,
      params: opts.params,
      assuranceTier: opts.assuranceTier ?? 1,
      quantity: opts.quantity ?? 1,
    });
    return { conversationId };
  }

  /** Counter-offer on a quote */
  async negotiate(quoteId: string, counterOffer: {
    maxPrice?: string;
    preferredStart?: string;
    assuranceTier?: number;
  }): Promise<void> {
    const broker = this.findBroker();
    await this.send(broker, {
      type: "negotiate",
      quoteId,
      counterOffer,
    });
  }

  /** Submit a full workflow to the broker */
  async submitWorkflow(cwm: CWM): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "submit_workflow",
      cwm: cwm as any,
      acceptedQuotes: {},
      payerWallet: this.wallet.address,
    });
    return { conversationId };
  }

  /** Check status of active job */
  async checkStatus(planId?: string): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "job_status_query",
      planId: planId ?? this.activePlanId,
    });
    return { conversationId };
  }

  /** Send a free-text message to the broker */
  async chat(text: string): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "text_message",
      text,
    });
    return { conversationId };
  }

  // ── Intent Handlers (responses from other agents) ──────────────

  private setupIntentHandlers(): void {
    this.onIntent("capabilities_response", async (msg) => {
      const intent = msg.intent as CapabilitiesResponseIntent;
      this.notify({
        type: "capabilities_found",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: false,
        summary: `Found ${intent.totalMatches} matching capabilities. ` +
          (intent.matches.length > 0
            ? `Best: ${intent.matches[0].capabilityName} at $${intent.matches[0].price} (${intent.matches[0].kernelName})`
            : "No matches."),
      });
      return null;
    });

    this.onIntent("quote_response", async (msg) => {
      const intent = msg.intent as QuoteResponseIntent;
      this.pendingQuotes.set(intent.quoteId, intent);
      this.notify({
        type: "quote_received",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: true,
        summary: `Quote received: $${intent.totalPrice} ${intent.currency} for ${intent.kernelName}. ` +
          `Tier ${intent.assuranceTier}, available ${new Date(intent.estimatedStart).toLocaleString()}. ` +
          `Bond: $${intent.operatorBond}. Valid until ${new Date(intent.validUntil).toLocaleString()}.` +
          (intent.options?.length ? ` ${intent.options.length} upgrade options available.` : ""),
      });
      return null;
    });

    this.onIntent("workflow_accepted", async (msg) => {
      const intent = msg.intent as WorkflowAcceptedIntent;
      this.activePlanId = intent.planId;
      this.notify({
        type: "workflow_accepted",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: true,
        summary: `Workflow accepted! Plan ${intent.planId}. ` +
          `Escrow: $${intent.totalEscrowAmount} ${intent.currency} to ${intent.escrowAddress}. ` +
          `${intent.milestones.length} milestones. Fund escrow to begin.`,
      });
      return null;
    });

    this.onIntent("job_status_response", async (msg) => {
      const intent = msg.intent as JobStatusResponseIntent;
      const isComplete = intent.overallStatus === "completed";
      this.notify({
        type: isComplete ? "job_completed" : "job_update",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: false,
        summary: isComplete
          ? `Job ${intent.planId} COMPLETED! All ${intent.steps.length} steps done.`
          : `Job ${intent.planId}: ${intent.overallStatus}. ` +
            intent.steps.map((s) => `${s.stepId}: ${s.status} (${s.progress}%)`).join(", "),
      });
      return null;
    });

    this.onIntent("negotiation_response", async (msg) => {
      const intent = msg.intent as any;
      this.notify({
        type: "message",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: !intent.accepted,
        summary: intent.accepted
          ? `Negotiation accepted: ${intent.message}`
          : `Negotiation rejected: ${intent.message}`,
      });
      return null;
    });

    this.onIntent("payment_request", async (msg) => {
      const intent = msg.intent as any;
      this.notify({
        type: "payment_needed",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: true,
        summary: `Payment requested: $${intent.amount} ${intent.currency} for ${intent.reason}. Pay to ${intent.payTo}.`,
      });
      return null;
    });

    this.onIntent("text_message", async (msg) => {
      const intent = msg.intent as any;
      this.notify({
        type: "message",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: false,
        summary: intent.text,
      });
      return null;
    });

    this.onIntent("error", async (msg) => {
      const intent = msg.intent as any;
      this.notify({
        type: "error",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: intent.retryable,
        summary: `Error: ${intent.message}`,
      });
      return null;
    });
  }

  private setupTools(): void {
    this.registerTool({
      name: "discover",
      description: "Find manufacturing capabilities (e.g., 3D printers, CNC machines) available on the network",
      parameters: {
        capability_type: { type: "string", description: "Type: fdm, sla, cnc-3axis, cnc-5axis, lathe, laser-cut" },
        material: { type: "string", description: "Material needed (e.g., pla, aluminum-6061)", required: false },
        max_price: { type: "string", description: "Maximum price (e.g., '50.00')", required: false },
      },
      execute: async (params) => this.discoverCapabilities({
        capabilityType: params.capability_type as string,
        material: params.material as string,
        maxPrice: params.max_price as string,
      }),
    });

    this.registerTool({
      name: "get_quote",
      description: "Request a price quote for manufacturing a part",
      parameters: {
        capability_type: { type: "string", description: "Type of manufacturing" },
        material: { type: "string", description: "Material" },
        assurance_tier: { type: "number", description: "Quality assurance level 0-3", required: false },
      },
      execute: async (params) => this.requestQuote({
        capabilityType: params.capability_type as string,
        params: { material: params.material },
        assuranceTier: params.assurance_tier as number,
      }),
    });

    this.registerTool({
      name: "check_job_status",
      description: "Check the status of your current manufacturing job",
      parameters: {},
      execute: async () => this.checkStatus(),
    });

    this.registerTool({
      name: "chat_with_broker",
      description: "Send a natural language message to the manufacturing broker",
      parameters: {
        message: { type: "string", description: "What you want to tell/ask the broker" },
      },
      execute: async (params) => this.chat(params.message as string),
    });
  }

  // ── Private ────────────────────────────────────────────────────

  private findBroker(): string {
    if (this.brokerAgentId) return this.brokerAgentId;
    const brokers = this.findAgentsByRole("scheduler");
    if (brokers.length === 0) throw new Error("No broker agent found on the network");
    this.brokerAgentId = brokers[0].id;
    return this.brokerAgentId;
  }

  private notify(notification: UserNotification): void {
    this.notifications.push(notification);
    this.notifyCallback?.(notification);
  }
}

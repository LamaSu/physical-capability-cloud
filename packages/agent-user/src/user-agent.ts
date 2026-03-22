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

import { BaseAgent, SettlementClient, UnbrowseClient, type SettlementResult } from "@pcc/agent-runtime";
import type { MessageBus, A2AMessage, Intent, QuoteResponseIntent, WorkflowAcceptedIntent, JobStatusResponseIntent, CapabilitiesResponseIntent, BuildOptionsResponseIntent, ContractBuiltResponseIntent, UnbrowseResultIntent, UnbrowseSkillSharedIntent } from "@pcc/a2a";
import type { CWM, SHA256 } from "@pcc/spec";
import { ids } from "@pcc/spec";

/** Callback for when the user agent receives a response that needs user attention */
export type UserNotificationCallback = (notification: UserNotification) => void;

export interface UserNotification {
  type: "capabilities_found" | "quote_received" | "workflow_accepted" | "payment_needed" | "job_update" | "job_completed" | "build_options" | "contract_built" | "unbrowse_results" | "unbrowse_skill_shared" | "message" | "error";
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
  private settlement?: SettlementClient;
  private unbrowse?: UnbrowseClient;

  constructor(bus: MessageBus, walletConfig?: { privateKey?: `0x${string}` }, opts?: {
    /** Gateway URL for batch settlement (e.g., "http://localhost:3200") */
    gatewayUrl?: string;
    /** Unbrowse server URL (default: http://localhost:6969) */
    unbrowseUrl?: string;
  }) {
    super({
      name: "User Agent",
      role: "user",
      description: "Represents a user: discovers capabilities, negotiates quotes, funds escrow, tracks jobs",
      wallet: walletConfig,
      bus,
    });

    if (opts?.gatewayUrl) {
      this.settlement = new SettlementClient({
        gatewayUrl: opts.gatewayUrl,
        agentId: this.id,
        wallet: this.wallet,
      });
    }

    if (opts?.unbrowseUrl || process.env.UNBROWSE_URL) {
      this.unbrowse = new UnbrowseClient({ serverUrl: opts?.unbrowseUrl });
    }

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

  /** Explore configurable build options for a capability type */
  async exploreBuildOptions(opts: {
    capabilityType: string;
    currentSelections?: Record<string, unknown>;
    profileId?: string;
  }): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "get_build_options",
      capabilityType: opts.capabilityType,
      currentSelections: opts.currentSelections,
      profileId: opts.profileId,
    });
    return { conversationId };
  }

  /** Build a validated, priced contract from selections */
  async buildContract(opts: {
    capabilityType: string;
    selections: Record<string, unknown>;
    assuranceTier?: number;
    profileId?: string;
  }): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "build_contract",
      capabilityType: opts.capabilityType,
      selections: opts.selections,
      assuranceTier: opts.assuranceTier ?? 1,
      profileId: opts.profileId,
    });
    return { conversationId };
  }

  // ── Unbrowse (capability discovery beyond PCC) ─────────────────

  /** Search for capabilities outside the PCC network via Unbrowse */
  async searchExternal(query: string, opts?: {
    targetUrl?: string;
    maxResults?: number;
  }): Promise<{ conversationId: string }> {
    const broker = this.findBroker();
    const { conversationId } = await this.startConversation(broker, {
      type: "unbrowse_query",
      query,
      targetUrl: opts?.targetUrl,
      maxResults: opts?.maxResults ?? 10,
      dryRun: true,
    });
    return { conversationId };
  }

  /** Share a discovered Unbrowse skill with the network */
  async shareSkill(skillId: string, domain: string, intent: string): Promise<void> {
    const broker = this.findBroker();
    await this.send(broker, {
      type: "unbrowse_share_skill",
      skillId,
      domain,
      intent,
      discoveredBy: this.id,
      discoveredAt: new Date().toISOString(),
    });
  }

  /** Direct Unbrowse search (bypasses broker, uses local Unbrowse instance) */
  async searchUnbrowseDirect(query: string): Promise<Array<{
    skillId: string;
    domain: string;
    intent: string;
    confidence: number;
  }>> {
    if (!this.unbrowse) return [];
    return this.unbrowse.searchExternalCapabilities(query);
  }

  // ── Escrow / Settlement ────────────────────────────────────────

  /**
   * Fund an escrow contract. Routes through the batch settlement service
   * when available, falling back to direct wallet calls.
   */
  async fundEscrow(escrowAddress: `0x${string}`, tokenAddress?: `0x${string}`, amount?: string): Promise<SettlementResult | { transactionHash: string }> {
    if (this.settlement) {
      return this.settlement.fund(escrowAddress);
    }

    // Direct fallback: approve + fund
    if (tokenAddress && amount) {
      await this.wallet.approveToken(tokenAddress, escrowAddress, amount);
    }
    const txHash = await this.wallet.fundEscrow(escrowAddress);
    return { transactionHash: txHash };
  }

  /** Get the settlement client (if configured) */
  getSettlement(): SettlementClient | undefined {
    return this.settlement;
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

    this.onIntent("build_options_response", async (msg) => {
      const intent = msg.intent as BuildOptionsResponseIntent;
      const paramCount = intent.groups.reduce((s, g) => s + g.params.length, 0);
      this.notify({
        type: "build_options",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: true,
        summary: `Build options for ${intent.templateName}: ${paramCount} configurable parameters in ${intent.groups.length} groups. ` +
          `Base price: $${intent.basePrice} ${intent.currency}.` +
          (intent.machineInfo ? ` Machine: ${intent.machineInfo.machineName}.` : ""),
      });
      return null;
    });

    this.onIntent("contract_built_response", async (msg) => {
      const intent = msg.intent as ContractBuiltResponseIntent;
      this.notify({
        type: "contract_built",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: !intent.isValid,
        summary: intent.isValid
          ? `Contract built: $${intent.totalPrice} ${intent.currency} for ${intent.templateName}. ` +
            `${intent.priceBreakdown.length} line items. Ready to submit.`
          : `Contract has ${intent.validationErrors.length} errors: ${intent.validationErrors.map((e) => e.message).join("; ")}`,
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

    // Unbrowse results (from broker after unbrowse_query)
    this.onIntent("unbrowse_result", async (msg) => {
      const intent = msg.intent as UnbrowseResultIntent;
      this.notify({
        type: "unbrowse_results",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: false,
        summary: `Unbrowse: ${intent.totalResults} external results for "${intent.query}" (${intent.durationMs}ms). ` +
          (intent.results.length > 0
            ? `Top: ${intent.results[0].domain} (${(intent.results[0].confidence * 100).toFixed(0)}% confidence)`
            : "No results."),
      });
      return null;
    });

    // Skill shared notification (broadcast from broker)
    this.onIntent("unbrowse_skill_shared", async (msg) => {
      const intent = msg.intent as UnbrowseSkillSharedIntent;
      this.notify({
        type: "unbrowse_skill_shared",
        data: intent,
        conversationId: msg.conversationId,
        requiresAction: false,
        summary: `New Unbrowse skill shared: ${intent.skillId} (${intent.networkReach} agents reached)`,
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
      name: "explore_build_options",
      description: "Discover all configurable parameters for a manufacturing process (e.g., materials, infill, layer height, post-processing) with pricing",
      parameters: {
        capability_type: { type: "string", description: "Process type: fdm, sla, cnc-3axis, laser-cut" },
        profile_id: { type: "string", description: "Specific machine profile ID", required: false },
      },
      execute: async (params) => this.exploreBuildOptions({
        capabilityType: params.capability_type as string,
        profileId: params.profile_id as string | undefined,
      }),
    });

    this.registerTool({
      name: "configure_and_build",
      description: "Build a priced, validated contract from parameter selections",
      parameters: {
        capability_type: { type: "string", description: "Process type: fdm, sla, cnc-3axis, laser-cut" },
        selections: { type: "string", description: "JSON string of parameter selections" },
        assurance_tier: { type: "number", description: "Quality assurance level 0-3", required: false },
      },
      execute: async (params) => this.buildContract({
        capabilityType: params.capability_type as string,
        selections: JSON.parse(params.selections as string),
        assuranceTier: params.assurance_tier as number | undefined,
      }),
    });

    this.registerTool({
      name: "chat_with_broker",
      description: "Send a natural language message to the manufacturing broker",
      parameters: {
        message: { type: "string", description: "What you want to tell/ask the broker" },
      },
      execute: async (params) => this.chat(params.message as string),
    });

    this.registerTool({
      name: "search_external",
      description: "Search for manufacturing capabilities OUTSIDE the PCC network via Unbrowse (e.g., Xometry, Hubs, McMaster-Carr, Protolabs). Discovers real vendor APIs automatically.",
      parameters: {
        query: { type: "string", description: "What you need (e.g., 'CNC machining in titanium', 'injection molding quotes')" },
        url: { type: "string", description: "Specific vendor URL to query", required: false },
      },
      execute: async (params) => this.searchExternal(params.query as string, {
        targetUrl: params.url as string | undefined,
      }),
    });

    this.registerTool({
      name: "share_skill",
      description: "Share a discovered Unbrowse skill with all agents on the network. Other agents can reuse it instantly.",
      parameters: {
        skill_id: { type: "string", description: "Unbrowse skill ID to share" },
        domain: { type: "string", description: "Domain the skill targets" },
        intent: { type: "string", description: "What the skill does" },
      },
      execute: async (params) => this.shareSkill(
        params.skill_id as string,
        params.domain as string,
        params.intent as string,
      ),
    });

    this.registerTool({
      name: "fund_escrow",
      description: "Fund an escrow contract (approve USDC + call fund). Routes through batch settlement for higher throughput.",
      parameters: {
        escrow_address: { type: "string", description: "Escrow contract address" },
        token_address: { type: "string", description: "USDC token address (for direct fallback)", required: false },
        amount: { type: "string", description: "Amount to approve (for direct fallback)", required: false },
      },
      execute: async (params) => this.fundEscrow(
        params.escrow_address as `0x${string}`,
        params.token_address as `0x${string}` | undefined,
        params.amount as string | undefined,
      ),
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

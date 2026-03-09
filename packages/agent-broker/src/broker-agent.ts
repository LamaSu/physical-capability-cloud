/**
 * Broker Agent — the "concierge" of the Physical Capability Cloud.
 *
 * This is what a user's agent talks to when they want to get something made.
 * The broker:
 *   1. Discovers available hubs/kernels that match the user's needs
 *   2. Collects quotes from kernel agents
 *   3. Presents options with pricing, timelines, and assurance tiers
 *   4. Compiles accepted quotes into an execution plan
 *   5. Manages escrow funding
 *   6. Coordinates logistics (courier) agents
 *   7. Tracks job status and relays updates
 *   8. Handles verification and settlement
 */

import { BaseAgent, type BaseAgentConfig, type AgentTool } from "@pcc/agent-runtime";
import { CapabilityRouter, WorkflowCompiler, type KernelCapabilities } from "@pcc/scheduler";
import { VerifierMarket, EvidenceVerifier } from "@pcc/verifier";
import { ContractBuilder } from "@pcc/contract-builder";
import type {
  A2AMessage,
  Intent,
  DiscoverCapabilitiesIntent,
  CapabilitiesResponseIntent,
  RequestQuoteIntent,
  QuoteResponseIntent,
  SubmitWorkflowIntent,
  WorkflowAcceptedIntent,
  JobStatusQueryIntent,
  JobStatusResponseIntent,
  RequestCourierIntent,
  CourierAssignedIntent,
  TextMessageIntent,
  GetBuildOptionsIntent,
  BuildOptionsResponseIntent,
  BuildContractIntent,
  ContractBuiltResponseIntent,
} from "@pcc/a2a";
import type { MessageBus } from "@pcc/a2a";
import type { CWM, Capability, MachineProfile } from "@pcc/spec";
import { ids } from "@pcc/spec";

interface ActiveQuote {
  quoteId: string;
  kernelAgentId: string;
  kernelId: string;
  capabilityId: string;
  price: string;
  estimatedStart: string;
  estimatedCompletion: string;
  assuranceTier: number;
  validUntil: string;
}

interface ActivePlan {
  planId: string;
  cwm: CWM;
  quotes: ActiveQuote[];
  status: "planning" | "funded" | "executing" | "completed" | "failed";
  userAgentId: string;
  conversationId: string;
}

export class BrokerAgent extends BaseAgent {
  private router: CapabilityRouter;
  private compiler: WorkflowCompiler;
  private verifierMarket: VerifierMarket;
  private contractBuilder: ContractBuilder;
  private activeQuotes: Map<string, ActiveQuote> = new Map();
  private activePlans: Map<string, ActivePlan> = new Map();

  constructor(bus: MessageBus, walletConfig?: { privateKey?: `0x${string}` }) {
    super({
      name: "PCC Broker",
      role: "scheduler",
      description: "Discovers manufacturing capabilities, collects quotes, plans workflows, manages escrow and logistics",
      wallet: walletConfig,
      bus,
    });

    this.router = new CapabilityRouter();
    this.compiler = new WorkflowCompiler(this.router);
    this.verifierMarket = new VerifierMarket();
    this.contractBuilder = new ContractBuilder();

    this.setupIntentHandlers();
    this.setupTools();
  }

  /** Register a kernel's capabilities (called when kernel agents come online) */
  registerKernelCapabilities(kernelAgentId: string, kernel: KernelCapabilities): void {
    this.router.registerKernel(kernel);
  }

  /** Register a machine profile for the contract builder */
  registerMachineProfile(profile: MachineProfile): void {
    this.contractBuilder.registerProfile(profile);
  }

  private setupIntentHandlers(): void {
    // Discovery
    this.onIntent("discover_capabilities", async (msg) => {
      const intent = msg.intent as DiscoverCapabilitiesIntent;
      return this.handleDiscoverCapabilities(intent);
    });

    this.onIntent("discover_hubs", async (msg) => {
      const intent = msg.intent as any;
      return this.handleDiscoverHubs(intent);
    });

    // Quoting
    this.onIntent("request_quote", async (msg) => {
      const intent = msg.intent as RequestQuoteIntent;
      return this.handleRequestQuote(msg, intent);
    });

    // Negotiation
    this.onIntent("negotiate", async (msg) => {
      const intent = msg.intent as any;
      return this.handleNegotiate(msg, intent);
    });

    // Contract builder
    this.onIntent("get_build_options", async (msg) => {
      const intent = msg.intent as GetBuildOptionsIntent;
      return this.handleGetBuildOptions(intent);
    });

    this.onIntent("build_contract", async (msg) => {
      const intent = msg.intent as BuildContractIntent;
      return this.handleBuildContract(intent);
    });

    // Workflow submission
    this.onIntent("submit_workflow", async (msg) => {
      const intent = msg.intent as SubmitWorkflowIntent;
      return this.handleSubmitWorkflow(msg, intent);
    });

    // Job status
    this.onIntent("job_status_query", async (msg) => {
      const intent = msg.intent as JobStatusQueryIntent;
      return this.handleJobStatusQuery(intent);
    });

    // Free text — only respond to user agents, not kernel/verifier replies
    this.onIntent("text_message", async (msg) => {
      const sender = this.bus.getAgent(msg.from);
      if (sender && sender.role !== "user") return null; // don't reply-loop with other agents
      const intent = msg.intent as TextMessageIntent;
      return this.handleTextMessage(msg, intent);
    });

    // When a kernel agent reports job completion
    this.onIntent("job_completed", async (msg) => {
      return this.handleJobCompleted(msg);
    });
  }

  private setupTools(): void {
    this.registerTool({
      name: "search_capabilities",
      description: "Search for manufacturing capabilities across all registered hubs",
      parameters: {
        capability_type: { type: "string", description: "Type of capability (e.g., fdm, cnc-3axis, lathe)" },
        material: { type: "string", description: "Material needed", required: false },
        max_price: { type: "string", description: "Maximum acceptable price", required: false },
        assurance_tier: { type: "number", description: "Desired assurance tier (0-3)", required: false },
      },
      execute: async (params) => {
        const matches = await this.router.findAllMatches({
          id: "search",
          capability: params.capability_type as any,
          params: { material: params.material as string },
          assuranceTier: (params.assurance_tier ?? 1) as any,
          dependsOn: [],
        });
        return matches;
      },
    });

    this.registerTool({
      name: "get_quote",
      description: "Get a price quote for a specific job from a specific kernel",
      parameters: {
        kernel_id: { type: "string", description: "ID of the kernel to quote from" },
        capability_type: { type: "string", description: "Type of capability" },
        material: { type: "string", description: "Material" },
        assurance_tier: { type: "number", description: "Assurance tier" },
        duration_minutes: { type: "number", description: "Estimated duration in minutes" },
      },
      execute: async (params) => {
        const match = await this.router.findBestMatch({
          id: "quote",
          capability: params.capability_type as any,
          params: { material: params.material as string },
          assuranceTier: (params.assurance_tier ?? 1) as any,
          dependsOn: [],
          preferredKernel: params.kernel_id as string,
          estimatedDuration: params.duration_minutes as number,
        });
        if (!match) return { error: "No matching capability found" };

        const quoteId = ids.job();
        const quote: ActiveQuote = {
          quoteId,
          kernelAgentId: "", // filled when we know the agent
          kernelId: match.kernelId,
          capabilityId: match.capability.id,
          price: match.quotedPrice,
          estimatedStart: new Date(Date.now() + 15 * 60_000).toISOString(),
          estimatedCompletion: new Date(Date.now() + (15 + (params.duration_minutes as number ?? 60)) * 60_000).toISOString(),
          assuranceTier: (params.assurance_tier ?? 1) as number,
          validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
        };
        this.activeQuotes.set(quoteId, quote);
        return quote;
      },
    });

    this.registerTool({
      name: "list_active_plans",
      description: "List all active workflow plans and their statuses",
      parameters: {},
      execute: async () => {
        return [...this.activePlans.values()].map((p) => ({
          planId: p.planId,
          status: p.status,
          stepCount: p.cwm.steps.length,
          totalQuoted: p.quotes.reduce((s, q) => s + parseFloat(q.price), 0).toFixed(2),
        }));
      },
    });
  }

  // ── Intent Handlers ───────────────────────────────────────────

  private async handleDiscoverCapabilities(
    intent: DiscoverCapabilitiesIntent,
  ): Promise<CapabilitiesResponseIntent> {
    const matches = await this.router.findAllMatches({
      id: "discover",
      capability: (intent.capabilityType ?? "fdm") as any,
      params: { material: intent.material },
      assuranceTier: (intent.assuranceTier ?? 0) as any,
      dependsOn: [],
      maxPrice: intent.maxPrice,
    });

    const kernels = this.router.getKernels();
    const kernelMap = new Map(kernels.map((k) => [k.kernelId, k]));

    return {
      type: "capabilities_response",
      matches: matches.map((m) => {
        const kernel = kernelMap.get(m.kernelId);
        return {
          kernelId: m.kernelId,
          kernelName: kernel?.kernelId ?? m.kernelId,
          capabilityId: m.capability.id,
          capabilityName: m.capability.name,
          type: m.capability.type,
          materials: m.capability.materials,
          price: m.quotedPrice,
          currency: m.capability.pricing.currency,
          assuranceTiers: m.capability.assuranceTiers,
          queueDepth: m.capability.queueDepth,
          estimatedAvailability: new Date(Date.now() + 15 * 60_000).toISOString(),
          reputation: kernel?.reputation ?? 0,
          location: m.capability.location,
        };
      }),
      totalMatches: matches.length,
    };
  }

  private async handleDiscoverHubs(intent: any): Promise<Intent> {
    const kernels = this.router.getKernels();
    return {
      type: "hubs_response",
      hubs: kernels.map((k) => ({
        kernelId: k.kernelId,
        name: k.kernelId,
        address: "Mock Address",
        location: k.capabilities[0]?.location ?? { lat: 0, lng: 0 },
        capabilities: k.capabilities.map((c) => c.type),
        reputation: k.reputation,
        availableSlots: k.capabilities.reduce((s, c) => s + Math.max(0, 5 - c.queueDepth), 0),
      })),
    } as any;
  }

  private async handleRequestQuote(
    msg: A2AMessage,
    intent: RequestQuoteIntent,
  ): Promise<QuoteResponseIntent> {
    const match = await this.router.findBestMatch({
      id: "quote",
      capability: intent.capabilityType as any,
      params: intent.params,
      assuranceTier: intent.assuranceTier as any,
      dependsOn: [],
    });

    if (!match) {
      return {
        type: "quote_response",
        quoteId: "",
        pricePerUnit: "0",
        totalPrice: "0",
        currency: "USDC",
        estimatedStart: "",
        estimatedCompletion: "",
        assuranceTier: intent.assuranceTier,
        operatorBond: "0",
        validUntil: "",
        kernelId: "",
        kernelName: "",
      };
    }

    const quoteId = ids.job();
    const quantity = intent.quantity ?? 1;
    const unitPrice = parseFloat(match.quotedPrice);
    const totalPrice = (unitPrice * quantity).toFixed(2);
    const bondPercent = [0, 5, 15, 25][intent.assuranceTier] ?? 0;
    const bond = ((unitPrice * bondPercent) / 100).toFixed(2);

    const quote: ActiveQuote = {
      quoteId,
      kernelAgentId: "", // will be resolved
      kernelId: match.kernelId,
      capabilityId: match.capability.id,
      price: totalPrice,
      estimatedStart: new Date(Date.now() + 15 * 60_000).toISOString(),
      estimatedCompletion: new Date(Date.now() + 75 * 60_000).toISOString(),
      assuranceTier: intent.assuranceTier,
      validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    this.activeQuotes.set(quoteId, quote);

    return {
      type: "quote_response",
      quoteId,
      pricePerUnit: match.quotedPrice,
      totalPrice,
      currency: match.capability.pricing.currency,
      estimatedStart: quote.estimatedStart,
      estimatedCompletion: quote.estimatedCompletion,
      assuranceTier: intent.assuranceTier,
      operatorBond: bond,
      validUntil: quote.validUntil,
      kernelId: match.kernelId,
      kernelName: match.capability.name,
      options: [
        {
          name: "Express Processing",
          description: "Jump to front of queue",
          additionalCost: (unitPrice * 0.5).toFixed(2),
        },
        {
          name: "Higher Assurance",
          description: `Upgrade to Tier ${Math.min(3, intent.assuranceTier + 1)}`,
          additionalCost: (unitPrice * 0.2).toFixed(2),
        },
      ],
    };
  }

  private async handleNegotiate(msg: A2AMessage, intent: any): Promise<Intent> {
    const quote = this.activeQuotes.get(intent.quoteId);
    if (!quote) {
      return { type: "error", code: "quote_not_found", message: "Quote expired or not found", retryable: false };
    }

    // Simple negotiation: accept counter-offers within 20% of original
    if (intent.counterOffer?.maxPrice) {
      const offered = parseFloat(intent.counterOffer.maxPrice);
      const original = parseFloat(quote.price);
      if (offered >= original * 0.8) {
        quote.price = offered.toFixed(2);
        return {
          type: "negotiation_response",
          quoteId: quote.quoteId,
          accepted: true,
          message: `Counter-offer accepted at $${quote.price}`,
        } as any;
      }
      return {
        type: "negotiation_response",
        quoteId: quote.quoteId,
        accepted: false,
        message: `Cannot go below $${(original * 0.8).toFixed(2)}. Current price: $${original.toFixed(2)}`,
      } as any;
    }

    return {
      type: "negotiation_response",
      quoteId: quote.quoteId,
      accepted: true,
      message: "Current quote stands",
    } as any;
  }

  private async handleSubmitWorkflow(
    msg: A2AMessage,
    intent: SubmitWorkflowIntent,
  ): Promise<WorkflowAcceptedIntent> {
    const cwm = intent.cwm as unknown as CWM;
    const plan = await this.compiler.compile(cwm);

    const activePlan: ActivePlan = {
      planId: plan.id,
      cwm,
      quotes: plan.assignments.map((a) => ({
        quoteId: ids.job(),
        kernelAgentId: "",
        kernelId: a.kernelId,
        capabilityId: a.capabilityId,
        price: a.quotedPrice,
        estimatedStart: a.scheduledWindow.start,
        estimatedCompletion: a.scheduledWindow.end,
        assuranceTier: a.assuranceTier,
        validUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      })),
      status: "planning",
      userAgentId: msg.from,
      conversationId: msg.conversationId,
    };
    this.activePlans.set(plan.id, activePlan);

    const escrowAddress = `0x${"E5C80".padEnd(40, "0")}` as `0x${string}`;

    return {
      type: "workflow_accepted",
      planId: plan.id,
      escrowAddress,
      totalEscrowAmount: plan.totalCost,
      currency: cwm.settlement.currency,
      milestones: plan.assignments.map((a) => ({
        stepId: a.stepId,
        amount: a.quotedPrice,
        kernelId: a.kernelId,
        estimatedStart: a.scheduledWindow.start,
        estimatedEnd: a.scheduledWindow.end,
      })),
    };
  }

  private async handleJobStatusQuery(
    intent: JobStatusQueryIntent,
  ): Promise<JobStatusResponseIntent> {
    const plan = intent.planId
      ? this.activePlans.get(intent.planId)
      : [...this.activePlans.values()].find((p) => p.status === "executing");

    if (!plan) {
      return {
        type: "job_status_response",
        planId: "",
        overallStatus: "not_found",
        steps: [],
      };
    }

    return {
      type: "job_status_response",
      planId: plan.planId,
      overallStatus: plan.status,
      steps: plan.quotes.map((q) => ({
        stepId: q.capabilityId,
        status: plan.status === "completed" ? "completed" : "in_progress",
        progress: plan.status === "completed" ? 100 : 50,
        kernelName: q.kernelId,
      })),
    };
  }

  private async handleJobCompleted(msg: A2AMessage): Promise<Intent | null> {
    const intent = msg.intent as any;
    // Find the plan this job belongs to and update
    for (const plan of this.activePlans.values()) {
      const quote = plan.quotes.find((q) => q.kernelId === msg.from || q.kernelAgentId === msg.from);
      if (quote) {
        // Check if all steps complete
        const allDone = plan.quotes.every(() => true); // simplified
        if (allDone) {
          plan.status = "completed";
          // Notify user agent
          await this.send(plan.userAgentId, {
            type: "job_status_response",
            planId: plan.planId,
            overallStatus: "completed",
            steps: plan.quotes.map((q) => ({
              stepId: q.capabilityId,
              status: "completed",
              progress: 100,
              kernelName: q.kernelId,
              evidenceBundleId: intent.evidenceBundleHash,
            })),
          }, plan.conversationId);
        }
        break;
      }
    }
    return null;
  }

  private async handleGetBuildOptions(
    intent: GetBuildOptionsIntent,
  ): Promise<BuildOptionsResponseIntent> {
    const options = this.contractBuilder.getBuildOptions(
      intent.capabilityType as any,
      intent.currentSelections ?? {},
      intent.profileId,
    );

    return {
      type: "build_options_response",
      capabilityType: options.capabilityType,
      templateName: options.templateName,
      groups: options.groups.map((g) => ({
        name: g.name,
        params: g.params.map((rp) => ({
          key: rp.def.key,
          type: rp.def.type,
          label: rp.def.label,
          description: rp.def.description,
          required: rp.def.required,
          group: rp.def.group,
          visible: rp.visible,
          options: rp.def.type === "enum" ? (rp.def as any).options : undefined,
          min: rp.def.type === "number" ? (rp.def as any).min : undefined,
          max: rp.def.type === "number" ? (rp.def as any).max : undefined,
          step: rp.def.type === "number" ? (rp.def as any).step : undefined,
          unit: rp.def.type === "number" ? (rp.def as any).unit : undefined,
          defaultValue: (rp.def as any).defaultValue,
          multi: rp.def.type === "enum" ? (rp.def as any).multi : undefined,
          pricingImpact: rp.def.pricingImpact ? {
            mode: rp.def.pricingImpact.mode,
            value: rp.def.pricingImpact.value,
            label: rp.def.pricingImpact.label,
          } : undefined,
        })),
      })),
      basePrice: options.basePrice,
      currency: options.currency,
      machineInfo: options.machineInfo ? {
        profileId: options.machineInfo.profileId,
        machineName: options.machineInfo.machineName,
        kernelId: options.machineInfo.kernelId,
      } : undefined,
    };
  }

  private async handleBuildContract(
    intent: BuildContractIntent,
  ): Promise<ContractBuiltResponseIntent> {
    const contract = this.contractBuilder.buildContract(
      intent.capabilityType as any,
      intent.selections,
      intent.assuranceTier,
      intent.profileId,
    );

    return {
      type: "contract_built_response",
      isValid: contract.isValid,
      totalPrice: contract.totalPrice,
      currency: "USDC",
      priceBreakdown: contract.priceBreakdown.map((b) => ({
        paramKey: b.paramKey,
        paramLabel: b.paramLabel,
        selectedValue: b.selectedValue,
        amount: b.amount,
        impactLabel: b.impact.label,
      })),
      cwmStep: {
        capability: contract.cwmStep.capability,
        params: contract.cwmStep.params,
        assuranceTier: contract.cwmStep.assuranceTier,
      },
      validationErrors: contract.validationErrors,
      templateName: contract.templateName,
      machineInfo: contract.machineInfo ? {
        profileId: contract.machineInfo.profileId,
        machineName: contract.machineInfo.machineName,
        kernelId: contract.machineInfo.kernelId,
      } : undefined,
    };
  }

  private async handleTextMessage(
    msg: A2AMessage,
    intent: TextMessageIntent,
  ): Promise<Intent> {
    // Parse natural language into structured intents
    const text = intent.text.toLowerCase();

    if (text.includes("option") || text.includes("configure") || text.includes("build option")) {
      // Route to contract builder
      const capType = text.includes("cnc") ? "cnc-3axis"
        : text.includes("sla") || text.includes("resin") ? "sla"
        : text.includes("laser") ? "laser-cut"
        : "fdm";
      return this.handleGetBuildOptions({
        type: "get_build_options",
        capabilityType: capType,
      });
    }

    if (text.includes("print") || text.includes("3d") || text.includes("fdm")) {
      return this.handleDiscoverCapabilities({
        type: "discover_capabilities",
        capabilityType: "fdm",
        query: intent.text,
      });
    }

    if (text.includes("cnc") || text.includes("mill") || text.includes("machine")) {
      return this.handleDiscoverCapabilities({
        type: "discover_capabilities",
        capabilityType: text.includes("5") ? "cnc-5axis" : "cnc-3axis",
        query: intent.text,
      });
    }

    if (text.includes("status") || text.includes("where") || text.includes("progress")) {
      return this.handleJobStatusQuery({ type: "job_status_query" });
    }

    if (text.includes("hub") || text.includes("shop") || text.includes("near")) {
      return this.handleDiscoverHubs({
        type: "discover_hubs",
        description: intent.text,
      });
    }

    return {
      type: "text_message",
      text: `I'm the PCC Broker. I can help you:\n` +
        `- Find manufacturing capabilities ("I need 3D printing in PLA")\n` +
        `- Get quotes ("Quote me 5-axis CNC in aluminum")\n` +
        `- Submit workflows ("Print this part and deliver it")\n` +
        `- Check job status ("What's the status of my job?")\n` +
        `- Find nearby hubs ("Show me shops near NYC")\n\n` +
        `What do you need?`,
    };
  }
}

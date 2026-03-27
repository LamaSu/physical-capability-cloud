/**
 * NanoClaw Agent — Opentrons OT-2 operator on the PCC network.
 *
 * Extends KernelAgent with OpentronOperator for real liquid handling.
 * Supports dual-network operation (e.g., BioPunk + Frontier Devices).
 *
 * Deploy on: Raspberry Pi, VPS, DGX Spark, or any machine with
 * network access to both PCC gateway and OT-2 robot (port 31950).
 */

import type { MessageBus, Intent } from "@pcc/a2a";
import type { Capability } from "@pcc/spec";
import {
  OpentronOperator,
  OpentronsMachineAdapter,
  type OperatorConfig,
  type OpentronAdapterConfig,
} from "@pcc/kernel";
import { KernelAgent, type KernelAgentConfig } from "./kernel-agent.js";

// ── NanoClaw Config ──────────────────────────────────────────────

export interface NanoClawConfig {
  /** Unique kernel ID */
  kernelId: string;
  /** Human-readable name */
  name: string;
  /** Operator wallet address */
  operatorAddress: string;
  /** Physical location */
  location: { lat: number; lng: number };
  /** Opentrons connection config */
  opentrons: OpentronAdapterConfig;
  /** Pricing */
  pricing: {
    baseCost: string;
    perMinute: string;
    minimum: string;
    currency: string;
  };
  /** Gateway URL for settlement */
  gatewayUrl?: string;
  /** Max queue depth (default 10) */
  maxQueueDepth?: number;
  /** Networks to participate in (dual-network support) */
  networks?: string[];
  /** Fiat on-ramp config for agent funding */
  fiatRamp?: {
    /** Stripe publishable key (for credit card on-ramp) */
    stripeKey?: string;
    /** Enable Yellowcard for emerging markets */
    yellowcardEnabled?: boolean;
  };
}

// ── NanoClaw Agent ───────────────────────────────────────────────

export class NanoClawAgent extends KernelAgent {
  private operator: OpentronOperator;
  private otAdapter: OpentronsMachineAdapter;
  private nanoConfig: NanoClawConfig;
  private started = false;

  constructor(bus: MessageBus, config: NanoClawConfig) {
    // Create the Opentrons adapter
    const otAdapter = new OpentronsMachineAdapter(
      `${config.kernelId}-ot2`,
      config.opentrons,
    );

    // Build the operator config for OpentronOperator
    const operatorConfig: OperatorConfig = {
      kernelId: config.kernelId,
      name: config.name,
      operatorAddress: config.operatorAddress,
      location: config.location,
      adapter: config.opentrons,
      pricing: config.pricing,
      maxQueueDepth: config.maxQueueDepth,
    };

    // Build the liquid-handler capability (pre-start, refined on start())
    const liquidCap: Capability = {
      id: `cap-${config.kernelId}-liquid`,
      kernelId: config.kernelId,
      type: "liquid-handler",
      name: `${config.name} Liquid Handling`,
      description: "Automated liquid handling via Opentrons OT-2 — transfers, serial dilutions, plate formatting, mixing",
      materials: ["aqueous", "organic", "biological", "chemical"],
      assuranceTiers: [0, 1, 2],
      pricing: {
        currency: config.pricing.currency as "USDC" | "ETH" | "DAI" | "SOL",
        baseCost: config.pricing.baseCost,
        perMinute: config.pricing.perMinute,
        minimum: config.pricing.minimum,
      },
      availability: {
        timezone: "America/Los_Angeles",
        windows: {},
      },
      location: config.location,
      queueDepth: 0,
    };

    // Initialize KernelAgent with Opentrons as the pluggable machine adapter
    super(bus, {
      kernelId: config.kernelId,
      name: config.name,
      location: config.location,
      capabilities: [liquidCap],
      gatewayUrl: config.gatewayUrl,
      networks: config.networks ?? ["biopunk", "frontier-devices"],
      adapters: {
        machine: otAdapter,
        sensors: [], // OT-2 handles its own telemetry
        camera: undefined, // Optional — add RPi camera later
      },
    } satisfies KernelAgentConfig);

    this.otAdapter = otAdapter;
    this.operator = new OpentronOperator(operatorConfig);
    this.nanoConfig = config;

    // Override intent handlers with OpentronOperator's richer ones
    this.setupNanoClawIntents();
    this.setupNanoClawTools();
  }

  /** Start the NanoClaw — connects to OT-2, verifies, starts heartbeat */
  async startOperator(): Promise<{ online: boolean; capability: Capability }> {
    const result = await this.operator.start();
    this.started = true;
    return result;
  }

  /** Shut down gracefully */
  async stopOperator(): Promise<void> {
    await this.operator.stop();
    this.started = false;
  }

  /** Get the underlying OpentronOperator */
  getOperator(): OpentronOperator {
    return this.operator;
  }

  // ── Intent Overrides (uses OpentronOperator for richer handling) ──

  private setupNanoClawIntents(): void {
    // Override discover_capabilities with operator's
    this.onIntent("discover_capabilities", async (msg) => {
      if (!this.started) {
        return { type: "error", code: "NOT_STARTED", message: "NanoClaw operator not started", retryable: true };
      }
      return this.operator.handleDiscoverCapabilities(msg.intent as any);
    });

    // Override request_quote with operator's pricing engine
    this.onIntent("request_quote", async (msg) => {
      if (!this.started) {
        return { type: "error", code: "NOT_STARTED", message: "NanoClaw operator not started", retryable: true };
      }
      return this.operator.handleRequestQuote(msg.intent as any);
    });

    // Override execute_job with operator's queue + compiler
    this.onIntent("execute_job", async (msg) => {
      if (!this.started) {
        return { type: "error", code: "NOT_STARTED", message: "NanoClaw operator not started", retryable: true };
      }
      // Route through OpentronOperator's submit workflow handler
      const intent = msg.intent as any;
      return this.operator.handleSubmitWorkflow({
        type: "submit_workflow",
        cwm: intent.cwm ?? intent.protocol ?? {},
        payerWallet: intent.payerWallet ?? msg.from,
        assuranceTier: intent.assuranceTier ?? 1,
      } as any);
    });

    // Override job_status with operator's richer status
    this.onIntent("job_status_query", async (msg) => {
      if (!this.started) {
        return { type: "error", code: "NOT_STARTED", message: "NanoClaw operator not started", retryable: true };
      }
      return this.operator.handleJobStatusQuery(msg.intent as any);
    });

    // NanoClaw-specific: get capability card (for bundle building)
    this.onIntent("get_capability_card", async () => {
      if (!this.started) {
        return { type: "error", code: "NOT_STARTED", message: "NanoClaw operator not started", retryable: true };
      }
      const card = await this.operator.getCapabilityCard();
      return {
        type: "capability_card_response" as any,
        card,
      };
    });

    // NanoClaw-specific: submit execution bundle
    this.onIntent("submit_bundle", async (msg) => {
      if (!this.started) {
        return { type: "error", code: "NOT_STARTED", message: "NanoClaw operator not started", retryable: true };
      }
      const result = await this.operator.submitBundle(msg.intent as any);
      return {
        type: "bundle_response" as any,
        ...result,
      };
    });
  }

  // ── NanoClaw-Specific Tools ──────────────────────────────────────

  private setupNanoClawTools(): void {
    this.registerTool({
      name: "nanoclaw_status",
      description: "Get NanoClaw operator status: robot info, queue depth, health metrics",
      parameters: {},
      execute: async () => {
        if (!this.started) return { status: "not_started" };
        const info = await this.operator.getOperatorInfo();
        return {
          status: "online",
          kernelId: this.nanoConfig.kernelId,
          name: this.nanoConfig.name,
          networks: this.networks,
          robot: info.hardware,
          queue: info.state,
          reliability: info.reliability,
          pricing: info.pricing,
        };
      },
    });

    this.registerTool({
      name: "nanoclaw_deck",
      description: "Get current OT-2 deck layout (labware in each slot)",
      parameters: {},
      execute: async () => {
        if (!this.started) return { error: "NanoClaw not started" };
        const card = await this.operator.getCapabilityCard();
        return {
          slots: card.deck.slots,
          pipettes: card.hardware.pipettes,
          modules: card.hardware.modules,
        };
      },
    });

    this.registerTool({
      name: "nanoclaw_estimate",
      description: "Estimate cost and time for a liquid handling protocol",
      parameters: {
        protocolType: { type: "string", description: "transfer | serial-dilution | distribute | consolidate | mixing" },
        sampleCount: { type: "number", description: "Number of samples" },
        volumeUl: { type: "number", description: "Volume per transfer in µL" },
      },
      execute: async (params) => {
        if (!this.started) return { error: "NanoClaw not started" };
        const minutes = Math.max(5, (params.sampleCount as number ?? 8) * 0.5);
        const baseCost = parseFloat(this.nanoConfig.pricing.baseCost);
        const perMin = parseFloat(this.nanoConfig.pricing.perMinute);
        const total = Math.max(
          parseFloat(this.nanoConfig.pricing.minimum),
          baseCost + perMin * minutes,
        );
        return {
          estimatedMinutes: Math.round(minutes),
          estimatedCost: total.toFixed(2),
          currency: this.nanoConfig.pricing.currency,
          tipsRequired: (params.sampleCount as number ?? 8),
          queuePosition: (await this.operator.getQueueStatus()).depth,
        };
      },
    });

    this.registerTool({
      name: "nanoclaw_fund_agent",
      description: "Get fiat on-ramp options to fund this agent's wallet with a credit card",
      parameters: {},
      execute: async () => {
        const gatewayUrl = this.nanoConfig.gatewayUrl ?? "https://pcc-gateway-production.up.railway.app";
        return {
          message: "Fund your agent wallet via credit card or bank transfer",
          methods: [
            {
              provider: "Stripe",
              type: "credit-card",
              endpoint: `${gatewayUrl}/api/fiat-ramp/onramp/session`,
              currencies: ["USD", "EUR", "GBP"],
              note: "Visa/Mastercard/AMEX → USDC on Base",
            },
            {
              provider: "Yellowcard",
              type: "mobile-money",
              endpoint: `${gatewayUrl}/api/fiat-ramp/onramp/yellowcard`,
              currencies: ["NGN", "GHS", "KES", "ZAR", "UGX", "TZS", "RWF", "XOF"],
              note: "Mobile money and bank transfer in 34 emerging market countries",
            },
            {
              provider: "Wise",
              type: "bank-transfer",
              endpoint: `${gatewayUrl}/api/fiat-ramp/payout`,
              currencies: ["USD", "EUR", "GBP", "JPY", "CAD", "AUD"],
              note: "Enterprise bank payouts in 40+ currencies",
            },
          ],
          quickStart: `POST ${gatewayUrl}/api/fiat-ramp/onramp/session { walletAddress: "0x...", amount: 50, currency: "USD" }`,
        };
      },
    });
  }
}

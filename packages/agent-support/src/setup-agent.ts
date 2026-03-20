/**
 * SetupAgent — orchestrates PCC setup flows via A2A intents and LLM tools.
 *
 * Handles intents:
 * - setup_detect: Auto-detect current configuration state
 * - setup_configure: Generate device adapter config
 * - setup_validate: Validate the current setup
 * - text_message: Free-form setup guidance with NLP routing
 *
 * LLM tools:
 * - detect_config
 * - configure_adapter
 * - register_device
 * - validate_setup
 * - run_test_job
 * - get_setup_status
 */

import type { MessageBus, A2AMessage } from "@pcc/a2a";

// ── Config ───────────────────────────────────────────────────────

export interface SetupAgentConfig {
  /** Gateway base URL, default: http://localhost:3200 */
  gatewayUrl?: string;
}

// ── Tool definitions ────────────────────────────────────────────

export interface SetupAgentTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

// ── Agent ───────────────────────────────────────────────────────

export class SetupAgent {
  readonly id = "agent_setup_001";

  private bus: MessageBus;
  private config: Required<SetupAgentConfig>;
  private toolMap: Map<string, SetupAgentTool> = new Map();
  private running = false;

  constructor(bus: MessageBus, config?: SetupAgentConfig) {
    this.bus = bus;
    this.config = {
      gatewayUrl: config?.gatewayUrl ?? "http://localhost:3200",
    };
    this.registerTools();
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;

    this.bus.register({
      id: this.id,
      name: "PCC Setup Agent",
      description:
        "Orchestrates PCC setup flows: detect config, configure adapters, register devices, validate, run test jobs.",
      role: "broker" as any,
      walletAddress: "0x0000000000000000000000000000000000000000",
      capabilities: ["setup", "configuration", "device-registration", "validation"],
      endpoint: `agent://${this.id}`,
      supportedIntents: [
        "setup_detect",
        "setup_configure",
        "setup_validate",
        "text_message",
      ],
      publicKey: "0x00",
    });

    this.bus.subscribe(this.id, (message: A2AMessage) => {
      return this.handleMessage(message).catch((err) => {
        console.error(`[SETUP] Error handling message: ${err}`);
      });
    });

    console.log(`[SETUP] Setup agent started: ${this.id}`);
    console.log(`  Gateway: ${this.config.gatewayUrl}`);
  }

  stop(): void {
    this.running = false;
    this.bus.unregister(this.id);
  }

  // ── Message routing ───────────────────────────────────────────

  private async handleMessage(message: A2AMessage): Promise<void> {
    switch (message.intent.type) {
      case "setup_detect":
        await this.handleSetupDetect(message);
        break;
      case "setup_configure":
        await this.handleSetupConfigure(message);
        break;
      case "setup_validate":
        await this.handleSetupValidate(message);
        break;
      case "text_message":
        await this.handleTextMessage(message);
        break;
      default:
        this.reply(message, "Unsupported intent. I handle: setup_detect, setup_configure, setup_validate, text_message.");
        break;
    }
  }

  // ── Intent handlers ───────────────────────────────────────────

  private async handleSetupDetect(message: A2AMessage): Promise<void> {
    try {
      const result = await this.gatewayGet("/api/setup/detect");
      this.reply(message, JSON.stringify(result, null, 2));
    } catch (err) {
      this.reply(message, `Failed to detect config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleSetupConfigure(message: A2AMessage): Promise<void> {
    const intent = message.intent as any;
    const body = intent.body ?? {};
    try {
      const result = await this.gatewayPost("/api/setup/generate-config", body);
      this.reply(message, JSON.stringify(result, null, 2));
    } catch (err) {
      this.reply(message, `Failed to generate config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleSetupValidate(message: A2AMessage): Promise<void> {
    const intent = message.intent as any;
    const body = intent.body ?? {};
    try {
      const result = await this.gatewayPost("/api/setup/validate", body);
      this.reply(message, JSON.stringify(result, null, 2));
    } catch (err) {
      this.reply(message, `Failed to validate setup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleTextMessage(message: A2AMessage): Promise<void> {
    const text = ((message.intent as any).text as string) ?? "";
    const { intent, response } = await this.routeTextMessage(text);
    void intent; // used for routing, result is in response
    this.reply(message, typeof response === "string" ? response : JSON.stringify(response, null, 2));
  }

  // ── NLP routing ───────────────────────────────────────────────

  async routeTextMessage(text: string): Promise<{ intent: string; response: unknown }> {
    const q = text.toLowerCase();

    // validate/verify must come before configure to avoid "verify" matching "set up"
    if (/\bvalidate\b|\bverify\b|is it working/.test(q)) {
      const response = await this.gatewayPost("/api/setup/validate", {}).catch((e) => ({ error: String(e) }));
      return { intent: "validate", response };
    }

    if (/\bdetect\b|\bcheck\b|what.?s configured/.test(q)) {
      const response = await this.gatewayGet("/api/setup/detect").catch((e) => ({ error: String(e) }));
      return { intent: "detect", response };
    }

    if (/\bconfigure\b|\bset ?up\b|add (?:a |an )?(?:printer|cnc|device|adapter|sensor|camera)/.test(q)) {
      return {
        intent: "configure",
        response: [
          "To configure a device, provide details such as:",
          "",
          "  • name: your device name",
          "  • type: machine | sensor | camera",
          "  • adapterType: octoprint | modbus | opcua | sila | generic-http | mock",
          "  • url/host/port as appropriate",
          "",
          "Then send a setup_configure intent with those device descriptions.",
        ].join("\n"),
      };
    }

    if (/\btest\b|try it|run a job/.test(q)) {
      const response = await this.gatewayPost("/api/setup/test-job", {}).catch((e) => ({ error: String(e) }));
      return { intent: "test-job", response };
    }

    if (/\bstatus\b|\boverview\b|\bsummary\b/.test(q)) {
      const response = await this.gatewayGet("/api/setup/status").catch((e) => ({ error: String(e) }));
      return { intent: "status", response };
    }

    return {
      intent: "unknown",
      response: [
        "I can help you set up PCC. Try:",
        "  • detect config",
        "  • add a device",
        "  • validate setup",
        "  • run a test job",
        "  • check status",
      ].join("\n"),
    };
  }

  // ── LLM tools ─────────────────────────────────────────────────

  private registerTools(): void {
    const tools: SetupAgentTool[] = [
      {
        name: "detect_config",
        description: "Detect current PCC configuration state — env vars, DB, kernel service, chain, storage, identity.",
        parameters: {},
        execute: async (_params) => this.gatewayGet("/api/setup/detect"),
      },
      {
        name: "configure_adapter",
        description: "Generate a KERNEL_CONFIG JSON from device descriptions. Supports octoprint, modbus, opcua, sila, generic-http, mock adapters.",
        parameters: {
          kernelId: { type: "string", description: "Optional kernel ID override", required: false },
          devices: { type: "array", description: "Array of device descriptions: {name, type, adapterType, url?, apiKey?, host?, port?}", required: false },
          mockMode: { type: "boolean", description: "Enable mock mode for all adapters", required: false },
        },
        execute: async (params) => this.gatewayPost("/api/setup/generate-config", params),
      },
      {
        name: "register_device",
        description: "Register a device on the network kernel DB.",
        parameters: {
          kernelId: { type: "string", description: "Kernel ID to attach the device to" },
          deviceId: { type: "string", description: "Unique device identifier" },
          type: { type: "string", description: "Device type: machine | sensor | camera" },
          adapterType: { type: "string", description: "Adapter type: octoprint | modbus | opcua | sila | generic-http | mock" },
          model: { type: "string", description: "Device model name", required: false },
          adapterConfig: { type: "object", description: "Adapter-specific configuration", required: false },
          capabilities: { type: "array", description: "List of capability types this device supports", required: false },
        },
        execute: async (params) => this.gatewayPost("/api/setup/register-device", params),
      },
      {
        name: "validate_setup",
        description: "Validate the current setup — checks config JSON, kernel ID, device definitions, adapter configs.",
        parameters: {
          config: { type: "string", description: "JSON config string to validate (optional — defaults to KERNEL_CONFIG env var)", required: false },
        },
        execute: async (params) => this.gatewayPost("/api/setup/validate", params),
      },
      {
        name: "run_test_job",
        description: "Submit a test job to verify the full pipeline end-to-end.",
        parameters: {
          kernelId: { type: "string", description: "Kernel to run the test job on", required: false },
          deviceId: { type: "string", description: "Specific device to use", required: false },
          assuranceTier: { type: "number", description: "Assurance tier 0-3 (default 0)", required: false },
        },
        execute: async (params) => this.gatewayPost("/api/setup/test-job", params),
      },
      {
        name: "get_setup_status",
        description: "Get comprehensive setup status across all categories: gateway, database, adapters, chain, storage, identity.",
        parameters: {},
        execute: async (_params) => this.gatewayGet("/api/setup/status"),
      },
    ];

    for (const tool of tools) {
      this.toolMap.set(tool.name, tool);
    }
  }

  /** Get all registered tools */
  getTools(): SetupAgentTool[] {
    return [...this.toolMap.values()];
  }

  /** Get tool definitions in Anthropic/OpenAI function-calling format */
  getToolDefinitions(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: object };
  }> {
    return [...this.toolMap.values()].map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }]),
          ),
          required: Object.entries(tool.parameters)
            .filter(([, v]) => v.required !== false)
            .map(([k]) => k),
        },
      },
    }));
  }

  /** Execute a tool by name */
  async executeTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.toolMap.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(params);
  }

  // ── Helpers ───────────────────────────────────────────────────

  private reply(original: A2AMessage, text: string): void {
    this.bus.send({
      id: `msg_${Date.now()}`,
      conversationId: original.conversationId,
      from: this.id,
      to: original.from,
      intent: { type: "text_message", text } as any,
      timestamp: new Date().toISOString(),
      inReplyTo: original.id,
    });
  }

  private async gatewayGet(path: string): Promise<unknown> {
    const url = `${this.config.gatewayUrl}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  private async gatewayPost(path: string, body: unknown): Promise<unknown> {
    const url = `${this.config.gatewayUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`POST ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }
}

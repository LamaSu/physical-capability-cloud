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
 * - identify_machine_from_photo
 * - scan_network_for_devices
 * - auto_detect_connection
 * - generate_kernel_config
 * - register_and_test
 */

import type { MessageBus, A2AMessage } from "@pcc/a2a";
import type { AdapterType } from "@pcc/spec";

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

// ── Conversation state machine ───────────────────────────────────

export interface SetupConversationState {
  phase: "greeting" | "identify" | "connect" | "configure" | "test" | "complete";
  detectedMachine?: { make: string; model: string; type: string };
  connectionConfig?: { adapterType: string; url: string };
  kernelConfig?: Record<string, unknown>;
  registered?: boolean;
  tested?: boolean;
}

// ── Machine identification result ───────────────────────────────

export interface MachineIdentificationResult {
  make: string;
  model: string;
  type: string;
  suggestedAdapterType: AdapterType;
  confidence: number;
}

// ── Discovered device ───────────────────────────────────────────

export interface DiscoveredDevice {
  address: string;
  hostname?: string;
  port?: number;
  service?: string;
}

// ── Connection detection result ─────────────────────────────────

export interface ConnectionDetectionResult {
  adapterType: AdapterType | "unknown";
  url: string;
  apiVersion?: string;
  capabilities?: string[];
}

// ── Agent ───────────────────────────────────────────────────────

export class SetupAgent {
  readonly id = "agent_setup_001";

  private bus: MessageBus;
  private config: Required<SetupAgentConfig>;
  private toolMap: Map<string, SetupAgentTool> = new Map();
  private running = false;

  /** Per-conversation state tracked for multi-turn setup flows */
  private conversationStates: Map<string, SetupConversationState> = new Map();

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
        "Orchestrates PCC setup flows: detect config, configure adapters, register devices, validate, run test jobs. Supports conversational multi-turn setup with photo machine identification.",
      role: "broker" as any,
      walletAddress: "0x0000000000000000000000000000000000000000",
      capabilities: ["setup", "configuration", "device-registration", "validation", "machine-identification"],
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

  // ── Conversation state ─────────────────────────────────────────

  getConversationState(conversationId: string): SetupConversationState {
    if (!this.conversationStates.has(conversationId)) {
      this.conversationStates.set(conversationId, { phase: "greeting" });
    }
    return this.conversationStates.get(conversationId)!;
  }

  updateConversationState(
    conversationId: string,
    update: Partial<SetupConversationState>,
  ): SetupConversationState {
    const current = this.getConversationState(conversationId);
    const next = { ...current, ...update };
    this.conversationStates.set(conversationId, next);
    return next;
  }

  clearConversationState(conversationId: string): void {
    this.conversationStates.delete(conversationId);
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

  // ── Machine identification ─────────────────────────────────────

  /**
   * Uses Gemini (or a compatible vision LLM) to identify a machine from a photo.
   * In the absence of a real Gemini client, falls back to structured mock analysis
   * based on image size/encoding hints.
   */
  async identifyMachineFromPhoto(imageBase64: string): Promise<MachineIdentificationResult> {
    // Attempt to call Gemini via the gateway proxy if available
    try {
      const result = await this.gatewayPost("/api/ai/identify-machine", {
        imageBase64,
        prompt:
          "Identify this machine. What is the make, model, and type? " +
          "Is it a 3D printer, CNC machine, laser cutter, industrial printer, etc.? " +
          "Respond in JSON: {make, model, type, confidence}",
      }) as any;

      const adapterMap: Record<string, AdapterType> = {
        "3d printer": "octoprint",
        "fdm printer": "octoprint",
        "resin printer": "octoprint",
        "cnc machine": "modbus",
        "cnc router": "modbus",
        "laser cutter": "opcua",
        "laser engraver": "opcua",
        "industrial printer": "sila",
        "inkjet printer": "sila",
        "plotter": "generic-http",
      };

      const typeLower = (result.type ?? "").toLowerCase();
      let suggestedAdapterType: AdapterType = "generic-http";
      for (const [keyword, adapter] of Object.entries(adapterMap)) {
        if (typeLower.includes(keyword)) {
          suggestedAdapterType = adapter;
          break;
        }
      }

      return {
        make: result.make ?? "Unknown",
        model: result.model ?? "Unknown",
        type: result.type ?? "Unknown",
        suggestedAdapterType,
        confidence: typeof result.confidence === "number" ? result.confidence : 0.5,
      };
    } catch {
      // Gateway proxy unavailable — return a structured mock response
      // In production, this would call the Gemini Vision API directly.
      const imageSize = imageBase64.length;
      const isLargeImage = imageSize > 50_000;

      return {
        make: "Unknown",
        model: "Unknown",
        type: isLargeImage ? "3D Printer" : "Machine",
        suggestedAdapterType: isLargeImage ? "octoprint" : "generic-http",
        confidence: 0.4,
      };
    }
  }

  // ── Network scanning ───────────────────────────────────────────

  /**
   * Scans the local network for printers and devices.
   * Calls the gateway's network scan endpoint, falling back to an empty list.
   */
  async scanNetworkForDevices(): Promise<DiscoveredDevice[]> {
    try {
      const result = await this.gatewayPost("/api/setup/scan-network", {}) as any;
      return Array.isArray(result.devices) ? result.devices : [];
    } catch {
      return [];
    }
  }

  // ── Connection probing ─────────────────────────────────────────

  /**
   * Probes an IP/hostname to detect what type of device is running there.
   * Tries OctoPrint, IPP, Modbus, and OPC-UA in order.
   */
  async autoDetectConnection(target: string): Promise<ConnectionDetectionResult> {
    try {
      const result = await this.gatewayPost("/api/setup/detect-connection", { target }) as any;
      return {
        adapterType: result.adapterType ?? "unknown",
        url: result.url ?? target,
        apiVersion: result.apiVersion,
        capabilities: result.capabilities,
      };
    } catch {
      // Fallback: assume OctoPrint on default port if target looks like a printer IP
      const url = target.startsWith("http") ? target : `http://${target}:5000`;
      return {
        adapterType: "octoprint",
        url,
      };
    }
  }

  // ── LLM tools ─────────────────────────────────────────────────

  private registerTools(): void {
    const tools: SetupAgentTool[] = [
      // ── Existing tools ─────────────────────────────────────
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

      // ── New conversational tools ──────────────────────────

      {
        name: "identify_machine_from_photo",
        description:
          "Takes a base64-encoded photo of a machine and calls Gemini Vision to identify it. " +
          "Returns the machine make, model, type, suggested adapter type, and confidence score.",
        parameters: {
          imageBase64: {
            type: "string",
            description: "Base64-encoded image data (JPEG or PNG). Can include data URI prefix.",
          },
        },
        execute: async (params) => {
          const imageBase64 = String(params.imageBase64 ?? "");
          // Strip data URI prefix if present
          const base64Data = imageBase64.replace(/^data:image\/[^;]+;base64,/, "");
          return this.identifyMachineFromPhoto(base64Data);
        },
      },

      {
        name: "scan_network_for_devices",
        description:
          "Scans the local network for printers and devices (OctoPrint, IPP, Modbus, OPC-UA). " +
          "Returns a list of discovered devices with their addresses and services.",
        parameters: {},
        execute: async (_params) => {
          const devices = await this.scanNetworkForDevices();
          return { devices, count: devices.length };
        },
      },

      {
        name: "auto_detect_connection",
        description:
          "Given an IP address or hostname, probes for OctoPrint, IPP, Modbus, and OPC-UA. " +
          "Returns the detected adapter type, URL, API version, and capabilities.",
        parameters: {
          target: {
            type: "string",
            description: "IP address, hostname, or URL of the device to probe (e.g. '192.168.1.50' or 'http://printer.local:5000')",
          },
        },
        execute: async (params) => {
          const target = String(params.target ?? "");
          return this.autoDetectConnection(target);
        },
      },

      {
        name: "generate_kernel_config",
        description:
          "Takes the results of the setup conversation (machine info, connection config) and " +
          "generates a complete KernelConfig object with the env variable line to add to .env.",
        parameters: {
          kernelId: { type: "string", description: "Kernel ID for the config", required: false },
          deviceName: { type: "string", description: "Human-readable device name" },
          deviceType: { type: "string", description: "Device type: machine | sensor | camera" },
          adapterType: { type: "string", description: "Adapter type detected or chosen" },
          url: { type: "string", description: "Device URL or endpoint", required: false },
          apiKey: { type: "string", description: "API key for the device adapter", required: false },
          host: { type: "string", description: "Host/IP for TCP adapters (Modbus, OPC-UA)", required: false },
          port: { type: "number", description: "Port for TCP adapters", required: false },
          mockMode: { type: "boolean", description: "Enable mock mode", required: false },
        },
        execute: async (params) => {
          return this.gatewayPost("/api/setup/generate-config", {
            kernelId: params.kernelId,
            devices: [
              {
                name: params.deviceName,
                type: params.deviceType,
                adapterType: params.adapterType,
                url: params.url,
                apiKey: params.apiKey,
                host: params.host,
                port: params.port,
              },
            ],
            mockMode: params.mockMode ?? false,
          });
        },
      },

      {
        name: "register_and_test",
        description:
          "Registers the device via /api/setup/register-device and then runs a test job to verify " +
          "the full pipeline. Returns whether registration succeeded and the test result.",
        parameters: {
          kernelId: { type: "string", description: "Kernel ID to register the device under" },
          deviceId: { type: "string", description: "Unique device identifier" },
          type: { type: "string", description: "Device type: machine | sensor | camera" },
          adapterType: { type: "string", description: "Adapter type" },
          model: { type: "string", description: "Device model name", required: false },
          adapterConfig: { type: "object", description: "Adapter-specific configuration", required: false },
        },
        execute: async (params) => {
          let registered = false;
          let registrationError: string | undefined;
          let testResult: { success: boolean; duration?: number } | undefined;

          // Step 1: Register
          try {
            await this.gatewayPost("/api/setup/register-device", params);
            registered = true;
          } catch (err) {
            registrationError = err instanceof Error ? err.message : String(err);
          }

          // Step 2: Test job (only if registration succeeded)
          if (registered) {
            try {
              const start = Date.now();
              const jobResult = await this.gatewayPost("/api/setup/test-job", {
                kernelId: params.kernelId,
                deviceId: params.deviceId,
              }) as any;
              testResult = {
                success: jobResult?.status === "completed",
                duration: Date.now() - start,
              };
            } catch (err) {
              testResult = { success: false };
            }
          }

          return {
            registered,
            registrationError,
            testResult,
          };
        },
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

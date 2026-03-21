import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SetupAgent } from "../setup-agent.js";
import type { MessageBus, A2AMessage } from "@pcc/a2a";

// ── Mock MessageBus ────────────────────────────────────────────────────────

function makeMockBus(): MessageBus {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    subscribe: vi.fn(),
    send: vi.fn(),
    findAgents: vi.fn().mockReturnValue([]),
    findByIntent: vi.fn().mockReturnValue([]),
    getConversation: vi.fn(),
    getAgents: vi.fn().mockReturnValue([]),
    setSecurityMiddleware: vi.fn(),
  } as unknown as MessageBus;
}

// ── Mock fetch ─────────────────────────────────────────────────────────────

const DETECT_PAYLOAD = {
  envVars: [],
  db: { kernels: 1, devices: 2, jobs: 0, initialized: true },
  kernelService: { ready: true, devices: [] },
  chain: { connected: false, network: null },
  storage: { type: "local", configured: true },
  identity: { configured: false, accountAddress: null },
  litProtocol: { real: false },
};

const STATUS_PAYLOAD = {
  overall: "partial",
  categories: [
    { name: "gateway", status: "ready", details: "Running on port 3200" },
  ],
};

const VALIDATE_PAYLOAD = {
  valid: true,
  checks: [{ name: "kernel_id", status: "pass", message: "kernelId: kernel_dev_001" }],
  errors: [],
  warnings: [],
};

const TEST_JOB_PAYLOAD = {
  jobId: "test-job-abc",
  deviceId: "dev_001",
  status: "completed",
  evidenceBundleId: null,
  duration: 1234,
};

const GENERATE_CONFIG_PAYLOAD = {
  config: { kernelId: "kernel_test", devices: [] },
  envLine: "KERNEL_CONFIG='{}'",
  configJson: "{}",
};

function makeFetchMock(overrides?: Record<string, unknown>) {
  return vi.fn((url: string | URL) => {
    const urlStr = String(url);

    // Must check detect-connection before /api/setup/detect (prefix match avoidance)
    if (urlStr.includes("/api/setup/detect-connection")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.detectConnection ?? {
          adapterType: "octoprint",
          url: "http://192.168.1.50:5000",
          apiVersion: "0.1.0",
          capabilities: ["print", "preheat"],
        }),
      });
    }
    if (urlStr.includes("/api/setup/detect")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.detect ?? DETECT_PAYLOAD),
      });
    }
    if (urlStr.includes("/api/setup/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.status ?? STATUS_PAYLOAD),
      });
    }
    if (urlStr.includes("/api/setup/validate")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.validate ?? VALIDATE_PAYLOAD),
      });
    }
    if (urlStr.includes("/api/setup/test-job")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.testJob ?? TEST_JOB_PAYLOAD),
      });
    }
    if (urlStr.includes("/api/setup/generate-config")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.generateConfig ?? GENERATE_CONFIG_PAYLOAD),
      });
    }
    if (urlStr.includes("/api/setup/register-device")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ registered: true, device: { id: "dev_001" } }),
      });
    }
    if (urlStr.includes("/api/ai/identify-machine")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.identifyMachine ?? {
          make: "Prusa",
          model: "MK4",
          type: "FDM 3D Printer",
          suggestedAdapterType: "octoprint",
          confidence: 0.92,
        }),
      });
    }
    if (urlStr.includes("/api/setup/scan-network")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides?.scanNetwork ?? {
          devices: [
            { address: "192.168.1.50", hostname: "octopi.local", service: "OctoPrint" },
          ],
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, statusText: "Not Found", text: () => Promise.resolve("Not Found") });
  });
}

function makeMessage(overrides?: Partial<A2AMessage>): A2AMessage {
  return {
    id: "msg_test_001",
    conversationId: "conv_test_001",
    from: "agent_user_001",
    to: "agent_setup_001",
    intent: { type: "text_message", text: "hello" } as any,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("SetupAgent", () => {
  let bus: MessageBus;
  let agent: SetupAgent;
  let fetchMock: ReturnType<typeof makeFetchMock>;

  beforeEach(() => {
    bus = makeMockBus();
    agent = new SetupAgent(bus, { gatewayUrl: "http://localhost:3200" });
    fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Constructor ─────────────────────────────────────────────────

  describe("constructor", () => {
    it("creates agent with default gateway URL", () => {
      const a = new SetupAgent(bus);
      expect(a.id).toBe("agent_setup_001");
    });

    it("creates agent with custom gateway URL", () => {
      const a = new SetupAgent(bus, { gatewayUrl: "http://custom:9000" });
      expect(a.id).toBe("agent_setup_001");
    });

    it("registers 11 tools on construction", () => {
      expect(agent.getTools()).toHaveLength(11);
    });
  });

  // ── start / stop ────────────────────────────────────────────────

  describe("start()", () => {
    it("registers with the bus on start", () => {
      agent.start();
      expect(bus.register).toHaveBeenCalledOnce();
      const card = (bus.register as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(card.id).toBe("agent_setup_001");
    });

    it("subscribes to the bus on start", () => {
      agent.start();
      expect(bus.subscribe).toHaveBeenCalledOnce();
      const [agentId] = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(agentId).toBe("agent_setup_001");
    });

    it("does not double-register if called twice", () => {
      agent.start();
      agent.start();
      expect(bus.register).toHaveBeenCalledOnce();
    });
  });

  describe("stop()", () => {
    it("unregisters from the bus on stop", () => {
      agent.start();
      agent.stop();
      expect(bus.unregister).toHaveBeenCalledWith("agent_setup_001");
    });
  });

  // ── Intent handlers ─────────────────────────────────────────────

  describe("handleSetupDetect", () => {
    it("calls GET /api/setup/detect and replies with result", async () => {
      agent.start();
      const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const message = makeMessage({ intent: { type: "setup_detect" } as any });

      await handler(message);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/detect");
      expect(bus.send).toHaveBeenCalledOnce();
      const sent = (bus.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as A2AMessage;
      expect(sent.to).toBe("agent_user_001");
      expect((sent.intent as any).text).toContain("initialized");
    });

    it("replies with error message when gateway fails", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
      agent.start();
      const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const message = makeMessage({ intent: { type: "setup_detect" } as any });

      await handler(message);

      const sent = (bus.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as A2AMessage;
      expect((sent.intent as any).text).toContain("Failed to detect config");
    });
  });

  describe("handleSetupConfigure", () => {
    it("calls POST /api/setup/generate-config and replies", async () => {
      agent.start();
      const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const message = makeMessage({
        intent: {
          type: "setup_configure",
          body: { devices: [{ name: "My Printer", type: "machine", adapterType: "octoprint" }] },
        } as any,
      });

      await handler(message);

      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/generate-config");
      const sent = (bus.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as A2AMessage;
      expect((sent.intent as any).text).toContain("kernel_test");
    });
  });

  describe("handleSetupValidate", () => {
    it("calls POST /api/setup/validate and replies", async () => {
      agent.start();
      const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const message = makeMessage({ intent: { type: "setup_validate" } as any });

      await handler(message);

      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/validate");
      const sent = (bus.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as A2AMessage;
      expect((sent.intent as any).text).toContain("valid");
    });
  });

  // ── Text message NLP routing ────────────────────────────────────

  describe("handleTextMessage", () => {
    async function sendText(text: string): Promise<A2AMessage> {
      agent.start();
      const handler = (bus.subscribe as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const message = makeMessage({ intent: { type: "text_message", text } as any });
      await handler(message);
      return (bus.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as A2AMessage;
    }

    it('routes "check status" to detect', async () => {
      const sent = await sendText("check what's configured");
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/detect");
      expect(sent.to).toBe("agent_user_001");
    });

    it('routes "add printer" to configure guidance', async () => {
      const sent = await sendText("add printer");
      // Should NOT call fetch for configure (returns guidance text without HTTP call)
      const detectCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/api/setup/detect"),
      );
      expect(detectCalls).toHaveLength(0);
      expect((sent.intent as any).text).toContain("adapterType");
    });

    it('routes "validate setup" to validate', async () => {
      await sendText("validate setup");
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/validate");
    });

    it('routes "run a test job" to test-job', async () => {
      await sendText("run a test job");
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/test-job");
    });

    it('routes "status" to setup status', async () => {
      await sendText("status overview");
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/status");
    });

    it("returns help text for unrecognized input", async () => {
      const sent = await sendText("how is the weather today");
      expect((sent.intent as any).text).toContain("detect config");
      // No fetch calls for unrecognized input
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── LLM tool definitions ────────────────────────────────────────

  describe("getTools()", () => {
    it("returns exactly 11 tools", () => {
      expect(agent.getTools()).toHaveLength(11);
    });

    it("includes all expected tool names", () => {
      const names = agent.getTools().map((t) => t.name);
      expect(names).toContain("detect_config");
      expect(names).toContain("configure_adapter");
      expect(names).toContain("register_device");
      expect(names).toContain("validate_setup");
      expect(names).toContain("run_test_job");
      expect(names).toContain("get_setup_status");
      expect(names).toContain("identify_machine_from_photo");
      expect(names).toContain("scan_network_for_devices");
      expect(names).toContain("auto_detect_connection");
      expect(names).toContain("generate_kernel_config");
      expect(names).toContain("register_and_test");
    });

    it("each tool has a name, description, parameters, and execute function", () => {
      for (const tool of agent.getTools()) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(typeof tool.parameters).toBe("object");
        expect(typeof tool.execute).toBe("function");
      }
    });
  });

  describe("getToolDefinitions()", () => {
    it("returns definitions in Anthropic/OpenAI function-calling format", () => {
      const defs = agent.getToolDefinitions();
      expect(defs).toHaveLength(11);
      for (const def of defs) {
        expect(def.type).toBe("function");
        expect(def.function.name).toBeTruthy();
        expect(def.function.description).toBeTruthy();
        expect(def.function.parameters).toBeDefined();
        expect((def.function.parameters as any).type).toBe("object");
        expect((def.function.parameters as any).properties).toBeDefined();
      }
    });

    it("detect_config has no required parameters", () => {
      const defs = agent.getToolDefinitions();
      const detect = defs.find((d) => d.function.name === "detect_config")!;
      expect((detect.function.parameters as any).required).toHaveLength(0);
    });

    it("register_device has required parameters", () => {
      const defs = agent.getToolDefinitions();
      const reg = defs.find((d) => d.function.name === "register_device")!;
      const required = (reg.function.parameters as any).required as string[];
      expect(required).toContain("kernelId");
      expect(required).toContain("deviceId");
      expect(required).toContain("type");
      expect(required).toContain("adapterType");
    });
  });

  // ── executeTool ─────────────────────────────────────────────────

  describe("executeTool()", () => {
    it('executes "detect_config" and calls gateway', async () => {
      const result = await agent.executeTool("detect_config", {});
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/detect");
      expect(result).toEqual(DETECT_PAYLOAD);
    });

    it('executes "get_setup_status" and calls gateway', async () => {
      const result = await agent.executeTool("get_setup_status", {});
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/status");
      expect(result).toEqual(STATUS_PAYLOAD);
    });

    it('executes "validate_setup" and calls gateway', async () => {
      const result = await agent.executeTool("validate_setup", {});
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/validate");
      expect(result).toEqual(VALIDATE_PAYLOAD);
    });

    it('executes "run_test_job" and calls gateway', async () => {
      const result = await agent.executeTool("run_test_job", {});
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/test-job");
      expect(result).toEqual(TEST_JOB_PAYLOAD);
    });

    it('executes "configure_adapter" and calls gateway', async () => {
      await agent.executeTool("configure_adapter", { devices: [], mockMode: true });
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/generate-config");
    });

    it('executes "register_device" and calls gateway', async () => {
      await agent.executeTool("register_device", {
        kernelId: "k1",
        deviceId: "d1",
        type: "machine",
        adapterType: "mock",
      });
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/register-device");
    });

    it('executes "identify_machine_from_photo" and calls gateway', async () => {
      const result = await agent.executeTool("identify_machine_from_photo", {
        imageBase64: "data:image/jpeg;base64,/9j/4AAQ==",
      }) as any;
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/ai/identify-machine");
      expect(result.make).toBe("Prusa");
      expect(result.suggestedAdapterType).toBe("octoprint");
    });

    it('executes "scan_network_for_devices" and returns devices', async () => {
      const result = await agent.executeTool("scan_network_for_devices", {}) as any;
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/scan-network");
      expect(result.count).toBe(1);
      expect(result.devices[0].address).toBe("192.168.1.50");
    });

    it('executes "auto_detect_connection" and probes target', async () => {
      const result = await agent.executeTool("auto_detect_connection", { target: "192.168.1.50" }) as any;
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/detect-connection");
      expect(result.adapterType).toBe("octoprint");
      expect(result.url).toBe("http://192.168.1.50:5000");
    });

    it('executes "generate_kernel_config" and calls generate-config', async () => {
      const result = await agent.executeTool("generate_kernel_config", {
        deviceName: "My Printer",
        deviceType: "machine",
        adapterType: "octoprint",
        url: "http://192.168.1.50:5000",
      }) as any;
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/generate-config");
      expect(result.config.kernelId).toBe("kernel_test");
    });

    it('executes "register_and_test" and calls register-device then test-job', async () => {
      const result = await agent.executeTool("register_and_test", {
        kernelId: "k1",
        deviceId: "d1",
        type: "machine",
        adapterType: "octoprint",
      }) as any;
      expect(result.registered).toBe(true);
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/api/setup/register-device"))).toBe(true);
      expect(urls.some((u) => u.includes("/api/setup/test-job"))).toBe(true);
    });

    it("throws for unknown tool name", async () => {
      await expect(agent.executeTool("unknown_tool", {})).rejects.toThrow("Unknown tool: unknown_tool");
    });
  });

  // ── routeTextMessage ────────────────────────────────────────────

  describe("routeTextMessage()", () => {
    it('returns "detect" intent for "detect" keyword', async () => {
      const { intent } = await agent.routeTextMessage("detect");
      expect(intent).toBe("detect");
    });

    it('returns "configure" intent for "set up" keyword', async () => {
      const { intent } = await agent.routeTextMessage("set up a CNC machine");
      expect(intent).toBe("configure");
    });

    it('returns "validate" intent for "verify" keyword', async () => {
      const { intent } = await agent.routeTextMessage("verify the setup");
      expect(intent).toBe("validate");
    });

    it('returns "test-job" intent for "test" keyword', async () => {
      const { intent } = await agent.routeTextMessage("test the pipeline");
      expect(intent).toBe("test-job");
    });

    it('returns "status" intent for "status" keyword', async () => {
      const { intent } = await agent.routeTextMessage("give me a status overview");
      expect(intent).toBe("status");
    });

    it('returns "unknown" intent for unrecognized input', async () => {
      const { intent, response } = await agent.routeTextMessage("what is the meaning of life");
      expect(intent).toBe("unknown");
      expect(response).toContain("detect config");
    });
  });

  // ── Conversation state machine ──────────────────────────────────

  describe("conversation state", () => {
    it("initializes state with 'greeting' phase for a new conversation", () => {
      const state = agent.getConversationState("conv_new_001");
      expect(state.phase).toBe("greeting");
      expect(state.detectedMachine).toBeUndefined();
    });

    it("updates state and reflects changes on next get", () => {
      agent.updateConversationState("conv_upd_001", {
        phase: "identify",
        detectedMachine: { make: "Prusa", model: "MK4", type: "FDM Printer" },
      });
      const state = agent.getConversationState("conv_upd_001");
      expect(state.phase).toBe("identify");
      expect(state.detectedMachine?.make).toBe("Prusa");
    });

    it("clears conversation state", () => {
      agent.updateConversationState("conv_clr_001", { phase: "complete", registered: true });
      agent.clearConversationState("conv_clr_001");
      const state = agent.getConversationState("conv_clr_001");
      expect(state.phase).toBe("greeting");
      expect(state.registered).toBeUndefined();
    });

    it("tracks multiple conversations independently", () => {
      agent.updateConversationState("conv_a", { phase: "connect" });
      agent.updateConversationState("conv_b", { phase: "test" });
      expect(agent.getConversationState("conv_a").phase).toBe("connect");
      expect(agent.getConversationState("conv_b").phase).toBe("test");
    });
  });

  // ── identifyMachineFromPhoto ────────────────────────────────────

  describe("identifyMachineFromPhoto()", () => {
    it("returns machine identification from gateway proxy", async () => {
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/ai/identify-machine");
      expect(result.make).toBe("Prusa");
      expect(result.model).toBe("MK4");
      expect(result.suggestedAdapterType).toBe("octoprint");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("falls back to mock result when gateway is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result.make).toBe("Unknown");
      expect(result.confidence).toBeLessThanOrEqual(0.5);
    });
  });

  // ── scanNetworkForDevices ───────────────────────────────────────

  describe("scanNetworkForDevices()", () => {
    it("returns discovered devices from gateway", async () => {
      const devices = await agent.scanNetworkForDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].address).toBe("192.168.1.50");
      expect(devices[0].service).toBe("OctoPrint");
    });

    it("returns empty array when gateway is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
      const devices = await agent.scanNetworkForDevices();
      expect(devices).toEqual([]);
    });
  });

  // ── autoDetectConnection ────────────────────────────────────────

  describe("autoDetectConnection()", () => {
    it("returns connection detection result from gateway", async () => {
      const result = await agent.autoDetectConnection("192.168.1.50");
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/setup/detect-connection");
      expect(result.adapterType).toBe("octoprint");
      expect(result.url).toBe("http://192.168.1.50:5000");
    });

    it("falls back to octoprint guess when gateway is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
      const result = await agent.autoDetectConnection("192.168.1.50");
      expect(result.adapterType).toBe("octoprint");
      expect(result.url).toContain("192.168.1.50");
    });
  });
});

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
    if (urlStr.includes("/api/onboard/identify-device")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(overrides && "identifyDevice" in overrides ? overrides.identifyDevice : {
          candidates: [{
            vendor: "Prusa",
            model: "MK4",
            confidence: 0.92,
            mappedAdapterType: "octoprint",
            reasoning: "The label identifies a Prusa MK4 printer.",
            apiDocsUrl: "https://example.com/docs",
          }],
          clarifyingQuestions: [],
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

    it('executes "identify_machine_from_photo" with the photo unchanged', async () => {
      const result = await agent.executeTool("identify_machine_from_photo", {
        imageBase64: "data:image/png;base64,iVBORw0KGgo=",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("http://localhost:3200/api/onboard/identify-device");
      expect(options?.method).toBe("POST");
      expect(JSON.parse(options!.body as string)).toStrictEqual({
        photoBase64: "data:image/png;base64,iVBORw0KGgo=",
      });
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: "MK4",
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it('describes "identify_machine_from_photo" and its photo parameter exactly', () => {
      const tool = agent.getTools().find((t) => t.name === "identify_machine_from_photo")!;
      expect(tool.description).toStrictEqual(
        "Sends a photo of a machine to the gateway's identification route. If the gateway identifies it, returns identified: true with make, model and confidence, plus suggestedAdapterType (octoprint, modbus, opcua, sila or opentrons) when the machine maps to one of those. The suggestion is for the operator to confirm. Otherwise returns identified: false with a reason, plus the HTTP status when the gateway replied.",
      );
      expect(tool.parameters.imageBase64.description).toStrictEqual(
        "The photo, base64-encoded. Send it as a data URI (data:image/png;base64,...) so the gateway can tell its image type; without the prefix the gateway treats it as JPEG.",
      );
    });

    it('still throws the gateway\'s error for "run_test_job"', async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("boom"),
      }));
      await expect(agent.executeTool("run_test_job", {})).rejects.toThrow(
        "POST /api/setup/test-job failed: 500 boom",
      );
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
    it("posts the photo to the identification route and passes make, model and confidence", async () => {
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("http://localhost:3200/api/onboard/identify-device");
      expect(options?.method).toBe("POST");
      expect(options?.headers).toStrictEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(options!.body as string)).toStrictEqual({ photoBase64: "/9j/4AAQ==" });
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: "MK4",
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it.each(["octoprint", "modbus", "opcua", "sila", "opentrons"])("suggests %s", async (mappedAdapterType) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor: "Prusa", model: "MK4", confidence: 0.92, mappedAdapterType }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: "MK4",
        confidence: 0.92,
        suggestedAdapterType: mappedAdapterType,
      });
    });

    it.each([0, 1])("passes a confidence of %s at the end of the range", async (confidence) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor: "Prusa", model: "MK4", confidence, mappedAdapterType: "octoprint" }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: "MK4",
        confidence,
        suggestedAdapterType: "octoprint",
      });
    });

    it.each(["generic-http", "hamilton", "mock"])("suggests nothing for %s", async (mappedAdapterType) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor: "Prusa", model: "MK4", confidence: 0.92, mappedAdapterType }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: "MK4",
        confidence: 0.92,
      });
    });

    it("passes none of the reply's other fields", async () => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{
            vendor: "Prusa",
            model: "MK4",
            confidence: 0.92,
            mappedAdapterType: "octoprint",
            type: "FDM 3D Printer",
            reasoning: "The orange extruder cover and frame label identify this as a Prusa MK4.",
            apiDocsUrl: "https://example.com/docs",
          }],
          clarifyingQuestions: ["Which model?"],
          askForPhoto: true,
          raw: "MODEL TEXT",
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: "MK4",
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it("returns the failure result without a status when fetch rejects", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:3200")));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(fetch).toHaveBeenCalledOnce();
      expect(result).toStrictEqual({
        identified: false,
        reason: "Couldn't get an identification from the photo.",
      });
    });

    it.each([400, 429, 502, 503])("returns the failure result with status %i and reads no body", async (status) => {
      const body = { error: "Model returned unparseable output", raw: "MODEL TEXT" };
      const json = vi.fn().mockResolvedValue(body);
      const text = vi.fn().mockResolvedValue(JSON.stringify(body));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, json, text }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(fetch).toHaveBeenCalledOnce();
      expect(result).toStrictEqual({
        identified: false,
        reason: "Couldn't get an identification from the photo.",
        status,
      });
      expect(json).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    });

    it("returns the failure result with status 200 when the reply has no candidates", async () => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: { candidates: [], clarifyingQuestions: ["Which model?"] },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: false,
        reason: "Couldn't get an identification from the photo.",
        status: 200,
      });
    });

    it.each([
      { label: "a body that is null", body: null },
      { label: "a body without candidates", body: { clarifyingQuestions: ["Which model?"] } },
      { label: "a first candidate that is not an object", body: { candidates: ["Prusa MK4"] } },
      {
        label: "a first candidate without a vendor",
        body: { candidates: [{ model: "MK4", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "a blank vendor",
        body: { candidates: [{ vendor: "  ", model: "MK4", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "a first candidate without a model",
        body: { candidates: [{ vendor: "Prusa", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "an empty model",
        body: { candidates: [{ vendor: "Prusa", model: "", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "a blank model",
        body: { candidates: [{ vendor: "Prusa", model: "  ", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "a first candidate without a confidence",
        body: { candidates: [{ vendor: "Prusa", model: "MK4", mappedAdapterType: "octoprint" }] },
      },
      {
        label: "a confidence above 1",
        body: { candidates: [{ vendor: "Prusa", model: "MK4", confidence: 1.5, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "an unusable first candidate before a usable one",
        body: {
          candidates: [
            { model: "MK4", confidence: 0.9, mappedAdapterType: "octoprint" },
            { vendor: "Prusa", model: "MK4", confidence: 0.9, mappedAdapterType: "octoprint" },
          ],
        },
      },
      {
        label: "a vendor of only a line feed, a zero-width space and a tab",
        body: { candidates: [{ vendor: "\n\u200B\t", model: "MK4", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "a model of only a line separator, a soft hyphen and a carriage return",
        body: { candidates: [{ vendor: "Prusa", model: "\u2028\u00AD\r", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
      {
        label: "a model of only a lone surrogate",
        body: { candidates: [{ vendor: "Prusa", model: "\uD800", confidence: 0.9, mappedAdapterType: "octoprint" }] },
      },
    ])("returns the failure result for $label", async ({ body }) => {
      vi.stubGlobal("fetch", makeFetchMock({ identifyDevice: body }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: false,
        reason: "Couldn't get an identification from the photo.",
        status: 200,
      });
    });

    it("returns the failure result with status 200 when the body is not JSON", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token in JSON")),
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(fetch).toHaveBeenCalledOnce();
      expect(result).toStrictEqual({
        identified: false,
        reason: "Couldn't get an identification from the photo.",
        status: 200,
      });
    });

    it.each([
      { label: "a line feed between words", vendor: "Prusa\nResearch", make: "Prusa Research" },
      { label: "a trailing carriage return and line feed", vendor: "Prusa\r\n", make: "Prusa" },
    ])("cleans a vendor with $label", async ({ vendor, make }) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor, model: "MK4", confidence: 0.92, mappedAdapterType: "octoprint" }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make,
        model: "MK4",
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it.each([
      { label: "a carriage return and line feed", model: "MK\r\n4", expectedModel: "MK 4" },
      { label: "a tab", model: "MK\t4", expectedModel: "MK 4" },
      { label: "a NUL", model: "MK\u00004", expectedModel: "MK 4" },
      { label: "an escape", model: "MK\u001B4", expectedModel: "MK 4" },
      { label: "a delete", model: "MK\u007F4", expectedModel: "MK 4" },
      { label: "a next line", model: "MK\u00854", expectedModel: "MK 4" },
      { label: "a C1 control", model: "MK\u009B4", expectedModel: "MK 4" },
      { label: "a line separator", model: "MK\u20284", expectedModel: "MK 4" },
      { label: "a paragraph separator", model: "MK\u20294", expectedModel: "MK 4" },
      { label: "a mixed run", model: "MK\r\n\u2028\t\u001B4", expectedModel: "MK 4" },
      { label: "a run with a format character inside", model: "MK\n\u200B\n4", expectedModel: "MK 4" },
      { label: "a leading tab and a trailing line feed", model: "\tMK4\n", expectedModel: "MK4" },
    ])("cleans a model with $label", async ({ model, expectedModel }) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor: "Prusa", model, confidence: 0.92, mappedAdapterType: "octoprint" }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: expectedModel,
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it.each([
      { label: "a zero-width space", vendor: "Pr\u200Busa" },
      { label: "a right-to-left override and its pop", vendor: "Pr\u202Eus\u202Ca" },
      { label: "a left-to-right isolate and its pop", vendor: "Pr\u2066us\u2069a" },
      { label: "a byte order mark", vendor: "Pru\uFEFFsa" },
      { label: "a soft hyphen", vendor: "Pru\u00ADsa" },
      { label: "a lone high surrogate", vendor: "Prusa\uD83D" },
      { label: "a lone low surrogate", vendor: "Pru\uDE00sa" },
    ])("removes $label from the vendor", async ({ vendor }) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor, model: "MK4", confidence: 0.92, mappedAdapterType: "octoprint" }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make: "Prusa",
        model: "MK4",
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it.each([
      { label: "accented Latin", vendor: "Cr\u00E9ation M\u00E9canique", model: "Fraiseuse \u00D812" },
      { label: "Cyrillic", vendor: "\u0421\u0442\u0430\u043D\u043E\u043A", model: "16\u041A20" },
      { label: "CJK with a character outside the BMP", vendor: "\u{20BB7}\u91CE", model: "\u65CB\u76E4 NC-7" },
      { label: "an inner no-break space, digits and punctuation", vendor: "Prusa\u00A0Research", model: "MK3.9/S+ (#2, 2024)" },
    ])("keeps $label unchanged", async ({ vendor, model }) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor, model, confidence: 0.92, mappedAdapterType: "octoprint" }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make: vendor,
        model,
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it.each([
      { label: "a vendor of 81 units to 80", vendor: "A".repeat(81), make: "A".repeat(80) },
      { label: "a model of 121 units to 120", model: "B".repeat(121), expectedModel: "B".repeat(120) },
      { label: "a vendor of exactly 80 units, keeping it whole", vendor: "A".repeat(80), make: "A".repeat(80) },
      { label: "a model of exactly 120 units, keeping it whole", model: "B".repeat(120), expectedModel: "B".repeat(120) },
      { label: "a vendor whose cut falls inside a surrogate pair", vendor: "A".repeat(79) + "\u{20BB7}", make: "A".repeat(79) },
      { label: "a model whose cut falls inside a surrogate pair", model: "B".repeat(119) + "\u{20BB7}", expectedModel: "B".repeat(119) },
      { label: "a vendor before its format characters are removed", vendor: "\u200B".repeat(10) + "A".repeat(80), make: "A".repeat(70) },
      { label: "a model before its format characters are removed", model: "\u200B".repeat(10) + "B".repeat(120), expectedModel: "B".repeat(110) },
    ])("caps $label", async ({ vendor = "Prusa", model = "MK4", make = "Prusa", expectedModel = "MK4" }) => {
      vi.stubGlobal("fetch", makeFetchMock({
        identifyDevice: {
          candidates: [{ vendor, model, confidence: 0.92, mappedAdapterType: "octoprint" }],
        },
      }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(result).toStrictEqual({
        identified: true,
        make,
        model: expectedModel,
        confidence: 0.92,
        suggestedAdapterType: "octoprint",
      });
    });

    it("returns the photo-size reason with status 413 and reads no body", async () => {
      const body = { error: "Model returned unparseable output", raw: "MODEL TEXT" };
      const json = vi.fn().mockResolvedValue(body);
      const text = vi.fn().mockResolvedValue(JSON.stringify(body));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 413, json, text }));
      const result = await agent.identifyMachineFromPhoto("/9j/4AAQ==");
      expect(fetch).toHaveBeenCalledOnce();
      expect(result).toStrictEqual({
        identified: false,
        reason: "The gateway refused the photo as too large. Try a smaller photo.",
        status: 413,
      });
      expect(json).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
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

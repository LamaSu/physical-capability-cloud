import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageBus } from "../message-bus.js";
import type {
  AgentCard,
  A2AMessage,
  Intent,
  SetupDetectIntent,
  SetupDetectResultIntent,
  SetupConfigureIntent,
  SetupConfigureResultIntent,
  SetupValidateIntent,
  SetupValidateResultIntent,
  SetupDetectPayload,
  SetupDetectResultPayload,
  SetupConfigurePayload,
  SetupConfigureResultPayload,
  SetupValidatePayload,
  SetupValidateResultPayload,
} from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id: `agent_${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Agent",
    role: "user",
    walletAddress: "0x0000000000000000000000000000000000000001",
    capabilities: [],
    endpoint: "agent://test",
    description: "test agent",
    supportedIntents: [],
    publicKey: "0xpub",
    ...overrides,
  };
}

function makeMessage(
  intent: Intent,
  overrides: Partial<A2AMessage> = {},
): A2AMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId: `conv_${Math.random().toString(36).slice(2, 8)}`,
    from: "agent_setup_orchestrator",
    to: "agent_setup_worker",
    intent,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Type-level guard tests ───────────────────────────────────────
// These ensure the discriminant union compiles and narrows correctly.

function assertSetupDetect(intent: Intent): intent is SetupDetectIntent {
  return intent.type === "setup_detect";
}
function assertSetupDetectResult(intent: Intent): intent is SetupDetectResultIntent {
  return intent.type === "setup_detect_result";
}
function assertSetupConfigure(intent: Intent): intent is SetupConfigureIntent {
  return intent.type === "setup_configure";
}
function assertSetupConfigureResult(intent: Intent): intent is SetupConfigureResultIntent {
  return intent.type === "setup_configure_result";
}
function assertSetupValidate(intent: Intent): intent is SetupValidateIntent {
  return intent.type === "setup_validate";
}
function assertSetupValidateResult(intent: Intent): intent is SetupValidateResultIntent {
  return intent.type === "setup_validate_result";
}

// ── Tests ────────────────────────────────────────────────────────

describe("Setup Intent Types", () => {
  // ── Intent construction ────────────────────────────────────────

  describe("setup_detect", () => {
    it("constructs a valid setup_detect intent", () => {
      const intent: SetupDetectIntent = { type: "setup_detect" };
      expect(intent.type).toBe("setup_detect");
    });

    it("narrows correctly from the Intent union", () => {
      const intent: Intent = { type: "setup_detect" };
      expect(assertSetupDetect(intent)).toBe(true);
    });

    it("SetupDetectPayload omits the type discriminant", () => {
      // If this compiles, the type alias is correct.
      const payload: SetupDetectPayload = {};
      expect(payload).toBeDefined();
    });
  });

  describe("setup_detect_result", () => {
    it("constructs a valid setup_detect_result intent", () => {
      const intent: SetupDetectResultIntent = {
        type: "setup_detect_result",
        gateway: { running: true, url: "http://localhost:3200", version: "1.0.0" },
        database: { initialized: true, kernels: 1, devices: 2, jobs: 5 },
        chain: { connected: true, network: "base-sepolia", walletAddress: "0xabc", balance: "1.5" },
        adapters: [{ id: "printer-1", type: "machine", adapterType: "octoprint", healthy: true }],
        storage: { type: "helia", connected: true },
        identity: { registered: true, agentId: "agent_123", did: "did:pcc:test" },
        overall: "ready",
        missing: [],
      };
      expect(intent.type).toBe("setup_detect_result");
      expect(intent.overall).toBe("ready");
      expect(intent.missing).toHaveLength(0);
    });

    it("accepts 'partial' and 'unconfigured' overall statuses", () => {
      const partial: SetupDetectResultIntent = {
        type: "setup_detect_result",
        gateway: { running: true, url: "http://localhost:3200" },
        database: { initialized: true, kernels: 0, devices: 0, jobs: 0 },
        chain: { connected: false },
        adapters: [],
        storage: { type: "mock", connected: false },
        identity: { registered: false },
        overall: "partial",
        missing: ["chain_rpc", "evidence_storage"],
      };
      expect(partial.overall).toBe("partial");
      expect(partial.missing).toContain("chain_rpc");

      const unconfigured: SetupDetectResultIntent = {
        type: "setup_detect_result",
        gateway: { running: false, url: "" },
        database: { initialized: false, kernels: 0, devices: 0, jobs: 0 },
        chain: { connected: false },
        adapters: [],
        storage: { type: "none", connected: false },
        identity: { registered: false },
        overall: "unconfigured",
        missing: ["gateway", "database", "chain", "storage", "identity"],
      };
      expect(unconfigured.overall).toBe("unconfigured");
    });

    it("narrows correctly from the Intent union", () => {
      const intent: Intent = {
        type: "setup_detect_result",
        gateway: { running: true, url: "http://localhost:3200" },
        database: { initialized: true, kernels: 0, devices: 0, jobs: 0 },
        chain: { connected: true },
        adapters: [],
        storage: { type: "mock", connected: false },
        identity: { registered: false },
        overall: "partial",
        missing: ["storage"],
      };
      expect(assertSetupDetectResult(intent)).toBe(true);
    });

    it("SetupDetectResultPayload type alias is usable", () => {
      const payload: SetupDetectResultPayload = {
        gateway: { running: true, url: "http://localhost:3200" },
        database: { initialized: true, kernels: 1, devices: 1, jobs: 0 },
        chain: { connected: true },
        adapters: [],
        storage: { type: "helia", connected: true },
        identity: { registered: false },
        overall: "partial",
        missing: ["identity"],
      };
      expect(payload.overall).toBe("partial");
    });
  });

  describe("setup_configure", () => {
    it("constructs a valid setup_configure intent for adapter subsystem", () => {
      const intent: SetupConfigureIntent = {
        type: "setup_configure",
        subsystem: "adapter",
        config: { adapterType: "octoprint", url: "http://192.168.1.50:5000", apiKey: "abc123" },
      };
      expect(intent.type).toBe("setup_configure");
      expect(intent.subsystem).toBe("adapter");
    });

    it("accepts all valid subsystem values", () => {
      const subsystems: SetupConfigureIntent["subsystem"][] = [
        "adapter", "chain", "storage", "identity", "full",
      ];
      for (const subsystem of subsystems) {
        const intent: SetupConfigureIntent = {
          type: "setup_configure",
          subsystem,
          config: {},
        };
        expect(intent.subsystem).toBe(subsystem);
      }
    });

    it("narrows correctly from the Intent union", () => {
      const intent: Intent = {
        type: "setup_configure",
        subsystem: "chain",
        config: { network: "base-sepolia" },
      };
      expect(assertSetupConfigure(intent)).toBe(true);
    });

    it("SetupConfigurePayload type alias is usable", () => {
      const payload: SetupConfigurePayload = {
        subsystem: "identity",
        config: { agentName: "my-kernel" },
      };
      expect(payload.subsystem).toBe("identity");
    });
  });

  describe("setup_configure_result", () => {
    it("constructs a valid success result", () => {
      const intent: SetupConfigureResultIntent = {
        type: "setup_configure_result",
        subsystem: "adapter",
        success: true,
        config: { adapterType: "octoprint", healthy: true },
      };
      expect(intent.type).toBe("setup_configure_result");
      expect(intent.success).toBe(true);
    });

    it("constructs a valid failure result with error message", () => {
      const intent: SetupConfigureResultIntent = {
        type: "setup_configure_result",
        subsystem: "chain",
        success: false,
        error: "RPC endpoint unreachable",
      };
      expect(intent.success).toBe(false);
      expect(intent.error).toBe("RPC endpoint unreachable");
    });

    it("narrows correctly from the Intent union", () => {
      const intent: Intent = {
        type: "setup_configure_result",
        subsystem: "storage",
        success: true,
      };
      expect(assertSetupConfigureResult(intent)).toBe(true);
    });

    it("SetupConfigureResultPayload type alias is usable", () => {
      const payload: SetupConfigureResultPayload = {
        subsystem: "full",
        success: true,
      };
      expect(payload.success).toBe(true);
    });
  });

  describe("setup_validate", () => {
    it("constructs a valid setup_validate intent without config (validate current)", () => {
      const intent: SetupValidateIntent = { type: "setup_validate" };
      expect(intent.type).toBe("setup_validate");
      expect(intent.config).toBeUndefined();
    });

    it("constructs a valid setup_validate intent with inline config JSON", () => {
      const configJson = JSON.stringify({ kernelId: "test", devices: [] });
      const intent: SetupValidateIntent = { type: "setup_validate", config: configJson };
      expect(intent.config).toBe(configJson);
    });

    it("narrows correctly from the Intent union", () => {
      const intent: Intent = { type: "setup_validate" };
      expect(assertSetupValidate(intent)).toBe(true);
    });

    it("SetupValidatePayload type alias is usable", () => {
      const payload: SetupValidatePayload = { config: '{"kernelId":"k1"}' };
      expect(payload.config).toBeDefined();
    });
  });

  describe("setup_validate_result", () => {
    it("constructs a valid passing result", () => {
      const intent: SetupValidateResultIntent = {
        type: "setup_validate_result",
        valid: true,
        checks: [
          { name: "gateway_reachable", status: "pass", message: "Gateway responded in 12ms" },
          { name: "db_initialized", status: "pass", message: "SQLite DB has 1 kernel, 2 devices" },
          { name: "chain_connected", status: "warn", message: "Chain connected but wallet has low balance" },
        ],
        errors: [],
        warnings: ["Wallet balance below recommended 0.1 ETH"],
      };
      expect(intent.valid).toBe(true);
      expect(intent.checks).toHaveLength(3);
      expect(intent.warnings).toHaveLength(1);
    });

    it("constructs a valid failing result", () => {
      const intent: SetupValidateResultIntent = {
        type: "setup_validate_result",
        valid: false,
        checks: [
          { name: "adapter_reachable", status: "fail", message: "OctoPrint did not respond at http://192.168.1.50:5000" },
          { name: "db_initialized", status: "pass", message: "DB OK" },
        ],
        errors: ["Adapter octoprint unreachable"],
        warnings: [],
      };
      expect(intent.valid).toBe(false);
      expect(intent.errors).toContain("Adapter octoprint unreachable");
    });

    it("accepts pass, warn, and fail check statuses", () => {
      const statuses: Array<"pass" | "warn" | "fail"> = ["pass", "warn", "fail"];
      for (const status of statuses) {
        const check = { name: "test_check", status, message: "ok" };
        expect(check.status).toBe(status);
      }
    });

    it("narrows correctly from the Intent union", () => {
      const intent: Intent = {
        type: "setup_validate_result",
        valid: true,
        checks: [],
        errors: [],
        warnings: [],
      };
      expect(assertSetupValidateResult(intent)).toBe(true);
    });

    it("SetupValidateResultPayload type alias is usable", () => {
      const payload: SetupValidateResultPayload = {
        valid: false,
        checks: [{ name: "c", status: "fail", message: "nope" }],
        errors: ["failed"],
        warnings: [],
      };
      expect(payload.valid).toBe(false);
    });
  });
});

// ── MessageBus routing tests ──────────────────────────────────────

describe("MessageBus routes setup intents", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it("delivers setup_detect message to recipient", async () => {
    const worker = makeCard({ id: "agent_setup_worker", supportedIntents: ["setup_detect"] });
    bus.register(worker);

    const handler = vi.fn();
    bus.subscribe("agent_setup_worker", handler);

    const msg = makeMessage({ type: "setup_detect" }, { to: "agent_setup_worker" });
    await bus.send(msg);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0][0] as A2AMessage;
    expect(received.intent.type).toBe("setup_detect");
  });

  it("delivers setup_detect_result message to orchestrator", async () => {
    const orchestrator = makeCard({ id: "agent_orchestrator" });
    bus.register(orchestrator);

    const handler = vi.fn();
    bus.subscribe("agent_orchestrator", handler);

    const intent: SetupDetectResultIntent = {
      type: "setup_detect_result",
      gateway: { running: true, url: "http://localhost:3200" },
      database: { initialized: true, kernels: 1, devices: 1, jobs: 0 },
      chain: { connected: false },
      adapters: [{ id: "dev-1", type: "machine", adapterType: "mock", healthy: true }],
      storage: { type: "mock", connected: false },
      identity: { registered: false },
      overall: "partial",
      missing: ["chain", "storage", "identity"],
    };

    const msg = makeMessage(intent, { to: "agent_orchestrator" });
    await bus.send(msg);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0][0] as A2AMessage;
    const receivedIntent = received.intent as SetupDetectResultIntent;
    expect(receivedIntent.overall).toBe("partial");
    expect(receivedIntent.missing).toContain("chain");
  });

  it("delivers setup_configure with chain subsystem", async () => {
    const worker = makeCard({ id: "agent_chain_configurer" });
    bus.register(worker);

    const handler = vi.fn();
    bus.subscribe("agent_chain_configurer", handler);

    const intent: SetupConfigureIntent = {
      type: "setup_configure",
      subsystem: "chain",
      config: { network: "base-sepolia", rpcUrl: "https://rpc.example.com" },
    };

    await bus.send(makeMessage(intent, { to: "agent_chain_configurer" }));

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0][0] as A2AMessage;
    const receivedIntent = received.intent as SetupConfigureIntent;
    expect(receivedIntent.subsystem).toBe("chain");
    expect(receivedIntent.config).toMatchObject({ network: "base-sepolia" });
  });

  it("delivers setup_configure_result back to requester", async () => {
    const requester = makeCard({ id: "agent_requester" });
    bus.register(requester);

    const handler = vi.fn();
    bus.subscribe("agent_requester", handler);

    const intent: SetupConfigureResultIntent = {
      type: "setup_configure_result",
      subsystem: "chain",
      success: true,
      config: { network: "base-sepolia", chainId: 84532 },
    };

    await bus.send(makeMessage(intent, { to: "agent_requester" }));

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0][0] as A2AMessage;
    const receivedIntent = received.intent as SetupConfigureResultIntent;
    expect(receivedIntent.success).toBe(true);
  });

  it("delivers setup_validate to a setup agent", async () => {
    const setupAgent = makeCard({
      id: "agent_setup",
      supportedIntents: ["setup_detect", "setup_configure", "setup_validate"],
    });
    bus.register(setupAgent);

    const handler = vi.fn();
    bus.subscribe("agent_setup", handler);

    const intent: SetupValidateIntent = {
      type: "setup_validate",
      config: JSON.stringify({ kernelId: "k1", devices: [] }),
    };

    await bus.send(makeMessage(intent, { to: "agent_setup" }));

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0][0] as A2AMessage;
    expect(received.intent.type).toBe("setup_validate");
  });

  it("delivers setup_validate_result with check details", async () => {
    const orchestrator = makeCard({ id: "agent_orch" });
    bus.register(orchestrator);

    const handler = vi.fn();
    bus.subscribe("agent_orch", handler);

    const intent: SetupValidateResultIntent = {
      type: "setup_validate_result",
      valid: false,
      checks: [
        { name: "gateway_reachable", status: "pass", message: "Gateway OK" },
        { name: "adapter_reachable", status: "fail", message: "Printer offline" },
      ],
      errors: ["adapter_reachable failed"],
      warnings: [],
    };

    await bus.send(makeMessage(intent, { to: "agent_orch" }));

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0][0] as A2AMessage;
    const receivedIntent = received.intent as SetupValidateResultIntent;
    expect(receivedIntent.valid).toBe(false);
    expect(receivedIntent.checks).toHaveLength(2);
    expect(receivedIntent.errors).toContain("adapter_reachable failed");
  });

  it("findByIntent finds setup agents by setup_detect support", () => {
    bus.register(
      makeCard({
        id: "agent_s1",
        supportedIntents: ["setup_detect", "setup_configure", "setup_validate"],
      }),
    );
    bus.register(
      makeCard({ id: "agent_u1", supportedIntents: ["discover_capabilities"] }),
    );

    const setupAgents = bus.findByIntent("setup_detect");
    expect(setupAgents).toHaveLength(1);
    expect(setupAgents[0].id).toBe("agent_s1");
  });

  it("conversation topic is set to the setup intent type", async () => {
    const worker = makeCard({ id: "agent_setup_w" });
    bus.register(worker);

    const convId = "conv_setup_test";
    const msg = makeMessage(
      { type: "setup_detect" },
      { conversationId: convId, to: "agent_setup_w" },
    );
    await bus.send(msg);

    const convo = bus.getConversation(convId);
    expect(convo).toBeDefined();
    expect(convo!.topic).toBe("setup_detect");
  });
});

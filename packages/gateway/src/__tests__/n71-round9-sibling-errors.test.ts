import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCard, MessageBus } from "@pcc/a2a";
import { AgentHeartbeatMonitor } from "../services/agent-heartbeat-monitor.js";

vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
const hostile = ["pcc", "live", "N71-SENTINEL"].join("_");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("N71 round 9 newly discovered exception forwarders", () => {
  it("MCP domain fallback logs a code and class without the rejected configuration", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("PCC_MCP_APP_DOMAIN", `https://operator:${hostile}@example.invalid/`);
    const { resolveMcpAppDomain, MCP_APP_DOMAIN_PLACEHOLDER } = await import("../mcp/mcp-app-view.js");
    expect(resolveMcpAppDomain()).toBe(MCP_APP_DOMAIN_PLACEHOLDER);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toEqual({ code: "mcp_app_domain_invalid", errorClass: "Error" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(hostile);
  });

  it("heartbeat callbacks log only closed error classes and formatted identifiers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const bus = {
      broadcast: vi.fn().mockRejectedValue(new TypeError(hostile)),
      unregister: vi.fn().mockImplementation(() => { throw new RangeError(hostile); }),
    };
    const monitor = new AgentHeartbeatMonitor(bus as unknown as MessageBus, 100, 3, 5);
    vi.spyOn(monitor as unknown as { _suspendScopes(id: string): Promise<number> }, "_suspendScopes")
      .mockRejectedValue(new RangeError(hostile));
    monitor.onRogue = () => { throw new TypeError(hostile); };
    const card = { id: hostile, name: hostile, role: "user" } as AgentCard;
    monitor.registerAgent(card);
    vi.setSystemTime(300);
    (monitor as unknown as { _check(): void })._check();
    vi.setSystemTime(500);
    (monitor as unknown as { _check(): void })._check();
    await vi.advanceTimersByTimeAsync(0);
    expect(error.mock.calls.map(([value]) => value)).toEqual(expect.arrayContaining([
      { code: "heartbeat_monitor_alert_broadcast_failed", errorClass: "TypeError" },
      { code: "heartbeat_monitor_anomaly_broadcast_failed", errorClass: "TypeError" },
      { code: "heartbeat_monitor_rogue_callback_failed", agentId: "[invalid id]", errorClass: "TypeError" },
      { code: "heartbeat_monitor_scope_suspension_failed", agentId: "[invalid id]", errorClass: "RangeError" },
      { code: "heartbeat_monitor_bus_unregister_failed", agentId: "[invalid id]", errorClass: "RangeError" },
    ]));
    expect(JSON.stringify([error.mock.calls, warn.mock.calls, log.mock.calls])).not.toContain(hostile);
    monitor.unregisterAgent(hostile);
    expect(log.mock.calls.at(-1)?.[0]).toContain("[invalid id]");
  });
});

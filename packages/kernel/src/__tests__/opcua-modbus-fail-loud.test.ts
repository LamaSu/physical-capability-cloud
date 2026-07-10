/**
 * Fail-loud contract tests for the OPC-UA and Modbus adapters.
 *
 * Real mode (mockMode: false) has no transport wired. A command or read in
 * that state must surface as FAILURE, never as fabricated success:
 *   - opcua load_gcode/start/stop → { success: false } and NO evidence events
 *   - modbus startRecording/getCurrentReading → reject (no fabricated readings)
 * Mock mode (mockMode: true) keeps simulated success — that path is legitimate
 * and used by tests/demos.
 *
 * Also covers the SafetyGateway half of the invariant: an execute callback
 * that resolves to { success: false } must record a circuit-breaker FAILURE,
 * not a phantom success that resets the consecutive-failure count.
 */

import { describe, it, expect } from "vitest";
import { OPCUAAdapter } from "../adapters/opcua-adapter.js";
import { ModbusSensorAdapter } from "../adapters/modbus-sensor-adapter.js";
import type { ModbusRegisterDef } from "../adapters/modbus-sensor-adapter.js";
import { SafetyGateway } from "../safety/gateway.js";
import type { PhysicalCommand } from "../safety/governor.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOpcua(mockMode: boolean): OPCUAAdapter {
  return new OPCUAAdapter("opcua-test-1", {
    endpoint: "opc.tcp://192.0.2.1:4840", // TEST-NET-1 — nothing listens here
    kernelId: "kernel-test",
    machineType: "cnc-3axis",
    nodeMap: [],
    mockMode,
  });
}

const REGISTERS: ModbusRegisterDef[] = [
  {
    channel: "power",
    label: "Power draw",
    address: 100,
    registerType: "holding",
    dataType: "uint16",
    unit: "W",
  },
];

function makeModbus(mockMode: boolean): ModbusSensorAdapter {
  return new ModbusSensorAdapter("modbus-test-1", {
    host: "192.0.2.1", // TEST-NET-1 — nothing listens here
    kernelId: "kernel-test",
    registerMap: REGISTERS,
    mockMode,
  });
}

// ── OPC-UA: real mode fails loud ─────────────────────────────────────────────

describe("OPCUAAdapter real mode — actuation commands fail loud", () => {
  it.each(["load_gcode", "start", "stop"] as const)(
    "%s returns success:false (nothing was sent to the machine)",
    async (type) => {
      const adapter = makeOpcua(false);
      const result = await adapter.execute({ type });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not implemented/i);
      await adapter.dispose();
    },
  );

  it("emits NO evidence events for real-mode load_gcode/start (nothing happened)", async () => {
    const adapter = makeOpcua(false);
    const events: unknown[] = [];
    adapter.onEvidence((e) => events.push(e));

    await adapter.execute({ type: "load_gcode", payload: { filename: "part.nc" } });
    await adapter.execute({ type: "start" });

    expect(events).toHaveLength(0);
    await adapter.dispose();
  });

  it("real-mode stop says the machine was NOT stopped so callers can escalate to e-stop", async () => {
    const adapter = makeOpcua(false);
    const result = await adapter.execute({ type: "stop" });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/NOT been stopped/);
    await adapter.dispose();
  });
});

// ── OPC-UA: mock mode preserved ──────────────────────────────────────────────

describe("OPCUAAdapter mock mode — simulated success preserved", () => {
  it("load_gcode → start → stop all succeed with (mock) tags", async () => {
    const adapter = makeOpcua(true);

    const load = await adapter.execute({ type: "load_gcode", payload: { filename: "part.nc" } });
    expect(load.success).toBe(true);
    expect(load.message).toContain("(mock)");

    const start = await adapter.execute({ type: "start" });
    expect(start.success).toBe(true);

    const stop = await adapter.execute({ type: "stop" });
    expect(stop.success).toBe(true);
    expect(stop.message).toContain("(mock)");

    await adapter.dispose();
  });

  it("mock mode still emits evidence events", async () => {
    const adapter = makeOpcua(true);
    const events: Array<{ type: string }> = [];
    adapter.onEvidence((e) => events.push(e as { type: string }));

    await adapter.execute({ type: "load_gcode" });
    await adapter.execute({ type: "start" });
    expect(events.map((e) => e.type)).toEqual(["gcode_received", "execution_started"]);

    await adapter.execute({ type: "stop" });
    await adapter.dispose();
  });
});

// ── Modbus: real mode fails loud ─────────────────────────────────────────────

describe("ModbusSensorAdapter real mode — reads fail loud (no fabricated evidence)", () => {
  it("startRecording rejects instead of recording random values as quality-1.0 readings", async () => {
    const adapter = makeModbus(false);
    await expect(adapter.startRecording("job-1")).rejects.toThrow(/not implemented/i);
    await adapter.dispose();
  });

  it("getCurrentReading rejects instead of returning random values", async () => {
    const adapter = makeModbus(false);
    await expect(adapter.getCurrentReading()).rejects.toThrow(/not implemented/i);
    await adapter.dispose();
  });
});

// ── Modbus: mock mode preserved ──────────────────────────────────────────────

describe("ModbusSensorAdapter mock mode — simulated readings preserved", () => {
  it("startRecording + getCurrentReading produce numeric simulated values", async () => {
    const adapter = makeModbus(true);

    await adapter.startRecording("job-1");
    const reading = await adapter.getCurrentReading();
    expect(typeof reading.power).toBe("number");

    const summary = await adapter.stopRecording();
    expect(summary.type).toBe("sensor_data_summary");

    await adapter.dispose();
  });
});

// ── SafetyGateway: self-reported failure reaches the breaker ─────────────────

describe("SafetyGateway — self-reported adapter failure reaches the circuit breaker", () => {
  let cmdCounter = 0;
  function makeCmd(deviceId: string): PhysicalCommand {
    return {
      commandId: `flc-cmd-${++cmdCounter}`,
      deviceId,
      class: "safe",
      type: "start",
      params: {},
      agentDid: "did:key:agent-test",
    };
  }

  it("execute resolving { success:false } records a breaker FAILURE (trips at threshold)", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } });
    const selfReportedFailure = async () => ({
      success: false,
      message: "OPC-UA write not implemented",
    });

    const r1 = await gw.validateAndRelay(makeCmd("dev-stub"), selfReportedFailure);
    expect(r1.allowed).toBe(true);
    expect(r1.executed).toBe(true); // callback ran without throwing
    const r2 = await gw.validateAndRelay(makeCmd("dev-stub"), selfReportedFailure);
    expect(r2.allowed).toBe(true);

    // Two self-reported failures hit failureThreshold=2 → circuit must be open
    const r3 = await gw.validateAndRelay(makeCmd("dev-stub"), async () => undefined);
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toBe("circuit_open");
  });

  it("execute resolving { success:true } or non-result values still records success", async () => {
    const gw = new SafetyGateway({ circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 } });

    await gw.validateAndRelay(makeCmd("dev-ok"), async () => ({ success: true }));
    await gw.validateAndRelay(makeCmd("dev-ok"), async () => undefined);
    await gw.validateAndRelay(makeCmd("dev-ok"), async () => ({ machines: 3 }));

    // failureThreshold=1: a single mis-recorded failure would have tripped it
    const r = await gw.validateAndRelay(makeCmd("dev-ok"), async () => ({ success: true }));
    expect(r.allowed).toBe(true);
    expect(r.executed).toBe(true);
  });
});

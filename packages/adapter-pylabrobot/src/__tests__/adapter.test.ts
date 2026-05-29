/**
 * PyLabRobotAdapter tests — mock-mode round-trip + sidecar-injected round-trip
 * via InMemoryTransport. No real Python subprocess.
 */

import { describe, expect, it } from "vitest";
import { PyLabRobotAdapter } from "../adapter.js";
import { InMemoryTransport, SidecarClient } from "../sidecar-client.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { AdapterEvidenceEvent } from "../types.js";

function makeAdapterWithTransport() {
  const transport = new InMemoryTransport();
  const sidecar = new SidecarClient({ inMemoryTransport: transport });
  const adapter = new PyLabRobotAdapter({
    deviceId: "dev-ot2-test",
    kernelId: "kernel-test",
    plrBackend: "chatterbox",
    backendConfig: {},
    sidecar,
  });
  return { adapter, transport, sidecar };
}

/** Yield to the microtask queue so async send/respond ordering settles */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("PyLabRobotAdapter — mock mode", () => {
  it("identifies itself with the correct source", () => {
    const adapter = new PyLabRobotAdapter({
      deviceId: "dev-1",
      kernelId: "kernel-1",
      plrBackend: "ot2",
      backendConfig: {},
      mockMode: true,
    });
    expect(adapter.id).toBe("dev-1");
    expect(adapter.type).toBe("liquid-handler");
    expect(adapter.source.deviceId).toBe("dev-1");
    expect(adapter.source.kernelId).toBe("kernel-1");
    expect(adapter.source.firmwareVersion).toContain("ot2");
  });

  it("respects machineType override", () => {
    const adapter = new PyLabRobotAdapter({
      deviceId: "dev-pr",
      kernelId: "kernel-1",
      plrBackend: "clariostar",
      backendConfig: {},
      mockMode: true,
      machineType: "plate-reader",
    });
    expect(adapter.type).toBe("plate-reader");
  });

  it("returns idle status in mock mode", async () => {
    const adapter = new PyLabRobotAdapter({
      deviceId: "dev-1",
      kernelId: "kernel-1",
      plrBackend: "chatterbox",
      backendConfig: {},
      mockMode: true,
    });
    await expect(adapter.getStatus()).resolves.toBe("idle");
    await expect(adapter.getProgress()).resolves.toBe(0);
  });

  it("runs a 5-op mock job and emits the expected event sequence", async () => {
    const adapter = new PyLabRobotAdapter({
      deviceId: "dev-1",
      kernelId: "kernel-1",
      plrBackend: "chatterbox",
      backendConfig: {},
      mockMode: true,
    });
    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));
    const loadRes = await adapter.execute({ type: "load_gcode", payload: { jobId: "mock-1" } });
    expect(loadRes.success).toBe(true);
    const startRes = await adapter.execute({ type: "start", payload: { jobId: "mock-1" } });
    expect(startRes.success).toBe(true);
    await tick();
    const types = events.map((e) => e.type);
    expect(types).toContain("method_loaded");
    expect(types).toContain("execution_started");
    expect(types.filter((t) => t === "instrument_result").length).toBe(5);
    expect(types).toContain("execution_completed");
  });

  it("stop is a no-op success in mock mode", async () => {
    const adapter = new PyLabRobotAdapter({
      deviceId: "dev-1",
      kernelId: "kernel-1",
      plrBackend: "chatterbox",
      backendConfig: {},
      mockMode: true,
    });
    await expect(adapter.execute({ type: "stop" })).resolves.toMatchObject({ success: true });
  });

  it("dispose returns offline-equivalent state", async () => {
    const adapter = new PyLabRobotAdapter({
      deviceId: "dev-1",
      kernelId: "kernel-1",
      plrBackend: "chatterbox",
      backendConfig: {},
      mockMode: true,
    });
    await adapter.dispose();
    await expect(adapter.getStatus()).resolves.toBe("offline");
    const res = await adapter.execute({ type: "start" });
    expect(res.success).toBe(false);
  });
});

describe("PyLabRobotAdapter — sidecar round-trip via InMemoryTransport", () => {
  it("initializes backend on first execute call", async () => {
    const { adapter, transport, sidecar } = makeAdapterWithTransport();
    await sidecar.start();

    const lr = await adapter.execute({ type: "load_gcode", payload: { protocolSource: "plr-script" } });
    expect(lr.success).toBe(true);
    expect(transport.sent.length).toBe(0);

    const startP = adapter.execute({
      type: "start",
      payload: { jobId: "j-1", protocolSource: "inline-ops" },
    });
    await tick();

    // First request is backend.init
    let last = transport.lastSent();
    expect(last).not.toBeNull();
    expect((last as { method: string }).method).toBe("backend.init");
    transport.respondSuccess((last as { id: string }).id, {
      ok: true,
      deviceId: "dev-ot2-test",
      plrBackend: "chatterbox",
    });
    await tick();

    // Second outbound: evidence.startRecording
    last = transport.lastSent();
    expect((last as { method: string }).method).toBe("evidence.startRecording");
    transport.respondSuccess((last as { id: string }).id, { ok: true });
    await tick();

    // Third outbound: backend.run
    last = transport.lastSent();
    expect((last as { method: string }).method).toBe("backend.run");
    transport.respondSuccess((last as { id: string }).id, {
      ok: true,
      jobId: "j-1",
      opCount: 12,
      durationMs: 2500,
    });
    await tick();

    // Fourth outbound: evidence.stopRecording
    last = transport.lastSent();
    expect((last as { method: string }).method).toBe("evidence.stopRecording");
    transport.respondSuccess((last as { id: string }).id, { ok: true });

    const res = await startP;
    expect(res.success).toBe(true);
    expect((res.data as Record<string, unknown>).opCount).toBe(12);
  });

  it("forwards sidecar evidence notifications during a run", async () => {
    const { adapter, transport, sidecar } = makeAdapterWithTransport();
    await sidecar.start();

    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const startP = adapter.execute({ type: "start", payload: { jobId: "j-stream" } });
    await tick();
    // init
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true, deviceId: "dev-ot2-test", plrBackend: "chatterbox" });
    await tick();
    // startRecording
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true });
    await tick();

    // backend.run is now in-flight. Push a few evidence notifications.
    for (let i = 0; i < 3; i++) {
      transport.notify("evidence", {
        type: "aspirate",
        deviceId: "dev-ot2-test",
        jobId: "j-stream",
        timestamp: new Date().toISOString(),
        payload: { well: `A${i + 1}`, volume_uL: 100 },
      });
    }

    transport.respondSuccess((transport.lastSent() as { id: string }).id, {
      ok: true,
      jobId: "j-stream",
      opCount: 3,
      durationMs: 1234,
    });
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true });

    await startP;
    const instrumentResults = events.filter((e) => e.type === "instrument_result");
    expect(instrumentResults.length).toBe(3);
    expect((instrumentResults[0]!.payload as Record<string, unknown>).well).toBe("A1");
  });

  it("backend.run failure surfaces as execute() failure + execution_failed event", async () => {
    const { adapter, transport, sidecar } = makeAdapterWithTransport();
    await sidecar.start();

    const events: AdapterEvidenceEvent[] = [];
    adapter.onEvidence((e) => events.push(e));

    const startP = adapter.execute({ type: "start", payload: { jobId: "j-fail" } });
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true, deviceId: "dev-ot2-test", plrBackend: "chatterbox" });
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true });
    await tick();

    // backend.run errors
    transport.respondError(
      (transport.lastSent() as { id: string }).id,
      RPC_ERROR_CODES.NON_RETRYABLE,
      "out of tips",
      { plrException: "NoTipError" },
    );
    await tick();
    // evidence.stopRecording still sent — respond
    if (transport.lastSent() && (transport.lastSent() as { method: string }).method === "evidence.stopRecording") {
      transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true });
    }

    const res = await startP;
    expect(res.success).toBe(false);
    expect(res.message).toBe("out of tips");
    expect(events.some((e) => e.type === "execution_failed")).toBe(true);
  });

  it("status command returns the sidecar's status payload", async () => {
    const { adapter, transport, sidecar } = makeAdapterWithTransport();
    await sidecar.start();

    const p = adapter.execute({ type: "status" });
    await tick();
    // init
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true, deviceId: "dev-ot2-test", plrBackend: "chatterbox" });
    await tick();
    // status
    transport.respondSuccess((transport.lastSent() as { id: string }).id, {
      status: "idle",
      progress: 0,
      diagnostics: { deckLoaded: true },
    });
    const res = await p;
    expect(res.success).toBe(true);
    expect((res.data as Record<string, unknown>).status).toBe("idle");
  });

  it("getStatus returns 'offline' on init failure", async () => {
    const { adapter, transport, sidecar } = makeAdapterWithTransport();
    await sidecar.start();
    const p = adapter.getStatus();
    await tick();
    transport.respondError(
      (transport.lastSent() as { id: string }).id,
      RPC_ERROR_CODES.HARDWARE_UNREACHABLE,
      "USB not found",
    );
    await expect(p).resolves.toBe("offline");
  });

  it("stop forwards backend.abort + maps NOT_SUPPORTED to honest failure", async () => {
    const { adapter, transport, sidecar } = makeAdapterWithTransport();
    await sidecar.start();

    // initialize first
    const initP = adapter.execute({ type: "status" });
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { ok: true, deviceId: "dev-ot2-test", plrBackend: "chatterbox" });
    await tick();
    transport.respondSuccess((transport.lastSent() as { id: string }).id, { status: "idle" });
    await initP;

    const stopP = adapter.execute({ type: "stop" });
    await tick();
    transport.respondError(
      (transport.lastSent() as { id: string }).id,
      RPC_ERROR_CODES.NOT_SUPPORTED,
      "abort not supported",
    );
    const res = await stopP;
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/abort not supported/);
  });
});
